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
            emit("time", { position: lastTime, duration: duration });
        });
        v.addEventListener("playing", function () {
            if (mode === "mse") { mark("playing"); emit("playing", { duration: duration }); }
        });
        v.addEventListener("waiting", function () {
            if (mode !== "mse") { return; }
            emit("buffering", true);

            /* A stall still gets described, but from the player's own stats
             * rather than from a byte pump we no longer own. Rate-limited: a
             * stall flaps, and one line per flap buries the run it belongs to. */
            var now = new Date().getTime();
            if (!shakaPlayer || now - lastStallAt < 5000) { return; }
            lastStallAt = now;
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
                log("卡住 t=" + (v.currentTime || 0).toFixed(1) + "s" +
                    " ahead=" + ahead.toFixed(1) + "s" +
                    " readyState=" + v.readyState +
                    " 估算带宽=" + Math.round((st.estimatedBandwidth || 0) / 1000) + "kbps" +
                    " 当前画质=" + (st.width || "?") + "x" + (st.height || "?") +
                    " 已卡=" + (st.bufferingTime || 0).toFixed(1) + "s" +
                    " 丢帧=" + (st.droppedFrames || 0));
            } catch (e) {}
        });
        v.addEventListener("canplay", function () {
            if (mode === "mse") { emit("buffering", false); }
        });
        v.addEventListener("ended", function () {
            if (mode === "mse") { emit("ended"); }
        });
        v.addEventListener("error", function () {
            if (mode !== "mse") { return; }
            emit("error", "video element error " + (v.error ? v.error.code : "?"));
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
        try { webapis.avplay.stop(); } catch (e) {}
        try { webapis.avplay.close(); } catch (e) {}
        if (obj && obj.parentNode) { obj.parentNode.removeChild(obj); }
        obj = null;

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
        player.configure(shakaConfig());

        /* Registered once. They act on whatever is playing now, which is what
         * a long-lived player means — there is no generation to check because
         * there is only ever one session. */
        player.addEventListener("error", function (e) {
            var err = e && e.detail;
            if (err && (err.category === 1 || err.category === 3)) {
                log("shaka 可恢复错误 " + describeShakaError(err) + "，重试取流");
                try { player.retryStreaming(); } catch (e2) {}
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
                bufferingGoal: 30,
                /* One second, not two. This is how much has to be in hand
                 * before the picture is allowed to start, and it was measured
                 * costing two seconds of black screen after the load had
                 * already finished. */
                rebufferingGoal: 1,
                bufferBehind: 30
            }
        };
    }

    function playDashWithShaka(dash, startMs, isRetry) {
        mode = "mse";
        var gen = ++mseGeneration;
        var retriedLoad = !!isRetry;

        var manifest = Mpd.build(dash, PREFERRED_QN);
        if (!manifest) {
            emit("error", "拼不出播放清单（缺少分段索引）");
            return;
        }
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

            /* One more go, after a pause, when the failure was the network.
             * Shaka's own retries all happen inside a few seconds; this CDN's
             * refusals outlast that, and a second attempt half a minute later
             * routinely succeeds where the first was turned away. */
            if (e && e.category === 1 && !retriedLoad) {
                retriedLoad = true;
                log("首次加载被拒（" + describeShakaError(e) + "），3 秒后重来一次");
                setTimeout(function () {
                    if (gen !== mseGeneration) { return; }
                    playDashWithShaka(dash, startMs, true);
                }, 3000);
                return;
            }
            emit("error", "shaka load 失败 " + describeShakaError(e));
        });
    }

    /* `code` alone names the class of failure and nothing about this one.
     * `data` carries the part that matters — the url and the HTTP status for a
     * network error, the offending codec for an unsupported one — and without
     * it a 1001 is just "something was refused somewhere". */
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
                    /* Stream urls are enormous; the host and status are the
                     * informative bits. */
                    if (part.length > 120) {
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

        playProgressive: function (url, startMs) { reset(); playAvplay(url, startMs); },
        playDash: function (dash, startMs) { reset(); playDashWithShaka(dash, startMs); },

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
            if (mode === "avplay") { try { webapis.avplay.seekTo(target); } catch (e) {} }
            else if (mode === "mse") { el("html5-video").currentTime = target / 1000; }
            lastTime = target;
            emit("time", { position: target, duration: duration });
        },
        /* Absolute seek, for the scrub bar. seekBy stays for the +/-10 s keys. */
        seekTo: function (ms) {
            var target = Math.max(0, ms);
            if (duration) { target = Math.min(target, duration - 2000); }
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
