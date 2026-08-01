/* BiliSpike — answers one question: can a Tizen app play a bilibili CDN
 * stream without being able to set a Referer header?
 *
 * Three probes, in order of how much they tell you:
 *   01  XHR range request      -> is the URL reachable at all, header-free?
 *   02  AVPlay                 -> does the path a real client would use work?
 *   03  HTML5 <video>          -> control group; WebKit sends its own Referer
 *
 * The interesting outcome is 01+02 pass, 03 fails. That means AVPlay sends
 * no Referer, the CDN is fine with that, and the whole project is unblocked.
 */

(function () {
    "use strict";

    var results = { 1: null, 2: null, 3: null, 4: null, 5: null };
    var TEST_COUNT = 5;
    var avplayObj = null;
    var playTimer = null;
    var busy = false;

    /* Smart Remotes have no number pad and only virtual colour keys, so the
     * D-pad is the primary control. 0 = run all, 1..3 = individual tests. */
    var focusIdx = 0;

    /* ---------------- logging ---------------- */

    var logEl = document.getElementById("log");
    var lines = [];

    function log(msg, cls) {
        var d = new Date();
        var t = ("0" + d.getHours()).slice(-2) + ":" +
                ("0" + d.getMinutes()).slice(-2) + ":" +
                ("0" + d.getSeconds()).slice(-2);
        lines.push('<div><span class="t">' + t + '</span>' +
                   '<span class="' + (cls || "") + '">' + msg + "</span></div>");
        if (lines.length > 6) { lines.shift(); }
        logEl.innerHTML = lines.join("");
        if (window.console) { console.log("[spike] " + msg); }
        report("log", { msg: msg });
    }

    /* ---------------- status painting ---------------- */

    function setStatus(n, state, chipText, detail) {
        var row  = document.getElementById("test-" + n);
        var chip = document.getElementById("chip-" + n);
        row.className  = "test " + (state || "");
        chip.className = "chip " + (state || "");
        chip.textContent = chipText;
        if (detail !== undefined) {
            document.getElementById("detail-" + n).innerHTML = detail;
        }
        if (state === "pass" || state === "fail") {
            report("test" + n, { chip: chipText, detail: String(detail || "") });
        }
    }

    function setVerdict(cls, text) {
        var v = document.getElementById("verdict");
        v.className = "verdict " + cls;
        v.textContent = text;
        if (cls !== "running") { report("verdict", text); }
    }

    function judge() {
        var a = results[1], b = results[2], c = results[3];
        /* Once the DASH pair has answered it outranks the progressive result:
         * it is the path a real client actually takes. */
        if (results[5] === true && results[4] === true) {
            setVerdict("good", "DASH plays and the API answers on device. No backend, no proxy — build it.");
            return;
        }
        if (results[5] === false) {
            setVerdict("bad", results[4] === false
                ? "API unreachable from the TV. The client would need a backend."
                : "Progressive plays but DASH does not. Ship progressive, or mux server-side.");
            return;
        }
        if (b === true) {
            if (c === false) {
                setVerdict("good", "AVPlay plays, video tag does not. Referer is not a blocker — build it.");
            } else {
                setVerdict("good", "AVPlay plays. Nothing is blocking you.");
            }
        } else if (b === false) {
            if (a === true) {
                setVerdict("bad", "URL is reachable but AVPlay refuses it. Suspect codec or container, not Referer.");
            } else {
                setVerdict("bad", "CDN rejects the request. You need a LAN proxy that adds a Referer.");
            }
        } else if (a === false) {
            setVerdict("bad", "CDN rejected a plain range request. Check the url has not expired.");
        }
    }

    /* ---------------- dev reporting ---------------- */

    /* dlog is closed on retail sets, so the run posts itself to the dev machine
     * instead. Fire and forget: a missing collector must never affect a test. */
    function report(event, payload) {
        if (!REPORT_TO) { return; }
        try {
            var xhr = new XMLHttpRequest();
            xhr.open("POST", REPORT_TO, true);
            xhr.setRequestHeader("Content-Type", "text/plain");
            xhr.send(JSON.stringify({
                event: event,
                results: results,
                detail: payload || null,
                log: lines.join("").replace(/<[^>]+>/g, " "),
                at: new Date().toISOString()
            }));
        } catch (e) { /* never let reporting break a run */ }
    }

    function haveUrl() {
        if (!VIDEO_URL) {
            document.getElementById("nourl").className = "nourl";
            log("VIDEO_URL is empty — nothing to test", "err");
            return false;
        }
        return true;
    }

    /* ---------------- test 01: raw range request ---------------- */

    function testFetch() {
        if (!haveUrl() || busy) { return; }
        setStatus(1, "running", "RUNNING", "&mdash;");
        log("01 range request, no Referer");

        var xhr = new XMLHttpRequest();
        var done = false;

        xhr.open("GET", VIDEO_URL, true);
        xhr.setRequestHeader("Range", "bytes=0-1023");

        /* Referer is a forbidden header name in WebKit. Try anyway and report
         * what happens — if it ever stops throwing, that is worth knowing. */
        try {
            xhr.setRequestHeader("Referer", "https://www.bilibili.com");
            log("Referer header accepted by XHR (unexpected)", "ok");
        } catch (e) {
            log("Referer blocked by XHR, as expected");
        }

        xhr.timeout = 15000;

        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || done) { return; }
            done = true;
            var s = xhr.status;
            var ok = (s === 200 || s === 206);
            results[1] = ok;
            setStatus(1, ok ? "pass" : "fail", "HTTP " + s,
                      ok ? "Reachable with no Referer. Range honoured: " +
                           (xhr.getResponseHeader("Content-Range") || "n/a")
                         : "CDN returned " + s + ". A Referer is very likely required.");
            log("01 finished with status " + s, ok ? "ok" : "err");
            judge();
        };

        xhr.ontimeout = function () {
            if (done) { return; }
            done = true;
            results[1] = false;
            setStatus(1, "fail", "TIMEOUT", "No response in 15s. Check the TV's network.");
            log("01 timed out", "err");
            judge();
        };

        xhr.onerror = function () {
            if (done) { return; }
            done = true;
            results[1] = false;
            setStatus(1, "fail", "ERROR", "Transport error. If this says status 0, the " +
                                          "wildcard access rule in config.xml did not apply.");
            log("01 transport error", "err");
            judge();
        };

        xhr.send();
    }

    /* ---------------- test 02: AVPlay ---------------- */

    function ensureAvplayObject() {
        if (avplayObj) { return avplayObj; }
        avplayObj = document.createElement("object");
        avplayObj.type = "application/avplayer";
        avplayObj.style.position = "absolute";
        avplayObj.style.left = "0px";
        avplayObj.style.top = "0px";
        avplayObj.style.width = "1920px";
        avplayObj.style.height = "1080px";
        document.getElementById("stage").appendChild(avplayObj);
        return avplayObj;
    }

    function showUi(show) {
        document.getElementById("ui").className = show ? "" : "playing";
    }

    function stopAvplay() {
        if (playTimer) { clearTimeout(playTimer); playTimer = null; }
        try { webapis.avplay.stop(); } catch (e) {}
        try { webapis.avplay.close(); } catch (e) {}
        showUi(true);
        busy = false;
    }

    function testAvplay() {
        if (!haveUrl() || busy) { return; }
        if (typeof webapis === "undefined" || !webapis.avplay) {
            results[2] = false;
            setStatus(2, "fail", "NO API", "webapis.avplay is undefined. This build is " +
                                           "not running on a Samsung TV.");
            log("02 avplay api missing", "err");
            judge();
            return;
        }

        busy = true;
        setStatus(2, "running", "RUNNING", "&mdash;");
        log("02 opening stream in AVPlay");

        ensureAvplayObject();

        try {
            webapis.avplay.close();
        } catch (e) {}

        try {
            webapis.avplay.open(VIDEO_URL);
        } catch (e) {
            results[2] = false;
            setStatus(2, "fail", "OPEN FAIL", "open() threw: " + e.message);
            log("02 open threw: " + e.message, "err");
            busy = false;
            judge();
            return;
        }

        webapis.avplay.setDisplayRect(0, 0, 1920, 1080);

        /* setStreamingProperty is only legal in IDLE state, i.e. after open()
         * and before prepare(). */
        if (COOKIE) {
            try {
                webapis.avplay.setStreamingProperty("COOKIE", COOKIE);
                log("cookie applied");
            } catch (e) { log("cookie rejected: " + e.message, "err"); }
        }
        if (USER_AGENT) {
            try {
                webapis.avplay.setStreamingProperty("USER_AGENT", USER_AGENT);
                log("user agent applied");
            } catch (e) { log("user agent rejected: " + e.message, "err"); }
        }

        webapis.avplay.setListener({
            onbufferingstart: function () { log("buffering"); },
            onbufferingcomplete: function () { log("buffering complete", "ok"); },
            onstreamcompleted: function () {
                log("stream completed");
                stopAvplay();
            },
            onerror: function (err) {
                results[2] = false;
                setStatus(2, "fail", "ERROR", "AVPlay error: " + err);
                log("02 avplay error: " + err, "err");
                stopAvplay();
                judge();
            },
            oncurrentplaytime: function (ms) {
                if (ms > 0 && results[2] !== true) {
                    results[2] = true;
                    log("frames are decoding at " + ms + "ms", "ok");
                }
            }
        });

        webapis.avplay.prepareAsync(
            function () {
                log("prepared, starting playback", "ok");
                showUi(false);
                webapis.avplay.play();

                playTimer = setTimeout(function () {
                    var info = "&mdash;";
                    try {
                        var w = webapis.avplay.getCurrentStreamInfo();
                        if (w && w.length) {
                            info = "Streams: " + w.map(function (s) {
                                return s.type + " " + (s.extra_info || "");
                            }).join(" | ");
                        }
                    } catch (e) {}
                    stopAvplay();
                    if (results[2] !== true) { results[2] = false; }
                    setStatus(2, results[2] ? "pass" : "fail",
                              results[2] ? "PLAYING" : "NO FRAMES", info);
                    log("02 finished", results[2] ? "ok" : "err");
                    judge();
                }, PLAY_SECONDS * 1000);
            },
            function (err) {
                results[2] = false;
                var msg = String(err);
                var hint = msg.indexOf("CONNECTION") >= 0
                    ? "Connection failed — this is what a 403 looks like from AVPlay."
                    : "prepareAsync failed: " + msg;
                setStatus(2, "fail", "PREPARE FAIL", hint);
                log("02 prepare failed: " + msg, "err");
                stopAvplay();
                judge();
            }
        );
    }

    /* ---------------- test 03: html5 video (control group) ---------------- */

    function testVideoTag() {
        if (!haveUrl() || busy) { return; }
        busy = true;
        setStatus(3, "running", "RUNNING", "&mdash;");
        log("03 html5 video element");

        var v = document.getElementById("html5");
        var settled = false;

        function settle(ok, chip, detail) {
            if (settled) { return; }
            settled = true;
            v.className = "hidden";
            try { v.pause(); v.removeAttribute("src"); v.load(); } catch (e) {}
            results[3] = ok;
            setStatus(3, ok ? "pass" : "fail", chip, detail);
            log("03 " + chip, ok ? "ok" : "err");
            busy = false;
            judge();
        }

        v.onerror = function () {
            var code = v.error ? v.error.code : "?";
            settle(false, "MEDIA ERR " + code,
                   "WebKit refused the stream. If test 02 passed, this is the " +
                   "Referer difference showing up.");
        };
        v.onplaying = function () {
            settle(true, "PLAYING", "WebKit plays it too — the CDN is not checking Referer at all.");
        };

        setTimeout(function () {
            settle(false, "TIMEOUT", "No playback within 15s.");
        }, 15000);

        v.className = "";
        v.src = VIDEO_URL;
        v.play().catch(function (e) {
            settle(false, "REJECTED", "play() rejected: " + e.message);
        });
    }

    /* ---------------- test 04: the API, from the TV itself ---------------- */

    /* The API applies the same rule as the CDN: it rejects a Referer it does not
     * recognise, but is fine with none. The no-referrer meta tag is what makes
     * this reachable from inside the widget. */
    var PLAYURL = "https://api.bilibili.com/x/player/playurl?bvid=" + DASH_BVID +
                  "&cid=" + DASH_CID + "&qn=32&fnval=16&fnver=0&fourk=1";

    var dashData = null;

    function fetchPlayurl(onOk, onFail) {
        var xhr = new XMLHttpRequest();
        xhr.open("GET", PLAYURL, true);
        xhr.timeout = 15000;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) { return; }
            if (xhr.status !== 200) { onFail("HTTP " + xhr.status); return; }
            var j;
            try { j = JSON.parse(xhr.responseText); }
            catch (e) { onFail("bad JSON"); return; }
            if (j.code !== 0) { onFail("api code " + j.code + " " + (j.message || "")); return; }
            onOk(j.data);
        };
        xhr.ontimeout = function () { onFail("timeout"); };
        xhr.onerror = function () { onFail("transport error"); };
        xhr.send();
    }

    function testApi() {
        if (busy) { return; }
        setStatus(4, "running", "RUNNING", "&mdash;");
        log("04 calling playurl from the TV");

        fetchPlayurl(function (data) {
            dashData = data.dash || null;
            results[4] = true;
            var d = "&mdash;";
            if (dashData) {
                d = "dash: " + (dashData.video || []).length + " video / " +
                    (dashData.audio || []).length + " audio representations, " +
                    dashData.duration + "s";
            } else if (data.durl) {
                d = "no dash in response, got durl instead";
            }
            setStatus(4, "pass", "OK", d);
            log("04 api answered", "ok");
            judge();
        }, function (why) {
            results[4] = false;
            setStatus(4, "fail", "FAIL", "API unreachable: " + why +
                      ". A client would need its own backend.");
            log("04 api failed: " + why, "err");
            judge();
        });
    }

    /* ---------------- test 05: DASH ---------------- */

    function xmlEscape(s) {
        return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    function seg(rep) {
        return rep.SegmentBase || rep.segment_base || {};
    }
    function segIndex(rep) {
        var s = seg(rep); return s.indexRange || s.index_range || "";
    }
    function segInit(rep) {
        var s = seg(rep); return s.Initialization || s.initialization || "";
    }

    /* bilibili hands out DASH representations but no manifest, so build one.
     * Prefer avc1 over hvc1: H.264 is the safe bet across TV model years. */
    function buildMpd(dash) {
        var vids = (dash.video || []).slice().sort(function (a, b) {
            var aAvc = a.codecs.indexOf("avc1") === 0 ? 0 : 1;
            var bAvc = b.codecs.indexOf("avc1") === 0 ? 0 : 1;
            return aAvc - bAvc || a.bandwidth - b.bandwidth;
        });
        var auds = (dash.audio || []).slice().sort(function (a, b) {
            return a.bandwidth - b.bandwidth;
        });
        if (!vids.length || !auds.length) { return null; }
        var v = vids[0], a = auds[0];
        var dur = "PT" + (dash.duration || 0) + "S";

        return '<?xml version="1.0" encoding="utf-8"?>\n' +
          '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" ' +
              'profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" type="static" ' +
              'mediaPresentationDuration="' + dur + '" minBufferTime="PT1.5S">\n' +
          '<Period duration="' + dur + '">\n' +
          '<AdaptationSet mimeType="video/mp4" segmentAlignment="true" startWithSAP="1">\n' +
          '<Representation id="v" codecs="' + v.codecs + '" bandwidth="' + v.bandwidth +
              '" width="' + (v.width || 0) + '" height="' + (v.height || 0) + '">\n' +
          '<BaseURL>' + xmlEscape(v.baseUrl) + '</BaseURL>\n' +
          '<SegmentBase indexRange="' + segIndex(v) + '">' +
          '<Initialization range="' + segInit(v) + '"/></SegmentBase>\n' +
          '</Representation>\n</AdaptationSet>\n' +
          '<AdaptationSet mimeType="audio/mp4" segmentAlignment="true" startWithSAP="1">\n' +
          '<Representation id="a" codecs="' + a.codecs + '" bandwidth="' + a.bandwidth +
              '" audioSamplingRate="44100">\n' +
          '<AudioChannelConfiguration ' +
              'schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/>\n' +
          '<BaseURL>' + xmlEscape(a.baseUrl) + '</BaseURL>\n' +
          '<SegmentBase indexRange="' + segIndex(a) + '">' +
          '<Initialization range="' + segInit(a) + '"/></SegmentBase>\n' +
          '</Representation>\n</AdaptationSet>\n</Period>\n</MPD>\n';
    }

    /* AVPlay takes a URL, not a string, so the manifest has to land on disk
     * first. wgt-private is the app's own writable directory. */
    function writeMpd(mpd, onOk, onFail) {
        log("05 resolving wgt-private");
        if (typeof tizen === "undefined" || !tizen.filesystem) {
            onFail("tizen.filesystem unavailable"); return;
        }
        var settled = false;
        function ok(u) { if (!settled) { settled = true; onOk(u); } }
        function fail(w) { if (!settled) { settled = true; onFail(w); } }

        /* Neither callback is guaranteed to fire on every firmware, so the step
         * gets its own deadline rather than hanging the whole run. */
        setTimeout(function () { fail("filesystem call never came back"); }, 12000);

        try {
            tizen.filesystem.resolve("wgt-private", function (dir) {
                log("05 resolved, writing manifest");
                var name = "stream.mpd", file = null;
                try { file = dir.resolve(name); } catch (e) { file = null; }
                if (file) { try { dir.deleteFile(file.fullPath); } catch (e) {} }
                try { file = dir.createFile(name); }
                catch (e) { fail("createFile: " + e.message); return; }
                file.openStream("w", function (fs) {
                    try {
                        fs.write(mpd);
                        fs.close();
                        log("05 manifest written");
                        ok(file.toURI());
                    } catch (e) { fail("write: " + e.message); }
                }, function (e) { fail("openStream: " + e.message); }, "UTF-8");
            }, function (e) { fail("resolve: " + e.message); }, "rw");
        } catch (e) {
            fail("resolve threw synchronously: " + e.message);
        }
    }

    /* AVPlay refuses a file:// manifest with PLAYER_ERROR_NOT_SUPPORTED_FILE, so
     * the delivery method is itself the thing under test. Each candidate is
     * tried in turn and the first that prepares wins. A data: URI is the only
     * one of these that a shipped app could actually use. */
    var deliveries = [], deliveryIdx = -1, generation = 0;
    var mseResult = null;

    /* setListener registers on the avplay singleton, and swapping the <object>
     * does not detach it. Without a generation token a stale onerror from the
     * previous attempt knocks over the next one, and the attempts race. */
    function nextDelivery(why, gen) {
        if (arguments.length > 1 && gen !== generation) { return; }
        generation++;
        if (deliveryIdx >= 0) {
            log("05 " + deliveries[deliveryIdx].name + " rejected: " + why, "err");
        }
        deliveryIdx++;
        if (deliveryIdx >= deliveries.length) {
            /* Every AVPlay route is out; MSE is the remaining way to get audio
             * and video together without a server. */
            stopAvplay();
            results[5] = false;
            setStatus(5, "fail", "NO ROUTE",
                      "MSE failed (" + (mseResult ? mseResult.why : "not run") +
                      ") and AVPlay refused every manifest delivery. " +
                      "Progressive playback still works.");
            busy = false;
            judge();
            return;
        }
        var d = deliveries[deliveryIdx];
        /* A failed prepareAsync leaves AVPlay in a state where the next open()
         * reports INVALID_URI whatever the URI is, so each attempt gets a fresh
         * player object. Without this the second and third results are noise. */
        resetPlayer(function () {
            log("05 trying manifest as " + d.name);
            playDash(d.uri, d.name);
        });
    }

    function resetPlayer(cb) {
        try { webapis.avplay.stop(); } catch (e) {}
        try { webapis.avplay.close(); } catch (e) {}
        if (avplayObj && avplayObj.parentNode) {
            avplayObj.parentNode.removeChild(avplayObj);
        }
        avplayObj = null;
        setTimeout(cb, 900);
    }

    function playDash(uri, method) {
        var gen = generation;
        log("05 manifest via " + method + ", " + uri.slice(0, 60));
        ensureAvplayObject();
        try { webapis.avplay.close(); } catch (e) {}
        try { webapis.avplay.open(uri); }
        catch (e) { nextDelivery("open() threw: " + e.message, gen); return; }
        webapis.avplay.setDisplayRect(0, 0, 1920, 1080);
        if (USER_AGENT) {
            try { webapis.avplay.setStreamingProperty("USER_AGENT", USER_AGENT); }
            catch (e) { log("05 ua rejected: " + e.message, "err"); }
        }

        webapis.avplay.setListener({
            onbufferingcomplete: function () { log("05 buffering complete", "ok"); },
            onstreamcompleted: function () { stopAvplay(); },
            onerror: function (err) {
                if (results[5] !== true) { nextDelivery("avplay error " + err, gen); }
            },
            oncurrentplaytime: function (ms) {
                if (ms > 0 && results[5] !== true) {
                    results[5] = true;
                    log("05 dash frames decoding at " + ms + "ms", "ok");
                }
            }
        });

        webapis.avplay.prepareAsync(function () {
            log("05 prepared, playing DASH", "ok");
            showUi(false);
            webapis.avplay.play();
            playTimer = setTimeout(function () {
                var info = "&mdash;";
                try {
                    var w = webapis.avplay.getCurrentStreamInfo();
                    if (w && w.length) {
                        info = "Streams: " + w.map(function (s) {
                            return s.type + " " + (s.extra_info || "");
                        }).join(" | ");
                    }
                } catch (e) {}
                stopAvplay();
                if (results[5] !== true) { results[5] = false; }
                var d = deliveries[deliveryIdx];
                if (results[5] === true && d && d.partial) {
                    /* Decodes, but video only — keep going so MSE still gets
                     * its turn, since a client needs sound too. */
                    log("05 " + method + " decodes, but has no audio; continuing", "ok");
                    results[5] = null;
                    nextDelivery("video only", gen);
                    return;
                }
                setStatus(5, results[5] ? "pass" : "fail",
                          results[5] ? "PLAYING via " + method : "NO FRAMES", info);
                log("05 finished", results[5] ? "ok" : "err");
                judge();
            }, PLAY_SECONDS * 1000);
        }, function (err) {
            nextDelivery("prepareAsync: " + err, gen);
        });
    }

    /* ---------------- MSE route ----------------
     * AVPlay will not take a manifest this app can generate, so the other way to
     * get muxed DASH is to feed WebKit the two streams through Media Source
     * Extensions. Whole-file appends here — a real client would append by range. */

    function fetchBuf(url, onOk, onFail) {
        var xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.responseType = "arraybuffer";
        xhr.timeout = 30000;
        xhr.onload = function () {
            if (xhr.status === 200 || xhr.status === 206) { onOk(xhr.response); }
            else { onFail("HTTP " + xhr.status); }
        };
        xhr.onerror = function () { onFail("transport error"); };
        xhr.ontimeout = function () { onFail("timeout"); };
        xhr.send();
    }

    function tryMse(dash, onResult) {
        if (!window.MediaSource) { onResult(false, "MediaSource is not available"); return; }
        var v = (dash.video || []).filter(function (s) {
            return s.codecs.indexOf("avc1") === 0;
        })[0];
        var a = (dash.audio || [])[0];
        if (!v || !a) { onResult(false, "no avc1 + audio pair"); return; }

        var vType = 'video/mp4; codecs="' + v.codecs + '"';
        var aType = 'audio/mp4; codecs="' + a.codecs + '"';
        if (!MediaSource.isTypeSupported(vType)) { onResult(false, "unsupported: " + vType); return; }
        if (!MediaSource.isTypeSupported(aType)) { onResult(false, "unsupported: " + aType); return; }
        log("05 MSE supports both codecs, fetching streams");

        var el = document.getElementById("html5");
        var ms = new MediaSource();
        var settled = false;
        function done(ok, why) {
            if (settled) { return; }
            settled = true;
            try { el.pause(); el.removeAttribute("src"); el.load(); } catch (e) {}
            el.className = "hidden";
            onResult(ok, why);
        }

        el.className = "";
        el.src = URL.createObjectURL(ms);

        ms.addEventListener("sourceopen", function () {
            var vb, ab;
            try {
                vb = ms.addSourceBuffer(vType);
                ab = ms.addSourceBuffer(aType);
            } catch (e) { done(false, "addSourceBuffer: " + e.message); return; }

            var pending = 2;
            function appended() {
                if (--pending > 0) { return; }
                log("05 MSE buffers filled, playing");
                el.play().catch(function (e) { done(false, "play(): " + e.message); });
            }
            function feed(sb, url, label) {
                fetchBuf(url, function (buf) {
                    sb.addEventListener("updateend", function once() {
                        sb.removeEventListener("updateend", once);
                        appended();
                    });
                    try { sb.appendBuffer(buf); }
                    catch (e) { done(false, "appendBuffer " + label + ": " + e.message); }
                }, function (why) { done(false, "fetch " + label + ": " + why); });
            }
            feed(vb, v.baseUrl, "video");
            feed(ab, a.baseUrl, "audio");
        });

        el.addEventListener("playing", function () {
            done(true, "MSE plays muxed video+audio");
        });
        el.addEventListener("error", function () {
            done(false, "video element error " + (el.error ? el.error.code : "?"));
        });
        setTimeout(function () { done(false, "no playback within 40s"); }, 40000);
    }

    function testDash() {
        if (busy) { return; }
        if (typeof webapis === "undefined" || !webapis.avplay) {
            results[5] = false;
            setStatus(5, "fail", "NO API", "webapis.avplay is undefined.");
            judge(); return;
        }
        busy = true;
        setStatus(5, "running", "RUNNING", "&mdash;");
        log("05 starting dash test");

        /* Backstop for the whole test: AVPlay can also go quiet without ever
         * calling back, and a silent hang reports nothing at all. */
        setTimeout(function () {
            if (results[5] === null) {
                results[5] = false;
                setStatus(5, "fail", "TIMED OUT", "No callback within 45s — see the log for the last step reached.");
                log("05 timed out", "err");
                stopAvplay();
                judge();
            }
        }, 90000);

        function go(dash) {
            var mpd = buildMpd(dash);
            if (!mpd) {
                results[5] = false;
                setStatus(5, "fail", "NO STREAMS", "API returned no dash representations.");
                log("05 no dash streams", "err");
                busy = false; judge(); return;
            }
            log("05 manifest built, " + mpd.length + " chars");

            /* MSE goes first now. AVPlay is known to play this manifest, but only
             * when it is served over HTTP, and a widget cannot listen on a
             * socket — so MSE is the only route that could ship without a
             * backend. Its answer is the one that decides the architecture. */
            tryMse(dash, function (mseOk, mseWhy) {
                mseResult = { ok: mseOk, why: mseWhy };
                log("05 mse: " + mseWhy, mseOk ? "ok" : "err");
                if (mseOk) {
                    results[5] = true;
                    setStatus(5, "pass", "PLAYING via MSE",
                              mseWhy + ". DASH ships client-side, no backend needed.");
                    busy = false;
                    judge();
                    return;
                }
                startAvplayRoutes(dash, mpd);
            });
        }

        function startAvplayRoutes(dash, mpd) {
            deliveries = [];
            /* Only this one would work in a shipped app — no disk, no server. */
            try {
                deliveries.push({
                    name: "data URI",
                    uri: "data:application/dash+xml;base64," +
                         btoa(unescape(encodeURIComponent(mpd)))
                });
            } catch (e) { log("05 data uri unavailable: " + e.message, "err"); }

            /* Diagnostic only: proves whether AVPlay can do DASH at all when the
             * manifest arrives over HTTP. Needs the dev collector running. */
            if (REPORT_TO) {
                var base = REPORT_TO.replace(/\/report$/, "");
                try {
                    var up = new XMLHttpRequest();
                    up.open("POST", base + "/mpd", false);
                    up.setRequestHeader("Content-Type", "text/plain");
                    up.send(mpd);
                    deliveries.push({ name: "http (dev collector)", uri: base + "/stream.mpd" });
                } catch (e) { log("05 could not upload manifest: " + e.message, "err"); }
            }

            /* Last resort, and a useful negative: if AVPlay plays a bare .m4s as
             * a progressive stream then fragmented MP4 is fine and only the
             * manifest is the problem. Video only, so no audio is expected. */
            var vRep = (dash.video || []).filter(function (s) {
                return s.codecs.indexOf("avc1") === 0;
            })[0];
            if (vRep) {
                deliveries.push({
                    name: "bare .m4s, video only",
                    uri: vRep.baseUrl,
                    partial: true   /* proves the container decodes; no audio */
                });
            }

            writeMpd(mpd, function (uri) {
                deliveries.splice(deliveries.length - (vRep ? 1 : 0), 0,
                                  { name: "file:// on device", uri: uri });
                deliveryIdx = -1;
                nextDelivery();
            }, function (why) {
                log("05 write failed: " + why, "err");
                deliveryIdx = -1;
                if (deliveries.length) { nextDelivery(); }
                else {
                    results[5] = false;
                    setStatus(5, "fail", "WRITE FAIL", "Could not write the manifest: " + why);
                    busy = false; judge();
                }
            });
        }

        if (dashData) { go(dashData); return; }
        log("05 fetching dash streams first");
        fetchPlayurl(function (data) {
            if (!data.dash) {
                results[5] = false;
                setStatus(5, "fail", "NO DASH", "API returned durl, not dash.");
                busy = false; judge(); return;
            }
            dashData = data.dash;
            go(dashData);
        }, function (why) {
            results[5] = false;
            setStatus(5, "fail", "API FAIL", "Could not fetch streams: " + why);
            busy = false; judge();
        });
    }

    /* ---------------- run all ---------------- */

    function runAll() {
        if (busy) { return; }
        setVerdict("running", "Running");
        log("running all five");
        testFetch();
        setTimeout(testAvplay, 1500);
        setTimeout(function () {
            if (!busy) { testVideoTag(); }
        }, (PLAY_SECONDS + 4) * 1000);
        /* 04 is a plain XHR, so it can overlap the video tests. */
        setTimeout(testApi, (PLAY_SECONDS + 6) * 1000);
        setTimeout(function () {
            if (!busy) { testDash(); }
        }, (PLAY_SECONDS + 22) * 1000);
    }

    /* ---------------- remote control ---------------- */

    function exitApp() {
        try {
            tizen.application.getCurrentApplication().exit();
        } catch (e) {
            log("exit failed: " + e.message, "err");
        }
    }

    function paintFocus() {
        var all = document.getElementById("runall");
        all.className = "runall" + (focusIdx === 0 ? " focused" : "");
        for (var i = 1; i <= TEST_COUNT; i++) {
            var row = document.getElementById("test-" + i);
            var cls = row.className.replace(/\s*focused/, "");
            row.className = cls + (focusIdx === i ? " focused" : "");
        }
    }

    function moveFocus(delta) {
        var n = TEST_COUNT + 1;
        focusIdx = (focusIdx + delta + n) % n;
        paintFocus();
    }

    function activate() {
        switch (focusIdx) {
            case 0: runAll();       break;
            case 1: testFetch();    break;
            case 2: testAvplay();   break;
            case 3: testVideoTag(); break;
            case 4: testApi();      break;
            case 5: testDash();     break;
        }
    }

    function bindKeys() {
        try {
            tizen.tvinputdevice.registerKey("ColorF0Red");
            tizen.tvinputdevice.registerKey("ColorF1Green");
            tizen.tvinputdevice.registerKey("ColorF2Yellow");
            tizen.tvinputdevice.registerKey("ColorF3Blue");
        } catch (e) {
            log("colour keys unavailable, D-pad still works");
        }

        document.addEventListener("keydown", function (e) {
            switch (e.keyCode) {
                case 38: moveFocus(-1);   break;   // up
                case 40: moveFocus(1);    break;   // down
                case 13: activate();      break;   // enter / select
                case 403: testFetch();    break;   // red, if available
                case 404: testAvplay();   break;   // green
                case 405: testVideoTag(); break;   // yellow
                case 406: runAll();       break;   // blue
                case 10009:                        // return
                    if (busy) { stopAvplay(); } else { exitApp(); }
                    break;
                case 10182: exitApp();    break;   // exit
                default: break;
            }
        });
    }

    /* ---------------- boot ---------------- */

    window.onload = function () {
        bindKeys();
        paintFocus();
        log("ready");
        if (!VIDEO_URL) {
            document.getElementById("nourl").className = "nourl";
            setVerdict("bad", "No url configured");
            log("edit js/config.js first", "err");
        } else {
            log("url length " + VIDEO_URL.length + " chars");
            setVerdict("idle", "Select Run all five and press the centre button");
        }
    };
})();
