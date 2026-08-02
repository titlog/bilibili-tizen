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
    var mseGeneration = 0;   /* invalidates in-flight appends after a reset */
    var avGeneration = 0;    /* same, for the avplay singleton's listener */
    var mseSeek = null;      /* set while an MSE session is live */

    function el(id) { return document.getElementById(id); }

    function emit(kind, data) { onEvent(kind, data); }

    function log(msg) { onEvent("log", msg); }

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
            if (mode === "mse") { emit("playing", { duration: duration }); }
        });
        v.addEventListener("waiting", function () {
            if (mode === "mse") { emit("buffering", true); }
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
        mseSeek = null;
        try { webapis.avplay.stop(); } catch (e) {}
        try { webapis.avplay.close(); } catch (e) {}
        if (obj && obj.parentNode) { obj.parentNode.removeChild(obj); }
        obj = null;
        var v = el("html5-video");
        /* Revoke first: removeAttribute empties v.src, and revoking "" leaks
         * the blob for the lifetime of the app. */
        if (ms) { try { URL.revokeObjectURL(v.src); } catch (e) {} ms = null; }
        try { v.pause(); v.removeAttribute("src"); v.load(); } catch (e) {}
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
            emit("playing", { duration: duration });
        }, function (err) {
            if (live()) { emit("error", "prepare failed: " + err); }
        });
    }

    /* ---------------- MSE ---------------- */

    function fetchRange(url, from, to, onOk, onFail) {
        var xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.responseType = "arraybuffer";
        if (from !== null) { xhr.setRequestHeader("Range", "bytes=" + from + "-" + to); }
        xhr.timeout = 30000;
        xhr.onload = function () {
            if (xhr.status === 200 || xhr.status === 206) { onOk(xhr.response); }
            /* Reading sequentially, the range past the last byte answers 416.
             * That is the end of the file, not a failure. */
            else if (xhr.status === 416) { onOk(null); }
            else { onFail("HTTP " + xhr.status); }
        };
        xhr.onerror = function () { onFail("network error"); };
        xhr.ontimeout = function () { onFail("timeout"); };
        xhr.send();
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

    function playMse(dash, startMs) {
        mode = "mse";
        /* Minted here rather than inside sourceopen: a late-opening MediaSource
         * would otherwise bump the counter after a newer session had captured
         * it, killing the live pump and reviving the dead one. */
        var gen = ++mseGeneration;
        var video = pickDashVideo(dash);
        /* dash.audio comes back unsorted, and on some videos the first entry is
         * a tier the account cannot fetch — every mirror then answers 403 and
         * the video buffers fine while the sound never arrives. Prefer a modest
         * standard track, and keep the rest as fallbacks. */
        var audioReps = (dash.audio || []).slice().sort(function (a, b) {
            return (a.bandwidth || 0) - (b.bandwidth || 0);
        });
        var audio = audioReps[0];
        if (!video || !audio) { emit("error", "no usable dash pair"); return; }

        var vType = 'video/mp4; codecs="' + video.codecs + '"';
        var aType = 'audio/mp4; codecs="' + audio.codecs + '"';
        log("dash id=" + video.id + " " + video.codecs + " " + video.width + "x" + video.height +
            " audio=" + audio.codecs +
            " mirrors=" + ((video.urls || []).length || 1));
        if (!window.MediaSource) { emit("error", "MediaSource unavailable"); return; }
        if (!MediaSource.isTypeSupported(vType)) { emit("error", "codec unsupported: " + vType); return; }
        if (!MediaSource.isTypeSupported(aType)) { emit("error", "codec unsupported: " + aType); return; }

        var v = el("html5-video");
        bindMediaElement();
        v.className = "";
        ms = new MediaSource();
        v.src = URL.createObjectURL(ms);
        duration = (dash.duration || 0) * 1000;

        ms.addEventListener("sourceopen", function () {
            var vb, ab;
            try {
                vb = ms.addSourceBuffer(vType);
                ab = ms.addSourceBuffer(aType);
            } catch (e) { emit("error", "addSourceBuffer: " + e.message); return; }

            /* A flat chunk size is wrong for both streams at once: 4 MB is three
             * minutes of audio but thirteen seconds of 1080p video, so the audio
             * raced far ahead while the picture — the thing playback waits on —
             * trickled in. Size each request by its own bitrate instead, and ask
             * for a short one first so something is playable almost at once. */
            function chunkFor(rep, seconds) {
                var bps = (rep.bandwidth || 1200000) / 8;
                return Math.max(192 * 1024, Math.round(bps * seconds));
            }
            var FIRST_SECONDS = 5, NEXT_SECONDS = 20;

            var streams = [
                { rep: video, sb: vb, at: 0, done: false, inflight: 0, host: 0,
                  kind: "video", pending: {}, appendAt: 0 },
                { rep: audio, sb: ab, at: 0, done: false, inflight: 0, host: 0,
                  kind: "audio", pending: {}, appendAt: 0 }
            ];
            /* Waiting for QuotaExceededError is too late on a feature-length
             * video; drop what is well behind the playhead as we go. */
            function evict(s) {
                if (gen !== mseGeneration || !ms) { return; }
                if (s.sb.updating || ms.readyState !== "open") { return; }
                /* Deep enough that the usual short rewinds stay seekable. */
                var keepFrom = (v.currentTime || 0) - 120;
                if (keepFrom <= 0) { return; }
                try {
                    if (s.sb.buffered.length && s.sb.buffered.start(0) < keepFrom - 30) {
                        s.sb.remove(0, keepFrom);
                    }
                } catch (e) {}
            }

            function drain(s) {
                if (gen !== mseGeneration || !ms || ms.readyState !== "open") { return; }
                if (s.sb.updating) { return; }   /* updateend calls back in */
                var buf = s.pending[s.appendAt];
                if (!buf) { return; }
                delete s.pending[s.appendAt];
                try { s.sb.appendBuffer(buf); } catch (e) {
                    if (e.name === "QuotaExceededError") {
                        /* Put it back and make room; the next tick retries. */
                        s.pending[s.appendAt] = buf;
                        try {
                            var keep = Math.max(0, (v.currentTime || 0) - 20);
                            if (keep > 0 && !s.sb.updating) { s.sb.remove(0, keep); }
                        } catch (e2) {}
                        return;
                    }
                    emit("error", "append: " + e.message);
                    return;
                }
                s.appendAt += buf.byteLength;
                if (s.eof && s.appendAt >= s.eof) { s.done = true; }
            }

            function pump(s) {
                /* inflight matters as much as updating: a 4 MB fetch outlives
                 * several ticks of the timer, and without this the same range is
                 * requested again and again and appended on top of itself. */
                /* Two requests in flight keeps the link busy while one is being
                 * appended; more than that only queues behind the first. */
                if (s.done || s.inflight >= 2 || s.sb.updating) { return; }
                if (gen !== mseGeneration || !ms || ms.readyState !== "open") { return; }
                /* Stay a couple of chunks ahead of the playhead, no further. */
                var buffered = 0;
                try {
                    if (s.sb.buffered.length) {
                        buffered = s.sb.buffered.end(s.sb.buffered.length - 1);
                    }
                } catch (e) {}
                if (buffered - (v.currentTime || 0) > 60) { return; }

                var want = chunkFor(s.rep, s.at === 0 ? FIRST_SECONDS : NEXT_SECONDS);
                var to = s.at + want - 1;
                s.inflight++;
                var urls = s.rep.urls || [s.rep.baseUrl];
                var from = s.at;
                s.at = to + 1;   /* claim the range so the second request follows it */
                fetchRange(urls[s.host || 0], from, to, function (buf) {
                    s.inflight--;
                    if (gen !== mseGeneration || !ms || ms.readyState !== "open") { return; }
                    if (!buf || buf.byteLength === 0) { s.done = true; return; }
                    s.misses = 0;                 /* this mirror is working again */
                    if (buf.byteLength < want) { s.eof = from + buf.byteLength; }
                    /* Held until its turn: two requests are in flight to keep the
                     * link busy, but a fragmented MP4 is a sequential byte
                     * stream, and appending the second range before the first
                     * hands the parser garbage. */
                    s.pending[from] = buf;
                    drain(s);
                }, function (why) {
                    s.inflight--;
                    s.at = from;                  /* nothing arrived; still owed */
                    if (gen !== mseGeneration) { return; }

                    s.misses = (s.misses || 0) + 1;
                    if (s.misses < 2) { return; }
                    s.misses = 0;

                    if ((s.host || 0) + 1 < urls.length) {
                        s.host = s.host + 1;
                        log("mirror " + s.host + " for " + s.kind + " after " + why);
                        return;
                    }

                    /* Out of mirrors. Cycling them again is pointless when the
                     * refusal is about the track itself, so move to the next
                     * representation before giving up — some videos list an
                     * audio tier this account cannot fetch, and the picture then
                     * buffers happily while the sound never arrives. */
                    if (s.kind === "audio" && audioReps.length > (s.repIdx || 0) + 1) {
                        s.repIdx = (s.repIdx || 0) + 1;
                        s.rep = audioReps[s.repIdx];
                        s.host = 0; s.at = 0; s.appendAt = 0;
                        s.pending = {}; s.done = false; s.eof = 0;
                        log("audio track " + s.rep.id + " after " + why);
                        return;
                    }
                    emit("error", "fetch: " + why + "（" + s.kind + " 所有镜像与音轨均被拒）");
                });
            }

            /* Seeking is limited to what is already buffered. Estimating a byte
             * offset from the average bitrate lands mid-box, and appending
             * there hands the parser a malformed stream — the picture dies and
             * the whole video restarts in a lower quality. Refusing the jump is
             * the lesser evil until the sidx is parsed properly. */
            mseSeek = function (seconds) {
                for (var i = 0; i < streams.length; i++) {
                    var sb = streams[i].sb;
                    var inside = false;
                    try {
                        for (var b = 0; b < sb.buffered.length; b++) {
                            if (seconds >= sb.buffered.start(b) &&
                                seconds <= sb.buffered.end(b)) { inside = true; }
                        }
                    } catch (e) {}
                    if (!inside) { return false; }
                }
                return true;
            };

            for (var d0 = 0; d0 < streams.length; d0++) {
                (function (st) {
                    st.sb.addEventListener("updateend", function () { drain(st); });
                })(streams[d0]);
            }

            var timer = setInterval(function () {
                if (mode !== "mse" || gen !== mseGeneration) { clearInterval(timer); return; }
                for (var i = 0; i < streams.length; i++) { evict(streams[i]); }
                for (var i = 0; i < streams.length; i++) { drain(streams[i]); }
                for (var i = 0; i < streams.length; i++) { pump(streams[i]); }
                if (streams[0].done && streams[1].done &&
                    !streams[0].inflight && !streams[1].inflight &&
                    !streams[0].sb.updating && !streams[1].sb.updating) {
                    try { if (ms.readyState === "open") { ms.endOfStream(); } } catch (e) {}
                    clearInterval(timer);
                }
            }, 250);

            for (var i = 0; i < streams.length; i++) { pump(streams[i]); }

            /* If nothing is buffered after a reasonable wait, say so instead of
             * spinning: a silent stall was indistinguishable from a slow link. */
            setTimeout(function () {
                if (gen !== mseGeneration) { return; }
                var vb2 = 0, ab2 = 0;
                try { vb2 = vb.buffered.length ? vb.buffered.end(vb.buffered.length - 1) : 0; } catch (e) {}
                try { ab2 = ab.buffered.length ? ab.buffered.end(ab.buffered.length - 1) : 0; } catch (e) {}
                log("dash after 12s: video buffered " + vb2.toFixed(1) + "s, audio " + ab2.toFixed(1) +
                    "s, bytes v=" + streams[0].at + " a=" + streams[1].at +
                    ", readyState=" + v.readyState);
                if (vb2 === 0 && ab2 === 0) { emit("error", "dash 无法缓冲任何数据"); }
            }, 12000);
        });

        if (startMs) { v.currentTime = startMs / 1000; }
        v.play().catch(function (e) {
            /* Backing out mid-start rejects the promise; that is a race being
             * resolved correctly, not a playback failure. */
            if (gen !== mseGeneration) { return; }
            if (/interrupted|aborted/i.test(e.message || "")) { return; }
            emit("error", "play(): " + e.message);
        });
    }

    return {
        on: function (fn) { onEvent = fn; },

        playProgressive: function (url, startMs) { reset(); playAvplay(url, startMs); },
        playDash: function (dash, startMs) { reset(); playMse(dash, startMs); },

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
        seekBy: function (deltaMs) {
            var target = Math.max(0, lastTime + deltaMs);
            if (duration) { target = Math.min(target, duration - 2000); }
            if (mode === "avplay") { try { webapis.avplay.seekTo(target); } catch (e) {} }
            else if (mode === "mse") {
                if (mseSeek && !mseSeek(target / 1000)) {
                    emit("seek-refused");
                    return;
                }
                el("html5-video").currentTime = target / 1000;
            }
            lastTime = target;
            emit("time", { position: target, duration: duration });
        },
        /* Absolute seek, for the scrub bar. seekBy stays for the +/-10 s keys. */
        seekTo: function (ms) {
            var target = Math.max(0, ms);
            if (duration) { target = Math.min(target, duration - 2000); }
            if (mode === "avplay") { try { webapis.avplay.seekTo(target); } catch (e) {} }
            else if (mode === "mse") {
                if (mseSeek && !mseSeek(target / 1000)) { emit("seek-refused"); return; }
                el("html5-video").currentTime = target / 1000;
            }
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
