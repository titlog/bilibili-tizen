/* Playback.
 *
 * Two routes, both proven on this hardware by the spike in ../spike:
 *
 *   AVPlay + progressive durl  — the default. Native seeking, hardware decode,
 *                                constant memory however long the video is.
 *   MSE + DASH representations — the fallback for videos with no durl. AVPlay
 *                                also does DASH, but only from a manifest served
 *                                over HTTP, and a widget cannot listen on a
 *                                socket, so MSE is the only self-contained way.
 *
 * AVPlay's listener is registered on a singleton and survives swapping the
 * <object> element, so every teardown goes through reset().
 */
var Player = (function () {
    "use strict";

    var obj = null;
    var mode = null;          /* "avplay" | "mse" | null */
    var ms = null;
    var onEvent = function () {};
    var duration = 0;
    var lastTime = 0;
    var mseGeneration = 0;   /* invalidates a load that a newer one superseded */
    var avGeneration = 0;    /* same, for the avplay singleton's listener */
    var shakaPlayer = null;  /* the live DASH player, kept across videos */
    /* load() and unload() both take time and both own the media element while
     * they run, so they are queued rather than raced. */
    var shakaOp = Promise.resolve();

    function el(id) { return document.getElementById(id); }

    function emit(kind, data) { onEvent(kind, data); }

    function log(msg) { onEvent("log", msg); }

    /* Milliseconds from the button press to each stage of getting a picture up.
     * "several seconds before it plays" is a symptom with at least five
     * candidate causes — two API round trips, the index fetch, the first media
     * chunk, the decoder — and no way to tell them apart by watching the screen.
     * Every stage records once; the first value wins so a retry cannot rewrite
     * the run that is being measured. */
    var marks = null;
    var markOrder = [];

    /* A stall is the failure the viewer actually complains about and the one
     * least likely to leave a trace, so it still gets a line — now taken from
     * the player's own statistics. */
    var lastStallAt = 0;
    var stallTimer = null;
    var stallSilenced = false; /* capped out; owed a 恢复播放 line when it ends */

    /* One line describing the stall, from Shaka's own statistics. `已卡` is the
     * number to read first: it is cumulative, so if it has not moved since the
     * previous line then whatever happened was not a stall at all — a seek
     * raises `waiting` exactly as a stall does. */
    function stallLine(tag) {
        if (!shakaPlayer) { return; }
        var v = el("html5-video");
        try {
            var st = shakaPlayer.getStats() || {};
            var ahead = 0;
            if (v.buffered && v.buffered.length) {
                for (var b = 0; b < v.buffered.length; b++) {
                    if (v.currentTime >= v.buffered.start(b) - 0.5 &&
                        v.currentTime <= v.buffered.end(b)) {
                        ahead = v.buffered.end(b) - v.currentTime;
                    }
                }
            }
            log(tag + " t=" + (v.currentTime || 0).toFixed(1) + "s" +
                " ahead=" + ahead.toFixed(1) + "s" +
                " seeking=" + v.seeking +
                " readyState=" + v.readyState +
                " 估算带宽=" + Math.round((st.estimatedBandwidth || 0) / 1000) + "kbps" +
                " 当前画质=" + (st.width || "?") + "x" + (st.height || "?") +
                " 已卡=" + (st.bufferingTime || 0).toFixed(1) + "s" +
                " 丢帧=" + (st.droppedFrames || 0));
        } catch (e) {}
    }

    /* `waiting` fires once when the picture stops and does not fire again while
     * nothing arrives — so the worse the stall, the quieter the log. A
     * twenty-nine second freeze left exactly one line, printed at the instant it
     * began, when there was nothing yet to say; the numbers that would have
     * explained it (bandwidth collapsing, the tier being dropped, `已卡`
     * climbing) all happened afterwards, in silence. Restated on a timer until
     * the picture returns. */
    function startStallWatch() {
        if (stallTimer) { return; }
        stallLine("卡住");
        /* Capped. Nothing here is guaranteed to end: a viewer who gives up and
         * hits pause during a stall gets no `playing` and no `canplay`, so the
         * timer would restate the same frozen numbers every five seconds until
         * the television was switched off — and every line is an XHR to the
         * collector. A minute of it says everything a longer stall would. */
        var left = 12;
        stallTimer = setInterval(function () {
            if (--left <= 0) {
                stallLine("仍然卡住（一分钟了，不再复述，恢复时会说一声）");
                stopStallWatch(true);
                /* After the quiet stop, which clears the flag: a capped-out
                 * stall still owes the log its ending — without this, a stall
                 * that outlives the cap and then recovers ends invisibly, the
                 * exact silence this watch was built to remove. */
                stallSilenced = true;
                return;
            }
            stallLine("仍然卡住");
        }, 5000);
    }

    /* `quiet` for teardown: reset() stops the watch on its way out, and a
     * 「恢复播放」 line for a video that is being thrown away is a lie in the one
     * place the log is read most carefully. */
    function stopStallWatch(quiet) {
        var had = !!stallTimer;
        if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
        if (quiet) { stallSilenced = false; return; }
        if (had || stallSilenced) {
            /* Stamped so the flap the element often throws in the first second
             * after recovery — waiting and canplay back to back as readyState
             * settles — cannot reopen the watch and print a fake 卡住/恢复播放
             * pair (seen at 23:16:18: two pairs in the same second). */
            lastStallAt = new Date().getTime();
            stallLine("恢复播放");
        }
        stallSilenced = false;
    }

    /* The playhead has been observed jumping backwards — 1021s to 14s once,
     * 383s to 358s later — with nobody touching the remote, and the jump is
     * what destroys the resume point: `Resume.record` files anything under
     * thirty seconds as "nothing worth resuming" and writes the stored position
     * away. It could not be chased because `waiting` fires for a seek exactly as
     * it does for a stall, so every one of these was logged as 卡住 while
     * Shaka's own bufferingTime sat unchanged — the one number that said no
     * stall had happened at all.
     *
     * So: seeks get their own line, and it says who asked. A seek this code
     * issued and a seek the player performed on its own are the same event to
     * the element, and telling them apart is the entire question. */
    var lastAppSeekAt = 0;
    var lastAppSeekTo = 0;
    var lastTickSec = 0;      /* playhead as of the last timeupdate — the "from" */

    function noteAppSeek(targetMs) {
        lastAppSeekAt = new Date().getTime();
        lastAppSeekTo = targetMs;
    }

    function startTiming() {
        marks = { t0: new Date().getTime() };
        markOrder = [];
    }

    function mark(name) {
        if (!marks || marks[name] !== undefined) { return; }
        marks[name] = new Date().getTime() - marks.t0;
        markOrder.push(name);
    }

    function timings() {
        if (!marks) { return ""; }
        var out = [];
        for (var i = 0; i < markOrder.length; i++) {
            out.push(markOrder[i] + "=" + marks[markOrder[i]] + "ms");
        }
        return out.join(" ");
    }

    /* Bound once. Attaching these inside playMse left one live set of handlers
     * per video played, so by the fifth clip every tick fired five times. */
    var mediaBound = false;
    function bindMediaElement() {
        if (mediaBound) { return; }
        mediaBound = true;
        var v = el("html5-video");
        v.addEventListener("timeupdate", function () {
            if (mode !== "mse") { return; }
            lastTime = v.currentTime * 1000;
            /* Kept separate from `lastTime`, which seekBy/seekTo also write —
             * this one has to survive as the position *before* a seek. */
            lastTickSec = v.currentTime;

            /* The retry ladder is spent per video and never refilled, so one bad
             * patch two minutes in left the remaining twenty-eight with no way
             * out of the next one. This only fires on real progress —
             * `timeupdate` does not tick while the picture is frozen — so a
             * minute of actual playback is what buys the budget back. */
            if (decodeRecoveries && lastDecodeFailAt &&
                    new Date().getTime() - lastDecodeFailAt > 60000) {
                decodeRecoveries = 0;
            }
            if (criticalRetries && lastCriticalAt &&
                    new Date().getTime() - lastCriticalAt > 60000) {
                criticalRetries = 0;
            }
            emit("time", { position: lastTime, duration: duration });
        });

        /* Fires after currentTime has already moved, so `lastTickSec` is still
         * the position it moved away from. */
        v.addEventListener("seeking", function () {
            if (mode !== "mse") { return; }
            /* Matched by time OR by target. Time alone mislabelled at least one
             * seek: when the main thread is busy rebuffering, the gap between
             * the keypress and the element's `seeking` event can exceed any
             * reasonable window, and a remote-control seek gets logged as
             * 「播放器自己」 — the one attribution this line exists to rule out.
             * The 19:54 "player jumped back 31.4s on its own" sample had
             * exactly the remote's step size; it was almost certainly this.
             * Landing within 1.5s of the last target the remote asked for is
             * the stronger signal, honoured for ten seconds. */
            var now = new Date().getTime();
            var sinceApp = now - lastAppSeekAt;
            var byApp = sinceApp < 1500 ||
                (sinceApp < 10000 &&
                 Math.abs(v.currentTime * 1000 - lastAppSeekTo) < 1500);
            var extra = "";
            if (shakaPlayer) {
                try {
                    var r = shakaPlayer.seekRange();
                    extra = " 可跳转区间=" + r.start.toFixed(1) + "…" + r.end.toFixed(1) + "s";
                } catch (e) {}
            }
            log("跳转 " + lastTickSec.toFixed(1) + "s → " + v.currentTime.toFixed(1) + "s" +
                " 发起=" + (byApp ? "遥控器(目标 " + (lastAppSeekTo / 1000).toFixed(1) + "s)"
                                  : "播放器自己") +
                extra + " 时长=" + (v.duration || 0).toFixed(1) + "s");
        });
        v.addEventListener("playing", function () {
            if (mode !== "mse") { return; }
            stopStallWatch();
            mark("playing");
            emit("playing", { duration: duration });
        });
        v.addEventListener("waiting", function () {
            if (mode !== "mse") { return; }
            emit("buffering", true);

            /* Throttled only on the way in: a stall flaps, and one opening line
             * per flap buries the run it belongs to. Once the watch is running
             * the timer sets the cadence. */
            var now = new Date().getTime();
            if (stallTimer || now - lastStallAt < 5000) { return; }
            lastStallAt = now;
            startStallWatch();
        });
        v.addEventListener("canplay", function () {
            if (mode !== "mse") { return; }
            emit("buffering", false);
            stopStallWatch();
        });
        v.addEventListener("ended", function () {
            if (mode === "mse") { emit("ended"); }
        });
        v.addEventListener("error", function () {
            if (mode !== "mse") { return; }
            var code = v.error ? v.error.code : 0;
            /* 3 is MEDIA_ERR_DECODE — the same failure the demuxer reports, seen
             * from the element instead of from Shaka. Whichever arrives first
             * gets one shot at H.264; `lastDash.retried` stops the other from
             * taking a second. */
            if (code === 3 && recoverFromDecodeFailure("video element error 3")) { return; }
            /* A code-less error milliseconds after a decode reload is the old
             * element being torn down, not a new fault. Unswallowed it raced
             * the ladder: 19:52:15 on 2026-08-03 it preempted the avc1 rung
             * with an hev1 in-place restart, burned the restart budget on an
             * echo, and the exit that followed was blamed on a video that had
             * never been given its second codec. */
            if (!code && new Date().getTime() - lastDecodeFailAt < 3000) {
                log("媒体元素无码错误紧跟在解码重载之后，当作同一事件忽略");
                return;
            }
            emit("error", "video element error " + (code || "?"));
        });
    }

    function ensureObject() {
        if (obj) { return obj; }
        obj = document.createElement("object");
        obj.type = "application/avplayer";
        obj.id = "avplayer";
        /* AVPlay renders into the object's laid-out box, not the rect passed to
         * setDisplayRect. Leave the size off and the video lands in a ~300x150
         * corner while setDisplayRect quietly reports success. */
        obj.style.position = "absolute";
        obj.style.left = "0px";
        obj.style.top = "0px";
        obj.style.width = "1920px";
        obj.style.height = "1080px";
        el("video-stage").appendChild(obj);
        return obj;
    }

    function reset() {
        mseGeneration++;
        avGeneration++;

        /* Only when AVPlay was actually used. `obj` is created by
         * `ensureObject()` on that path and nowhere else, so a null one means
         * there is nothing native to tear down — and `stop()` and `close()` are
         * not free when there is nothing to stop: they measured **570ms**
         * together on this set, sitting between the playurl answer and the
         * manifest, on every DASH start. That is most of a second of black
         * screen spent closing a player that was never opened. Found by
         * splitting the `到画面` line with a `teardown` mark rather than by
         * guessing, which is the only reason it was ever visible. */
        if (obj) {
            try { webapis.avplay.stop(); } catch (e) {}
            try { webapis.avplay.close(); } catch (e) {}
            if (obj.parentNode) { obj.parentNode.removeChild(obj); }
            obj = null;
        }

        var v = el("html5-video");

        /* unload(), not destroy(): the player is kept for the next video, and
         * unloading is what cancels every in-flight segment request and frees
         * the SourceBuffers. Leaving requests to be garbage collected left them
         * holding connections, which is the fault that made fast-forwarding a
         * few times break playback for good.
         *
         * It is asynchronous, and the element belongs to it while it runs —
         * clearing src here fought it, and the next load started before the
         * previous teardown had finished. Both are serialised through shakaOp
         * instead. */
        if (shakaPlayer) {
            try { v.autoplay = false; } catch (e) {}
            shakaOp = shakaOp.then(function () {
                return shakaPlayer ? shakaPlayer.unload() : null;
            })["catch"](function () {});
        } else {
            try { v.pause(); v.removeAttribute("src"); v.load(); } catch (e) {}
        }
        v.className = "hidden";
        mode = null;
        duration = 0;
        lastTime = 0;
        /* Belongs to the video being torn down. Left behind, a decode failure on
         * the next one would replay the previous one's manifest, and the retry
         * budget would already be spent before it started. */
        lastDash = null;
        decodeRecoveries = 0;
        lastDecodeFailAt = 0;
        lastDecodeHandled = false;
        criticalRetries = 0;
        lastCriticalAt = 0;
        /* The "from" of the first 跳转 line belongs to this video, not the
         * last one — stale, it reads as a cross-video jump that never happened. */
        lastTickSec = 0;
        stopStallWatch(true);
    }

    /* ---------------- AVPlay ---------------- */

    function playAvplay(url, startMs) {
        mode = "avplay";
        var gen = ++avGeneration;
        ensureObject();
        try { webapis.avplay.close(); } catch (e) {}
        try { webapis.avplay.open(url); }
        catch (e) { emit("error", "open failed: " + e.message); return; }

        try { webapis.avplay.setDisplayMethod("PLAYER_DISPLAY_MODE_LETTER_BOX"); } catch (e) {}
        webapis.avplay.setDisplayRect(0, 0, 1920, 1080);
        try { webapis.avplay.setStreamingProperty("USER_AGENT", USER_AGENT); } catch (e) {}
        /* Only when there is an actual cookie to send. A jar-only session has
         * no readable SESSDATA, so this was handing AVPlay an empty COOKIE
         * property — which it turns into a malformed Cookie header and the CDN
         * refuses the request. It looked exactly like a broken stream, and it
         * only started once the viewer signed in. */
        var cookie = (typeof Auth !== "undefined" && Auth.isLoggedIn())
            ? Auth.cookieHeader() : "";
        if (cookie) {
            try { webapis.avplay.setStreamingProperty("COOKIE", cookie); } catch (e) {}
        }

        /* setListener registers on the avplay singleton and close() does not
         * detach it, so a torn-down session's onerror or onstreamcompleted lands
         * in whatever is playing now — ending or erroring a video that is
         * perfectly fine. The spike learned this; the client had forgotten it. */
        function live() { return gen === avGeneration && mode === "avplay"; }

        webapis.avplay.setListener({
            onbufferingstart: function () { if (live()) { emit("buffering", true); } },
            onbufferingcomplete: function () { if (live()) { emit("buffering", false); } },
            oncurrentplaytime: function (ms2) {
                if (!live()) { return; }
                lastTime = ms2;
                emit("time", { position: ms2, duration: duration });
            },
            onstreamcompleted: function () { if (live()) { emit("ended"); } },
            onerror: function (err) { if (live()) { emit("error", String(err)); } }
        });

        webapis.avplay.prepareAsync(function () {
            if (!live()) { return; }
            try { duration = webapis.avplay.getDuration(); } catch (e) { duration = 0; }
            if (startMs) { try { webapis.avplay.seekTo(startMs); } catch (e) {} }
            webapis.avplay.play();
            mark("playing");
            emit("playing", { duration: duration });
        }, function (err) {
            if (live()) { emit("error", "prepare failed: " + err); }
        });
    }

    /* ---------------- MSE ---------------- */

    /* Built once and kept. Constructing a player and attaching it to the element
     * measured at about seven hundred milliseconds, and paying that on every
     * video is seven hundred milliseconds of black screen for nothing — Shaka is
     * designed to be loaded and unloaded, not rebuilt. */
    function ensureShaka() {
        if (shakaPlayer) { return shakaPlayer; }
        if (typeof shaka === "undefined" || !shaka.Player) { return null; }

        shaka.polyfill.installAll();
        if (!shaka.Player.isBrowserSupported()) { return null; }

        var player = new shaka.Player();
        player.attach(el("html5-video"));
        var cfg = shakaConfig();
        player.configure(cfg);
        /* Once per run, right after engine:/account:. A config experiment whose
         * arms cannot be told apart in the log afterwards is unreadable — every
         * session stamps which knobs it ran with, from the object actually
         * handed to the player, so this line cannot drift from the truth. */
        log("shaka 配置 bufferingGoal=" + cfg.streaming.bufferingGoal +
            "s rebufferingGoal=" + cfg.streaming.rebufferingGoal +
            "s bufferBehind=" + cfg.streaming.bufferBehind + "s");

        /* Registered once. They act on whatever is playing now, which is what
         * a long-lived player means — there is no generation to check because
         * there is only ever one session. */
        player.addEventListener("error", function (e) {
            var err = e && e.detail;
            noteBadHost(err);
            /* A *critical* media error is the decoder refusing the stream, not
             * a blip on the wire. retryStreaming() re-fetches bytes that will be
             * refused for the same reason the moment they arrive; the answer to
             * a codec this set claimed and then could not decode is H.264. */
            if (err && err.category === 3 && err.severity === 2 &&
                    recoverFromDecodeFailure(describeShakaError(err))) {
                return;
            }
            /* Only what Shaka itself calls recoverable gets retried in silence.
             * severity 2 is CRITICAL — the player has given up — and sending
             * that through retryStreaming() meant a failure it had already
             * abandoned was answered with a line reading 「可恢复错误…重试取流」
             * and then nothing at all: no toast, no way back, a black screen
             * whose last log line claimed a retry was under way. `emit("error")`
             * was unreachable for categories 1 and 3, so a network or media
             * failure could never reach the viewer by any path.
             *
             * Not what bit tonight — every 1002 measured came in at severity 1
             * and did recover, by dropping a tier — but a fault with no way to
             * announce itself is the shape of every expensive bug in this
             * codebase. */
            if (err && err.severity !== 2 &&
                    (err.category === 1 || err.category === 3)) {
                log("shaka 可恢复错误 " + describeShakaError(err) + "，重试取流");
                try { player.retryStreaming(); } catch (e2) {}
                return;
            }

            /* CRITICAL, but not fatal on the first showing. Every stall measured
             * on this link came back on its own — the CDN cuts a connection, the
             * player retries, the tier drops, the picture returns half a minute
             * later. Bailing out on the first critical error would have thrown
             * the viewer back to the grid in the middle of exactly that, which
             * is worse than the wait it replaces.
             *
             * So: one silent retry, then speak. What must not happen is the
             * old shape, where category 1 and 3 were retried in silence forever
             * and `emit("error")` below was unreachable code — no toast, no way
             * back, a black screen whose last log line claimed a retry was under
             * way. Once is patience; twice is a fault, and a fault the viewer is
             * never told about is the most expensive kind in this codebase. */
            if (err && err.severity === 2 &&
                    (err.category === 1 || err.category === 3)) {
                lastCriticalAt = new Date().getTime();
                criticalRetries++;
                if (criticalRetries <= 1) {
                    log("shaka 严重错误 " + describeShakaError(err) + "，先试一次重取");
                    try { player.retryStreaming(); } catch (e2) {}
                    return;
                }
                emit("error", "shaka 严重错误反复出现 " + describeShakaError(err));
                return;
            }
            emit("error", "shaka error " + describeShakaError(err));
        });

        player.addEventListener("adaptation", function () {
            var t = currentVideoTrack(player);
            if (!t) { return; }
            log("画质切到 " + t.width + "x" + t.height +
                " (" + Math.round((t.videoBandwidth || t.bandwidth) / 1000) + " kbps)");
            emit("quality", { id: t.originalVideoId || t.id, width: t.width, height: t.height });
        });

        shakaPlayer = player;
        return player;
    }

    function shakaConfig() {
        return {
                /* Adaptation on, capped by the manifest itself — Mpd.build only
                 * writes tiers at or below PREFERRED_QN. This is what makes a
                 * deep seek into a long upload survivable: the CDN has never
                 * cached the middle of a four gigabyte file, and dropping a tier
                 * beats waiting on bytes that have to come from the origin. */
                abr: {
                    enabled: true,
                    /* Shaka's own default is deliberately pessimistic, so the
                     * first video started at 720p and switched up a second
                     * later — a whole segment fetched and thrown away before
                     * the picture appeared. This link measured at 14 Mbit;
                     * six is a conservative reading of that and still starts
                     * at 1080p. After the first video the player's own estimate
                     * has taken over, which is another reason it is kept
                     * between videos rather than rebuilt. */
                    defaultBandwidthEstimate: 6000000
                },
                /* Flat, short retries. An exponential backoff sounds prudent and
                 * is not — the thing being waited out is usually one dropped
                 * connection, and seconds of frozen picture cost more than one
                 * more request. */
                manifest: {
                    retryParameters: { maxAttempts: 3, baseDelay: 150, backoffFactor: 1, timeout: 15000 }
                },
            streaming: {
                /* Spread over roughly ten seconds rather than one and a half.
                 * What is being ridden out is this CDN refusing a burst from one
                 * address and then recovering on its own — measured turning away
                 * even single sequential requests for a while after a couple of
                 * dozen rapid ones. Six attempts inside a second and a half all
                 * land within that window and all fail, and the video is
                 * declared unplayable when it is merely unlucky. */
                retryParameters: { maxAttempts: 7, baseDelay: 600, backoffFactor: 1.6,
                                   fuzzFactor: 0.5, timeout: 20000 },
                /* EXPERIMENT 2026-08-02, single variable: 60 → 30.
                 *
                 * The hypothesis under test: our own read-ahead is what trips
                 * the CDN's per-IP burst limiter, and the limiter is where the
                 * evening's failures came from. The chain, each link measured:
                 * every seek makes Shaka fill `bufferingGoal` worth of buffer
                 * immediately — at this CDN's segment sizing that is a burst of
                 * range requests on two streams at once; the probe run from the
                 * dev machine found ~20 requests in a short window is enough to
                 * start the cooldown, inside which connections are simply cut
                 * (status 000 — the same empty-status shape as tonight's
                 * `1002 data[1]={}` errors); and the viewer seeked a dozen times
                 * tonight, re-arming it each time. Meanwhile the official web
                 * player on the very same LAN never trips it — so the variable
                 * is how much we ask for and how fast, not the route.
                 *
                 * 60 was itself a fix — "stalls when I skip ahead", "nothing
                 * cached when I go back" — so this may regress that. bufferBehind
                 * stays at 120: it retains, it does not fetch.
                 *
                 * Read the verdict from the collector, not from feel:
                 *   fewer `1002 … data[1]={}` per hour of viewing  → keep 30
                 *   1002s unchanged                                → hypothesis
                 *     dead, revert to 60, look elsewhere
                 *   skip-ahead stalls return without fewer 1002s   → revert */
                bufferingGoal: 30,
                /* One second, not two. This is how much has to be in hand
                 * before the picture is allowed to start, and it was measured
                 * costing two seconds of black screen after the load had
                 * already finished. */
                rebufferingGoal: 1,
                bufferBehind: 120,
                /* How long Shaka benches a stream whose segment requests keep
                 * failing, before poking it again. Measured with the default:
                 * a 1080p tier whose deep ranges this edge has never cached got
                 * poked every 60-90 seconds for eight minutes straight — seven
                 * cut connections (1002, empty status), each one a request fed
                 * to the per-IP limiter and an 800-char error line, while 720p
                 * played on underneath. Cold ranges stay cold until someone
                 * streams them; a minute-later retry buys nothing.
                 *
                 * Two minutes, not five: the bench is per-stream, not per-range,
                 * so after a seek into warm territory a longer bench would hold
                 * the picture at 720p even where 1080p serves fine. This knob
                 * exists in the vendored build — verified by grep before use. */
                maxDisabledTime: 120
            }
        };
    }

    /* The last DASH request, kept so a decode failure can be answered by
     * replaying it on H.264 without app.js having to hold the response.
     *
     * The avc1 net at the bottom of playDashWithShaka only catches a `load()`
     * that rejects. A codec probe that lied does not always fail that early:
     * this set accepted an H.265 stream, loaded it, played it, and then the
     * demuxer refused a sample —
     *   CHUNK_DEMUXER_ERROR_APPEND_FAILED: Failed to prepare video sample for decode
     * followed by media element error 3 — several seconds in, long after load
     * had resolved. `isTypeSupported` said yes to that stream. */
    var lastDash = null;      /* {dash, startMs, family} */
    var decodeRecoveries = 0; /* per video; reset() clears it */
    var lastDecodeFailAt = 0;
    var lastDecodeHandled = false;
    var criticalRetries = 0;  /* per video; reset() clears it */
    var lastCriticalAt = 0;   /* refills criticalRetries the same way the
                               * decode ladder refills: a minute of real
                               * playback since the last one */

    /* Hosts that answered 401/403 during this video, kept so no rebuild leads
     * with one. Shaka treats those two statuses as CRITICAL and does *not*
     * advance to the next BaseURL the way it does for a cut connection —
     * measured 2026-08-03 evening: one video had akam truncating segments
     * *and* cosov answering 403, the decode-failure rotation put cosov in
     * front, and every reload died at load() before the codec ladder could
     * run. A 403 host is not "next in line", it is off the list until the
     * next video. Session-scoped on purpose: which mirror is dead varies per
     * video, and tonight proved it both ways within one hour. */
    var badHosts = {};
    /* Which video the blacklist belongs to. reset() must NOT clear it: the
     * in-place restart goes through Player.playDash → reset(), and clearing
     * there wiped the list mid-incident — 19:52 on 2026-08-03 the same cosov
     * had to be re-learned with a fresh 403 on every restart of the same
     * video. The list turns over when the *video* changes, detected from the
     * cid baked into the stream url path. */
    var badHostsScope = "";

    function hostOf(u) { return String(u || "").split("/")[2] || ""; }

    function scopeOf(dash) {
        var v = dash && dash.video && dash.video[0];
        var u = (v && (v.baseUrl || (v.urls && v.urls[0]))) || "";
        var m = /upgcxcode\/\d+\/\d+\/(\d+)\//.exec(String(u));
        return m ? m[1] : String(u).split("?")[0];
    }

    function noteBadHost(err) {
        if (!err || err.code !== 1001 || !err.data) { return; }
        var status = err.data[1];
        if (status !== 403 && status !== 401) { return; }
        var h = hostOf(err.data[0]);
        if (h && !badHosts[h]) {
            badHosts[h] = true;
            log("镜像 " + h + " 返回 " + status + "，这个视频内不再排在前面");
        }
    }

    /* Every path into playDashWithShaka runs through this, so a manifest can
     * never lead with a host already known to refuse — including the in-place
     * restart, which reuses a session object earlier rotations may have left
     * pointing at exactly the wrong mirror. */
    function preferGoodHosts(dash) {
        var kinds = ["video", "audio"];
        for (var k = 0; k < kinds.length; k++) {
            var list = (dash && dash[kinds[k]]) || [];
            for (var i = 0; i < list.length; i++) {
                var urls = list[i].urls;
                if (!urls || urls.length < 2 || !badHosts[hostOf(urls[0])]) { continue; }
                for (var j = 1; j < urls.length; j++) {
                    if (!badHosts[hostOf(urls[j])]) {
                        urls.unshift(urls.splice(j, 1)[0]);
                        list[i].baseUrl = urls[0];
                        break;
                    }
                }
            }
        }
    }

    /* A cut connection does not always announce itself as one. The failure
     * chain measured all evening on 2026-08-03 was: segment request dies at the
     * transport level, a truncated body reaches the demuxer anyway, and the
     * element reports a *decode* error — so the reload below re-asks the same
     * host for the same range and gets the same corpse, deterministically, at
     * the same second of the same video. The official web player survives the
     * identical CDN weather by leading its retry with the other mirror. Rotating
     * the mirror order before the reload is that, in our shape: the manifest is
     * rebuilt from `urls`, so whichever host burned us last moves to the back of
     * every representation. Mutates the session's own arrays on purpose — the
     * lesson should stick for the rest of this video, including app.js's
     * in-place restart, which rebuilds from the same object. */
    function rotateMirrors(dash) {
        var kinds = ["video", "audio"], lead = "";
        for (var k = 0; k < kinds.length; k++) {
            var list = (dash && dash[kinds[k]]) || [];
            for (var i = 0; i < list.length; i++) {
                var urls = list[i].urls;
                if (!urls || urls.length < 2) { continue; }
                /* Skip mirrors already known to 403: rotating onto one turns a
                 * recoverable decode failure into an instant load failure. If
                 * every host is marked, the loop lands back on the original
                 * order, which is the honest answer — there is nowhere better
                 * to go. */
                for (var r = 0; r < urls.length; r++) {
                    urls.push(urls.shift());
                    if (!badHosts[hostOf(urls[0])]) { break; }
                }
                list[i].baseUrl = urls[0];
                lead = hostOf(urls[0]) || lead;
            }
        }
        return lead;
    }

    /* Reload the same codec *first*, and only change family if that did not
     * settle it.
     *
     * The first version of this went straight to H.264, on the reasoning that a
     * codec probe had lied. The device said otherwise: every decode failure
     * measured arrived a second or two after a segment request had failed at the
     * transport level — Shaka 1002 with an empty `data[1]`, no status code at
     * all, which is this CDN cutting the connection when it decides the client
     * is asking for too much. That leaves a hole in the buffer and the demuxer
     * refuses the next sample. What repairs it is *reloading*; the codec switch
     * was riding along, taking the credit.
     *
     * And it was not free. H.264 carries the same picture at 1771 kbps where
     * H.265 needs 502, so the "fix" tripled the bytes on a link that was being
     * throttled precisely for asking too much — then lasted 25 seconds where
     * H.265 had managed 32. Bytes are the one thing this set cannot spare. */
    function recoverFromDecodeFailure(why) {
        if (!lastDash) { return false; }

        /* One failure, announced twice. The media element raises `error 3` and
         * Shaka raises CHUNK_DEMUXER_ERROR_APPEND_FAILED for the same refused
         * sample, milliseconds apart. Counted as two, they burned both rungs of
         * the ladder inside a single second: the same-family reload was
         * declared "没解决" before it had issued one request, and the H.264
         * switch it was meant to replace happened anyway — so the experiment
         * this ladder exists to run never actually ran. Whichever channel
         * arrives first owns the failure; the other is the same event, and gets
         * the same answer. */
        var now = new Date().getTime();
        if (now - lastDecodeFailAt < 3000) { return lastDecodeHandled; }
        lastDecodeFailAt = now;

        /* From where the viewer actually got to, not from the original start —
         * this failure arrives mid-playback, and restarting the episode is a
         * worse answer than the stall was. */
        var from = lastTime || lastDash.startMs || 0;
        var at = Math.round(from / 1000);
        decodeRecoveries++;
        lastDecodeHandled = true;

        if (decodeRecoveries === 1) {
            /* Once per incident, not per rung: if the rotated-to host also fails
             * decode, the avc1 rung below should keep it in front rather than
             * rotate back onto the host that started the incident. */
            var lead = rotateMirrors(lastDash.dash);
            log("解码失败（" + why + "），从 " + at + "s 用 " + lastDash.family +
                " 原样重载一次" + (lead ? "，镜像改从 " + lead + " 出发" : ""));
            playDashWithShaka(lastDash.dash, from, true, lastDash.family, lastDash.capId);
            return true;
        }
        /* Same codec, twice, still refused — now the probe is the suspect after
         * all, and H.264 is one reload away. */
        if (decodeRecoveries === 2 && lastDash.family !== "avc1") {
            log("解码失败（" + why + "），同族重载没解决，从 " + at + "s 退回 avc1");
            playDashWithShaka(lastDash.dash, from, true, "avc1", lastDash.capId);
            return true;
        }
        /* Both codec families dead at this tier is not the end: the tiers are
         * different files, and "drop a tier" is the documented escape that
         * carried P17 through its poisoned region — it just relied on ABR
         * getting lucky. Made an explicit rung 2026-08-03 after a video turned
         * up with hev1-1080p truncating, avc1-1080p answering 403 and the
         * spare host dead: every 1080p route was gone while 720p served. */
        if (!lastDash.capId) {
            log("解码失败（" + why + "），换编码也没走通，压到 720p 从 " + at + "s 再试");
            playDashWithShaka(lastDash.dash, from, true, null, 64);
            return true;
        }
        log("解码失败（" + why + "），已重载 " + decodeRecoveries + " 次仍然失败，交给上层");
        lastDecodeHandled = false;
        return false;
    }

    function playDashWithShaka(dash, startMs, isRetry, prefer, capId) {
        mode = "mse";
        var gen = ++mseGeneration;
        var retriedLoad = !!isRetry;

        var scope = scopeOf(dash);
        if (scope !== badHostsScope) { badHostsScope = scope; badHosts = {}; }
        preferGoodHosts(dash);
        var manifest = Mpd.build(dash, capId || PREFERRED_QN, prefer);
        if (!manifest && !prefer) {
            /* The preferred family had nothing usable. H.264 is always there. */
            manifest = Mpd.build(dash, capId || PREFERRED_QN, "avc1");
        }
        if (!manifest) {
            emit("error", "拼不出播放清单（缺少分段索引）");
            return;
        }
        var usedFamily = Mpd.chosen();
        log("编码 " + usedFamily + (prefer ? "（指定）" : "") +
            (capId ? "，画质压到 qn" + capId : ""));
        lastDash = { dash: dash, startMs: startMs, family: usedFamily,
                     capId: capId || 0 };
        var player = ensureShaka();
        if (!player) {
            emit("error", "这台设备的浏览器内核不支持 DASH 播放");
            return;
        }

        var v = el("html5-video");
        bindMediaElement();
        v.className = "";
        duration = (dash.duration || 0) * 1000;
        /* Start the moment there is something to show, rather than waiting for
         * load() to resolve and only then asking. */
        v.autoplay = true;

        mark("manifest");
        var url = URL.createObjectURL(new Blob([manifest], { type: "application/dash+xml" }));

        /* The start position goes into load(). Loading at zero and seeking
         * afterwards buffers the opening and throws it away, which is exactly
         * what made resuming a video take forever. */
        var startAt = startMs > 1000 ? startMs / 1000 : undefined;
        shakaOp = shakaOp.then(function () {
            if (gen !== mseGeneration) { return null; }
            return player.load(url, startAt);
        }).then(function () {
            try { URL.revokeObjectURL(url); } catch (e) {}
            if (gen !== mseGeneration) { return; }
            mark("loaded");
            if (!duration) {
                try { duration = (v.duration || 0) * 1000; } catch (e) {}
            }
            var t = currentVideoTrack(player);
            if (t) { emit("quality", { id: t.originalVideoId || t.id, width: t.width, height: t.height }); }
            v.play().catch(function (e) {
                if (gen !== mseGeneration) { return; }
                if (/interrupted|aborted/i.test(e.message || "")) { return; }
                emit("error", "play(): " + e.message);
            });
        })["catch"](function (e) {
            try { URL.revokeObjectURL(url); } catch (e2) {}
            if (gen !== mseGeneration) { return; }
            /* 7000 is LOAD_INTERRUPTED, which is a newer load winning. */
            if (e && e.code === 7000) { return; }
            noteBadHost(e);

            /* One more go, after a pause, when the failure was the network.
             * Shaka's own retries all happen inside a few seconds; this CDN's
             * refusals outlast that, and a second attempt half a minute later
             * routinely succeeds where the first was turned away. */
            if (e && e.category === 1 && !retriedLoad) {
                retriedLoad = true;
                log("首次加载被拒（" + describeShakaError(e) + "），3 秒后重来一次");
                setTimeout(function () {
                    if (gen !== mseGeneration) { return; }
                    playDashWithShaka(dash, startMs, true, prefer, capId);
                }, 3000);
                return;
            }

            /* Anything that is not the network, on a stream this set said it
             * could decode, is the set having been wrong. H.264 is the answer
             * to that and it is one reload away — far better than a viewer
             * meeting a black screen because a codec probe lied. Straight away,
             * with no pause: nothing out there needs time to change its mind. */
            if (usedFamily && usedFamily !== "avc1" && (!e || e.category !== 1)) {
                log("走 " + usedFamily + " 时失败（" + describeShakaError(e) + "），退回 avc1");
                playDashWithShaka(dash, startMs, retriedLoad, "avc1", capId);
                return;
            }
            /* The top tier can be refused while lower tiers serve — the tiers
             * are different files, and a 403 on one says nothing about the
             * next. One capped attempt before giving the failure to app.js,
             * which would only rebuild the same top-tier manifest. */
            if (!capId) {
                log("加载连续被拒（" + describeShakaError(e) + "），压到 720p 再试一次");
                playDashWithShaka(dash, startMs, true, prefer, 64);
                return;
            }
            emit("error", "shaka load 失败 " + describeShakaError(e));
        });
    }

    /* `code` alone names the class of failure and nothing about this one.
     * `data` carries the part that matters — the url and the HTTP status for a
     * network error, the offending codec for an unsupported one — and without
     * it a 1001 is just "something was refused somewhere". */
    /* Host, path and the handful of query parameters that decide whether a
     * stream url is accepted. Deliberately does NOT include `upsig` or the
     * Akamai `hdnts` token: those are credentials for the stream, they are
     * enormous, and knowing they are present is all a log needs. */
    var URL_PARAMS_WORTH_SEEING =
        ["os", "platform", "mid", "uipk", "deadline", "trid", "og", "bvc",
         "nettype", "gen", "buvid", "orderid", "agrr"];

    function summariseStreamUrl(u) {
        var out;
        try {
            var noScheme = u.replace(/^https?:\/\//, "");
            var slash = noScheme.indexOf("/");
            var host = slash < 0 ? noScheme : noScheme.slice(0, slash);
            var rest = slash < 0 ? "" : noScheme.slice(slash);
            var q = rest.indexOf("?");
            var path = q < 0 ? rest : rest.slice(0, q);
            var query = q < 0 ? "" : rest.slice(q + 1);

            out = host + " " + path;
            var seen = {};
            var pairs = query.split("&");
            for (var i = 0; i < pairs.length; i++) {
                var eq = pairs[i].indexOf("=");
                if (eq <= 0) { continue; }
                seen[pairs[i].slice(0, eq)] = pairs[i].slice(eq + 1);
            }
            for (var j = 0; j < URL_PARAMS_WORTH_SEEING.length; j++) {
                var k = URL_PARAMS_WORTH_SEEING[j];
                if (seen[k] !== undefined) { out += " " + k + "=" + seen[k]; }
            }
            out += " upsig=" + (seen.upsig ? "有" : "无") +
                   " hdnts=" + (seen.hdnts ? "有" : "无");
        } catch (e) { out = u.slice(0, 80); }
        return out;
    }

    function describeShakaError(e) {
        if (!e) { return "(no error object)"; }
        var out = "code=" + e.code + " category=" + e.category +
                  " severity=" + e.severity;
        try {
            var d = e.data || [];
            for (var i = 0; i < d.length; i++) {
                var part = d[i];
                if (part && typeof part === "object") {
                    try { part = JSON.stringify(part).slice(0, 200); }
                    catch (e2) { part = "[object]"; }
                } else {
                    part = String(part);
                    /* A stream url is 800 characters of which about ten matter.
                     * Truncating it hid exactly the ten — three rounds of
                     * "why does the television get 403 where a browser gets
                     * 206" went unanswered because the parameters that differ
                     * were past the cut. */
                    if (part.indexOf("http") === 0 && part.indexOf("upgcxcode") > 0) {
                        part = summariseStreamUrl(part);
                    } else if (part.length > 120) {
                        part = part.slice(0, 60) + "…(" + part.length + " chars)";
                    }
                }
                out += " data[" + i + "]=" + part;
            }
        } catch (e3) {}
        return out;
    }

    function currentVideoTrack(player) {
        try {
            var tracks = player.getVariantTracks();
            for (var i = 0; i < tracks.length; i++) {
                if (tracks[i].active) { return tracks[i]; }
            }
        } catch (e) {}
        return null;
    }

    /* Fragmented MP4 is a run of moof+mdat boxes after the init segment, so
     * sequential byte ranges can be appended as-is — no sidx parsing needed to
     * get playback going, and memory stays bounded on long videos. */
    /* The single source of truth for which video representation is played, so
     * the quality badge cannot name a different one. */
    function pickDashVideo(dash) {
        return (dash.video || []).filter(function (s) {
            return s.codecs && s.codecs.indexOf("avc1") === 0;
        })[0] || (dash.video || [])[0];
    }

    return {
        on: function (fn) { onEvent = fn; },

        /* The clock starts when the button is pressed, which is before the
         * player is involved at all — so app.js owns starting it. */
        startTiming: startTiming,
        mark: mark,
        timings: timings,

        /* Build the player before anyone asks for it. It is kept for the life
         * of the app, so this is paid exactly once either way — the only
         * question is whether it is paid while the viewer is reading the grid
         * or while they are staring at a black screen waiting for the first
         * video. Called on a timer rather than at init so it lands after the
         * feed has painted. */
        prewarm: function () { ensureShaka(); },

        playProgressive: function (url, startMs) { reset(); playAvplay(url, startMs); },
        playDash: function (dash, startMs) {
            reset();
            /* Half a second goes missing between `playurl` and `manifest` and
             * has done since before Shaka. `reset()` is the only thing in
             * there besides building the manifest, and it calls into AVPlay —
             * whose stop/close are native and are not free even when nothing
             * is playing. Split the mark rather than guess at it. */
            mark("teardown");
            playDashWithShaka(dash, startMs);
        },

        pause: function () {
            if (mode === "avplay") { try { webapis.avplay.pause(); } catch (e) {} }
            else if (mode === "mse") { el("html5-video").pause(); }
        },
        resume: function () {
            if (mode === "avplay") { try { webapis.avplay.play(); } catch (e) {} }
            else if (mode === "mse") { el("html5-video").play(); }
        },
        isPaused: function () {
            if (mode === "avplay") {
                try { return webapis.avplay.getState() === "PAUSED"; } catch (e) { return false; }
            }
            if (mode === "mse") { return el("html5-video").paused; }
            return true;
        },
        /* Seeking is now unconditional. It used to be refused unless the target
         * was already buffered, because a hand-rolled reader had no way to know
         * which byte a given second lived at; the player fetches what it needs
         * and "seek-refused" no longer happens. */
        seekBy: function (deltaMs) {
            var target = Math.max(0, lastTime + deltaMs);
            if (duration) { target = Math.min(target, duration - 2000); }
            noteAppSeek(target);
            if (mode === "avplay") { try { webapis.avplay.seekTo(target); } catch (e) {} }
            else if (mode === "mse") { el("html5-video").currentTime = target / 1000; }
            lastTime = target;
            emit("time", { position: target, duration: duration });
        },
        /* Absolute seek, for the scrub bar. seekBy stays for the +/-10 s keys. */
        seekTo: function (ms) {
            var target = Math.max(0, ms);
            if (duration) { target = Math.min(target, duration - 2000); }
            noteAppSeek(target);
            if (mode === "avplay") { try { webapis.avplay.seekTo(target); } catch (e) {} }
            else if (mode === "mse") { el("html5-video").currentTime = target / 1000; }
            lastTime = target;
            emit("time", { position: target, duration: duration });
        },

        /* How much is ready to play, so the bar can show it. */
        bufferedMs: function () {
            if (mode === "avplay") {
                /* AVPlay exposes no buffered range; report the playhead so the
                 * bar simply shows no lead rather than a wrong one. */
                return lastTime;
            }
            if (mode === "mse") {
                var v = el("html5-video");
                try {
                    if (v.buffered && v.buffered.length) {
                        return v.buffered.end(v.buffered.length - 1) * 1000;
                    }
                } catch (e) {}
            }
            return 0;
        },

        durationMs: function () { return duration; },
        pickDashVideo: pickDashVideo,
        stop: reset,
        mode: function () { return mode; }
    };
})();
