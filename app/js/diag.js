/* Diagnostics that reach the developer from televisions nobody here can see.
 *
 * The collector on 8099 (tools/collect.mjs) exists only for dev builds. A set in
 * somebody else's living room used to fail in silence, and a photo of a toast
 * was all there was to go on — issue #5: every video 403 on a Tizen 3.0 set on
 * a network this project had never been run from, and nothing on the screen
 * could say which route had been refused by which host.
 *
 * So every log line also lands in a small ring here, scrubbed as it is
 * recorded, and the ring is uploaded when something goes wrong in a way the
 * viewer was told about (Diag.incident), or when the viewer presses 上传诊断日志
 * in 设置. On by default, switchable in 设置; off means nothing is recorded,
 * kept or sent.
 *
 * What never leaves the television: account ids and names, credential
 * fingerprints, video titles, search terms. Call sites wrap those in
 * Diag.priv(), which the upload replaces with "…", and the pattern net in
 * scrub() catches the shapes that are easy to forget (mid=…, uname=…, signed
 * url parameters). The bvid stays: "only this one video fails" cannot be
 * reproduced without it.
 *
 * The receiving end is server/diag-worker.js (a Cloudflare Worker with D1);
 * tools/diag-logs.mjs reads it. This file is part of every update bundle, so
 * the endpoint and the scrubbing can be fixed by an update; config.js cannot,
 * which is why the endpoint is here. ES5, like everything in app/js. */
