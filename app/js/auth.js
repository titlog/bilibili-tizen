/* QR login and session storage.
 *
 * XHR cannot read Set-Cookie, so the browser cookie jar is not where the session
 * comes from: bilibili puts the credentials in the poll response's `url` as
 * query parameters, which is how its own TV and app clients collect them. They
 * are kept in localStorage and replayed as a Cookie header.
 */
var Auth = (function () {
    "use strict";

    var KEY = "bili.session";
    var session = null;   /* { SESSDATA, bili_jct, DedeUserID, savedAt } */
    var pollTimer = null;
    var lastParseKeys = [];   /* parameter names from a failed parse, never values */

    function load() {
        if (session) { return session; }
        try {
            var raw = localStorage.getItem(KEY);
            session = raw ? JSON.parse(raw) : null;
        } catch (e) { session = null; }
        return session;
    }

    function save(s) {
        session = s;
        try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {}
    }

    function clear() {
        session = null;
        try { localStorage.removeItem(KEY); } catch (e) {}
    }

    function cookieHeader() {
        var s = load();
        if (!s || !s.SESSDATA) { return ""; }
        var parts = ["SESSDATA=" + s.SESSDATA];
        if (s.bili_jct) { parts.push("bili_jct=" + s.bili_jct); }
        if (s.DedeUserID) { parts.push("DedeUserID=" + s.DedeUserID); }
        return parts.join("; ");
    }

    function parseSessionUrl(url) {
        var out = {}, qs = String(url || "");
        var q = qs.indexOf("?");
        qs = q >= 0 ? qs.slice(q + 1) : qs;
        var pairs = qs.split("&");
        for (var i = 0; i < pairs.length; i++) {
            /* Split on the first = only: SESSDATA and gourl both carry further
             * = characters in their values, and requiring exactly two parts
             * silently dropped the session. */
            var eq = pairs[i].indexOf("=");
            if (eq <= 0) { continue; }
            out[pairs[i].slice(0, eq)] = decodeURIComponent(pairs[i].slice(eq + 1));
        }
        if (!out.SESSDATA) {
            /* Names only — the values here are live credentials. */
            lastParseKeys = [];
            for (var k in out) { if (out.hasOwnProperty(k)) { lastParseKeys.push(k); } }
            return null;
        }
        return {
            SESSDATA: out.SESSDATA,
            bili_jct: out.bili_jct || "",
            DedeUserID: out.DedeUserID || "",
            savedAt: new Date().getTime()
        };
    }

    function getJson(url, onOk, onFail) {
        var xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.timeout = 20000;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) { return; }
            if (xhr.status !== 200) { onFail("HTTP " + xhr.status); return; }
            try { onOk(JSON.parse(xhr.responseText)); }
            catch (e) { onFail("bad JSON"); }
        };
        xhr.ontimeout = function () { onFail("timeout"); };
        xhr.onerror = function () { onFail("network error"); };
        xhr.send();
    }

    return {
        session: load,
        isLoggedIn: function () { var s = load(); return !!(s && (s.SESSDATA || s.viaCookieJar)); },
        /* True when the cookies live in the engine jar and this code cannot
         * read them — AVPlay takes no jar, so playback must go via MSE. */
        needsJar: function () { var s = load(); return !!(s && s.viaCookieJar && !s.SESSDATA); },
        cookieHeader: cookieHeader,
        logout: function () { clear(); },

        /* onState is called with one of:
         *   {kind:"qr", url}          show this to the user
         *   {kind:"scanned"}          phone has it, awaiting confirmation
         *   {kind:"done"}             session stored
         *   {kind:"expired"}          need a fresh code
         *   {kind:"error", why}       */
        startQrLogin: function (onState) {
            this.cancelQrLogin();
            getJson("https://passport.bilibili.com/x/passport-login/web/qrcode/generate", function (r) {
                if (r.code !== 0) { onState({ kind: "error", why: r.message || r.code }); return; }
                var key = r.data.qrcode_key;
                onState({ kind: "qr", url: r.data.url });

                var pollUrl = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=" + key;
                var lastInner = null;
                pollTimer = setInterval(function () {
                    getJson(pollUrl, function (p) {
                        var d = p.data || {};
                        if (d.code === 0) {
                            clearInterval(pollTimer); pollTimer = null;
                            var s = parseSessionUrl(d.url || "");
                            if (s) { save(s); onState({ kind: "done" }); return; }

                            /* No credentials in the query: this account got the
                             * ticket flow, where the cookies are only ever
                             * delivered as Set-Cookie by the cross-domain hop.
                             * XHR cannot read those, so fetch the url and let
                             * the engine's own cookie jar take them. */
                            onState({ kind: "finishing" });
                            var hop = new XMLHttpRequest();
                            hop.open("GET", d.url, true);
                            try { hop.withCredentials = true; } catch (e) {}
                            hop.onreadystatechange = function () {
                                if (hop.readyState !== 4) { return; }
                                save({ viaCookieJar: true, savedAt: new Date().getTime() });
                                onState({ kind: "done" });
                            };
                            hop.onerror = function () {
                                onState({ kind: "error", why: "跨域换取凭证失败" });
                            };
                            hop.send();
                        } else if (d.code === 86038) {
                            clearInterval(pollTimer); pollTimer = null;
                            onState({ kind: "expired" });
                        } else if (d.code === 86090 && lastInner !== 86090) {
                            lastInner = 86090;
                            onState({ kind: "scanned" });
                        }
                    }, function () { /* a dropped poll is not fatal; the next one retries */ });
                }, 2000);
            }, function (why) { onState({ kind: "error", why: why }); });
        },

        cancelQrLogin: function () {
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        }
    };
})();
