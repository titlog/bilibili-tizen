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

    function el(id) { return document.getElementById(id); }

    function emit(kind, data) { onEvent(kind, data); }

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
        try { webapis.avplay.stop(); } catch (e) {}
        try { webapis.avplay.close(); } catch (e) {}
        if (obj && obj.parentNode) { obj.parentNode.removeChild(obj); }
        obj = null;
        var v = el("html5-video");
        try { v.pause(); v.removeAttribute("src"); v.load(); } catch (e) {}
        v.className = "hidden";
        if (ms) { try { URL.revokeObjectURL(v.src); } catch (e) {} ms = null; }
        mode = null;
        duration = 0;
        lastTime = 0;
    }

    /* ---------------- AVPlay ---------------- */

    function playAvplay(url, startMs) {
        mode = "avplay";
        ensureObject();
        try { webapis.avplay.close(); } catch (e) {}
        try { webapis.avplay.open(url); }
        catch (e) { emit("error", "open failed: " + e.message); return; }

        try { webapis.avplay.setDisplayMethod("PLAYER_DISPLAY_MODE_LETTER_BOX"); } catch (e) {}
        webapis.avplay.setDisplayRect(0, 0, 1920, 1080);
        try { webapis.avplay.setStreamingProperty("USER_AGENT", USER_AGENT); } catch (e) {}

        webapis.avplay.setListener({
            onbufferingstart: function () { emit("buffering", true); },
            onbufferingcomplete: function () { emit("buffering", false); },
            oncurrentplaytime: function (ms2) {
                lastTime = ms2;
                emit("time", { position: ms2, duration: duration });
            },
            onstreamcompleted: function () { emit("ended"); },
            onerror: function (err) { emit("error", String(err)); }
        });

        webapis.avplay.prepareAsync(function () {
            try { duration = webapis.avplay.getDuration(); } catch (e) { duration = 0; }
            if (startMs) { try { webapis.avplay.seekTo(startMs); } catch (e) {} }
            webapis.avplay.play();
            emit("playing", { duration: duration });
        }, function (err) {
            emit("error", "prepare failed: " + err);
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
            else { onFail("HTTP " + xhr.status); }
        };
        xhr.onerror = function () { onFail("network error"); };
        xhr.ontimeout = function () { onFail("timeout"); };
        xhr.send();
    }

    /* Fragmented MP4 is a run of moof+mdat boxes after the init segment, so
     * sequential byte ranges can be appended as-is — no sidx parsing needed to
     * get playback going, and memory stays bounded on long videos. */
    function playMse(dash, startMs) {
        mode = "mse";
        var video = (dash.video || []).filter(function (s) {
            return s.codecs.indexOf("avc1") === 0;
        })[0] || (dash.video || [])[0];
        var audio = (dash.audio || [])[0];
        if (!video || !audio) { emit("error", "no usable dash pair"); return; }

        var vType = 'video/mp4; codecs="' + video.codecs + '"';
        var aType = 'audio/mp4; codecs="' + audio.codecs + '"';
        if (!window.MediaSource || !MediaSource.isTypeSupported(vType) ||
            !MediaSource.isTypeSupported(aType)) {
            emit("error", "MSE cannot handle " + video.codecs + " / " + audio.codecs);
            return;
        }

        var v = el("html5-video");
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

            var CHUNK = 4 * 1024 * 1024;
            var streams = [
                { rep: video, sb: vb, at: 0, done: false },
                { rep: audio, sb: ab, at: 0, done: false }
            ];

            function pump(s) {
                if (s.done || s.sb.updating) { return; }
                /* Stay a couple of chunks ahead of the playhead, no further. */
                var buffered = 0;
                try {
                    if (s.sb.buffered.length) {
                        buffered = s.sb.buffered.end(s.sb.buffered.length - 1);
                    }
                } catch (e) {}
                if (buffered - (v.currentTime || 0) > 60) { return; }

                var to = s.at + CHUNK - 1;
                fetchRange(s.rep.baseUrl, s.at, to, function (buf) {
                    if (!buf || buf.byteLength === 0) { s.done = true; return; }
                    try { s.sb.appendBuffer(buf); } catch (e) {
                        if (e.name === "QuotaExceededError") { return; }
                        emit("error", "append: " + e.message);
                        return;
                    }
                    s.at += buf.byteLength;
                    if (buf.byteLength < CHUNK) { s.done = true; }
                }, function (why) { emit("error", "fetch: " + why); });
            }

            var timer = setInterval(function () {
                if (mode !== "mse") { clearInterval(timer); return; }
                for (var i = 0; i < streams.length; i++) { pump(streams[i]); }
                if (streams[0].done && streams[1].done &&
                    !streams[0].sb.updating && !streams[1].sb.updating) {
                    try { if (ms.readyState === "open") { ms.endOfStream(); } } catch (e) {}
                    clearInterval(timer);
                }
            }, 250);

            for (var i = 0; i < streams.length; i++) { pump(streams[i]); }
        });

        v.addEventListener("timeupdate", function () {
            lastTime = v.currentTime * 1000;
            emit("time", { position: lastTime, duration: duration });
        });
        v.addEventListener("playing", function () { emit("playing", { duration: duration }); });
        v.addEventListener("waiting", function () { emit("buffering", true); });
        v.addEventListener("canplay", function () { emit("buffering", false); });
        v.addEventListener("ended", function () { emit("ended"); });
        v.addEventListener("error", function () {
            emit("error", "video element error " + (v.error ? v.error.code : "?"));
        });

        if (startMs) { v.currentTime = startMs / 1000; }
        v.play().catch(function (e) { emit("error", "play(): " + e.message); });
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
            else if (mode === "mse") { el("html5-video").currentTime = target / 1000; }
            lastTime = target;
            emit("time", { position: target, duration: duration });
        },
        stop: reset,
        mode: function () { return mode; }
    };
})();