var Diag = (function () {
    "use strict";

    var ENDPOINT = "https://diag.titdev.nl/v1/upload";   /* server/README.md */
    var APP = "bilibili-tizen";

    var K_RING = "bili.diag.ring", K_DEVICE = "bili.diag.device", K_SENT = "bili.diag.sent";

    /* 600 lines is a little over one failed video's whole ladder plus the boot
     * that preceded it; the character cap keeps localStorage use near 300KB
     * (UTF-16), well clear of the update bundle sharing the same quota. */
    var MAX_LINES = 600, MAX_CHARS = 160000, MAX_LINE = 4000;
    var SETTLE = 8000;          /* after an incident, wait for the lines that explain it (probes land late) */
    var AUTO_GAP = 180000;      /* at most one automatic upload per three minutes… */
    var AUTO_PER_DAY = 12;      /* …and a dozen a day: a set stuck in a loop must not become a firehose */
    var MANUAL_GAP = 10000;
    var PERSIST_EVERY = 15000;
    var RETRY_AFTER = 60000;    /* a missed upload goes again this long after the next start */

    var OPEN = "", CLOSE = "";

    var report = function () {};
    var ring = [], chars = 0, loaded = false;
    var persistTimer = null, settleTimer = null, reasons = [], sending = false;
    var last = null;            /* {at, ok, id, why, manual} — the latest upload this run, for 设置 */

    function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function put(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
    function del(k) { try { localStorage.removeItem(k); } catch (e) {} }
    function parse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }
    function now() { return new Date().getTime(); }

    function enabled() {
        try { return Settings.get("diag", true) !== false; } catch (e) { return true; }
    }

    /* A build from source uploads like a release package (from 10-23). Until
     * then dev builds (REPORT_TO set) uploaded nothing, on the reasoning that
     * the collector has every line — true only on this project's own machine:
     * issue #7, a Tizen 4.0 set built from source, live failing two ways, and
     * not one line of it reached anybody. What still uploads nothing: a
     * selftest build (its failures are staged), and DIAG_TO "off" (deploy.sh
     * writes it from BILI_DIAG_TO=off, which this project's own machine sets).
     * Any other DIAG_TO is where to send instead (deploy.sh --diag: the local
     * stand-in). config.js in an older package may have neither DIAG_TO nor
     * SELFTEST, hence typeof. */
    function endpoint() {
        /* A desktop browser — a test harness, the README shots — is nobody's
         * television, and the receiver is for televisions: no "Tizen" in the
         * UA, nothing leaves. 10-22: douyin's desktop harness had not blocked
         * the receiver, and js errors from code still being written arrived as
         * two "new sets". Every real set's UA so far, 3.0 to
         * 9.0, reads SMART-TV; LINUX; Tizen x.y. */
        if (!/Tizen/.test(typeof navigator !== "undefined" && navigator.userAgent || "")) { return ""; }
        var override = typeof DIAG_TO !== "undefined" ? DIAG_TO : "";
        if (override === "off") { return ""; }
        if (override) { return override; }
        var selftest = typeof SELFTEST !== "undefined" && !!SELFTEST;
        return selftest ? "" : ENDPOINT;
    }

    /* ---------------- what may leave ---------------- */

    function priv(s) {
        return OPEN + String(s == null ? "" : s).replace(/[]/g, "") + CLOSE;
    }
    function plain(s) { return String(s == null ? "" : s).replace(/[]/g, ""); }

    var NET = [
        /* Wrapped at the call site. An unclosed span runs to the end of the
         * line: a slice() that cut off the closing mark must not leak the rest. */
        [/[^]*(?:|$)/g, "…"],
        [/[]/g, ""],
        /* mid=0 stays: "not signed in" is a diagnosis; a real id is a person. */
        [/\b(mid ?[=:：] ?)[1-9]\d*/g, "$1…"],
        [/\b(uname ?[=:：] ?)[^\s|；;，,）)]+/g, "$1…"],
        [/(凭证=)[0-9a-fA-F]+/g, "$1…"],
        [/(header=有 )[0-9a-fA-F]{6,}/g, "$1…"],
        /* Signed and session parameters in any url that reaches a log line. */
        [/([?&](?:access_key|access_token|refresh_token|upsig|hdnts|sign|w_rid|csrf|SESSDATA|bili_jct|DedeUserID|buvid3|mid)=)[^&\s"'<>]*/g, "$1…"],
        [/\b(SESSDATA|bili_jct|DedeUserID|DedeUserID__ckMd5|buvid3)=[^;&\s]+/g, "$1=…"],
        /* IP addresses: a CDN's 403 page prints one (Client_ip), a response
         * header Shaka quotes names one (x-debug-rmt-addr), a stream url
         * carries one as an integer (oi=). Any other dotted quad goes too,
         * except a url's host — a CDN node is worth knowing — and a version
         * after a slash (Chrome/120.0.0.0). */
        [/((?:client[_-]?ip|x-debug-rmt-addr|x-forwarded-for|x-real-ip|remote[_-]?addr)["']?\s*[:=]\s*["']?)[^\s"'<>,;&]+/gi, "$1…"],
        [/(\boi ?[=:：] ?)\d+/g, "$1…"],
        [/(:\/\/|\/)?\b\d{1,3}(?:\.\d{1,3}){3}\b/g, function (m, kept) { return kept ? m : "…"; }],
        /* access_key and upsig are both 32 hex digits; nothing a reader needs is. */
        [/\b[0-9a-f]{32}\b/g, "…"]
    ];

    function scrub(s) {
        var out = String(s == null ? "" : s);
        for (var i = 0; i < NET.length; i++) { out = out.replace(NET[i][0], NET[i][1]); }
        return out;
    }

    /* ---------------- the ring ---------------- */

    function pad(n) { return n < 10 ? "0" + n : String(n); }
    function stamp() {
        var d = new Date();
        return pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " +
               pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
    }

    function load() {
        if (loaded) { return; }
        loaded = true;
        var kept = parse(get(K_RING));
        if (kept && kept.length) {
            ring = kept.slice(-MAX_LINES);
            for (var i = 0; i < ring.length; i++) { chars += String(ring[i]).length; }
        }
    }

    function persist() {
        if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
        if (!enabled()) { return; }
        put(K_RING, JSON.stringify(ring));
    }

    function push(line) {
        load();
        if (line.length > MAX_LINE) { line = line.slice(0, MAX_LINE) + "…（这一行太长，截在 " + MAX_LINE + " 字）"; }
        ring.push(line);
        chars += line.length;
        while (ring.length > 1 && (ring.length > MAX_LINES || chars > MAX_CHARS)) { chars -= ring.shift().length; }
        if (!persistTimer) { persistTimer = setTimeout(persist, PERSIST_EVERY); }
    }

    function record(kind, detail) {
        if (!enabled()) { return; }
        try { push(stamp() + " " + scrub(kind + ": " + detail)); } catch (e) {}
    }

    /* ---------------- uploading ---------------- */

    var ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";   /* no 0/O, 1/I/L, U: read off a screen */
    function deviceId() {
        var id = get(K_DEVICE);
        if (id && /^[A-Z2-9]{8}$/.test(id)) { return id; }
        id = "";
        var bytes = null;
        try { bytes = new Uint8Array(8); window.crypto.getRandomValues(bytes); } catch (e) { bytes = null; }
        for (var i = 0; i < 8; i++) {
            var r = bytes ? bytes[i] : Math.floor(Math.random() * 256);
            id += ALPHABET.charAt(r % ALPHABET.length);
        }
        put(K_DEVICE, id);
        return id;
    }
    function shown(id) { return id.slice(0, 4) + "-" + id.slice(4); }

    function today() {
        var d = new Date();
        return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    }
    function sentState() {
        var s = parse(get(K_SENT)) || {};
        if (s.day !== today()) { s = { day: today(), n: 0, at: 0, manualAt: s.manualAt || 0 }; }
        return s;
    }

    function post(url, body, cb) {
        var finished = false;
        function end(status, text) { if (!finished) { finished = true; cb(status, text); } }
        try {
            var xhr = new XMLHttpRequest();
            xhr.open("POST", url, true);
            /* text/plain keeps it a simple request: no preflight on engines that would send one. */
            xhr.setRequestHeader("Content-Type", "text/plain;charset=UTF-8");
            xhr.timeout = 20000;
            xhr.onreadystatechange = function () {
                if (xhr.readyState === 4) { end(xhr.status, xhr.responseText); }
            };
            xhr.ontimeout = function () { end(0, "超时"); };
            xhr.onerror = function () { end(0, "连不上"); };
            xhr.send(body);
        } catch (e) { end(0, "发不出去：" + (e && e.message)); }
    }

    function versions() {
        try { return Boot.info(); } catch (e) { return { packaged: "", running: "" }; }
    }

    /* reason: why this upload happened, in the words the viewer saw. */
    function send(reason, manual, done, retry) {
        done = done || function () {};
        /* A manual press is answered on 设置's status line, so every way it can
         * end — refused here included — is kept in `last`. */
        function refuse(why) {
            if (manual) { last = { at: now(), ok: false, why: why, manual: true }; }
            done({ ok: false, why: why });
        }
        if (!enabled()) { refuse("诊断日志关着"); return; }
        var url = endpoint();
        if (!url) { refuse("这个版本没有接收地址"); return; }
        if (sending) { refuse("正在上传上一份"); return; }
        var t = now(), s = sentState();
        if (manual) {
            if (t - (s.manualAt || 0) < MANUAL_GAP) { refuse("刚传过，过几秒再按"); return; }
            s.manualAt = t;
        } else {
            /* A retry (retryMissed) has waited the gap out itself, and does not
             * start one: an incident right after it must not be held back —
             * held back is never retried (10-25, on the set: the staged incident
             * a second after the retry was). It still counts toward the day. */
            if (!retry && t - (s.at || 0) < AUTO_GAP) {
                report("diag", "没传（三分钟内自动传过一份）：" + reason);
                done({ ok: false, why: "三分钟内传过" });
                return;
            }
            if (s.n >= AUTO_PER_DAY) {
                report("diag", "没传（今天已经自动传了 " + s.n + " 份）：" + reason);
                done({ ok: false, why: "今天传够了" });
                return;
            }
            s.n++;
            if (!retry) { s.at = t; }
        }
        put(K_SENT, JSON.stringify(s));

        load();
        var v = versions();
        var body = JSON.stringify({
            v: 1, app: APP, device: deviceId(),
            version: v.packaged || "", running: v.running || "",
            reason: scrub(reason).slice(0, 300), manual: !!manual,
            tvAt: t, tz: new Date().getTimezoneOffset(),
            ua: String(navigator.userAgent || "").slice(0, 300),
            lines: ring.slice()
        });
        persist();
        sending = true;
        var lines = ring.length;
        post(url, body, function (status, text) {
            /* An old set's root store may not chain to the endpoint's
             * certificate, and the populations that most need diagnosing are
             * exactly the old sets. A network-level failure over https gets one
             * try over http, and the log says which one carried it — the only
             * way to learn whether this fallback is ever needed. */
            if (status === 0 && /^https:/.test(url)) {
                post("http:" + url.slice(6), body, function (s2, t2) { finish(s2, t2, "http（https " + text + "）"); });
                return;
            }
            finish(status, text, /^https:/.test(url) ? "https" : "http");
        });
        function finish(status, text, via) {
            sending = false;
            var res = parse(text) || {};
            if (status >= 200 && status < 300 && res.id) {
                last = { at: now(), ok: true, id: res.id, manual: !!manual };
                report("diag", "传了 " + lines + " 行，编号 " + res.id + "，走 " + via + "（" + reason + "）");
                done({ ok: true, id: res.id });
            } else {
                var why = status ? "HTTP " + status + (res.error ? " " + res.error : "") : String(text || "连不上");
                last = { at: now(), ok: false, why: why, manual: !!manual };
                report("diag", "没传上：" + why + "，走 " + via + "（" + reason + "）");
                done({ ok: false, why: why });
            }
        }
    }

    /* ---------------- a missed upload, sent again ----------------
     *
     * An upload that failed used to be dropped: 没传上 went into the ring and
     * nothing tried again. 10-25 the endpoint answered 404 for eight hours
     * (another Worker had been given the hostname) and every incident on every
     * set in that time was lost. Now each start looks at the ring: when its
     * latest upload line is a 没传上 — written by this version or an older one,
     * so a set that missed one before it updated sends it too — the ring goes
     * again, once, a minute in and out of the way of the first video. It still
     * holds what the missed upload held, unless 600 lines have been logged
     * since. Not when the receiver refused the upload itself (400, 413): the
     * same lines would be refused again. A retry that fails writes its own
     * 没传上, so the start after tries again; the daily cap still holds. */
    var MISSED = /diag: 没传上：(.*?)，走 https?(?:（[^（）]*）)?（([\s\S]*)）$/;
    function missed() {
        load();
        for (var i = ring.length - 1; i >= 0; i--) {
            if (/ diag: 传了 \d+ 行/.test(ring[i])) { return null; }
            var m = MISSED.exec(ring[i]);
            if (m) { return /^HTTP 4(?:00|13)\b/.test(m[1]) ? null : { why: m[1], reason: m[2].replace(/^补传：/, "") }; }
        }
        return null;
    }
    function retryMissed() {
        if (!enabled() || !endpoint()) { return; }
        var m = missed();
        if (!m) { return; }
        report("diag", "上次没传上（" + m.why + "），补传一次");
        send("补传：" + m.reason, false, null, true);
    }

    function incident(reason) {
        if (!enabled() || !endpoint()) { return; }
        reasons.push(String(reason || "?").slice(0, 120));
        if (settleTimer) { return; }
        settleTimer = setTimeout(function () {
            settleTimer = null;
            var why = reasons.join(" / ");
            reasons = [];
            send(why, false);
        }, SETTLE);
    }

    if (typeof document !== "undefined" && document.addEventListener) {
        /* Tizen suspends more often than it kills; a hidden page may never run
         * the 15-second timer again. */
        try {
            document.addEventListener("visibilitychange", function () {
                if (document.hidden) { persist(); }
            });
            window.addEventListener("pagehide", persist);
        } catch (e) {}
    }

    return {
        priv: priv,
        plain: plain,
        scrub: scrub,
        record: record,
        incident: incident,
        /* From app.js's window.onload: the log channel, and a marker so the
         * kept ring says where one run ends and the next begins. */
        init: function (opts) {
            if (opts && opts.report) { report = opts.report; }
            if (enabled()) {
                push(stamp() + " diag: —— 新的一次启动 ——");
                /* Past the automatic gap too, or the retry would only be held back. */
                setTimeout(retryMissed, Math.max(RETRY_AFTER, (sentState().at || 0) + AUTO_GAP - now()));
            }
        },
        upload: function (done) { send("在设置里手动上传", true, done); },
        enabled: enabled,
        setEnabled: function (on) {
            try { Settings.set("diag", !!on); } catch (e) {}
            if (!on) {
                ring = []; chars = 0; reasons = [];
                if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
                if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
                del(K_RING);
            }
        },
        status: function () {
            return { enabled: enabled(), configured: !!endpoint(), device: shown(deviceId()),
                     lines: (load(), ring.length), sending: sending || !!settleTimer, last: last,
                     pending: !!missed() };
        },
        _test: { NET: NET, endpoint: endpoint, ring: function () { return ring.slice(); },
                 SETTLE: SETTLE, AUTO_GAP: AUTO_GAP, AUTO_PER_DAY: AUTO_PER_DAY, RETRY_AFTER: RETRY_AFTER }
    };
})();
