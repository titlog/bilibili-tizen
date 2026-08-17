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
    /* Whether `lastTime` holds a position or merely its initial value.
     *
     * `position()` used to answer `lastTime || lastDash.startMs`, and that `||`
     * cannot tell "nothing has reported a position yet" from "the position is
     * zero". The two only diverge when a viewer deliberately goes back to the
     * very beginning, which is why it hid for so long — and 2026-08-17 21:47 is
     * what it costs when they do: opening a film at its stored 1:08:52, the
     * viewer held rewind back to 0:00; the element wedged mid-seek; the watchdog
     * rebuilt — and asked `position()`, which called the requested 0 falsy and
     * handed back 4132s. They were dropped back at 1:08:52 and had to rewind the
     * whole way a second time.
     *
     * A flag rather than a sentinel, because the hard part is already solved
     * elsewhere: the `timeupdate` handler's filter decides which zeros are the
     * element's start-up noise and which are real. This just carries that
     * verdict — and an app-issued seek is a position by definition. */
    var haveTime = false;
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
    function bufferedAhead(v) {
        var ahead = 0;
        try {
            if (v.buffered && v.buffered.length) {
                for (var b = 0; b < v.buffered.length; b++) {
                    if (v.currentTime >= v.buffered.start(b) - 0.5 &&
                        v.currentTime <= v.buffered.end(b)) {
                        ahead = v.buffered.end(b) - v.currentTime;
                    }
                }
            }
        } catch (e) {}
        return ahead;
    }

    /* Every buffered range, not just the one under the playhead. `ahead` cannot
     * tell "the buffer is empty" from "the playhead is sitting in a hole":
     * bufferedAhead() looks for the range containing currentTime and returns 0
     * when no range does, so both answer 0.0s — and the two want opposite fixes
     * (fetch more bytes vs. get across the gap). Two wedges on 2026-08-16
     * (17:17:03 and 17:17:28, same video, both after the very same 22KB audio
     * segment, `在飞=0` with the channel idle for nineteen seconds) could not be
     * told apart because this line was missing. Read it as: one range ending at
     * the playhead → genuinely out of bytes; a range starting just past the
     * playhead → a hole, and the player is stuck in front of it. */
    function bufferedRanges(v) {
        var out = [];
        try {
            if (v.buffered) {
                for (var b = 0; b < v.buffered.length; b++) {
                    out.push(v.buffered.start(b).toFixed(1) + "–" + v.buffered.end(b).toFixed(1));
                }
            }
        } catch (e) {}
        return out.length ? out.join(" | ") : "空";
    }

    function stallLine(tag) {
        if (!shakaPlayer) { return; }
        var v = el("html5-video");
        try {
            var st = shakaPlayer.getStats() || {};
            var ahead = bufferedAhead(v);
            log(tag + " t=" + (v.currentTime || 0).toFixed(1) + "s" +
                " ahead=" + ahead.toFixed(1) + "s" +
                " seeking=" + v.seeking +
                " readyState=" + v.readyState +
                " 估算带宽=" + Math.round((st.estimatedBandwidth || 0) / 1000) + "kbps" +
                " 当前画质=" + (st.width || "?") + "x" + (st.height || "?") +
                " 已卡=" + (st.bufferingTime || 0).toFixed(1) + "s" +
                " 丢帧=" + (st.droppedFrames || 0) +
                " 缓冲区间=" + bufferedRanges(v));
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

    /* The acting watchdog — a standing heartbeat, deliberately NOT driven by
     * media events.
     *
     * It was event-driven for three days and that is how it failed on
     * 2026-08-09 20:03: the picture froze four seconds after a recovery, the
     * one `waiting` event landed inside the five-second entry throttle that
     * exists to stop log spam, and was swallowed. `waiting` never fires again
     * while nothing arrives, so the watch never armed and the screen stayed
     * black for minutes with the collector completely silent — the exact
     * failure this watchdog was built to end, reintroduced by its own
     * debounce. The 08-06 av01 decoder wedge raised no `waiting` at all.
     * Two independent ways to lose the only wake-up there was; a heartbeat
     * has none.
     *
     * Progress is two watermarks, and it has to be two: the picture moving on,
     * and bytes still arriving. Either one counts — a frozen picture with the
     * buffer still filling is a slow cold range, not a dead one.
     *
     * It was written as one number, `currentTime + buffered ahead`, and that
     * expression is a lie by algebra: `bufferedAhead` is measured *from*
     * currentTime, so the sum is just the buffered edge and the playhead term
     * cancels out. Nothing goes wrong while the edge keeps advancing — which is
     * every video, right up until the buffer reaches the end of the file and
     * pins there. Then a perfectly healthy playback reads as zero progress
     * every fifteen seconds. 2026-08-17 15:33–15:35, a 100-second video,
     * buffered 0.0–99.7 complete: four firings at t=42.3, 64.7, 83.0, 98.2 —
     * the playhead advancing normally through every one of them — burned the
     * whole ladder (hvc1 reload → avc1 → av01 → qn64) on a video that was
     * playing fine, and blacklisted a mirror over a 403 collected on the way.
     * Anything shorter than the buffering goal gets this for its whole length;
     * every longer video gets it in its last ~72 seconds.
     *
     * `userPaused` is an explicit flag, not `element.paused`: the element
     * reports paused during load, and load is precisely when the worst hangs
     * happen. */
    var watchdogTimer = null;
    var watchdogSeen = -1;    /* furthest buffered edge seen */
    var watchdogPos = -1;     /* furthest playhead position seen */
    var watchdogAt = 0;       /* when either of them last moved */
    var userPaused = false;

    function startWatchdog() {
        watchdogSeen = -1;
        watchdogPos = -1;
        watchdogAt = new Date().getTime();
        if (watchdogTimer) { return; }
        watchdogTimer = setInterval(watchdogTick, 5000);
    }

    function stopWatchdog() {
        if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
        watchdogSeen = -1;
        watchdogPos = -1;
        watchdogAt = 0;
    }

    function watchdogTick() {
        var now = new Date().getTime();
        if (mode !== "mse" || userPaused) { watchdogAt = now; return; }
        var v = el("html5-video");
        var at = v.currentTime || 0;
        var end = at + bufferedAhead(v);   /* the buffered edge ahead of the playhead */
        var moved = false;
        if (at > watchdogPos + 0.3) { watchdogPos = at; moved = true; }
        if (end > watchdogSeen + 0.3) { watchdogSeen = end; moved = true; }
        if (moved) { watchdogAt = now; return; }

        /* Adaptive patience. A screen that has never shown a frame gets 10
         * seconds. Mid-play gets 14–15, and the reason changed on 2026-08-15:
         * it is no longer only about not burning a ladder rung on a healthy
         * video, it is about not preempting Shaka. Its connectionTimeout is 5s
         * and its retry backoff 0.6s, so a hung request fails and gets tried
         * again inside about eleven seconds — but only if nothing tears the
         * player down first. The old value here was 10s during an incident,
         * which meant the rebuild always won the race and the library's own
         * recovery never ran once (the counters that evening: seven requests in
         * flight, none answered, nothing new sent, and a rebuild every ten
         * seconds feeding a connection pool that was already full).
         *
         * These three numbers are keyed to each other — see retryParameters. */
        var need = (!marks || marks.playing === undefined) ? 10000
                 : (incidentAt ? 14000 : 15000);
        if (now - watchdogAt < need) { return; }
        watchdogAt = now;
        log("卡住 " + Math.round(need / 1000) + " 秒无错误也无进展，当作断连走重载阶梯" +
            "（t=" + (v.currentTime || 0).toFixed(1) + "s" +
            " readyState=" + v.readyState +
            " 缓冲区间=" + bufferedRanges(v) + "）");
        if (!recoverFromDecodeFailure("卡死无进展")) {
            emit("error", "卡死无进展，重载阶梯用尽");
        }
    }

    /* The discriminating experiment the DASH path never had. Progressive
     * failures have had one since 08-02 — `probe: … xhr=403|206` — and it
     * settled arguments that had already cost several deploys. A DASH stall
     * had nothing: 「没有字节到达」 is equally consistent with the CDN refusing
     * this client, with a connection that hangs open and delivers nothing, and
     * with bytes arriving fine while the player sits on them. Those three want
     * opposite fixes, and 2026-08-09 was spent guessing between them.
     *
     * One small range of the representation that is stalling, asked plainly.
     * 128KB, once per rescue — next to the segment traffic it interrupts, it
     * is noise, and the rate limiter is watched closely enough elsewhere. */
    function probeStalledStream() {
        if (!lastDash) { return; }
        var reps = (lastDash.dash && lastDash.dash.video) || [];
        var rep = null, i;
        for (i = 0; i < reps.length; i++) {
            if (String(reps[i].codecs || "").split(".")[0] === lastDash.family) { rep = reps[i]; break; }
        }
        rep = rep || reps[0];
        var url = rep && ((rep.urls && rep.urls[0]) || rep.baseUrl);
        if (!url) { return; }
        /* At the stalled position, NOT at byte zero. The first version asked
         * for bytes 0-131071 and came back 206 in 95ms, which proved only that
         * the host, the token and the UA are fine — the head of a file is
         * always warm at the edge. What stalls is a range nineteen minutes in,
         * and this CDN's documented failure is precisely the range its edge has
         * never cached: thirty times slower when it answers at all, connection
         * cut when it does not. A probe that cannot tell those apart from a
         * healthy file is not an experiment, it is decoration.
         *
         * Offset from bandwidth × time — the representation is CBR-ish enough
         * for this to land in the right neighbourhood, which is all it needs. */
        var v = el("html5-video");
        var at = v.currentTime || 0;
        var off = Math.floor((rep.bandwidth || 1000000) / 8 * at);
        var t0 = new Date().getTime();
        /* Snapshot both before the async callback. lastDash is nulled by reset()
         * when a session tears down, and the probe's onload arriving after that
         * threw an uncaught TypeError on lastDash.family — harmless (onerror
         * caught it) but noisy, and 2026-08-11 it landed right in the middle of
         * the strong-token retry. rep.id likewise. */
        var probeFam = lastDash.family, probeId = rep.id;
        try {
            var xhr = new XMLHttpRequest();
            xhr.open("GET", url, true);
            xhr.responseType = "arraybuffer";
            xhr.timeout = 10000;
            xhr.setRequestHeader("Range", "bytes=" + off + "-" + (off + 131071));
            xhr.onload = function () {
                var n = (xhr.response && xhr.response.byteLength) || 0;
                log("判别探测 xhr=" + xhr.status + " " + n + "B" +
                    (n && n < 131072 ? "（要 131072B，短了——半截响应）" : "") + " " +
                    (new Date().getTime() - t0) + "ms 偏移=" + Math.round(off / 1048576) +
                    "MB(" + Math.round(at) + "s) 主机=" + hostOf(url) +
                    " 档=" + probeId + " " + probeFam);
            };
            xhr.onerror = function () {
                log("判别探测 xhr=连接失败 " + (new Date().getTime() - t0) +
                    "ms 主机=" + hostOf(url));
            };
            xhr.ontimeout = function () {
                log("判别探测 xhr=十秒无响应（连接吊着不给字节）偏移=" +
                    Math.round(off / 1048576) + "MB(" + Math.round(at) + "s) 主机=" + hostOf(url));
            };
            xhr.send();
        } catch (e) {}
    }

    /* Which protocol this set actually speaks to the CDN, measured instead of
     * assumed.
     *
     * CLAUDE.md has carried 「MSE 走同代 Chromium 栈，大概率也是 h2（未在设备上
     * 证实）」 for a fortnight, and a great deal rides on it: over HTTP/1.1 the
     * six-connections-per-host cap turns one buffering goal into a completely
     * different shape of burst than the web player's single multiplexed
     * connection makes — and 「单发 206、成串的没下文」 is exactly what the
     * difference would look like from here. A constraint carrying that much
     * weight has to prove itself; that rule is the most expensive one this
     * repository has.
     *
     * Nothing extra goes on the wire: the entries are already there, left by the
     * segment requests themselves. The catch is that `nextHopProtocol` is one of
     * the fields a cross-origin response withholds unless it sends
     * Timing-Allow-Origin, and an empty string means *that*, not HTTP/1.1. The
     * line separates the two, because 「看不到」 and 「是 1.1」 want opposite next
     * steps — one needs a different experiment, the other needs the buffering
     * config rethought. */
    function transportSummary() {
        try {
            if (!window.performance || !performance.getEntriesByType) {
                return "没有 performance API";
            }
            var all = performance.getEntriesByType("resource");
            var byHost = {}, order = [], blind = 0, seenAny = 0;
            for (var i = 0; i < all.length; i++) {
                var name = all[i].name || "";
                if (name.indexOf("bilivideo") < 0 && name.indexOf("akamaized") < 0 &&
                    name.indexOf("bilibili") < 0) { continue; }
                seenAny++;
                var host = hostOf(name);
                var p = all[i].nextHopProtocol;
                if (!p) { blind++; p = "?"; }
                if (!byHost[host]) { byHost[host] = {}; order.push(host); }
                byHost[host][p] = (byHost[host][p] || 0) + 1;
            }
            if (!seenAny) { return "还没有 CDN 请求可看"; }
            /* Cleared after every read, so each line covers the window since the
             * last one rather than the whole session. The buffer stops accepting
             * entries at 250 and nothing else here clears it — every card
             * thumbnail counts against that, and 我的 now paints up to a hundred
             * of them, so a set that has browsed for a few minutes would have a
             * buffer full of cover art and none of the segment requests that are
             * actually stalling. A 「卡住时」 tally that is really a tally of
             * startup cannot be compared with 「健康时」, which is the only reason
             * both lines exist. */
            try { performance.clearResourceTimings(); } catch (e2) {}
            var out = [];
            for (var h = 0; h < order.length; h++) {
                var protos = byHost[order[h]], parts = [];
                for (var k in protos) {
                    if (protos.hasOwnProperty(k)) { parts.push(k + "×" + protos[k]); }
                }
                out.push(order[h] + "=" + parts.join(","));
            }
            return out.join(" ") +
                   (blind ? "（其中 " + blind + " 条问不到协议：跨域响应没给 " +
                            "Timing-Allow-Origin，「?」不等于 1.1）" : "");
        } catch (e) { return "问不出来：" + (e && e.message); }
    }

    /* One line per playback, well after the start burst so there is something to
     * count, and again inside the stall diagnostic — the interesting comparison
     * is healthy traffic against traffic that has just stopped arriving. */
    var transportTold = false, transportToldAt = 0, shapeProbed = false, shapeProbedStall = false;
    function tellTransport(when) {
        log("传输 " + when + " " + transportSummary());
    }

    /* The url of the representation currently being played, for probes. */
    function currentStreamUrl() {
        if (!lastDash) { return ""; }
        var reps = (lastDash.dash && lastDash.dash.video) || [];
        var rep = null;
        for (var i = 0; i < reps.length; i++) {
            if (String(reps[i].codecs || "").split(".")[0] === lastDash.family) { rep = reps[i]; break; }
        }
        rep = rep || reps[0];
        return (rep && ((rep.urls && rep.urls[0]) || rep.baseUrl)) || "";
    }

    /* What `nextHopProtocol` refused to say, asked a way the CDN cannot withhold.
     *
     * HTTP/1.1 caps a browser at six connections per host: fire eight requests
     * at once and the last two cannot even start until two of the first six
     * finish, so their completion times land in a second wave. HTTP/2 carries
     * all eight down one connection and they finish together. The shape of the
     * finish times is the answer, and it needs no cooperation from the server.
     *
     * Eight kilobytes total, once per app launch. That is genuinely nothing next
     * to one segment — but it is still a burst at a CDN whose limiter is keyed
     * on exactly that, so it is one shot, deliberately tiny, and never repeated
     * while an incident is running. */
    function probeTransportShape(tag) {
        var url = currentStreamUrl();
        if (!url) { return; }
        var N = 8, t0 = new Date().getTime(), done = 0, rows = [], codes = {};
        function finish(k, s0, code) {
            var now = new Date().getTime();
            rows.push({ k: k, start: s0 - t0, dur: now - s0 });
            codes[code] = (codes[code] || 0) + 1;
            if (++done < N) { return; }

            /* Start and duration kept apart, because the first version of this
             * probe could not tell them apart and read its own dispatch cost as
             * the network's shape: eight `send()` calls run one after another on
             * this set's main thread, so timing everything from one t0 draws a
             * staircase whatever the transport does. What separates the two:
             * over HTTP/1.1 the seventh and eighth requests cannot start until
             * two of the first six finish, so their *durations* run long while
             * their start offsets stay small; a slow dispatch loop staggers the
             * *starts* and leaves the durations alike. */
            rows.sort(function (a, b) { return a.start - b.start; });
            var starts = [], durs = [], sorted = [];
            for (var i = 0; i < rows.length; i++) {
                starts.push(rows[i].start); durs.push(rows[i].dur); sorted.push(rows[i].dur);
            }
            sorted.sort(function (a, b) { return a - b; });
            var medDur = sorted[3] || 1;
            var spread = starts[7] - starts[0];

            /* Three shapes, and the first reading of this probe had a rule for
             * only two of them — so it printed 「像多路复用」 at a set of numbers
             * that plainly queued (33,52,73,98,…, one every 21ms). A classifier
             * with no case for what actually happened does not fall silent, it
             * lies. The cases, stated so a fourth shape is visible as unclassified
             * rather than forced into one of these:
             *   - six-connection cap: six alike, the last two roughly doubled
             *   - single file: durations climbing by a near-constant step
             *   - genuinely parallel: all eight alike
             * The numbers are printed either way; the verdict is a reading of
             * them, and it says when it has none. */
            /* Averages, and a gentler multiplier than the first version's
             * 1.8×+30ms — which was calibrated so tightly that the textbook
             * six-connection shape (six at 100ms, two at 200ms) fell *through*
             * it and printed 「不属于已知三种」. A rule that cannot fire for the
             * signature it was written to catch is the same failure as having no
             * rule: it reads later as 「从没见过 h1.1」 rather than 「规则漏了」. */
            var firstSix = 0, lastTwo = 0, q;
            for (q = 0; q < 6; q++) { firstSix += durs[q]; }
            for (q = 6; q < 8; q++) { lastTwo += durs[q]; }
            firstSix /= 6; lastTwo /= 2;
            var lateTwo = lastTwo > firstSix * 1.5 + 20;
            var steps = [], stepSum = 0, s;
            for (s = 1; s < sorted.length; s++) {
                steps.push(sorted[s] - sorted[s - 1]);
                stepSum += sorted[s] - sorted[s - 1];
            }
            var stepAvg = stepSum / steps.length, even = 0;
            for (s = 0; s < steps.length; s++) {
                if (steps[s] > stepAvg * 0.5 && steps[s] < stepAvg * 2) { even++; }
            }
            var serial = stepAvg > 8 && even >= steps.length - 1;
            var flat = (sorted[7] - sorted[0]) < medDur * 0.4;

            var verdict = serial
                ? "耗时逐个递增约 " + Math.round(stepAvg) + "ms 一档 —— 响应是排着队一个接一个回来的，不是并行"
                : lateTwo
                    ? "第 7、8 个耗时明显翻倍 —— 像 HTTP/1.1 的六连接上限"
                    : flat
                        ? "八个耗时齐平 —— 真并行"
                        : "形状不属于已知三种（六连接上限 / 严格排队 / 真并行），别硬套";
            var codeList = [];
            for (var c in codes) { if (codes.hasOwnProperty(c)) { codeList.push(c + "×" + codes[c]); } }
            log("传输形状" + (tag ? "（" + tag + "）" : "") + " 8 并发×1KB" +
                " 发出(ms)=" + starts.join(",") + "（相差 " + spread + "ms，排除本机发送开销）" +
                " 各自耗时(ms)=" + durs.join(",") +
                " 状态=" + codeList.join(",") + " → " + verdict);
        }
        for (var j = 0; j < N; j++) {
            (function (k) {
                var s0 = new Date().getTime();
                try {
                    var xhr = new XMLHttpRequest();
                    xhr.open("GET", url, true);
                    xhr.responseType = "arraybuffer";
                    xhr.timeout = 8000;
                    /* Distinct offsets: identical requests can be coalesced, and
                     * a coalesced set would fake the multiplexed answer. */
                    xhr.setRequestHeader("Range", "bytes=" + (k * 4096) + "-" + (k * 4096 + 1023));
                    xhr.onload = function () { finish(k, s0, xhr.status); };
                    xhr.onerror = function () { finish(k, s0, "失败"); };
                    xhr.ontimeout = function () { finish(k, s0, "超时"); };
                    xhr.send();
                } catch (e) { finish(k, s0, "抛异常"); }
            })(j);
        }
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
        transportTold = false;   /* one transport line per video, not per seek */
        resetSegTraffic();
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
            /* A load with a start position ticks t=0 before the initial seek
             * lands, and a failing rebuild ticks it on every attempt. Letting
             * that tick through wrote 0 into lastTime, lastKnownPosition and
             * Resume — which is how the 2026-08-12 wake-up restarted a
             * 32-minute position 「从 0:00 起」 and wiped the stored resume
             * point on the way. A zero on a session that started elsewhere is
             * noise, not a position. */
            if (!v.currentTime && lastDash && lastDash.startMs > 1000) { return; }
            lastTime = v.currentTime * 1000;
            haveTime = true;   /* past the filter above, so this zero is a real one */
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
            /* Sixty seconds of real playback after an incident proves the
             * family that survived it. Keyed on its own marker rather than on
             * the decode budget: the incident that made this feature worth
             * building — 19:56 on 08-09, three hvc1 tiers 403'd one after
             * another until the family ran out and av01 took over — never
             * touched the decode ladder at all, so hanging the lesson off
             * `decodeRecoveries` recorded the bad files and lost the answer. */
            if (incidentAt && new Date().getTime() - incidentAt > 60000) {
                incidentAt = 0;
                if (mode === "mse" && lastDash) {
                    stashLesson({ f: lastDash.family });
                    log("这条路稳定播了一分钟，记为本视频的教训（" + lastDash.family + "）");
                }
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
            /* Both watchdog watermarks mean "further than anything seen so
             * far", and a seek makes that meaningless. Jumping back leaves the
             * playhead and the buffered edge below marks taken before the jump,
             * so neither can advance again until playback has climbed all the
             * way back — minutes, during which a perfectly healthy picture reads
             * as no progress at all and the recovery ladder starts pulling it
             * apart. Restart both from here; the position is discontinuous, so
             * everything measured against the old one is void. */
            watchdogSeen = -1;
            watchdogPos = -1;
            watchdogAt = now;
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
            /* Fifteen seconds in: past the start burst, so the count is of
             * steady-state segment traffic rather than of the manifest and two
             * init segments. Once per video — `playing` fires again after every
             * seek, and this answer does not change within a session. */
            if (!transportTold) {
                transportTold = true;
                setTimeout(function () {
                    if (mode !== "mse") { return; }
                    tellTransport("播放中");
                    /* Only from a healthy stretch, and only once for the whole
                     * app run: during an incident the eight would be eight more
                     * requests into a limiter that is already refusing, and the
                     * answer would be about the incident rather than about the
                     * transport. */
                    if (!shapeProbed && !incidentAt) {
                        shapeProbed = true;
                        probeTransportShape("健康时");
                    }
                }, 15000);
            }
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
        haveTime = false;
        /* Belongs to the video being torn down. Left behind, a decode failure on
         * the next one would replay the previous one's manifest, and the retry
         * budget would already be spent before it started. */
        lastDash = null;
        decodeRecoveries = 0;
        incidentAt = 0;
        lastDecodeFailAt = 0;
        lastDecodeHandled = false;
        criticalRetries = 0;
        lastCriticalAt = 0;
        triedAv01 = false;
        /* The "from" of the first 跳转 line belongs to this video, not the
         * last one — stale, it reads as a cross-video jump that never happened. */
        lastTickSec = 0;
        userPaused = false;
        stopWatchdog();
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
            /* A critical 403 usually names one *file*, not one host — the
             * 15:54 incident: hev1-720p answered 403 on every host while its
             * 1080p sibling played fine, the in-place restart rebuilt the
             * same manifest, and ABR dipped into the same mine on every
             * recovery until the budget ran out. Excise the representation
             * and rebuild from where the viewer is; chooseVideos re-runs, and
             * a family that just lost its top tier fails the baseline check
             * so the build falls to the next family on its own. `prefer` is
             * deliberately not pinned: the re-pick must be free to leave the
             * family whose file died. */
            if (err && err.severity === 2 && err.category === 1 && lastDash) {
                var badTok = noteBadFile(err);
                /* The first web-token 403 goes straight to the app endpoint —
                 * before dropping even one file. Each dropped file is another
                 * 403 request into this CDN's per-IP limiter, and by the third
                 * the strong token's own sidx reads are throttled, which is
                 * exactly why it kept arriving with 4 tiers of 12 (2026-08-11).
                 * offerStrongToken's guard (badFiles non-empty) is satisfied the
                 * instant noteBadFile records this one. It rebuilds from lastTime
                 * inside app.js; a strong manifest or a video with no aid falls
                 * through to the per-file drop below. */
                if (badTok && offerStrongToken()) { return; }
                if (badTok && dropRep(lastDash.dash, badTok)) {
                    var fromTok = lastTime || lastDash.startMs || 0;
                    log("文件 " + badTok + " 被 403，从清单剔除，从 " +
                        Math.round(fromTok / 1000) + "s 原地重建");
                    emit("status", "网络不顺，正在自动重试…");
                    incidentAt = new Date().getTime();
                    playDashWithShaka(lastDash.dash, fromTok, true, null, lastDash.capId);
                    return;
                }
                /* A 403 on an *audio* file. The representation cannot be
                 * dropped — audio has one family, and a manifest without sound
                 * is not a recovery — but the file exists on the other mirror,
                 * and Shaka will not fail over on 403 by itself. Rotate and
                 * rebuild, once per file: 2026-08-11 20:57 the soundtrack
                 * (30280) was refused by cosov twice in four seconds and the
                 * only path left was the critical-retry exit, while akam had
                 * never been asked. */
                var aTok = fileTokenOf(err.data && err.data[0]);
                if (aTok && !isVideoToken(lastDash.dash, aTok) && !audioRotated[aTok]) {
                    audioRotated[aTok] = true;
                    var aLead = rotateMirrors(lastDash.dash);
                    var fromA = lastTime || lastDash.startMs || 0;
                    log("音轨 " + aTok + " 被 403，换镜像" +
                        (aLead ? "（改从 " + aLead + " 出发）" : "") +
                        "，从 " + Math.round(fromA / 1000) + "s 原地重建");
                    emit("status", "网络不顺，正在自动重试…");
                    incidentAt = new Date().getTime();
                    playDashWithShaka(lastDash.dash, fromA, true,
                                      lastDash.family, lastDash.capId);
                    return;
                }
            }
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
                /* A 403 Shaka labels RECOVERABLE is not worth its retry when
                 * the manifest is a web one: the retry feeds the 403 error
                 * page into the demuxer, the element reports error 3, and a
                 * *token* problem then walks the codec/tier ladder as a fake
                 * decode failure — both 2026-08-12 incidents opened exactly
                 * this way (cosov refusing the soundtrack), and the 12:53
                 * replay ground through six rebuilds and forty seconds before
                 * reaching the strong token that then played instantly. The
                 * root cause is the token, not the segment
                 * (docs/播放流令牌-app端点根治.md), so the first web-token 403
                 * escalates now. On a strong manifest, or once per manifest,
                 * offerStrongToken declines and the retry runs as before. */
                if (err.code === 1001 && err.data &&
                        (err.data[1] === 403 || err.data[1] === 401) &&
                        offerStrongToken(true)) {
                    return;
                }
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

        /* What Shaka actually asked for, and what actually came back. Days of
         * this file have asserted that a decode error is a cut connection in
         * disguise — a truncated segment reaching the demuxer — and the claim
         * was never measured. 2026-08-09 21:03 measured the neighbourhood
         * instead (a plain range at the stalled offset returned its full 128KB)
         * and the demuxer still said 「stream parsing failed」, which the
         * truncation story does not explain. This closes the gap: the byte
         * range of the last segment request, against the length of its
         * response. Requested 1.2MB and got 2MB-capped or short → truncation,
         * as claimed. Requested and received the same → the bytes were whole
         * and the fault is in what we asked for (our own SegmentBase offsets)
         * or in the decoder. Two answers, opposite fixes; no way to tell them
         * apart without this.
         *
         * Both halves have to come from the *same* response, and until
         * 2026-08-15 they did not: one global slot held the last request's range
         * while the response filter wrote the next body's length into it, so
         * with video and audio in flight together the audio body was measured
         * against the video range. That is where 「要 36599B 收到 1021139B」 came
         * from — read on the day as the CDN answering with bytes nobody asked
         * for, and used to explain a decode error. It was this instrument
         * misreading itself. The response's own `content-range` settles it with
         * nothing to pair up: it states the range actually served, and the body
         * is right there beside it. The request filter stays only for responses
         * that carry no content-range (a 200 answering a range request — itself
         * worth seeing). */
        try {
            var RT = shaka.net.NetworkingEngine.RequestType;
            var ne = player.getNetworkingEngine();
            ne.registerRequestFilter(function (type, request) {
                if (type !== RT.SEGMENT) { return; }
                var h = (request.headers && (request.headers.Range || request.headers.range)) || "";
                lastAskedRange = String(h);
                segStarted++;
                segLastStart = new Date().getTime();
            });
            ne.registerResponseFilter(function (type, response) {
                if (type !== RT.SEGMENT) { return; }
                segFinished++;
                segLastFinish = new Date().getTime();
                var hs = response.headers || {};
                var cr = hs["content-range"] || hs["Content-Range"] || "";
                var m = /bytes\s+(\d+)-(\d+)/.exec(String(cr));
                var got = (response.data && response.data.byteLength) || 0;
                if (m) {
                    lastSegReq = { range: "bytes=" + m[1] + "-" + m[2],
                                   want: Number(m[2]) - Number(m[1]) + 1,
                                   got: got, uri: response.uri || "", ranged: true };
                    return;
                }
                var q = /bytes=(\d+)-(\d+)/.exec(lastAskedRange);
                lastSegReq = { range: lastAskedRange + "（响应没给 content-range）",
                               want: q ? (Number(q[2]) - Number(q[1]) + 1) : 0,
                               got: got, uri: response.uri || "", ranged: false };
            });
        } catch (e) { log("段级仪表装不上：" + e.message); }

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
                /* connectionTimeout and stallTimeout are the 2026-08-15 finding,
                 * and they are set here to fire *before* our own watchdog.
                 *
                 * What was measured that evening, with the segment counters that
                 * had just been added: at every stall, `发出=176 回来=169 在飞=7`
                 * — six or seven requests out and never answered, nothing new
                 * sent for twelve seconds, while a plain XHR to the same host at
                 * the same offset returned 206 in 93ms. So the host was alive and
                 * the bytes were there; what was dead were the connections
                 * already open, hanging without ever erroring (this platform
                 * reports a cut connection as a normal end). Six is not a
                 * coincidence: it is HTTP/1.1's per-host limit, so the hung
                 * requests were holding the whole pool and nothing else could
                 * even start.
                 *
                 * Shaka is built for this — fail the request, back off, retry,
                 * move down the BaseURL list — but its own defaults are
                 * connectionTimeout 10s / stallTimeout 5s, and our watchdog tore
                 * the player down at 10s. It never once got to try. The rebuild
                 * then queued a fresh burst into the same exhausted pool, which
                 * is the loop the viewer sees as a stutter every ten seconds.
                 *
                 * 6s and 5s leave room for a failure and one retry (6 + 0.6 +
                 * whatever the second attempt needs) inside the watchdog's 14s.
                 * The three numbers are keyed to each other — change one and
                 * check the others.
                 *
                 * connectionTimeout is the risky one and 6s is a compromise, not
                 * a measurement: it bounds time to *first byte*, and this CDN's
                 * documented worst case is a range its edge has never cached,
                 * which goes back to origin and is thirty times slower when it
                 * answers at all. A first version of this set it to 5s purely
                 * from the arithmetic above without checking it against that.
                 * Healthy time-to-first-byte here measures 68–467ms, so 6s is
                 * two orders of margin for the normal case; if deep seeks into
                 * long uploads start failing where they used to merely take a
                 * while, **this is the number to raise**, and Shaka moving down
                 * the BaseURL list on failure is part of why failing fast is not
                 * obviously worse than waiting. stallTimeout stays at Shaka's
                 * own 5s: a cold range is slow to start, not slow between
                 * chunks, so that one is not the cold-range risk. */
                retryParameters: { maxAttempts: 7, baseDelay: 600, backoffFactor: 1.6,
                                   fuzzFactor: 0.5, timeout: 20000,
                                   connectionTimeout: 6000, stallTimeout: 5000 },
                /* Both numbers are the official web player's, measured off it
                 * on 2026-08-03 and adopted on 08-09. The rule they follow:
                 * where the web player's behaviour is known, match it — it is
                 * the reference implementation, running against the same CDN
                 * with the same account, and it does not stutter.
                 *
                 * What this replaces: `bufferingGoal: 30`, an experiment from
                 * 08-02 testing "our own read-ahead is what trips the CDN's
                 * per-IP burst limiter". That hypothesis never proved itself
                 * and the reference refutes it — the web player fills ~72s and
                 * fires 34 requests in the ten seconds after a seek without
                 * being throttled. Thirty seconds of headroom is simply less
                 * room to ride out a cold patch, and cold patches are what
                 * 08-09 was made of.
                 *
                 * bufferBehind comes down at the same time, also to match
                 * (the web player trims at 20-38s). Together the set buffers
                 * *less* in total than before — 72+30 against 30+120 — while
                 * more than doubling what stands between a stalled range and
                 * a frozen picture. */
                bufferingGoal: 72,
                /* One second, not two. This is how much has to be in hand
                 * before the picture is allowed to start, and it was measured
                 * costing two seconds of black screen after the load had
                 * already finished. The web player starts on ~4.5s after a
                 * deep seek and reaches a picture in 1.0s; same philosophy,
                 * and ours has measured well, so this one stays ours. */
                rebufferingGoal: 1,
                bufferBehind: 30,
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
    /* Any rescue, whichever ladder ran it — the clock the lesson is measured
     * from. */
    var incidentAt = 0;
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
    /* One AV1 attempt per load session. AV1 sits last in the manifest's own
     * preference for a reason (nothing says this SoC decodes it in hardware),
     * but 2026-08-03 a video turned up whose hev1 and avc1 1080p files were
     * being starved by the CDN — 25-50 KB/s from the desktop, flat 403 for the
     * TV — while the av01 file served at full speed. The web player never
     * noticed the incident because av01 is its default. As a desperation rung
     * it outranks dropping to 720p; the 丢帧 counter in the stall lines is the
     * judge of whether the decode is actually holding up. */
    var triedAv01 = false;

    /* Builds the av01 manifest or says exactly why there is none — the rung
     * skipped silently once (20:34, P20 straight to 720p with av01 sitting
     * healthy on the CDN) and a silent skip and a missing feature read
     * identically from the sofa. */
    function tryAv01Manifest(dash, capId) {
        var m = Mpd.build(dash, capId || PREFERRED_QN, "av01");
        if (m) { return m; }
        var reps = 0, seg = 0, list = (dash && dash.video) || [];
        for (var i = 0; i < list.length; i++) {
            if (String(list[i].codecs || "").split(".")[0] === "av01") {
                reps++;
                if (list[i].segments) { seg++; }
            }
        }
        log("AV1 档不可用（av01 表示 " + reps + " 个、带段索引 " + seg +
            " 个；0 个是响应没给，非 0 是 isTypeSupported 拒绝或够不到 avc1 基线），跳过");
        return "";
    }

    /* The best tier strictly below `ceiling` that actually has a segment
     * index. The cap rung drops to this: a hardcoded 64 rebuilt the identical
     * manifest on uploads whose ladder already tops out at 64 — one wasted
     * load — and on the video that exposed it, the tier that actually served
     * was 32. */
    function tierBelow(dash, ceiling) {
        var best = 0, list = (dash && dash.video) || [];
        for (var i = 0; i < list.length; i++) {
            var id = list[i].id || 0;
            if (list[i].segments && id < ceiling && id > best) { best = id; }
        }
        return best;
    }

    var badHosts = {};
    /* Which video the blacklist belongs to. reset() must NOT clear it: the
     * in-place restart goes through Player.playDash → reset(), and clearing
     * there wiped the list mid-incident — 19:52 on 2026-08-03 the same cosov
     * had to be re-learned with a fresh 403 on every restart of the same
     * video. The list turns over when the *video* changes, detected from the
     * cid baked into the stream url path. */
    var badHostsScope = "";
    /* Files (representations), same scope and turnover as badHosts. A 403 is
     * usually aimed at one *file*, not one host — 2026-08-06 15:54: a video
     * whose hev1-720p file answered 403 everywhere while its 1080p sibling
     * played fine. Host-level blacklisting cannot express that. */
    var badFiles = {};

    /* Per-video lessons, persisted device-level and expiring. Re-entering a
     * sick video used to re-learn everything from scratch: on 08-09 the same
     * three starved files cost the same watchdog rounds on every entry — 40
     * seconds to a picture the previous entry had already found at av01.
     * The lesson (winning family, bad hosts, bad files, failed route) is
     * keyed by cid and expires after six hours: per-file weather flips
     * between evenings — 08-06 av01 was the disease and H.265 the cure,
     * 08-09 the exact mirror — so yesterday's lesson is not a fact, it is a
     * lie. That TTL is the design, not a nicety. */
    var LESSON_KEY = "bili.lessons.v1";
    var LESSON_TTL = 6 * 3600 * 1000;
    var LESSON_CAP = 100;
    var lessonFamily = "";   /* soft first-choice for the current video */
    var lastSegReq = null;   /* last segment response, measured against itself */
    var lastAskedRange = ""; /* only for responses that carry no content-range */

    /* Counts, not pairs. The question at a stall is whether the player is still
     * asking for bytes, and pairing requests to responses is what this file has
     * already got wrong once today — two counters and two timestamps answer it
     * with nothing to mismatch:
     *
     *   发出 == 回来, 最后一次发出在 12 秒前  → Shaka stopped asking. Nothing is
     *       hanging; the fault is on this side (the buffer logic, the index, the
     *       element) and tearing down to rebuild is the right response.
     *   发出 > 回来, 最后一次回来在 12 秒前   → a request went out and nothing came
     *       back. The connection is hanging, or the CDN is sitting on it — and the
     *       eight-way probe fired in the same breath says which.
     *
     * Those two want opposite fixes (rebuild at once vs back off and wait), and
     * this session has been arguing between them without the one measurement
     * that separates them. */
    var segStarted = 0, segFinished = 0, segLastStart = 0, segLastFinish = 0;

    /* Reset per session, or 「在飞」 is a lie that only ever grows. Every seek and
     * every adaptation switch aborts requests that are already out, and an
     * aborted request increments 发出 and never increments 回来 — so without
     * this, a viewer who scrubs three times gets 「在飞=7」 reported at the next
     * stall with nothing actually in flight, which reads as exactly the
     * diagnosis it is not. Caught in review the same evening the counter was
     * added, and it matters more than usual because this number is the evidence
     * behind the connectionTimeout change: the 08-15 18:31 sample survives it
     * (6→7→7→7 across three rebuilds, not 6→12→18, so those were the same hung
     * requests rather than accumulated debris) but that was luck, not design. */
    function resetSegTraffic() {
        segStarted = 0; segFinished = 0; segLastStart = 0; segLastFinish = 0;
    }

    function segTraffic() {
        var now = new Date().getTime();
        return "分段请求 发出=" + segStarted + " 回来=" + segFinished +
               " 在飞=" + Math.max(0, segStarted - segFinished) +
               " 最后一次发出=" + (segLastStart ? ((now - segLastStart) / 1000).toFixed(1) + "s前" : "无") +
               " 最后一次回来=" + (segLastFinish ? ((now - segLastFinish) / 1000).toFixed(1) + "s前" : "无");
    }

    function readLessons() {
        var now = new Date().getTime(), keep = {}, k;
        try {
            var all = JSON.parse(localStorage.getItem(LESSON_KEY) || "{}");
            for (k in all) {
                if (all[k] && now - (all[k].t || 0) < LESSON_TTL) { keep[k] = all[k]; }
            }
        } catch (e) {}
        return keep;
    }

    function writeLessons(map) {
        var keys = [], k;
        for (k in map) { keys.push(k); }
        keys.sort(function (a, b) { return (map[a].t || 0) - (map[b].t || 0); });
        while (keys.length > LESSON_CAP) { delete map[keys.shift()]; }
        try { localStorage.setItem(LESSON_KEY, JSON.stringify(map)); } catch (e) {}
    }

    function objectKeys(o) { var out = [], k; for (k in o) { out.push(k); } return out; }

    /* Raise the "try the app endpoint's strong token" request, once per video,
     * when a web manifest has met a 403 this video. Returns true if it fired —
     * the caller must then stop (not drop a tier). app.js turns the error into a
     * playurlDashStrong call; its result comes back as a fresh manifest whose
     * `strong` flag stops this from firing again. A strong manifest drops tiers
     * as before.
     *
     * `known403` is the load-failure path passing its own 403 directly:
     * playDashWithShaka's catch never calls noteBadFile, so badFiles stays empty
     * there and the badFiles-only guard was a permanent no-op — which for a
     * reupload that 403s at load time (the headline target) meant the strong
     * token fired only after the whole family+tier ladder had flooded the
     * limiter. Either signal — a recorded bad file, or a 403 in hand — is
     * enough. */
    function offerStrongToken(known403) {
        if (strongEmitted) { return false; }
        if (lastDash && lastDash.strong) { return false; }
        if (!known403 && !objectKeys(badFiles).length) { return false; }
        strongEmitted = true;
        log("web 令牌高档被 403 拒，压档前先试 app 端点强令牌");
        lastDecodeHandled = false;
        emit("error", "web 令牌 403，交给 app 端点强令牌");
        return true;
    }

    function stashLessonFor(scope, patch) {
        if (!scope) { return; }
        var map = readLessons();
        var l = map[scope] || {};
        if (scope === badHostsScope) {
            l.bh = objectKeys(badHosts);
            l.bf = objectKeys(badFiles);
        }
        if (patch && patch.f) { l.f = patch.f; }
        if (patch && patch.r) { l.r = patch.r; }
        l.t = new Date().getTime();
        map[scope] = l;
        writeLessons(map);
    }

    /* Snapshot what the current video has taught us — called from the same
     * places the in-memory maps learn, so store and session cannot drift. */
    function stashLesson(patch) { stashLessonFor(badHostsScope, patch); }

    function hostOf(u) { return String(u || "").split("/")[2] || ""; }

    function scopeOf(dash) {
        var v = dash && dash.video && dash.video[0];
        var u = (v && (v.baseUrl || (v.urls && v.urls[0]))) || "";
        var m = /upgcxcode\/\d+\/\d+\/(\d+)\//.exec(String(u));
        return m ? m[1] : String(u).split("?")[0];
    }

    /* Returns whether this call taught us something new. The immediate-rebuild
     * below keys on that, and nothing else bounds it: the once-per-session
     * flag it used at first was declared inside playDashWithShaka, so every
     * rebuild arrived with a fresh flag and a video whose files 403 on every
     * host rebuilt itself three times a second, forever — a spinner from the
     * sofa, hundreds of identical lines in the collector. */
    function noteBadHost(err) {
        if (!err || err.code !== 1001 || !err.data) { return false; }
        var status = err.data[1];
        if (status !== 403 && status !== 401) { return false; }
        var h = hostOf(err.data[0]);
        if (h && !badHosts[h]) {
            badHosts[h] = true;
            log("镜像 " + h + " 返回 " + status + "，这个视频内不再排在前面");
            stashLesson(null);
            return true;
        }
        return false;
    }

    function fileTokenOf(u) {
        var path = String(u || "").split(/[?#]/)[0];
        var seg = path.split("/").pop();
        return /\.m4s$/.test(seg) ? seg : "";
    }

    /* Whether a file token names one of this manifest's *video* representations.
     *
     * lastSegReq records whichever stream asked last, and audio asks too. On
     * 2026-08-11 20:52 the parse-failure rung took that token at face value and
     * blacklisted the soundtrack: both audio representations were dropped within
     * twenty seconds, the manifest lost its audio, and the attempt still ended in
     * 有声退出 — the rung made the failure worse than the one it was added to
     * fix. Dropping a video tier leaves other tiers; dropping the audio leaves
     * nothing to play. */
    function isVideoToken(dash, tok) {
        var list = (dash && dash.video) || [];
        for (var i = 0; i < list.length; i++) {
            var u = (list[i].urls && list[i].urls[0]) || list[i].baseUrl;
            if (fileTokenOf(u) === tok) { return true; }
        }
        return false;
    }

    /* Same contract as noteBadHost: returns the newly learned file token, or
     * "" — and *newly learned* is what bounds the rebuild below, exactly the
     * lesson the host blacklist paid for. N poisoned files cost at most N
     * rebuilds per video. */
    function noteBadFile(err) {
        if (!err || err.code !== 1001 || !err.data) { return ""; }
        var status = err.data[1];
        if (status !== 403 && status !== 401) { return ""; }
        var tok = fileTokenOf(err.data[0]);
        if (!tok || badFiles[tok]) { return ""; }
        /* Only what dropRep can actually act on. Recording an undroppable token
         * is a silent side effect: the entry does nothing except pollute the
         * lesson and make the next 403 on the same file unrecognisable as new —
         * 2026-08-11 20:52, the last remaining audio file was learned this way
         * and its second 403 fell straight through to the critical-retry exit.
         *
         * Droppable means: a video representation, or an audio representation
         * with a sibling left to carry the sound. The CDN discriminates
         * per-file on audio too (21:07: akam refused 30232 while cosov refused
         * 30280, and 30216 was healthy the whole time) — refusing to ever drop
         * audio just walks the refused file into the same exit via the retry
         * counter. The last audio file standing is the mirror-rotation rung's
         * job — see the caller. */
        if (lastDash && !isVideoToken(lastDash.dash, tok)) {
            var alist = (lastDash.dash && lastDash.dash.audio) || [];
            var mine = false;
            for (var ai = 0; ai < alist.length; ai++) {
                var au = (alist[ai].urls && alist[ai].urls[0]) || alist[ai].baseUrl;
                if (fileTokenOf(au) === tok) { mine = true; break; }
            }
            if (!mine || alist.length < 2) { return ""; }
        }
        badFiles[tok] = new Date().getTime();
        stashLesson(null);
        return tok;
    }

    /* One rotation per audio file per video: enough to reach the other mirror,
     * bounded so two hosts refusing the same file cannot spin a rebuild loop. */
    var audioRotated = {};

    /* Per video: has the "web token 403 → try the app endpoint's strong token"
     * request been raised yet. Raised once, before the first tier drop — the
     * app endpoint mints a token the CDN accepts where the web endpoint's is
     * refused, so restoring 1080p beats degrading to 480p. Reset per video with
     * the rest of the per-video state below. */
    var strongEmitted = false;

    function leadHostOf(dash) {
        var v = dash && dash.video && dash.video[0];
        return hostOf((v && ((v.urls && v.urls[0]) || v.baseUrl)) || "");
    }

    function dropRep(dash, tok) {
        var kinds = ["video", "audio"];
        for (var k = 0; k < kinds.length; k++) {
            var list = (dash && dash[kinds[k]]) || [];
            for (var i = 0; i < list.length; i++) {
                var u = (list[i].urls && list[i].urls[0]) || list[i].baseUrl;
                if (fileTokenOf(u) !== tok) { continue; }
                /* Never empty a list — a manifest with no audio (or video)
                 * cannot be built at all, and the honest exit path is a
                 * better end than 「拼不出播放清单」 on a self-inflicted
                 * wound. */
                if (list.length < 2) { return false; }
                list.splice(i, 1);
                return true;
            }
        }
        return false;
    }

    /* Fresh playurl responses within the same video (deadline expiry, the
     * app-level restart) arrive with the poisoned representations restored;
     * this re-applies what the video already taught us, the way
     * preferGoodHosts does for hosts. */
    var BAD_FILE_TTL = 5 * 60 * 1000;

    function dropKnownBadFiles(dash) {
        /* Expiring, because a 403 from this CDN is the weather of the minute:
         * the same file that refuses everything during a cooldown serves at
         * full speed a few minutes later, and a permanent ban costs a tier for
         * the rest of the video. */
        var now = new Date().getTime();
        for (var tok in badFiles) {
            if (badFiles[tok] !== true && now - badFiles[tok] > BAD_FILE_TTL) {
                delete badFiles[tok];
                continue;
            }
            dropRep(dash, tok);
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

        /* Whatever rung fires next, the screen must say the player is on it.
         * A minute of self-rescue that looks identical to a crash is what got
         * the app force-quit on 08-04 and complained about on 08-09; the log
         * carries the detail, the screen only needs a heartbeat. */
        emit("status", "网络不顺，正在自动重试…");
        incidentAt = now;
        /* Every rescue, whichever ladder runs it. It lived on the watchdog
         * path alone at first and missed the commonest failure of all — the
         * decode error, which this file has claimed for days is a cut
         * connection wearing a mask. That claim has never been measured. A
         * short body here (128KB asked, a fraction returned) is the mask
         * coming off. */
        if (lastSegReq && lastSegReq.want) {
            log("最后一个分段请求 " + lastSegReq.range + " 要 " + lastSegReq.want +
                "B 收到 " + lastSegReq.got + "B" +
                (lastSegReq.got < lastSegReq.want ? "（短了——确实是半截）" : "（完整）"));
        }
        /* Is anyone still asking? Printed at every rescue, because it is the one
         * thing that separates "the wire went quiet" from "we went quiet". */
        log(segTraffic());
        probeStalledStream();
        /* Alongside the probe, and at most once a minute so a ladder storm does
         * not repeat it seven times: the probe says the bytes are reachable,
         * this says over what — and whether the connection the player was using
         * is the same kind of connection the probe just succeeded on. */
        if (now - transportToldAt > 60000) {
            transportToldAt = now;
            tellTransport("卡住时");
            /* The one that settles the argument this session has been having.
             * The claim on the table is that the CDN refuses this client's
             * bursts — single requests pass, streams of them die. If eight at
             * once come back 206 in a hundred milliseconds *while the player is
             * getting nothing*, that claim is dead and the fault is on this side
             * of the wire: a socket hung open, or Shaka not asking. Once per app
             * run, eight kilobytes; the answer is worth more than the bytes. */
            if (!shapeProbedStall) {
                shapeProbedStall = true;
                probeTransportShape("卡住时");
            }
        }

        /* From where the viewer actually got to, not from the original start —
         * this failure arrives mid-playback, and restarting the episode is a
         * worse answer than the stall was. */
        var from = lastTime || lastDash.startMs || 0;
        var at = Math.round(from / 1000);
        var skippedReload = false;
        decodeRecoveries++;
        lastDecodeHandled = true;

        if (decodeRecoveries === 1) {
            /* Once per incident, not per rung: if the rotated-to host also fails
             * decode, the avc1 rung below should keep it in front rather than
             * rotate back onto the host that started the incident. */
            var wasLead = leadHostOf(lastDash.dash);
            var lead = rotateMirrors(lastDash.dash);
            /* This rung repairs a *truncated* stream: a cut connection leaves a
             * hole, the demuxer refuses the next sample, and re-asking — ideally
             * of another host — fills it. It repairs nothing when no byte
             * arrived at all and the rotation had nowhere to go: that is the
             * same file from the same host, asked the same way, and 2026-08-09
             * 20:17 spent twenty seconds proving it (av01 starved, cosov already
             * blacklisted, one host left, reload starved identically). Skip
             * straight to the family below — a different file. */
            if (why === "卡死无进展" && lead === wasLead) {
                log("卡死且没有别的镜像可换，跳过同族重载，直接换编码族");
                decodeRecoveries = 2;
                skippedReload = true;
            } else {
                log("解码失败（" + why + "），从 " + at + "s 用 " + lastDash.family +
                    " 原样重载一次" + (lead ? "，镜像改从 " + lead + " 出发" : ""));
                playDashWithShaka(lastDash.dash, from, true, lastDash.family, lastDash.capId);
                return true;
            }
        }
        /* Before blaming the family: the same *file* failing to parse twice is
         * evidence about that file, not about its codec.
         *
         * 2026-08-11《波士顿法律》: av01 played, then died at the identical byte
         * range (bytes=1530210-1571231, 41022B asked, 41022B received, twice on
         * two different hosts) with CHUNK_DEMUXER_ERROR_APPEND_FAILED. The rung
         * below read that as "av01 is bad" and switched to avc1 — whose every
         * tier was 403 that evening — and then walked the tier ladder down a
         * dead family to 有声退出, four times in a row while the viewer kept
         * pressing play. av01 was the only family the CDN was serving at all.
         *
         * 「族和字节区间是两件事」 is already written in CLAUDE.md from 08-09,
         * and the ladder still had no rung that could act on it. This is it:
         * drop that one representation and rebuild. The remaining tiers of the
         * same family are different files and stay reachable. Bounded the way
         * the 403 blacklist is — a file is learned once, so N poisoned files
         * cost at most N rebuilds. */
        if (lastSegReq && lastSegReq.uri) {
            var badTok2 = fileTokenOf(lastSegReq.uri);
            /* Video only — see isVideoToken for what taking the audio token
             * cost the first evening this rung existed. */
            if (badTok2 && !badFiles[badTok2] &&
                isVideoToken(lastDash.dash, badTok2)) {
                badFiles[badTok2] = new Date().getTime();
                stashLesson(null);
                log("解码失败（" + why + "），文件 " + badTok2 +
                    " 在同一处反复解析失败，剔出清单，从 " + at + "s 重建");
                playDashWithShaka(lastDash.dash, from, true, lastDash.family,
                                  lastDash.capId);
                return true;
            }
        }
        /* Same codec, twice, still refused — now the probe is the suspect after
         * all, and H.264 is one reload away. */
        if (decodeRecoveries === 2 && lastDash.family !== "avc1") {
            /* Two ways to arrive here and they are not the same event: the
             * reload ran and did not help, or it was skipped as futile. A line
             * claiming a reload that never happened is the kind of small lie
             * that costs an hour when the log is read months later. */
            log("解码失败（" + why + "），" + (skippedReload ? "没有镜像可换" : "同族重载没解决") +
                "，从 " + at + "s 退回 avc1");
            playDashWithShaka(lastDash.dash, from, true, "avc1", lastDash.capId);
            return true;
        }
        /* The third 1080p file. hev1 and avc1 dead ≠ 1080p dead: each family
         * is its own file with its own CDN treatment, and the healthy one has
         * been the one we exclude. */
        if (lastDash.family !== "av01" && !triedAv01) {
            triedAv01 = true;
            if (tryAv01Manifest(lastDash.dash, lastDash.capId)) {
                log("解码失败（" + why + "），hev1/avc1 都没走通，从 " + at +
                    "s 换 AV1 的同画质（不同的文件，网页端就靠它）");
                playDashWithShaka(lastDash.dash, from, true, "av01", lastDash.capId);
                return true;
            }
        }
        /* Both codec families dead at this tier is not the end: the tiers are
         * different files, and "drop a tier" is the documented escape that
         * carried P17 through its poisoned region — it just relied on ABR
         * getting lucky. Made an explicit rung 2026-08-03 after a video turned
         * up with hev1-1080p truncating, avc1-1080p answering 403 and the
         * spare host dead: every 1080p route was gone while 720p served.
         *
         * It descends one step at a time and it descends as many times as it
         * has to. It used to fire once and once only — the guard was
         * `!capId`, so the first drop set a cap and shut its own door. 2026-08-09
         * 22:30 是它的账单：BV1hCQsBDEAL 的 720P 和 1080P 被 CDN 全数拒绝（两台
         * 主机、hev1/avc1/av01 三个族无一幸免），梯子压到 720P、发现那里也全死，
         * 于是「所有路都试过，有声退出」—— 而同一台 akam 主机上，这个稿件的
         * 480P 和 360P 当时满速可取（各 131072B / 206，实测）。观众本可以看 480P，
         * 拿到的是一句退出。停下来的条件应该是「下面没有档位了」，不是「已经压过
         * 一次了」。 */
        /* Before dropping a tier, offer the incident to the app endpoint: a web
         * token 403 is what strands the high tiers, and the app endpoint mints a
         * token the CDN accepts. Restoring 1080p beats degrading to 480p, so it
         * goes first — but only for a web manifest that has actually met a 403
         * this video, and only once. A strong manifest that still fails has
         * nothing better to escalate to and drops tiers normally. */
        if (offerStrongToken()) { return true; }
        var capNow = lastDash.capId || tierBelow(lastDash.dash, PREFERRED_QN + 1);
        var below = tierBelow(lastDash.dash, capNow);
        if (below) {
            log("解码失败（" + why + "），换编码也没走通，从 qn" + capNow +
                " 再压到 qn" + below + "，从 " + at + "s 再试");
            playDashWithShaka(lastDash.dash, from, true, null, below);
            return true;
        }
        log("解码失败（" + why + "），已重载 " + decodeRecoveries + " 次仍然失败，交给上层");
        lastDecodeHandled = false;
        return false;
    }

    function playDashWithShaka(dash, startMs, isRetry, prefer, capId) {
        /* Every rung of the recovery ladder funnels back through here with the
         * response it already holds — and a kept response outlives its
         * signatures (`deadline`, about two hours). 2026-08-12 the TV woke
         * from an overnight suspend and the ladder rebuilt a ten-hour-dead
         * manifest nine times across two incidents — avc1, qn64, qn32, qn16,
         * every rung a guaranteed 403 — and the second incident ended in
         * 有声退出, while the one fresh playurl fetched in between played
         * instantly. Expiry is a property of the whole response, not of any
         * tier or family, so no rung can fix it; only a refetch can. A
         * response fetched within the last minute is trusted regardless of
         * the clock comparison — it is the freshest truth available, and that
         * exemption is also what makes a refetch loop impossible even if this
         * TV's clock drifts. */
        var nowMs = new Date().getTime();
        if (dash && dash.deadline &&
                (!dash.fetchedAt || nowMs - dash.fetchedAt > 60000) &&
                nowMs / 1000 > dash.deadline - 300) {
            log("清单已过期（deadline 已过 " +
                Math.max(0, Math.round(nowMs / 1000 - dash.deadline)) +
                "s），拒绝用它重建");
            emit("error", "清单已过期");
            return;
        }
        /* A fresh top-level handoff of a *web* manifest re-arms the
         * strong-token escalation. Spent-once-per-video it locked the door
         * for good: the 00:05 strong rebuild used the flag, the 12:46 兜底
         * fetched a brand-new web manifest, and when cosov refused that one
         * at 12:48 the ladder had nowhere to escalate and ground through six
         * rungs to 有声退出. The flag means "tried for this manifest", and a
         * new web manifest is a new incident. */
        if (!isRetry && dash && !dash.strong) { strongEmitted = false; }
        mode = "mse";
        var gen = ++mseGeneration;
        var retriedLoad = !!isRetry;

        var scope = scopeOf(dash);
        if (scope !== badHostsScope) {
            badHostsScope = scope; badHosts = {}; badFiles = {}; audioRotated = {};
            strongEmitted = false;
            lessonFamily = "";
            var lesson = readLessons()[scope];
            if (lesson) {
                var li;
                for (li = 0; li < (lesson.bh || []).length; li++) { badHosts[lesson.bh[li]] = true; }
                /* Replayed with the lesson's own age, not as `true`.
                 *
                 * `true` means "never expires" to dropKnownBadFiles, so a
                 * bad-file verdict up to six hours old outlived every file
                 * learned in this session — which expires in five minutes,
                 * because a 403 here is the weather of the minute. The two
                 * paths disagreed and the stricter one was the one built on
                 * the older evidence.
                 *
                 * 2026-08-11 20:14 是它的账单：《波士顿法律》20:07 那次失败
                 * （日志正好断着）学到 9 个坏文件，七分钟后回放成永久黑名单，
                 * 把 av01 整族从清单里删空 —— 日志写着「AV1 档不可用（av01
                 * 表示 0 个）」。而同一分钟从开发机逐个探这个稿件的每一份文件：
                 * avc1/hvc1 的 480P 和 360P、av01 的 480P 全部 403，**只有
                 * av01 的 360P 是 206**。教训里「编码从 av01 出发」说对了，
                 * 是这份名单让它没机会兑现，观众拿到的是「所有路都试过」。
                 *
                 * 现在它们按 lesson.t 计龄，过了 BAD_FILE_TTL 在第一次清扫时
                 * 自然消失。六小时的保留期继续为「赢的族」和「渐进式败绩」服务
                 * —— 那两样不是按分钟翻脸的。*/
                var lessonAt = lesson.t || new Date().getTime();
                var freshFiles = 0;
                for (li = 0; li < (lesson.bf || []).length; li++) {
                    badFiles[lesson.bf[li]] = lessonAt;
                    if (new Date().getTime() - lessonAt <= BAD_FILE_TTL) { freshFiles++; }
                }
                lessonFamily = lesson.f || "";
                log("沿用 " + Math.round((new Date().getTime() - (lesson.t || 0)) / 60000) +
                    " 分钟前的教训：" +
                    (lessonFamily ? "编码从 " + lessonFamily + " 出发" : "编码不限") +
                    "，坏主机 " + (lesson.bh || []).length +
                    "，坏文件 " + (lesson.bf || []).length +
                    "（还在保鲜期内的 " + freshFiles + " 个）");
            }
        }
        preferGoodHosts(dash);
        dropKnownBadFiles(dash);
        var manifest = Mpd.build(dash, capId || PREFERRED_QN, prefer, lessonFamily);
        if (!manifest && !prefer) {
            /* The preferred family had nothing usable. H.264 is always there. */
            manifest = Mpd.build(dash, capId || PREFERRED_QN, "avc1");
        }
        if (!manifest && objectKeys(badFiles).length) {
            /* The blacklist ate the manifest. Seven files banned inside one
             * video on 2026-08-09 left nothing to build and the video exited
             * with 「拼不出播放清单」 — the per-file ban repeating, at file
             * scale, the mistake 08-03 taught at mirror scale (rank, do not
             * discard). A tier that 403s is still better than no tier at all,
             * so the ban yields rather than the video. */
            log("坏文件名单把清单掏空了，这次忽略名单重建");
            badFiles = {};
            manifest = Mpd.build(dash, capId || PREFERRED_QN, prefer, lessonFamily) ||
                       Mpd.build(dash, capId || PREFERRED_QN, "avc1");
        }
        if (!manifest) {
            emit("error", "拼不出播放清单（缺少分段索引）");
            return;
        }
        var usedFamily = Mpd.chosen();
        if (usedFamily === "av01") { triedAv01 = true; }
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
        startWatchdog();
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
            /* New manifest, new accounting: unload() aborts whatever the last
             * one had in flight, and those aborts never reach a response
             * filter. Every rebuild rung would otherwise leave its debris in
             * 在飞 and the next stall would read as a hung connection. */
            resetSegTraffic();
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

            /* A refusal from a host we only just blacklisted is worth one
             * immediate rebuild — preferGoodHosts changes the lead. Keyed on
             * *newly learned*, which is what bounds it: with N hosts this can
             * fire N times and then never again, and a video refused on every
             * host falls through to the family ladder below instead of
             * rebuilding in a circle. Ahead of the 3-second retry on purpose:
             * a fresh lead needs no cooldown. */
            if (noteBadHost(e)) {
                log("排头镜像 403 已拉黑，立即换镜像重建清单");
                emit("status", "网络不顺，正在自动重试…");
                incidentAt = new Date().getTime();
                playDashWithShaka(dash, startMs, true, prefer, capId);
                return;
            }

            /* One more go, after a pause, when the failure was the network.
             * Shaka's own retries all happen inside a few seconds; this CDN's
             * refusals outlast that, and a second attempt half a minute later
             * routinely succeeds where the first was turned away. */
            if (e && e.category === 1 && !retriedLoad) {
                retriedLoad = true;
                log("首次加载被拒（" + describeShakaError(e) + "），3 秒后重来一次");
                emit("status", "网络不顺，正在自动重试…");
                setTimeout(function () {
                    if (gen !== mseGeneration) { return; }
                    playDashWithShaka(dash, startMs, true, prefer, capId);
                }, 3000);
                return;
            }

            /* A load 403 is a web-token refusal — go straight to the app
             * endpoint before switching families or dropping tiers, each of
             * which is another burst of refused requests into the limiter that
             * then throttles the strong token's own sidx reads. After the one
             * cooldown retry above, this is the earliest honest point. */
            var is403Load = !!(e && e.code === 1001 && e.data &&
                               (e.data[1] === 403 || e.data[1] === 401));
            if (offerStrongToken(is403Load)) { return; }

            /* Anything that is not the network, on a stream this set said it
             * could decode, is the set having been wrong — and a 401/403 counts
             * too, despite being category 1: the CDN discriminates per *file*,
             * a family's files can be refused on every host while another
             * family's serve (both directions seen on 2026-08-03, one video
             * each way), and once the host list is exhausted changing family
             * is the only move that changes the file being asked for. */
            if (usedFamily && usedFamily !== "avc1" &&
                    (!e || e.category !== 1 ||
                     (e.code === 1001 && e.data &&
                      (e.data[1] === 403 || e.data[1] === 401)))) {
                log("走 " + usedFamily + " 时失败（" + describeShakaError(e) + "），退回 avc1");
                playDashWithShaka(dash, startMs, retriedLoad, "avc1", capId);
                return;
            }

            /* Same tier, third file: the CDN treats each codec's file on its
             * own terms, and av01 has been the healthy one while both others
             * starved. Try it before surrendering resolution. */
            if (usedFamily !== "av01" && !triedAv01) {
                triedAv01 = true;
                if (tryAv01Manifest(dash, capId)) {
                    log("加载连续被拒（" + describeShakaError(e) + "），换 AV1 的同画质再试");
                    playDashWithShaka(dash, startMs, true, "av01", capId);
                    return;
                }
            }
            /* The top tier can be refused while lower tiers serve — the tiers
             * are different files, and a 403 on one says nothing about the
             * next. Keep stepping down for as long as there is a step: this is
             * the exit tonight's 有声退出 came out of, already capped at 720P and
             * refused there, with 480P serving all along. */
            var capNow2 = capId || tierBelow(dash, PREFERRED_QN + 1);
            var below2 = tierBelow(dash, capNow2);
            if (below2) {
                log("加载连续被拒（" + describeShakaError(e) + "），从 qn" + capNow2 +
                    " 再压到 qn" + below2 + " 试一次");
                playDashWithShaka(dash, startMs, true, prefer, below2);
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
                   " hdnts=" + (seen.hdnts ? "有" : "无") +
                   " buvid=" + (seen.buvid ? "有" : "空");
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
                    /* CDN refusals carry a whole HTML error page here, newlines
                     * included — printed raw, its tail lands in the collector as
                     * orphan lines with no timestamp (the untimestamped
                     * 「An error occur…」 lines of 08-06). One report, one line. */
                    part = String(part).replace(/\s+/g, " ");
                    /* A stream url is 800 characters of which about ten matter.
                     * Truncating it hid exactly the ten — three rounds of
                     * "why does the television get 403 where a browser gets
                     * 206" went unanswered because the parameters that differ
                     * were past the cut. */
                    if (part.indexOf("http") === 0 && part.indexOf("upgcxcode") > 0) {
                        part = summariseStreamUrl(part);
                    } else if (part.length > 400) {
                        /* Was 60 characters, which is how
                         * `CHUNK_DEMUXER_ERROR_APPEND_FAILED: RunSegmentParserLoop:
                         * str…(127 chars)` reached the collector all evening —
                         * the tail it cut carries the data size, the one number
                         * that says whether the segment arrived truncated. These
                         * strings are bounded (a few hundred characters); the
                         * 800-character monster this rule was written for is a
                         * stream url, and that goes through summariseStreamUrl
                         * above. */
                        part = part.slice(0, 400) + "…(" + part.length + " chars)";
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

        /* The real playhead, in ms — video.currentTime, and what seeks write.
         * app.js's own lastKnownPosition freezes at 0 through a stall (no
         * timeupdate fires), so the strong-token rebuild must ask here for where
         * the viewer actually is, not there. When lastTime itself has been
         * zeroed by rebuild churn, lastDash.startMs carries where the ladder
         * was rebuilding *from* — which is where the viewer is; reset() clears
         * lastDash, so a stopped player still answers 0. */
        position: function () {
            /* Not `lastTime || …` — see haveTime. A zero somebody asked for is
             * a position; a zero nobody has written is not. */
            if (haveTime) { return lastTime; }
            return (lastDash && lastDash.startMs) || 0;
        },
        /* Whether the number above means anything. Callers that would otherwise
         * write `Player.position() || somethingElse` need this: that `||` is
         * the same falsy-zero trap one level up, and fixing only position()
         * would have changed nothing at all. */
        hasPosition: function () { return haveTime; },

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

        /* Route lessons live in the same per-video store as codec lessons but
         * are written by app.js, which owns routing: 「渐进式打平胜出」 sent
         * 平凡之路 to AVPlay for seven doomed seconds on every entry, because
         * the tie-break had no memory of the last defeat. */
        routeHint: function (cid) {
            var l = readLessons()[String(cid)];
            return (l && l.r) || "";
        },
        learnRoute: function (cid, route) {
            stashLessonFor(String(cid), { r: route });
        },

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
            userPaused = true;
            if (mode === "avplay") { try { webapis.avplay.pause(); } catch (e) {} }
            else if (mode === "mse") { el("html5-video").pause(); }
        },
        resume: function () {
            userPaused = false;
            watchdogSeen = -1;
            watchdogPos = -1;
            watchdogAt = new Date().getTime();
            if (mode === "avplay") { try { webapis.avplay.play(); } catch (e) {} }
            else if (mode === "mse") { el("html5-video").play(); }
        },
        /* What the viewer pressed, as opposed to what the element reports — the
         * element is paused for the whole of a load, and code that hides chrome
         * or watches for stalls has to tell those two apart. */
        userPaused: function () { return userPaused; },
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
            haveTime = true;
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
            haveTime = true;
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
