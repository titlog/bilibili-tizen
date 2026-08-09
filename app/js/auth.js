/* Signing in, for as many people as share the television.
 *
 * There are two QR flows here and the difference between them is the whole
 * reason multiple accounts are possible at all:
 *
 *   TV login (passport-tv-login) returns the credentials as JSON — SESSDATA,
 *   bili_jct and a refresh token, in the response body. They can be stored,
 *   swapped and replayed as a Cookie header, so any number of accounts can sit
 *   on the set and switching between them is instant.
 *
 *   Web login (passport-login/web) is the fallback. On this account it does not
 *   hand back credentials at all: the poll answers with a cross-domain url whose
 *   query carries only `ticket`, and the session arrives as Set-Cookie on that
 *   hop. XHR cannot read Set-Cookie, so the only way to keep it is to let the
 *   engine's own jar take it — and the jar is global, unreadable, and holds one
 *   account at a time. An account acquired this way cannot be switched away from
 *   and switched back to; Accounts.needsRelogin is how that surfaces.
 *
 * The TV endpoints want a signed request, which is what md5.js is for. That
 * signature identifies this client as bilibili's own television client. It is
 * the only login route the platform offers that returns readable credentials.
 */
var Auth = (function () {
    "use strict";

    /* bilibili's Android TV client. The endpoints below reject an unsigned
     * request and accept no other appkey.
     *
     * ── This is the project's one deliberate trade-off. Read before changing. ──
     *
     * Signing with these makes this client present itself to bilibili as the
     * official television client. The values are not secret — they are公开
     * documented across the bilibili API community — but using them is a
     * decision, not an oversight, and it buys exactly one thing: credentials
     * this code can read, store and replay.
     *
     * `passport-tv-login` answers with SESSDATA, bili_jct, an access token and
     * a refresh token, as JSON. That is what makes several people able to share
     * one television: each account is a value this app holds and can swap.
     *
     * The web QR flow (startWeb below) is the alternative and needs none of
     * this. Its cost is structural, not cosmetic: it finishes by redirecting
     * through a URL whose `Set-Cookie` the engine swallows into its own global
     * jar. XHR never sees the credentials. So an account signed in that way
     * cannot be stored, cannot be restored, and cannot coexist with another —
     * the jar holds one session, and there is no way to put a previous one
     * back.
     *
     * Both paths are implemented and both work. The web flow is the automatic
     * fallback whenever the TV path is unavailable, and it fires *before* any
     * QR code reaches the screen — swapping the code out while somebody is
     * already holding up a phone is worse than failing.
     *
     * To ship without the TV appkey: delete these two constants and make
     * `login()` call `startWeb` directly. Everything keeps working for one
     * account. `Accounts` will still hold a list, but a second sign-in
     * dispossesses the first, and `Accounts.needsRelogin` will start flagging
     * whoever lost the jar. Watch-history reporting back to bilibili also stops
     * — `/x/v2/history/report` accepts `access_key` and rejects `csrf` from
     * this device, so it depends on the TV path.
     *
     * See README「两条登录路径」for the same trade-off in prose. */
    var TV_APPKEY = "4409e2ce8ffd12b8";
    var TV_APPSEC = "59b43e04ad6965f34319062b478f83dd";
    var TV_BASE = "https://passport.bilibili.com/x/passport-tv-login";
    var WEB_BASE = "https://passport.bilibili.com/x/passport-login/web";

    /* Every in-flight login carries the generation it started in. A cancelled or
     * superseded run therefore cannot announce over the live one — the same trap
     * the player hits with AVPlay's listener singleton, and it bit this file
     * once already when an orphaned poller declared a perfectly good code
     * expired. */
    var gen = 0;
    var pollTimer = null;

    /* Set when this login is meant to restore an account already on the set
     * rather than add a new one. Only one login can be in flight — the
     * generation counter sees to that — so it can live here instead of being
     * threaded through every callback. */
    var intoId = null;

    function stop() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    function session() {
        var acc = Accounts.active();
        return (acc && acc.session) || null;
    }

    /* ---------------- signed requests ---------------- */

    function sign(params) {
        params.appkey = TV_APPKEY;
        params.ts = Math.floor(new Date().getTime() / 1000);

        var keys = [], k;
        for (k in params) { if (params.hasOwnProperty(k)) { keys.push(k); } }
        keys.sort();

        var parts = [];
        for (var i = 0; i < keys.length; i++) {
            parts.push(keys[i] + "=" + encodeURIComponent(params[keys[i]]));
        }
        var qs = parts.join("&");
        return qs + "&sign=" + MD5(qs + TV_APPSEC);
    }

    function postForm(url, body, onOk, onFail) {
        var xhr = new XMLHttpRequest();
        var settled = false;
        function fail(why) { if (!settled) { settled = true; onFail(why); } }
        function ok(j) { if (!settled) { settled = true; onOk(j); } }

        xhr.open("POST", url, true);
        xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
        xhr.timeout = 20000;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) { return; }
            if (xhr.status !== 200) { fail("HTTP " + xhr.status); return; }
            try { ok(JSON.parse(xhr.responseText)); }
            catch (e) { fail("bad JSON"); }
        };
        xhr.ontimeout = function () { fail("timeout"); };
        xhr.onerror = function () { fail("network error"); };
        xhr.send(body);
    }

    function getJson(url, onOk, onFail) {
        var xhr = new XMLHttpRequest();
        var settled = false;
        function fail(why) { if (!settled) { settled = true; onFail(why); } }
        function ok(j) { if (!settled) { settled = true; onOk(j); } }

        xhr.open("GET", url, true);
        xhr.timeout = 20000;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) { return; }
            if (xhr.status !== 200) { fail("HTTP " + xhr.status); return; }
            try { ok(JSON.parse(xhr.responseText)); }
            catch (e) { fail("bad JSON"); }
        };
        xhr.ontimeout = function () { fail("timeout"); };
        xhr.onerror = function () { fail("network error"); };
        xhr.send();
    }

    /* ---------------- TV login ---------------- */

    /* The payload has been seen both flat and nested under token_info, so read
     * whichever is present rather than assuming. */
    function sessionFromTv(d) {
        var t = d.token_info || d;
        var out = {
            access_token: t.access_token || "",
            refresh_token: t.refresh_token || "",
            expiresAt: new Date().getTime() + ((t.expires_in || 0) * 1000),
            savedAt: new Date().getTime()
        };
        var cookies = (d.cookie_info && d.cookie_info.cookies) || [];
        for (var i = 0; i < cookies.length; i++) {
            var c = cookies[i] || {};
            if (c.name === "SESSDATA") { out.SESSDATA = c.value; }
            else if (c.name === "bili_jct") { out.bili_jct = c.value; }
            else if (c.name === "DedeUserID") { out.DedeUserID = c.value; }
        }
        /* Without SESSDATA there is nothing to replay, and storing the account
         * anyway would leave isLoggedIn true with no session behind it — which
         * then suppresses every "please sign in" path in the app. */
        if (!out.SESSDATA) { return null; }
        return { session: out, mid: t.mid || Number(out.DedeUserID) || 0 };
    }

    function startTv(mine, onState, onUnavailable) {
        postForm(TV_BASE + "/qrcode/auth_code", sign({ local_id: "0" }), function (r) {
            if (mine !== gen) { return; }
            if (r.code !== 0 || !r.data || !r.data.auth_code) {
                /* The endpoint is there but will not issue a code — nothing the
                 * viewer can act on, so quietly try the other flow. */
                onUnavailable("auth_code " + (r.message || r.code));
                return;
            }
            var code = r.data.auth_code;
            onState({ kind: "qr", url: r.data.url, via: "tv" });

            var announced = 0;
            pollTimer = setInterval(function () {
                if (mine !== gen) { stop(); return; }
                postForm(TV_BASE + "/qrcode/poll",
                         sign({ auth_code: code, local_id: "0" }), function (p) {
                    if (mine !== gen) { return; }

                    if (p.code === 0 && p.data) {
                        var got = sessionFromTv(p.data);
                        if (!got) {
                            stop();
                            onState({ kind: "error", why: "登录返回里没有凭证" });
                            return;
                        }
                        stop();
                        gen++;   /* this run is finished; nothing else may report */
                        var acc = Accounts.remember(got.session, { mid: got.mid }, intoId);
                        /* The mid bilibili itself attached to this scan, and the
                         * row it landed in. Without both, "the wrong person's
                         * name came up" cannot be split into "the scan gave us
                         * the wrong credentials" and "the right credentials went
                         * to the wrong place". */
                        onState({ kind: "done", via: "tv", mid: got.mid,
                                  accId: acc && acc.id, into: intoId });
                        return;
                    }
                    if (p.code === 86038) { stop(); onState({ kind: "expired" }); return; }
                    if (p.code === 86090 && announced !== 86090) {
                        announced = 86090;
                        onState({ kind: "scanned" });
                    }
                    /* 86039 is "not scanned yet", which is not news. */
                }, function () { /* a dropped poll is not fatal; the next retries */ });
            }, 3000);
        }, function (why) { onUnavailable(why); });
    }

    /* ---------------- web login, the fallback ---------------- */

    function startWeb(mine, onState) {
        getJson(WEB_BASE + "/qrcode/generate", function (r) {
            if (mine !== gen) { return; }
            if (r.code !== 0) { onState({ kind: "error", why: r.message || r.code }); return; }

            var key = r.data.qrcode_key;
            onState({ kind: "qr", url: r.data.url, via: "web" });

            var announced = 0;
            pollTimer = setInterval(function () {
                if (mine !== gen) { stop(); return; }
                getJson(WEB_BASE + "/qrcode/poll?qrcode_key=" + key, function (p) {
                    if (mine !== gen) { return; }
                    var d = p.data || {};

                    if (d.code === 0) {
                        stop();
                        var s = parseSessionUrl(d.url || "");
                        if (s) {
                            gen++;
                            var wa = Accounts.remember(s, {}, intoId);
                            onState({ kind: "done", via: "web", mid: 0,
                                      accId: wa && wa.id, into: intoId });
                            return;
                        }

                        /* No credentials in the query: this is the ticket flow,
                         * where the cookies exist only as Set-Cookie on the
                         * cross-domain hop. Fetch it and let the engine's jar
                         * take them — this code never gets to see them. */
                        onState({ kind: "finishing" });
                        /* Empty the jar first so what lands is unambiguously
                         * this account and jar ownership is true. */
                        Accounts.clearJar();

                        var hop = new XMLHttpRequest();
                        hop.open("GET", d.url, true);
                        try { hop.withCredentials = true; } catch (e) {}
                        hop.onreadystatechange = function () {
                            if (hop.readyState !== 4) { return; }
                            if (mine !== gen) { return; }
                            /* Storing an account for a hop that failed left
                             * isLoggedIn permanently true with nothing behind
                             * it. */
                            if (hop.status < 200 || hop.status >= 400) {
                                onState({ kind: "error", why: "换取凭证失败 HTTP " + hop.status });
                                return;
                            }
                            gen++;
                            var ja = Accounts.remember(
                                { viaCookieJar: true, savedAt: new Date().getTime() },
                                {}, intoId);
                            onState({ kind: "done", via: "web", mid: 0,
                                      accId: ja && ja.id, into: intoId });
                        };
                        hop.onerror = function () {
                            if (mine !== gen) { return; }
                            onState({ kind: "error", why: "跨域换取凭证失败" });
                        };
                        hop.send();
                        return;
                    }
                    if (d.code === 86038) { stop(); onState({ kind: "expired" }); return; }
                    if (d.code === 86090 && announced !== 86090) {
                        announced = 86090;
                        onState({ kind: "scanned" });
                    }
                }, function () { /* a dropped poll is not fatal */ });
            }, 3000);
        }, function (why) { onState({ kind: "error", why: why }); });
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
        if (!out.SESSDATA) { return null; }
        return {
            SESSDATA: out.SESSDATA,
            bili_jct: out.bili_jct || "",
            DedeUserID: out.DedeUserID || "",
            savedAt: new Date().getTime()
        };
    }

    return {
        session: session,

        /* An account whose credentials only ever lived in the jar, after the jar
         * has moved on, is not signed in however much is stored about it —
         * reporting otherwise would serve a signed-out feed under their name. */
        isLoggedIn: function () {
            var acc = Accounts.active();
            return !!(acc && acc.session && !Accounts.needsRelogin(acc));
        },

        /* True when the cookies live in the engine jar and this code cannot read
         * them: AVPlay takes no jar, so playback has to go through MSE. */
        needsJar: function () {
            var s = session();
            return !!(s && !s.SESSDATA);
        },

        /* Only when this account is the one the jar holds. Letting a request set
         * withCredentials otherwise would attach whichever account last logged
         * in through the web flow. */
        jarIsOurs: function () {
            var acc = Accounts.active();
            return !!(acc && Accounts.jarBelongsTo(acc.id));
        },

        cookieHeader: function () {
            var acc = Accounts.active();
            var s = acc && acc.session;
            if (!s || !s.SESSDATA) { return ""; }
            var parts = ["SESSDATA=" + s.SESSDATA];
            if (s.bili_jct) { parts.push("bili_jct=" + s.bili_jct); }
            if (s.DedeUserID) { parts.push("DedeUserID=" + s.DedeUserID); }
            /* Stable per account, so this client does not look like a new device
             * on every request. */
            if (acc.buvid) { parts.push("buvid3=" + acc.buvid); }
            return parts.join("; ");
        },

        /* The CSRF token every write endpoint wants. The web flow never exposes
         * one; the TV flow always does. Nothing writes yet — see CLAUDE.md. */
        csrf: function () {
            var s = session();
            return (s && s.bili_jct) || "";
        },

        /* The other way to sign a write. The TV login hands back an access token
         * as well as cookies, and the app-style endpoints take it in the body —
         * no CSRF token, no Origin, no jar. On a device whose requests carry
         * neither an Origin a website would recognise nor a browser's full set
         * of cookies, that is the path that fits. */
        accessKey: function () {
            var s = session();
            return (s && s.access_token) || "";
        },

        signTv: function (params) { return sign(params); },

        /* Signs the active account out and forgets it entirely, along with the
         * watch history that belonged to them. */
        logout: function () {
            var acc = Accounts.active();
            if (acc) { Accounts.remove(acc.id); }
        },

        /* onState is called with one of:
         *   {kind:"qr", url, via}   show this to the user
         *   {kind:"scanned"}        phone has it, awaiting confirmation
         *   {kind:"finishing"}      web fallback exchanging the ticket
         *   {kind:"done", via}      account stored and made active
         *   {kind:"expired"}        need a fresh code
         *   {kind:"error", why}
         *
         * The TV flow is tried first because it is the only one that yields
         * credentials this code can store. The fallback happens before any QR
         * reaches the screen — swapping the code out from under someone who is
         * already pointing a phone at it would be worse than failing. */
        startLogin: function (onState, restoreId) {
            this.cancelLogin();
            intoId = restoreId || null;
            var mine = gen;
            startTv(mine, onState, function (why) {
                if (mine !== gen) { return; }
                onState({ kind: "fallback", why: why });
                startWeb(mine, onState);
            });
        },

        cancelLogin: function () { gen++; stop(); intoId = null; }
    };
})();
