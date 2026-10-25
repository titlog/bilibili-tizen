/* bilibili API, called straight from the TV.
 *
 * No Referer is sent anywhere on purpose: bilibili rejects one it does not
 * recognise but is happy with none, and the widget's own file:// origin would
 * be rejected. index.html carries <meta name="referrer" content="no-referrer">
 * which is what actually enforces that.
 */
var API = (function () {
    "use strict";

    var BASE = "https://api.bilibili.com";
    /* 直播 lives on its own host (2026-10-18). */
    var LIVE = "https://api.live.bilibili.com";
    var strongState = null;
    /* Lines for the log from the detours below; app.js points it at report(). */
    var note = function () {};
    /* Until when API.view asks its wbi twin first — see view(). */
    var viewGatedUntil = 0;
    var VIEW_GATE_MEMORY = 30 * 60 * 1000;
    /* How long the strong path's second-stage header reads wait after the
     * manifest has been handed over — the start's own segment requests go to
     * the same host, and queue behind anything else in flight (CLAUDE.md,
     * 传输形状). */
    var STRONG_LATER_DELAY = 10000;   /* progress of the latest strong-token mint — see strongProgress */

    /* Attaching the session — the part multiple accounts broke.
     *
     * ── The Cookie header does not leave this television. ──
     *
     * It was believed to, on the strength of a 2026-08-02 device measurement,
     * and the whole account layer was built on that belief. The measurement was
     * taken with one account on the set, where the header and the engine's own
     * cookie jar cannot disagree: `服务器认得 X` is true whichever one the
     * request actually carried. It never had the power to tell them apart.
     *
     * A second account is what tells them apart, and on 2026-08-09 it did. A
     * two-second-old TV-login session, put in the header exactly as this
     * function builds it, came back isLogin=false from the set; the identical
     * header — same session, same UA, no Referer, self-minted buvid3 and all —
     * came back isLogin=true from a desktop. Cookie is a forbidden header name
     * and Chromium 120 silently ignores setRequestHeader for it; the widget's
     * <access> policy does not exempt it. So every signed-in request this app
     * ever made went out either anonymous or wearing whatever the jar happened
     * to hold, and with one account on the set the jar happened to hold the
     * right person.
     *
     * ── What carries a chosen account instead ──
     *
     * access_key, in the query. Nothing can strip a query parameter, there is
     * no global slot for one account to evict another from, and a request that
     * is already in flight during a switch still carries the account it was
     * made for. Measured against every login-only endpoint this file calls:
     * nav, rcmd, dynamic, history, history/cursor, player/v2 and playurl (which
     * returns the same twelve representations it returns for a cookie session,
     * against six signed out). The TV login hands one over; the web fallback
     * does not, which is why the jar route stays for those accounts.
     *
     * The header is still set. It costs nothing, it names the same account, and
     * a firmware that honours it is welcome to. */
    function applySession(xhr) {
        if (typeof Auth === "undefined" || !Auth.isLoggedIn()) { return; }
        var header = Auth.cookieHeader();
        if (header) {
            try { xhr.setRequestHeader("Cookie", header); } catch (e) {}
        }
        /* Only when the active account is the one the jar belongs to — otherwise
         * this flag attaches whoever logged in through the web fallback last, to
         * requests made under somebody else's name. */
        if (Auth.jarIsOurs()) {
            try { xhr.withCredentials = true; } catch (e) {}
        }
    }

    /* The route that actually arrives. Confined to bilibili's own API hosts —
     * api.bilibili.com and, for 直播, api.live.bilibili.com: the token is a
     * credential and the suggestion host has no business holding one. */
    function withSession(url) {
        if (typeof Auth === "undefined" || !Auth.isLoggedIn()) { return url; }
        if (url.indexOf(BASE) !== 0 && url.indexOf(LIVE) !== 0) { return url; }
        var key = Auth.accessKey();
        if (!key) { return url; }   /* web-fallback account — the jar is all it has */
        return url + (url.indexOf("?") < 0 ? "?" : "&") +
               Auth.signTv({ access_key: key });
    }

    /* `anon`: no account on this one — public lists, where a token would only
     * be one more thing for the endpoint to object to. */
    function getJson(url, onOk, onFail, anon) {
        var xhr = new XMLHttpRequest();
        var settled = false;
        /* A dropped request reaches readyState 4 with status 0 AND fires
         * onerror, so an unguarded pair of handlers reports the same failure
         * twice — and callers that retry on failure then retry twice. */
        function fail(why) { if (!settled) { settled = true; onFail(why); } }
        function ok(data) { if (!settled) { settled = true; onOk(data); } }
        xhr.open("GET", anon ? url : withSession(url), true);

        if (!anon) { applySession(xhr); }

        xhr.timeout = 20000;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) { return; }
            if (xhr.status !== 200) { fail("HTTP " + xhr.status); return; }
            var j;
            try { j = JSON.parse(xhr.responseText); }
            catch (e) { fail("bad JSON"); return; }
            /* The code *and* the message. bilibili's -404 reads 「啥都木有」 —
             * flavour text that cannot be searched for, cannot be told from a
             * network fault at a glance, and on 2026-08-12 reached the screen
             * as the entire explanation of why a video would not play. Same
             * shape postForm has always used. */
            if (j.code !== 0) {
                fail("code " + j.code + (j.message ? " " + j.message : ""));
                return;
            }
            /* Most endpoints answer under data; search suggestions use result. */
            ok(j.data !== undefined ? j.data : j.result);
        };
        xhr.ontimeout = function () { fail("timeout"); };
        xhr.onerror = function () { fail("network error"); };
        xhr.send();
    }

    /* Form writes use the same transport for watch history and explicit video
     * actions. Never send a mutation until the viewer selects it on the TV.
     *
     * bilibili's history endpoint wants the CSRF token that came with the
     * session. The TV login hands it over in the response body, so accounts
     * added that way can report; the web fallback leaves it in a cookie jar
     * this engine will not read back, so those accounts silently cannot. That
     * is why `Auth.csrf()` is checked by the caller rather than here — a write
     * that cannot be signed is not an error worth surfacing on a television. */
    function postForm(url, fields, headers, onOk, onFail) {
        var settled = false;
        function fail(why) { if (!settled) { settled = true; if (onFail) { onFail(why); } } }
        function ok(j) { if (!settled) { settled = true; if (onOk) { onOk(j); } } }

        /* A string body is already encoded — the signed ones have to be, since
         * the signature covers the exact bytes. */
        var body = fields;
        if (typeof fields !== "string") {
            var parts = [];
            for (var k in fields) {
                if (!fields.hasOwnProperty(k)) { continue; }
                parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(fields[k]));
            }
            body = parts.join("&");
        }

        var framed = url.indexOf(BASE + "/") === 0;
        if (framed && originGated) { postInFrame(url, body, ok, fail); return; }
        sendForm(new XMLHttpRequest(), url, body, headers, ok, function (why, gate) {
            if (!gate || !framed) { fail(why); return; }
            originGated = true;
            note("api", "写操作被 B 站网关按来源拒了（" + url.slice(BASE.length).split("?")[0] +
                 " " + why + " 网页），这次运行的写操作改从 api.bilibili.com 的框里发");
            postInFrame(url, body, ok, function (why2) { fail(why + "；从框里发：" + why2); });
        });
    }

    /* ── Writes the gateway refuses for their Origin (2026-10-25) ──
     *
     * A Tizen 4.0 set (Chromium 56), signed in with access_key, read everything
     * and wrote nothing for days: history/report and relation/modify came back
     * HTTP 403 by both credentials. That 403 is bilibili's gateway, not the API
     * — an HTML page, not JSON — and it is about the Origin header. One POST
     * each to history/report from the dev machine the same afternoon: no Origin,
     * or https://www / api / app / space.bilibili.com, gets 200 and JSON;
     * Origin file://, null or app://… gets the 403 page. GETs are checked the
     * same way (nav with Origin file:// is 403 too), but an engine sends Origin
     * only on a POST, which is why reads were fine there. That set sends the
     * widget's own origin on every POST; the CU7090 (Chromium 120) sends none,
     * so nothing here ever met it. Behind the check: history/report and every
     * relation path (modify, batch/modify, tags/addUsers) on every host
     * (api.biliapi.net/.com too). Not behind it: app.bilibili.com/x/v2/view/like
     * and coin/add, medialist/gateway/coll/resource/deal — 赞、投币、收藏 work.
     *
     * So no other endpoint is a way round; douyin-tizen's frame is. A widget may
     * script a cross-origin frame. With one on api.bilibili.com/robots.txt (30
     * bytes of text), that frame's own fetch makes the POST same-origin, and it
     * goes out as Origin https://api.bilibili.com, which the gateway lets
     * through. Only after a gateway 403, then for the rest of the run, and only
     * for api.bilibili.com. Whether Chromium 56 lets the frame be scripted has
     * not been seen yet (douyin's has, on Tizen 6.5 and 9.0); the note says.
     *
     * fetch, not the frame's XMLHttpRequest: same-origin, an XHR would carry the
     * frame's cookies whatever withCredentials says, and the jar may belong to a
     * different account than the access_key in the body. A body with access_key
     * goes without them; only the jar's own csrf route sends them. */
    var originGated = false;     /* a gateway 403 came back this run */
    var gateFrame = null;        /* { win, waiting } while it loads and after */
    var gateFrameBroken = "";    /* why it cannot be used, once known */
    var gateFrameNoted = false;

    function withGateFrame(done) {
        if (gateFrameBroken) { done(null, gateFrameBroken); return; }
        if (gateFrame && gateFrame.win) { done(gateFrame.win, ""); return; }
        if (gateFrame) { gateFrame.waiting.push(done); return; }
        var f = document.createElement("iframe");
        gateFrame = { win: null, waiting: [done] };
        function settle(win, why) {
            clearTimeout(timer);
            var waiting = gateFrame.waiting;
            gateFrame.waiting = [];
            gateFrame.win = win;
            if (!win) {
                gateFrameBroken = why;
                gateFrame = null;
                if (f.parentNode) { f.parentNode.removeChild(f); }
            }
            for (var i = 0; i < waiting.length; i++) { waiting[i](win, why); }
        }
        var timer = setTimeout(function () { settle(null, "框 10 秒没装上"); }, 10000);
        f.onload = function () {
            var win = f.contentWindow;
            try { void win.location.href; } catch (e) {
                settle(null, "这台电视不让脚本进跨域框（" + e.name + "）"); return;
            }
            settle(win.fetch ? win : null, win.fetch ? "" : "框里没有 fetch");
        };
        f.style.cssText = "position:absolute;left:0;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none";
        f.src = BASE + "/robots.txt";
        document.body.appendChild(f);
    }

    function postInFrame(url, body, ok, fail) {
        function said(line) {
            if (gateFrameNoted) { return; }
            gateFrameNoted = true;
            note("api", line);
        }
        withGateFrame(function (win, why) {
            if (!win) { said("框用不了：" + why + "，写操作只能失败"); fail(why); return; }
            var t0 = new Date().getTime();
            win.fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: body,
                credentials: /(^|&)access_key=/.test(body) ? "omit" : "same-origin"
            }).then(function (res) {
                return res.text().then(function (t) {
                    if (res.status !== 200) {
                        said("从框里发也被拒：HTTP " + res.status + (/^\s*</.test(t) ? " 网页" : ""));
                        fail("HTTP " + res.status);
                        return;
                    }
                    var j;
                    try { j = JSON.parse(t); } catch (e) { fail("bad JSON"); return; }
                    said("从框里发过去了（" + (new Date().getTime() - t0) + "ms，code " + j.code + "）");
                    if (j.code !== 0) { fail("code " + j.code + " " + (j.message || "")); return; }
                    ok(j);
                });
            }).then(null, function (e) {
                said("从框里发失败：" + ((e && e.message) || e));
                fail("network error");
            });
        });
    }

    /* `fail(why, refusedPage)`: the second argument is true for the gateway's
     * 403 page, the one thing postForm answers by going round. */
    function sendForm(xhr, url, body, headers, ok, fail) {
        xhr.open("POST", url, true);
        xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
        applySession(xhr);
        /* Referer and Origin are forbidden header names in a browser, but a
         * widget runs under <access> rather than CORS and sets Cookie the same
         * way, so they are worth trying — see `report`, which needs them. */
        for (var hk in (headers || {})) {
            if (!headers.hasOwnProperty(hk)) { continue; }
            try { xhr.setRequestHeader(hk, headers[hk]); } catch (e) {}
        }
        xhr.timeout = 20000;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) { return; }
            if (xhr.status !== 200) {
                fail("HTTP " + xhr.status, xhr.status === 403 && /^\s*</.test(xhr.responseText || ""));
                return;
            }
            var j;
            try { j = JSON.parse(xhr.responseText); }
            catch (e) { fail("bad JSON"); return; }
            /* The number, not just the sentence. "请求错误" alone does not
             * separate -400 (the request is wrong) from -111 (the token is),
             * and those want opposite fixes. */
            if (j.code !== 0) { fail("code " + j.code + " " + (j.message || "")); return; }
            ok(j);
        };
        xhr.ontimeout = function () { fail("timeout"); };
        xhr.onerror = function () { fail("network error"); };
        xhr.send(body);
    }

    /* WebP where it has been seen to render (Tizen 5.5, 9.0), JPEG below that.
     * Issue #1 (2026-09-26): on a 2018 UA49NU7100, Tizen 4, many covers came
     * out with blocky wrong-colour patches and oversaturation, while the same
     * WebP covers are clean on a Q90T (Tizen 5.5, PR #2's screenshots) and on
     * the CU7090. bilibili's WebP covers are VP8X with an sRGB ICC profile;
     * its JPEGs carry no profile (2026-10-17, five covers each). So JPEG steps
     * around both the old engine's WebP decoding and its colour management —
     * which one was at fault was never isolated, there is no such set here.
     * JPEG is 1.3–2.2× the bytes, which is why it is not the default. No
     * Tizen version in the UA (a desktop browser, node) keeps WebP. */
    var THUMB_FORMAT = (function () {
        var ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
        /* [ ] rather than a plain space: lint.mjs does not strip regex
         * literals, and reads "Tizen (" as a call to something undefined. */
        var m = /Tizen[ ](\d+)\.(\d+)/.exec(ua);
        if (!m) { return "webp"; }
        var major = +m[1], minor = +m[2];
        return (major < 5 || (major === 5 && minor < 5)) ? "jpg" : "webp";
    })();

    /* The width of a card in the grid, which app.js sets from the cards-per-row
     * setting (576 at three across, 430 at four, 344 at five). */
    var cardWidth = 576;

    /* Thumbnails come back as http:// or protocol-relative, and some are huge.
     * bilibili's image service resizes on demand via the @wxh suffix. */
    function thumb(url, w, h) {
        if (!url) { return ""; }
        var u = url.replace(/^http:/, "https:");
        if (u.indexOf("//") === 0) { u = "https:" + u; }
        /* The card's own size, 16:9: smaller is upscaled and soft (the old
         * 480×300 on three-column cards was), larger is bytes nobody sees. */
        return u + "@" + (w || cardWidth) + "w_" + (h || Math.round(cardWidth * 9 / 16)) +
               "h_1c." + THUMB_FORMAT;
    }

    function stripEm(s) {
        return String(s || "").replace(/<[^>]+>/g, "");
    }

    /* Search returns "667:37" or "12:05"; the feeds return plain seconds. */
    function duration(v) {
        if (typeof v === "number") {
            var m = Math.floor(v / 60), s = v % 60;
            if (m < 60) { return m + ":" + ("0" + s).slice(-2); }
            return Math.floor(m / 60) + ":" + ("0" + (m % 60)).slice(-2) + ":" + ("0" + s).slice(-2);
        }
        return String(v || "");
    }

    function count(n) {
        if (n >= 100000000) { return (n / 100000000).toFixed(1) + "亿"; }
        if (n >= 10000) { return (n / 10000).toFixed(1) + "万"; }
        return String(n || 0);
    }

    /* Signed in, bilibili often puts a PCDN node first, and those refuse plain
     * fetches — in AVPlay that surfaces as PLAYER_ERROR_CONNECTION_FAILED, which
     * reads like a broken video rather than a picky host. Keep them last rather
     * than dropping them: sometimes they are the only option offered. */
    /* `plain` adds an http:// twin of every https mirror. That exists for
     * AVPlay, whose HTTP stack is far older than WebKit's and fails the TLS
     * handshake with some nodes. MSE fetches over XHR and has no such problem,
     * so for DASH the twins are not mirrors at all — they are the same two hosts
     * listed twice, and a failure burst rotating through them hits each host
     * again within a second. On a CDN that rate-limits bursts by IP that is how
     * one refusal becomes twenty requests. */
    /* `upos-sz-mirrorcosov`, bilibili's designated spare, has now been caught
     * on both sides of the same bet. 2026-08-02 it answered 403 on every video
     * tried, and it was dropped here outright. 2026-08-03 the primary
     * (`upos-hz-mirrorakam`) spent an evening cutting connections mid-stream —
     * and cosov, measured from the desktop in the same hour on the same file,
     * served 206s. The official web player rode out akam's failures by failing
     * over to exactly the host this function had thrown away; this client,
     * holding a manifest with one lonely BaseURL, retried the same dead edge
     * seven times and walled at the same second of the same video every time.
     *
     * So cosov is *ordered*, never dropped: after the primaries — when it was
     * the dead one it cost a retry attempt per cycle, which is survivable;
     * having no second host at all when the primary sours is not. Before the
     * mcdn/szbdyd PCDN nodes, which refuse plain range requests by design. */
    function mirrors(primary, backups, plain) {
        var all = [primary].concat(backups || []).filter(function (u) { return !!u; });
        var good = [], spare = [], iffy = [];
        for (var i = 0; i < all.length; i++) {
            var host = String(all[i]).split("/")[2] || "";
            if (host.indexOf("mcdn") >= 0 || host.indexOf("szbdyd") >= 0) { iffy.push(all[i]); }
            else if (host.indexOf("upos-sz-mirrorcosov") >= 0) { spare.push(all[i]); }
            else { good.push(all[i]); }
        }
        var ordered = good.concat(spare).concat(iffy);

        /* AVPlay has its own HTTP stack, far older than WebKit's, and it fails
         * the TLS handshake with some CDN nodes while an XHR to the very same
         * url succeeds. The plaintext variant is the same file on the same host,
         * so append one per mirror as a last resort rather than giving up. */
        if (!plain) { return ordered; }

        var withPlain = [];
        for (var j = 0; j < ordered.length; j++) { withPlain.push(ordered[j]); }
        for (var k = 0; k < ordered.length; k++) {
            if (ordered[k].indexOf("https://") === 0) {
                withPlain.push("http://" + ordered[k].slice(8));
            }
        }
        return withPlain;
    }

    /* A live room as a card. The lists name the same things differently: the
     * area list says user_cover / area_v2_name / online, the following list
     * room_cover / area_name_v2 / text_small. 人气 (`online`) was replaced on the
     * site by 「N人看过」 (`watched_show`), which is what is shown when given. */
    function liveItem(x, followed) {
        var w = x.watched_show || {};
        return {
            live: true,
            roomid: x.roomid || x.room_id || 0,
            uid: x.uid || 0,
            title: stripEm(x.title || ""),
            pic: thumb(x.user_cover || x.room_cover || x.cover || x.keyframe || x.system_cover || ""),
            author: x.uname || "",
            face: x.face || "",
            area: x.area_v2_name || x.area_name_v2 || x.areaName || x.area_name || "",
            online: w.text_large || x.text_small || (x.online ? count(Number(x.online)) + " 人气" : ""),
            followed: !!followed
        };
    }

    /* aid → bvid, the site's own mapping (pskdje/bilibili-API-collect,
     * docs/misc/bvid_desc.md), for the app routes that name a video by aid
     * alone. Doubles, not BigInt (Chromium 47): every value stays below 2^52,
     * exact in a double, and the one XOR goes in two 32-bit halves. */
    var BV_ALPHABET = "FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf";
    var BV_XOR = 23442827791579, TWO32 = 4294967296;

    function bvidOf(aid) {
        aid = Number(aid);
        if (!(aid > 0) || aid >= Math.pow(2, 51)) { return ""; }
        var x = Math.pow(2, 51) + aid;
        var hi = (Math.floor(x / TWO32) ^ Math.floor(BV_XOR / TWO32)) >>> 0;
        var lo = ((x % TWO32) ^ (BV_XOR % TWO32)) >>> 0;
        var t = hi * TWO32 + lo;
        var b = ["B", "V", "1", "0", "0", "0", "0", "0", "0", "0", "0", "0"];
        for (var i = 11; t > 0 && i >= 3; i--) {
            b[i] = BV_ALPHABET.charAt(t % 58);
            t = Math.floor(t / 58);
        }
        var s = b[3]; b[3] = b[9]; b[9] = s;
        s = b[4]; b[4] = b[7]; b[7] = s;
        return b.join("");
    }

    /* The app ranking: rank/region for a zone (it takes the 1000-series ids),
     * rank?order=all for the whole site. Its items are the app's shape: `param`
     * is the aid as a string, `name` the uploader, `duration` seconds, a `cid`
     * to start on, and no bvid. */
    function rankingApp(rid, onOk, onFail) {
        var params = { pn: 1, ps: 100, platform: "android", mobi_app: "android", build: 7280300 };
        if (rid) { params.rid = rid; } else { params.order = "all"; }
        getJson("https://app.bilibili.com/x/v2/" + (rid ? "rank/region?" : "rank?") + Auth.signTv(params),
                function (d) {
            var raw = d || [], out = [];
            for (var i = 0; i < raw.length; i++) {
                var x = raw[i], aid = Number(x && x.param) || 0;
                if (!aid || x.goto !== "av" || !bvidOf(aid)) { continue; }
                out.push({
                    bvid: bvidOf(aid),
                    aid: aid,
                    cid: x.cid || null,
                    title: stripEm(x.title),
                    pic: thumb(x.cover),
                    author: x.name || "",
                    mid: x.mid || 0,
                    duration: duration(x.duration || 0),
                    play: count(x.play),
                    publishedAt: Number(x.pub_date || 0) || 0
                });
            }
            onOk(out);
        }, onFail);
    }

    /* A buvid3 from the site's own fingerprint endpoint, once a run. It names
     * this television to bilibili, as the website's does; nothing else is sent
     * it, and diag.js scrubs it like the rest. */
    var buvidKnown = null, buvidWaiting = null;
    var rank352 = false;   /* selftest: the web ranking answers -352 */

    function buvid3(done) {
        if (buvidKnown !== null) { done(buvidKnown); return; }
        if (buvidWaiting) { buvidWaiting.push(done); return; }
        buvidWaiting = [done];
        getJson(BASE + "/x/frontend/finger/spi", function (d) {
            settle((d && d.b_3) || "");
        }, function () { settle(""); }, true);
        function settle(b) {
            buvidKnown = b || null;   /* a failure is asked again next time */
            var w = buvidWaiting;
            buvidWaiting = null;
            for (var i = 0; i < w.length; i++) { w[i](b); }
        }
    }

    function normalise(v) {
        return {
            bvid: v.bvid,
            /* The home feed calls it `id`; popular, ranking and related all call
             * it `aid` (verified against all four endpoints on 2026-08-16, and
             * none of the three carries an `id` of its own, so the fallback
             * cannot pick up a different number by mistake). Worth the extra
             * term: an aid that is missing here is not missing harmlessly —
             * the app-endpoint strong token is keyed on it, and the one place
             * that token is needed is a video that failed to start, which is
             * also the one place view() has not yet run to fill it in. Every
             * video opened from the home feed was therefore unable to reach
             * the 08-11 fix at all (16:16 on 08-16: three videos dead on
             * 「DASH 全灭」 while a fourth, already playing and so already
             * holding an aid, recovered through the strong token in the same
             * minute). */
            aid: v.aid || v.id || 0,
            /* Kept when the feed supplies it, but most do not — Resume therefore
             * keys on bvid alone for the card marker. */
            cid: v.cid || null,
            title: stripEm(v.title),
            pic: thumb(v.pic),
            author: (v.owner && v.owner.name) || v.author || "",
            /* Who made it, as the id the space endpoint takes. The feeds carry
             * it under owner, search results flat as `mid`; it was dropped for
             * a month because nothing asked. The uploader page asks. */
            mid: (v.owner && v.owner.mid) || v.mid || 0,
            duration: duration(v.duration),
            play: count(v.stat ? v.stat.view : v.play),
            publishedAt: Number(v.pubdate || v.pubtime || v.pub_time || 0) || 0
        };
    }

    /* A 合集 (ugc_season), flattened: the uploader's series this video sits in,
     * every episode across every section, in the order the site lists them.
     * view() carries the whole list (2026-10-18, checked on a two-episode
     * season: sections[].episodes[] with bvid, aid, cid, title, arc.pic,
     * arc.duration, page). One episode is not a series worth a row. */
    function seasonOf(s) {
        if (!s || !s.sections) { return null; }
        var eps = [];
        for (var i = 0; i < s.sections.length; i++) {
            var list = s.sections[i].episodes || [];
            for (var j = 0; j < list.length; j++) {
                var e = list[j], arc = e.arc || {};
                if (!e.bvid || !e.cid) { continue; }
                eps.push({ bvid: e.bvid, aid: e.aid || arc.aid || 0, cid: e.cid,
                           title: e.title || arc.title || "",
                           pic: thumb(arc.pic),
                           duration: duration(arc.duration || (e.page && e.page.duration)) });
            }
        }
        return eps.length > 1 ? { id: s.id, title: s.title || "", episodes: eps } : null;
    }

    /* fnval for a DASH request at this quality cap. 2064 = 16 (DASH) | 2048
     * (AV1); a cap of 4K adds 128, the 4K bit, as the official web player
     * does. Measured 2026-08-17 (「4K 查过了」): for a non-member the bit
     * changes nothing — the same second, the same answer with and without it —
     * so it costs ordinary accounts nothing. Whether a 大会员 account needs it
     * to be handed the 120 tier has not been seen from here (nobody in this
     * house has 大会员); it is sent because the reference client sends it. */
    function fnvalFor(qn) { return 2064 | (qn >= 120 ? 128 : 0); }

    /* Where the init segment and the segment index live inside the file, kept
     * as the "0-916" strings the API states them in — that is the form a DASH
     * manifest wants, and Shaka reads the index itself. bilibili gives both
     * casings; take either. Shared by the web manifest and the strong one,
     * which borrows these for the files the two have in common. */
    function segmentBaseOf(rep) {
        var sb = rep.SegmentBase || rep.segment_base || {};
        var init = sb.Initialization || sb.initialization || "";
        var index = sb.indexRange || sb.index_range || "";
        if (!/^\d+-\d+$/.test(init) || !/^\d+-\d+$/.test(index)) { return null; }
        return { init: init, index: index };
    }

    /* A stream url without its host and its signature: what names the file. */
    function streamPath(u) {
        return String(u || "").replace(/^[a-z]+:\/\/[^\/]+/i, "").split(/[?#]/)[0];
    }

    return {
        /* Which cover format this set was given, for the boot line. */
        thumbFormat: THUMB_FORMAT,

        onNote: function (fn) { note = fn; },
        bvidOf: bvidOf,

        /* deploy.sh --selftest walks the two detours on a set that never needs
         * them: this television's writes carry no Origin, and its ranking goes
         * with an access_key. */
        _selftest: {
            gateWrites: function (on) { originGated = !!on; },
            rank352: function (on) { rank352 = !!on; }
        },

        setCardWidth: function (px) { if (px > 0) { cardWidth = px; } },

        /* The web home page's feed. Personalised once the session cookies are
         * in play, generic before that — same endpoint either way. */
        recommended: function (page, onOk, onFail) {
            /* This endpoint has no page cursor; fresh_idx asks it for a new
             * batch, which is how the web home page loads more. */
            getJson(BASE + "/x/web-interface/index/top/feed/rcmd?ps=24&fresh_type=4&fresh_idx=" +
                    (page || 1) + "&fresh_idx_1h=" + (page || 1), function (d) {
                var items = (d.item || []).filter(function (v) {
                    return v.goto === "av" && v.bvid;
                });
                onOk(items.map(normalise));
            }, onFail);
        },

        popular: function (page, onOk, onFail) {
            getJson(BASE + "/x/web-interface/popular?ps=24&pn=" + (page || 1), function (d) {
                onOk((d.list || []).map(normalise));
            }, onFail);
        },

        /* rid 0 is the whole site; a partition id narrows it. The endpoint takes
         * no WBI signature at any rid, which is why the zone tabs use the
         * ranking rather than 分区最新 — the newest uploads in a partition are
         * mostly not worth a television screen anyway. */
        /* ---- 直播 (2026-10-18) ----
         * Every live room on the site by how many are watching, thirty to a
         * page. The old area endpoint: unsigned and anonymous (measured from
         * here on 10-18; the newer web lists want a WBI signature). */
        liveRooms: function (page, onOk, onFail) {
            getJson(LIVE + "/room/v1/Area/getListByAreaID?areaId=0&sort=online&pageSize=30&page=" + (page || 1),
                function (d) {
                    var list = (d && d.list) || d || [];
                    onOk(list.map(function (x) { return liveItem(x, false); }));
                }, onFail, true);
        },

        /* Who this account follows that is live now. A web endpoint, so the
         * account rides on access_key the same way as everywhere else; whether
         * this one honours it is answered by the log (app.js reports the raw
         * fields once per run). onOk(items, raw). */
        liveFollowing: function (onOk, onFail) {
            getJson(LIVE + "/xlive/web-ucenter/user/following?page=1&page_size=30&ignoreRecord=1&hit_ab=true",
                function (d) {
                    var raw = (d && d.list) || [];
                    onOk(raw.filter(function (x) { return Number(x.live_status) === 1; })
                            .map(function (x) { return liveItem(x, true); }), raw);
                }, onFail);
        },

        /* Where to fetch a room's picture: HLS with fMP4 segments for Shaka —
         * the MPEG-TS variant would need a transmuxer, and FLV needs flv.js.
         * The TS variant of the same tier comes along as tsUrls, for AVPlay:
         * on Tizen 3.0 the MSE path fails every room with a decode error
         * (issue #5, 10-22) and app.js moves live to the native player.
         * Measured anonymous on 10-18: 原画 asked for, 超清 (250) given, the same
         * qn on avc and hevc; equal tiers go to avc. Asked with the account
         * first (a signed-in viewer may be given more), then without it if the
         * signed request is refused. `qn` asks for a lower tier (AVPlay stepping
         * down when a TS tier will not play, MSE when a tier will not decode);
         * 0 is the best there is.
         * A room with TS and no fMP4 is still a room (urls empty; AVPlay plays
         * the TS): issue #7, 10-23, a Tizen 4.0 set was told 「没有 HLS-fMP4 的流」
         * and nothing said what the room did offer — `shape` says, for the log.
         * The HTTP-FLV of the room comes along as flvUrls, also for AVPlay
         * (10-24): rooms that only offer 原画 have no fMP4, and their TS
         * playlist on d1--ov-gotcha105/105b did not answer in 20 s from here,
         * four rooms out of four, while the same rooms' FLV on
         * d1--ov-gotcha07/07b sent its first bytes in 0.1–1.8 s.
         * onOk({urls, qn, qnName, codec, accept, acceptQn,
         *       tsUrls, tsQn, tsQnName, tsCodec, tsAcceptQn,
         *       flvUrls, flvQn, flvQnName, flvCodec, flvAcceptQn, signed, shape});
         * onFail(why, shape) when none is there. */
        livePlay: function (roomId, onOk, onFail, qn) {
            var url = LIVE + "/xlive/web-room/v2/index/getRoomPlayInfo?room_id=" + encodeURIComponent(roomId) +
                      "&protocol=0,1&format=0,1,2&codec=0,1&qn=" + (qn || 10000) + "&platform=web&ptype=8&dolby=5&panorama=1";
            var signedIn = typeof Auth !== "undefined" && Auth.isLoggedIn();
            function bestOf(pu, formatName) {
                var best = null;
                (pu.stream || []).forEach(function (s) {
                    if (s.protocol_name !== (formatName === "flv" ? "http_stream" : "http_hls")) { return; }
                    (s.format || []).forEach(function (f) {
                        if (f.format_name !== formatName) { return; }
                        (f.codec || []).forEach(function (c) {
                            var qn = Number(c.current_qn) || 0;
                            if (!best || qn > best.qn || (qn === best.qn && c.codec_name === "avc")) {
                                best = { qn: qn, codec: c.codec_name, base: c.base_url,
                                         hosts: c.url_info || [], accept: c.accept_qn || [] };
                            }
                        });
                    });
                });
                return best;
            }
            function urlsOf(b) {
                return b ? b.hosts.map(function (u) { return u.host + b.base + (u.extra || ""); }) : [];
            }
            /* Every protocol/format/codec offered, with its tier and first host:
             * 「http_hls/ts(avc qn10000 d1--cn-gotcha104 ×2)」. */
            function shapeOf(pu) {
                var out = [];
                (pu.stream || []).forEach(function (s) {
                    (s.format || []).forEach(function (f) {
                        var cs = (f.codec || []).map(function (c) {
                            var hosts = c.url_info || [];
                            var h = hosts.length ? String(hosts[0].host || "").replace(/^https?:\/\//, "").split(".")[0] : "无主机";
                            return c.codec_name + " qn" + c.current_qn + " " + h + (hosts.length > 1 ? " ×" + hosts.length : "");
                        });
                        out.push(s.protocol_name + "/" + f.format_name + "(" + cs.join("，") + ")");
                    });
                });
                return out.join(" ") || "一路流都没有";
            }
            function pick(d, signed) {
                if (!d || Number(d.live_status) !== 1) { onFail("没在直播（live_status=" + (d && d.live_status) + "）"); return; }
                if (d.encrypted && !d.pwd_verified) { onFail("加了密码的直播间"); return; }
                var pu = (d.playurl_info && d.playurl_info.playurl) || {};
                var names = {};
                (pu.g_qn_desc || []).forEach(function (q) { names[q.qn] = q.desc; });
                var none = { qn: 0, codec: "", hosts: [], accept: [] };
                var best = bestOf(pu, "fmp4"), ts = bestOf(pu, "ts"), flv = bestOf(pu, "flv");
                if (!best || !best.hosts.length) { best = null; }
                if (!ts || !ts.hosts.length) { ts = null; }
                if (!flv || !flv.hosts.length) { flv = null; }
                var shape = d.playurl_info ? shapeOf(pu) : "没有 playurl_info";
                if (!best && !ts && !flv) { onFail("没给电视放得了的流", shape); return; }
                var urls = urlsOf(best);
                best = best || none;
                ts = ts || none;
                flv = flv || none;
                onOk({
                    urls: urls,
                    qn: best.qn, qnName: names[best.qn] || ("qn" + best.qn), codec: best.codec,
                    accept: best.accept.map(function (q) { return names[q] || String(q); }),
                    acceptQn: best.accept.map(Number),
                    tsUrls: urlsOf(ts), tsQn: ts.qn, tsQnName: names[ts.qn] || ("qn" + ts.qn), tsCodec: ts.codec,
                    tsAcceptQn: ts.accept.map(Number),
                    flvUrls: urlsOf(flv), flvQn: flv.qn, flvQnName: names[flv.qn] || ("qn" + flv.qn), flvCodec: flv.codec,
                    flvAcceptQn: flv.accept.map(Number),
                    signed: signed, shape: shape
                });
            }
            getJson(url, function (d) { pick(d, signedIn); }, function (why) {
                if (!signedIn) { onFail(why); return; }
                getJson(url, function (d) { pick(d, false); },
                        function (why2) { onFail(why + "；不带账号再问也不行：" + why2); }, true);
            });
        },

        /* -352 (2026-10-25): four sets on no account, 10-22 to 10-24, saw
         * 「加载失败：code -352」 on 排行 and the zone tabs — this endpoint only —
         * while 推荐 and 热门 loaded in the same minute; a signed-in set never
         * has (access_key rides along). Reproduced from the dev machine after a
         * dozen of these in a few minutes, and then, interleaved in the same
         * seconds: web -352, app.bilibili.com/x/v2/rank/region code 0 with 100;
         * a WBI signature or a TV-appkey signature, still -352; a buvid3 cookie
         * from finger/spi, code 0 — and so, twice, a buvid3 in the query, but
         * the gate lifted soon after and that pair could not be told apart from
         * the gate lifting. So: the app route first, measured. It takes the
         * 1000-series ids, but any zone comes back code 0 and empty about one
         * time in four, the same request asked again (人工智能 55/55/0/55, 户外潮流
         * 0/55/55/55, 绘画 55/55/55/0; 资讯 empty every time), so an empty answer
         * is asked once more. Empty twice, the web route once more with a buvid3,
         * and the note says whether that did anything. */
        ranking: function (rid, onOk, onFail) {
            var url = BASE + "/x/web-interface/ranking/v2?type=all&rid=" + (rid || 0);
            var where = rid ? "分区 " + rid + " 的排行" : "排行";
            if (rank352) { setTimeout(function () { refused("code -352 -352（自测）"); }, 0); }
            else { getJson(url, function (d) { onOk((d.list || []).map(normalise)); }, refused); }
            function refused(why) {
                if (!/^code -352\b/.test(String(why))) { onFail(why); return; }
                appTry(why, 1);
            }
            function appTry(why, n) {
                rankingApp(rid, function (items) {
                    if (items.length) {
                        note("feed", where + " " + why + "，改走 app 端排行" + (n > 1 ? "（第 " + n + " 次）" : "") +
                             "：" + items.length + " 条");
                        onOk(items);
                        return;
                    }
                    if (n < 2) { setTimeout(function () { appTry(why, n + 1); }, 500); return; }
                    withBuvid(why, "app 端排行两次都是空的");
                }, function (whyApp) { withBuvid(why, "app 端排行也不行：" + whyApp); });
            }
            function withBuvid(why, app) {
                buvid3(function (b) {
                    if (!b) { note("feed", where + " " + why + "，" + app + "，也拿不到 buvid3"); onFail(why); return; }
                    getJson(url + "&buvid3=" + encodeURIComponent(b), function (d) {
                        var items = (d.list || []).map(normalise);
                        note("feed", where + " " + why + "，" + app + "，带 buvid3 重问：" + items.length + " 条");
                        onOk(items);
                    }, function (why2) {
                        note("feed", where + " " + why + "，" + app + "，带 buvid3 重问：" + why2);
                        onFail(why);
                    });
                });
            }
        },

        /* search/all/v2 needs no WBI signature, unlike search/type which
         * answers with an HTML challenge page when called bare. */
        search: function (keyword, page, onOk, onFail) {
            var url = BASE + "/x/web-interface/search/all/v2?keyword=" +
                      encodeURIComponent(keyword) + "&page=" + (page || 1);
            getJson(url, function (d) {
                var groups = d.result || [], out = [];
                for (var i = 0; i < groups.length; i++) {
                    if (groups[i].result_type === "video") {
                        out = (groups[i].data || []).map(normalise);
                        break;
                    }
                }
                onOk(out);
            }, onFail);
        },

        /* Doubles as the proof that the stored session actually reaches the
         * server: isLogin true here means the cookies are being applied. That
         * makes it the only honest way to tell a live account from an expired
         * one, so the account switcher runs it and takes the name, avatar and
         * mid from the answer rather than trusting what is stored. */
        /* The whoami probe in app.js drives these, and each one answers a
         * question no other request can:
         *
         *   bare   — nothing attached at all. Says whether the engine carries a
         *            session of its own, which is the difference between an
         *            account layer that chooses who is signed in and one that
         *            merely describes whoever the engine last saw.
         *   noKey  — the Cookie header and nothing else. This firmware drops it,
         *            which is why access_key exists; keeping the measurement
         *            running is how a firmware that starts honouring it — or a
         *            replacement television that never did — gets noticed
         *            rather than assumed.
         *   bust   — a unique query, so a cached answer cannot stand in for a
         *            live one. */
        nav: function (onOk, onFail, opts) {
            opts = opts || {};
            var xhr = new XMLHttpRequest();
            var url = BASE + "/x/web-interface/nav";
            if (opts.bust) { url += "?_=" + new Date().getTime(); }
            if (!opts.bare && !opts.noKey) { url = withSession(url); }
            xhr.open("GET", url, true);
            if (!opts.bare) { applySession(xhr); }
            xhr.timeout = 20000;
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) { return; }
                var j;
                try { j = JSON.parse(xhr.responseText); }
                catch (e) { onFail("bad JSON"); return; }
                /* code -101 is "not logged in", which is an answer, not a fault. */
                var d = j.data || {};
                onOk({
                    isLogin: !!d.isLogin,
                    uname: d.uname || "",
                    mid: d.mid || 0,
                    face: d.face ? thumb(d.face, 160, 160) : "",
                    level: (d.level_info || {}).current_level,
                    /* Which membership this account actually holds, in
                     * bilibili's own words. `vip.label.text` is the string the
                     * website prints — 大会员 / 年度大会员 / 超级大会员 — and it
                     * settles by observation a question that marketing pages
                     * and memory both answer unreliably. Free: nav is already
                     * called at every startup. */
                    vipStatus: d.vipStatus || (d.vip || {}).status || 0,
                    vipType: d.vipType || (d.vip || {}).type || 0,
                    vipLabel: (((d.vip || {}).label) || {}).text || ""
                });
            };
            xhr.ontimeout = function () { onFail("timeout"); };
            xhr.onerror = function () { onFail("network error"); };
            xhr.send();
        },

        /* Video posts from followed accounts. Login only — signed out this
         * answers -101 rather than an empty list. */
        /* The dynamic feed pages by cursor, not by number: `page=2` on its
         * own answers the first page again, the grid's de-duplication then
         * finds nothing new and marks the tab exhausted — one screen of 动态,
         * ever (reported 2026-09-07: 「动态页面的数量也太少了」). The cursor is
         * the `offset` each answer carries; page 1 starts from none. */
        /* The cursor travels with the caller's cache, not in module state:
         * a page answer that app.js discards (tab changed, cache cleared)
         * must not advance anything, or the next "page 2" goes out with the
         * page-3 cursor. onOk(items, { cursor, more }). */
        dynamic: function (page, cursor, onOk, onFail) {
            page = page || 1;
            if (page > 1 && !cursor) { onOk([], { cursor: "", more: false }); return; }
            getJson(BASE + "/x/polymer/web-dynamic/v1/feed/all?type=video&page=" + page +
                    (page > 1 ? "&offset=" + encodeURIComponent(cursor) : ""), function (d) {
                var next = { cursor: String(d.offset || ""), more: d.has_more !== false };
                var items = d.items || [];
                var out = [];
                for (var i = 0; i < items.length; i++) {
                    var m = items[i].modules || {};
                    var arch = (m.module_dynamic || {}).major;
                    arch = arch && arch.archive;
                    if (!arch || !arch.bvid) { continue; }
                    out.push({
                        bvid: arch.bvid,
                        aid: arch.aid,
                        cid: null,
                        title: stripEm(arch.title),
                        pic: thumb(arch.cover),
                        author: ((m.module_author || {}).name) || "",
                        mid: ((m.module_author || {}).mid) || 0,
                        duration: arch.duration_text || "",
                        play: (arch.stat || {}).play || "",
                        publishedAt: Number(arch.pubdate || arch.pub_time || 0) || 0
                    });
                }
                onOk(out, next);
            }, onFail);
        },

        /* Search-as-you-type suggestions. Handy on a TV, where every extra
         * character costs several button presses. */
        /* bilibili's 热搜 — what the search page offers before anything is
         * typed, since typing on a remote is the expensive part. No WBI
         * signature needed (2026-09-28, answered code 0 unsigned). */
        hotSearch: function (onOk, onFail) {
            getJson(BASE + "/x/web-interface/search/square?limit=10", function (d) {
                var list = ((d && d.trending && d.trending.list) || []);
                onOk(list.map(function (x) { return stripEm(x.show_name || x.keyword || ""); })
                         .filter(function (x) { return !!x; }));
            }, onFail);
        },

        suggest: function (term, onOk, onFail) {
            var url = "https://s.search.bilibili.com/main/suggest?term=" +
                      encodeURIComponent(term) + "&main_ver=v1";
            getJson(url, function (d) {
                /* The list sits under result.tag, not at the top level. */
                var tags = ((d && d.tag) || []);
                onOk(tags.map(function (t) { return stripEm(t.value || t.name || ""); })
                         .filter(function (x) { return !!x; }));
            }, onFail);
        },

        /* bilibili's own history: the phone, the web, and — since `report` —
         * this television too. `app.js` folds it together with the local record
         * into one list in time order. Entries that are not plain videos
         * (bangumi, live, articles) carry no bvid and cannot be opened from
         * here, so they are dropped; `rawCount` still counts them, which is how
         * "24 entries, none of them openable" stays distinguishable from "the
         * request failed". */
        /* Paged, because one page is 24 entries and a set that is also merging
         * its own record against them ends up showing far fewer than either
         * side has — the same video counts once. `history/cursor` pages by
         * cursor rather than by number: the answer carries `max`/`view_at`, and
         * handing both back asks for what comes after that point.
         *
         * Progressive on purpose: `onOk` fires after every page with everything
         * so far, so the first two dozen are on screen in one round trip and the
         * list grows underneath. Both callers are built for being called again —
         * 我的 repaints and finds the focused card by bvid, the home strip only
         * takes the first four. Waiting for all three pages before painting
         * anything would trade a visible list for a spinner. */
        history: function (onOk, onFail, pages) {
            var want = pages || 3, got = [], rawTotal = 0, page = 0;

            function fetchPage(cursor) {
                var url = BASE + "/x/web-interface/history/cursor?ps=24";
                if (cursor && cursor.max) {
                    url += "&max=" + cursor.max + "&view_at=" + (cursor.view_at || 0) +
                           "&business=" + encodeURIComponent(cursor.business || "archive");
                }
                getJson(url, function (d) { take(d); }, function (why) {
                    /* A later page failing is not the list failing: what has
                     * already arrived is good, and the viewer would rather have
                     * two dozen entries than an error where a list was. */
                    if (page) { onOk(got, rawTotal, true); } else { onFail(why); }
                });
            }

            function take(d) {
                var all = d.list || [];
                var out = [];
                for (var i = 0; i < all.length; i++) {
                    var x = all[i];
                    if (!x.history || !x.history.bvid) { continue; }
                    /* `progress` is seconds watched, -1 when finished. The card
                     * draws the same sliver it draws for local history, so the
                     * two sections read alike. */
                    var secs = x.duration || 0;
                    var pos = x.progress;
                    var seen = 0;
                    if (pos === -1) { seen = 1; }
                    else if (secs > 0 && pos > 0) { seen = Math.min(1, pos / secs); }
                    out.push({
                        bvid: x.history.bvid,
                        /* `oid` is the aid for archive entries, and the report
                         * endpoint wants an aid — so a video opened from here
                         * can be reported without a view() round trip first. */
                        aid: x.history.oid || 0,
                        title: x.title,
                        pic: thumb(x.cover || x.pic),
                        author: x.author_name || "",
                        mid: x.author_mid || 0,
                        duration: duration(secs),
                        play: "",
                        publishedAt: Number(x.history.pubdate || x.pubdate || 0) || 0,
                        seen: seen,
                        /* Multi-part entries say which part, same as ours. */
                        page: (x.history.page && x.history.page > 1) ? x.history.page : 0,
                        /* Enough to carry on from the phone: which part, and
                         * how far in. -1 means finished, so start it over. */
                        cid: x.history.cid || null,
                        progressMs: (pos > 0) ? pos * 1000 : 0,
                        /* When, so this can be merged with the local list into
                         * one run of cards in time order rather than sitting in
                         * a section of its own. */
                        at: (x.view_at || 0) * 1000
                    });
                }
                page++;
                rawTotal += all.length;
                got = got.concat(out);
                var cur = d.cursor || {};
                var done = page >= want || !all.length || !cur.max;
                onOk(got, rawTotal, done);
                if (!done) { fetchPage(cur); }
            }

            fetchPage(null);
        },

        /* Read-only personal library. withSession attaches the TV access_key;
         * the installed widget still has to prove these endpoints accept it.
         * Keep authentication failures distinct from genuinely empty lists. */
        favoriteFolders: function (mid, onOk, onFail, aid) {
            getJson(BASE + "/x/v3/fav/folder/created/list-all?up_mid=" +
                    encodeURIComponent(mid) + "&type=2" +
                    (aid ? "&rid=" + encodeURIComponent(aid) : ""), function (d) {
                var raw = (d && d.list) || [], out = [];
                for (var i = 0; i < raw.length; i++) {
                    var f = raw[i];
                    if (!f || !f.id) { continue; }
                    out.push({ id: f.id, title: f.title || "未命名收藏夹",
                               count: Number(f.media_count) || 0,
                               selected: Number(f.fav_state) === 1 });
                }
                onOk(out);
            }, onFail);
        },

        videoLikeState: function (aid, onOk, onFail) {
            getJson(BASE + "/x/web-interface/archive/has/like?aid=" +
                    encodeURIComponent(aid), function (d) { onOk(Number(d) === 1); }, onFail);
        },

        videoCoinState: function (aid, onOk, onFail) {
            getJson(BASE + "/x/web-interface/archive/coins?aid=" +
                    encodeURIComponent(aid), function (d) {
                onOk(Math.max(0, Number((d || {}).multiply) || 0));
            }, onFail);
        },

        /* TV QR login supplies an APP token; browser fallback only works here
         * when this very account owns the engine jar and has a CSRF token. */
        videoActionReady: function () {
            return !!(Auth.accessKey() || (Auth.jarIsOurs() && Auth.csrf()));
        },

        /* The non-WBI reply route still answers on this TV and accepts a page
         * number. Keep comment traffic lazy so it never delays video startup. */
        comments: function (aid, page, onOk, onFail) {
            getJson(BASE + "/x/v2/reply?type=1&oid=" + encodeURIComponent(aid) +
                    "&pn=" + (page || 1) + "&ps=20&sort=2", function (d) {
                var rows = (d && d.replies) || [];
                onOk(rows, !!(d && d.page && page * 20 < Number(d.page.count || 0)));
            }, onFail);
        },

        commentReplies: function (aid, root, page, onOk, onFail) {
            getJson(BASE + "/x/v2/reply/reply?type=1&oid=" + encodeURIComponent(aid) +
                    "&root=" + encodeURIComponent(root) + "&pn=" + (page || 1) +
                    "&ps=20", function (d) {
                var rows = (d && d.replies) || [];
                onOk(rows, !!(d && d.page && page * 20 < Number(d.page.count || 0)));
            }, onFail);
        },

        videoLike: function (aid, liked, onOk, onFail) {
            var key = Auth.accessKey(), csrf = Auth.csrf();
            function failed(why) {
                /* The status GET only remembers recent likes. A stale 0 can
                 * therefore meet an already-liked video; the server's explicit
                 * duplicate code means the requested final state is true. */
                if (liked && /^code 65006\b/.test(String(why))) { onOk({ already: true }); }
                else { onFail(why); }
            }
            if (key) {
                postForm("https://app.bilibili.com/x/v2/view/like",
                         Auth.signTv({ access_key: key, aid: aid, like: liked ? 0 : 1 }),
                         null, onOk, failed);
            } else if (Auth.jarIsOurs() && csrf) {
                postForm(BASE + "/x/web-interface/archive/like",
                         { aid: aid, like: liked ? 1 : 2, csrf: csrf },
                         null, onOk, failed);
            } else { onFail("此账号缺少可用于操作的登录凭证，请用电视二维码重新登录"); }
        },

        /* `alsoLike`: the web page's 「同时点赞内容」, ticked there by default. */
        videoCoin: function (aid, amount, onOk, onFail, alsoLike) {
            var key = Auth.accessKey(), csrf = Auth.csrf();
            var like = alsoLike ? 1 : 0;
            if (key) {
                postForm("https://app.bilibili.com/x/v2/view/coin/add",
                         Auth.signTv({ access_key: key, aid: aid, multiply: amount,
                                       select_like: like }), null, onOk, onFail);
            } else if (Auth.jarIsOurs() && csrf) {
                postForm(BASE + "/x/web-interface/coin/add",
                         { aid: aid, multiply: amount, select_like: like, csrf: csrf },
                         null, onOk, onFail);
            } else { onFail("此账号缺少可用于操作的登录凭证，请用电视二维码重新登录"); }
        },

        videoFavorite: function (aid, folderId, add, onOk, onFail) {
            var key = Auth.accessKey(), csrf = Auth.csrf();
            var fields = { rid: aid, type: 2,
                           add_media_ids: add ? folderId : "",
                           del_media_ids: add ? "" : folderId };
            if (key) {
                fields.access_key = key;
                postForm(BASE + "/medialist/gateway/coll/resource/deal",
                         Auth.signTv(fields), null, onOk, onFail);
            } else if (Auth.jarIsOurs() && csrf) {
                fields.csrf = csrf;
                postForm(BASE + "/x/v3/fav/resource/deal", fields,
                         null, onOk, onFail);
            } else { onFail("此账号缺少可用于操作的登录凭证，请用电视二维码重新登录"); }
        },

        /* 关注 (2026-10-20). Read with /x/relation?fid= — attribute 2 is
         * following, 6 mutual, 128 blocked — and written with
         * /x/relation/modify, act 1 follow / 2 unfollow, re_src 14 (a video
         * page). Both take the TV login's access_key; the web route needs this
         * account's own jar and bili_jct, as the video writes do. */
        followState: function (mid, onOk, onFail) {
            getJson(BASE + "/x/relation?fid=" + encodeURIComponent(mid), function (d) {
                var a = Number((d || {}).attribute) || 0;
                onOk(a === 2 || a === 6);
            }, onFail);
        },

        follow: function (mid, on, onOk, onFail) {
            var key = Auth.accessKey(), csrf = Auth.csrf();
            var fields = { fid: mid, act: on ? 1 : 2, re_src: 14 };
            function failed(why) {
                /* 22014 is 「已经关注了」: the state asked for is the state. */
                if (on && /^code 22014\b/.test(String(why))) { onOk({}); } else { onFail(why); }
            }
            if (key) {
                fields.access_key = key;
                postForm(BASE + "/x/relation/modify", Auth.signTv(fields), null, onOk, failed);
            } else if (Auth.jarIsOurs() && csrf) {
                fields.csrf = csrf;
                postForm(BASE + "/x/relation/modify", fields, null, onOk, failed);
            } else { onFail("此账号缺少可用于操作的登录凭证，请用电视二维码重新登录"); }
        },

        favoriteVideos: function (folderId, page, onOk, onFail) {
            getJson(BASE + "/x/v3/fav/resource/list?media_id=" +
                    encodeURIComponent(folderId) + "&pn=" + (page || 1) +
                    "&ps=20&order=mtime&platform=web", function (d) {
                var raw = (d && d.medias) || [], out = [];
                for (var i = 0; i < raw.length; i++) {
                    var v = raw[i];
                    if (!v || Number(v.type) !== 2 || !(v.bvid || v.bv_id) || v.attr) { continue; }
                    out.push({
                        bvid: v.bvid || v.bv_id, aid: v.id || 0, cid: null,
                        title: stripEm(v.title), pic: thumb(v.cover),
                        author: (v.upper || {}).name || "",
                        mid: (v.upper || {}).mid || 0,
                        duration: duration(v.duration || 0),
                        play: count((v.cnt_info || {}).play),
                        publishedAt: Number(v.pubtime || 0) || 0
                    });
                }
                onOk(out, !!(d && d.has_more), raw.length);
            }, onFail);
        },

        followings: function (mid, page, onOk, onFail) {
            page = page || 1;
            var query = "vmid=" + encodeURIComponent(mid) + "&pn=" + page + "&ps=50";
            function deliver(d, appRoute) {
                var raw = (d && d.list) || [], out = [];
                for (var i = 0; i < raw.length; i++) {
                    var u = raw[i];
                    if (!u || !u.mid) { continue; }
                    out.push({ mid: u.mid, name: u.uname || "UP 主",
                               face: thumb(u.face, 160, 160),
                               sign: u.sign || "" });
                }
                var total = Number((d || {}).total || 0);
                var limit = appRoute && page >= 5 && page * 50 < total;
                onOk(out, raw.length > 0 && page * 50 < total && !(appRoute && page >= 5), limit);
            }
            function appFallback() {
                /* The web relation endpoint can return code 0 with an empty
                 * list when a TV's file:// request has no bilibili Referer.
                 * The app endpoint uses the same video uploader records and
                 * does not require that browser-only header. */
                var app = "https://app.bilibili.com/x/v2/relation/followings?";
                var key = Auth.accessKey();
                var url = app + (key
                    ? Auth.signTv({ access_key: key, vmid: mid, pn: page, ps: 50 })
                    : query);
                getJson(url, function (d) { deliver(d, true); }, function () {
                    /* The public app route is still useful if a TV token is
                     * rejected by this older endpoint. */
                    if (key) { getJson(app + query, function (d) { deliver(d, true); }, onFail); }
                    else { onFail("关注列表暂时无法读取"); }
                });
            }
            getJson(BASE + "/x/relation/followings?" + query, function (d) {
                if (!d || !d.list || (!d.list.length && page === 1)) { appFallback(); }
                else { deliver(d, false); }
            }, appFallback);
        },

        /* 稍后再看 — the pull-side substitute for casting.
         *
         * Casting to this app is impossible and always will be: a receiver has
         * to listen on the network (SSDP, mDNS, a control server) and a Tizen
         * web widget cannot open a port — the same wall that stopped AVPlay
         * being handed a local MPD. This is the way round it that needs no
         * listening at all: tap 稍后再看 on the phone, walk to the television,
         * it is on the tab. The phone is where things get found, the set is
         * where they get watched — the same division 我的 already runs on.
         *
         * It authenticates on `access_key`, measured 2026-08-15 with both arms
         * because one arm proves nothing: with the key `code 0`, bare request
         * `code -101 账号未登录`. `withSession` puts the key in the query, so
         * nothing here has to know about it.
         *
         * The list arrives whole — no cursor, no pages.
         *
         * `raw` goes back to the caller alongside the mapped cards, and that is
         * deliberate: nobody in this repository has ever seen this response, so
         * app.js prints the field names of the first entry once per run rather
         * than letting a wrong guess turn into blank cards. Cards whose shape
         * is assumed from a sibling endpoint fail silently and look like an
         * empty account. */
        toview: function (onOk, onFail) {
            getJson(BASE + "/x/v2/history/toview", function (d) {
                var all = (d && d.list) || [];
                var out = [];
                for (var i = 0; i < all.length; i++) {
                    var x = all[i];
                    if (!x || !x.bvid) { continue; }
                    var v = normalise(x);
                    /* Same two numbers history carries, read the same way: how
                     * far in, and -1 for finished. A card added on the phone and
                     * half-watched there should open where it was left. */
                    var secs = x.duration || 0, pos = x.progress;
                    v.seen = (pos === -1) ? 1
                           : (secs > 0 && pos > 0 ? Math.min(1, pos / secs) : 0);
                    v.progressMs = (pos > 0) ? pos * 1000 : 0;
                    /* When it was put on the list. Not decoration: it is what
                     * puts the thing just tapped on the phone under the cursor. */
                    v.at = (x.add_at || 0) * 1000;
                    /* Negative means the archive is gone (taken down, under
                     * review). Carried rather than acted on until there is a
                     * real one to look at. */
                    v.state = (typeof x.state === "number") ? x.state : 0;
                    out.push(v);
                }
                onOk(out, all);
            }, onFail);
        },

        /* One uploader's videos, newest first, paged by cursor.
         *
         * Not the web endpoint. `x/space/wbi/arc/search` on api.bilibili.com is
         * the documented route and it answers code=0 from this set — one time in
         * three. Measured on the device on 2026-09-16, four rounds, ~40 requests:
         * signed with a real WBI w_rid it went 2/10, then 3/3, then 1/3; the
         * unsigned `series/recArchivesByKeywords` went 2/3; the failures are
         * HTTP 412 pages and `-352 风控校验失败`, alternating, and nothing sent
         * along changes the odds — access_key on or off, the dm_img_* fingerprint
         * params, withCredentials. That is an IP-level gate on the space paths
         * of api.bilibili.com, not a signature problem, and there is no header
         * this widget can add to pass it (the Cookie header never leaves the
         * engine, see docs/平台坑.md).
         *
         * `app.bilibili.com/x/v2/space/archive/cursor` is the phone app's route
         * to the same list, signed the way playurl already signs — TV appkey,
         * access_key in the params — and it went 3/3 in the same run, with a
         * 15-second cadence the web routes were failing at. Same measurement,
         * same minute, same television. The payload is the app's shape: `param`
         * is the aid as a string, `duration` is seconds, `play` a number,
         * `first_cid` lets playback start without a view() round trip, and the
         * next page is asked for with `aid=<last param>`. */
        space: function (mid, cursor, onOk, onFail) {
            var params = { vmid: mid, ps: 20, order: "pubdate",
                           platform: "android", mobi_app: "android", build: 7280300 };
            if (typeof Auth !== "undefined" && Auth.isLoggedIn() && Auth.accessKey()) {
                params.access_key = Auth.accessKey();
            }
            if (cursor) { params.aid = cursor; }
            getJson("https://app.bilibili.com/x/v2/space/archive/cursor?" + Auth.signTv(params),
                    function (d) {
                var raw = (d && d.item) || [], out = [];
                for (var i = 0; i < raw.length; i++) {
                    var x = raw[i];
                    if (!x || !x.bvid || x.goto === "live") { continue; }
                    out.push({
                        bvid: x.bvid,
                        aid: Number(x.param) || 0,
                        cid: x.first_cid || null,
                        title: stripEm(x.title),
                        pic: thumb(x.cover),
                        author: x.author || "",
                        mid: mid,
                        duration: duration(x.duration || 0),
                        play: count(x.play),
                        /* The app space route calls this ctime, unlike web
                         * feeds and view(), which call it pubdate. */
                        publishedAt: Number(x.pubdate || x.pubtime || x.ctime || 0) || 0
                    });
                }
                var last = raw.length ? raw[raw.length - 1] : null;
                onOk(out, { cursor: last ? String(last.param || "") : "",
                            more: !!(d && d.has_next) && !!last });
            }, onFail);
        },

        /* Where this account left this particular video, straight from
         * bilibili — `last_play_cid` and `last_play_time` (milliseconds).
         *
         * The history list only carries the last two dozen entries, so the
         * handoff built on it works for a video opened from 我的 and for
         * nothing else. This answers for any video, however it was found: a
         * search result, a card in 推荐, a part deep inside a series. It is one
         * small GET and it is fired alongside playurl rather than before it, so
         * it costs no time on the way to a picture. */
        playerV2: function (bvid, cid, onOk, onFail) {
            getJson(BASE + "/x/player/v2?bvid=" + bvid + "&cid=" + cid, function (d) {
                /* Chapters ride along on the same answer, so marking the bar
                 * costs no extra request. Most uploads have none. */
                var vp = [];
                var raw = d.view_points || [];
                for (var i = 0; i < raw.length; i++) {
                    if (!raw[i] || raw[i].from === undefined) { continue; }
                    vp.push({
                        from: raw[i].from, to: raw[i].to,
                        title: raw[i].content || ""
                    });
                }
                onOk({
                    cid: d.last_play_cid || 0,
                    positionMs: d.last_play_time || 0,
                    chapters: vp,
                    subtitles: (d.subtitle && d.subtitle.subtitles) || []
                });
            }, onFail);
        },

        /* Subtitle files are plain JSON, not the usual {code,data} envelope.
         * Accept only bilibili's HTTPS media hosts: the URL comes from the
         * player metadata, but it still must never carry a session elsewhere. */
        subtitle: function (url, onOk, onFail) {
            var u = String(url || "");
            if (u.indexOf("//") === 0) { u = "https:" + u; }
            var host = /^https:\/\/([^\/?#]+)/i.exec(u);
            if (!host || !/(^|\.)(hdslb\.com|bilibili\.com|biliimg\.com)$/i.test(host[1])) {
                onFail("invalid subtitle URL");
                return;
            }
            var xhr = new XMLHttpRequest(), done = false;
            function fail(why) { if (!done) { done = true; onFail(why); } }
            xhr.open("GET", u, true);
            xhr.timeout = 12000;
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4 || done) { return; }
                if (xhr.status !== 200) { fail("HTTP " + xhr.status); return; }
                var j;
                try { j = JSON.parse(xhr.responseText); }
                catch (e) { fail("bad subtitle JSON"); return; }
                var body = j && j.body, cues = [];
                if (!body || !body.length) { done = true; onOk(cues); return; }
                for (var i = 0; i < body.length; i++) {
                    if (!body[i]) { continue; }
                    var from = Number(body[i].from), to = Number(body[i].to);
                    if (!isFinite(from) || !isFinite(to) || to <= from ||
                            typeof body[i].content !== "string") { continue; }
                    cues.push({ from: from, to: to, text: body[i].content.slice(0, 400) });
                }
                cues.sort(function (a, b) { return a.from - b.from; });
                done = true;
                onOk(cues);
            };
            xhr.onerror = function () { fail("network error"); };
            xhr.ontimeout = function () { fail("timeout"); };
            try { xhr.send(); } catch (e) { fail("request error"); }
        },

        /* The sprite sheets behind the scrub preview.
         *
         * Frames are laid out cols × rows per sheet. `index` gives each frame's
         * second — when bilibili omits it, and on long uploads it does, the
         * frames are evenly spaced and the caller works the position out from
         * the duration instead. */
        videoshot: function (bvid, cid, onOk, onFail) {
            getJson(BASE + "/x/player/videoshot?index=1&bvid=" + bvid + "&cid=" + cid,
                    function (d) {
                var sheets = [];
                var raw = d.image || [];
                for (var i = 0; i < raw.length; i++) {
                    if (!raw[i]) { continue; }
                    sheets.push(String(raw[i]).indexOf("//") === 0
                        ? "https:" + raw[i] : String(raw[i]).replace(/^http:/, "https:"));
                }
                if (!sheets.length) { onFail("没有缩略图"); return; }
                onOk({
                    sheets: sheets,
                    cols: d.img_x_len || 10,
                    rows: d.img_y_len || 10,
                    index: (d.index && d.index.length) ? d.index : []
                });
            }, onFail);
        },

        /* Tell bilibili where this television got to, so the phone shows it.
         * `progress` is seconds, or -1 for watched to the end — the same
         * convention the history endpoint reports back. Failures go no further
         * than the caller's log: a history write that does not land is not
         * something to interrupt a video for.
         *
         * The endpoint takes either kind of credential and this device has a
         * different one from a browser, so both are tried in order and the log
         * records which carried it. The web shape — aid/cid/progress/csrf —
         * succeeds from a logged-in Chrome and comes back -400 请求错误 from the
         * television, with or without a Referer (Chrome without one still
         * succeeds, so that is not the difference). What the television cannot
         * produce is an Origin the site recognises, and `setRequestHeader`
         * cannot forge one. The TV login's access token goes in the body
         * instead, signed with the same appkey the login itself used, and owes
         * nothing to headers. */
        report: function (aid, cid, progressSeconds, onOk, onFail) {
            if (!aid || !cid) {
                if (onFail) { onFail("缺 aid/cid"); }
                return;
            }
            var url = BASE + "/x/v2/history/report";
            var attempts = [];
            var key = Auth.accessKey();
            var csrf = Auth.csrf();

            if (key) {
                attempts.push({ how: "access_key", body: Auth.signTv({
                    access_key: key, aid: aid, cid: cid, progress: progressSeconds
                }) });
            }
            if (csrf) {
                attempts.push({ how: "csrf", body: {
                    aid: aid, cid: cid, progress: progressSeconds, csrf: csrf
                } });
            }
            if (!attempts.length) {
                if (onFail) { onFail("这个账号既没有 access_key 也没有 csrf"); }
                return;
            }

            var tried = [];
            function attempt(i) {
                var a = attempts[i];
                postForm(url, a.body, null, function (j) {
                    if (onOk) {
                        onOk(j, "走的是 " + a.how +
                                (tried.length ? "（先失败：" + tried.join("；") + "）" : ""));
                    }
                }, function (why) {
                    tried.push(a.how + " " + why);
                    if (i + 1 < attempts.length) { attempt(i + 1); return; }
                    if (onFail) { onFail(tried.join("；")); }
                });
            }
            attempt(0);
        },

        /* `/x/web-interface/view` started answering **HTTP 412** — a risk-control
         * HTML page, not JSON — on 2026-09-07, probed from this network with
         * the set's UA, a desktop UA, a Referer, a buvid3 cookie and by aid:
         * 412 every time, while `archive/related` and `player/pagelist` on the
         * same host answered 200. Its wbi twin (`/x/web-interface/wbi/view`)
         * answers 200 with the identical payload *unsigned*. Everything the
         * panel lists (parts, description) and the aid the strong-token rescue
         * mints from come out of this one call, so a 412 here was a panel with
         * no part list and a rescue path with no aid — both silent.
         *
         * The wbi path is the fallback, not the first choice: it is the one that
         * may start insisting on its signature some day, and the plain path is
         * the one the set has been measured on with an access_key. Whichever
         * answered is passed to the caller as `via` (empty for the plain path)
         * so the log says which one this set actually needs — that answer
         * cannot be probed from a desk, the requests differ in what they carry.
         *
         * No fallback on -404: that is a JSON answer about the 稿件, and the
         * dead-video check downstream reads it by that text. */
        view: function (bvid, onOk, onFail) {
            function shape(d) {
                return {
                    bvid: d.bvid,
                    aid: d.aid,
                    cid: d.cid,
                    title: d.title,
                    desc: d.desc,
                    pic: thumb(d.pic, 960, 600),
                    author: (d.owner || {}).name,
                    mid: (d.owner || {}).mid || 0,
                    /* The uploader page's header. Only view() carries the face;
                     * a card opened straight from a feed reaches the page
                     * without one and the header shows the name alone. */
                    face: thumb((d.owner || {}).face, 120, 120),
                    duration: duration(d.duration),
                    play: count((d.stat || {}).view),
                    publishedAt: Number(d.pubdate || 0) || 0,
                    season: seasonOf(d.ugc_season),
                    /* Set on the entries that stand for a 番剧 / 影视 episode
                     * (…/bangumi/play/ep813154): their streams live behind the
                     * PGC playurl, and the UGC one answers -404 (10-20). */
                    redirect: String(d.redirect_url || ""),
                    /* For the panel's three buttons. copyright 2 is a 转载,
                     * which takes one coin, not two. */
                    stat: { like: Number((d.stat || {}).like) || 0, coin: Number((d.stat || {}).coin) || 0,
                            fav: Number((d.stat || {}).favorite) || 0 },
                    copyright: Number(d.copyright) || 0,
                    /* 充电专属: only the uploader's 充电 members get the whole
                     * video; everyone else is served a 试看 clip, or nothing
                     * (BV19GM36GEno, 10-20: the app endpoint answers 87007). */
                    upowerOnly: !!d.is_upower_exclusive && !d.is_upower_play,
                    pages: (d.pages || []).map(function (p) {
                        /* Per-part length, formatted here like every other
                         * duration in this file. It is seconds on a page and
                         * seconds on an archive, and the panel is the only place
                         * that can use it — a five-hour part and a four-minute
                         * one look identical in a list of names. */
                        return { cid: p.cid, page: p.page, part: p.part,
                                 duration: duration(p.duration) };
                    })
                };
            }
            /* Only the gate's own shapes count: an HTTP status (412 today), a
             * non-JSON body, or bilibili's risk-control codes. A timeout or a
             * dropped connection is the link, and asking a second endpoint on
             * the same dead link only turns a 20 s wait into 40 s — for the
             * search-result open, the 403 rescue's aid lookup and the
             * dead-video check alike. */
            function gated(why) { return /^HTTP |^bad JSON|code -352|code -403/.test(String(why)); }
            var plain = BASE + "/x/web-interface/view?bvid=" + bvid;
            var twin = BASE + "/x/web-interface/wbi/view?bvid=" + bvid;
            /* The gate is not per request: 2026-09-28 it answered 412 to 14 of
             * 14 videos, each one a wasted request into the very IP gate that
             * was refusing it. Once it has refused, the twin goes first for a
             * while, with the plain endpoint kept as the fallback in case the
             * gate has moved to the twin instead. */
            if (new Date().getTime() < viewGatedUntil) {
                getJson(twin, function (d) {
                    onOk(shape(d), "wbi/view 答上了（view 近来被闸，先问它）");
                }, function (why2) {
                    if (!gated(why2)) { onFail("wbi/view " + why2); return; }
                    getJson(plain, function (d) {
                        viewGatedUntil = 0;
                        onOk(shape(d), "wbi/view 答 " + why2 + "，view 又答上了");
                    }, function (why1) {
                        onFail("wbi/view " + why2 + "；view " + why1);
                    });
                });
                return;
            }
            getJson(plain, function (d) {
                onOk(shape(d), "view 直接答上了");
            }, function (why1) {
                if (!gated(why1)) { onFail(why1); return; }
                viewGatedUntil = new Date().getTime() + VIEW_GATE_MEMORY;
                getJson(twin, function (d) {
                    onOk(shape(d), "view 答 " + why1 + "，wbi/view 不签名答上了（之后 30 分钟先问它）");
                }, function (why2) {
                    onFail("view " + why1 + "；wbi/view " + why2);
                });
            });
        },

        /* bilibili's "this 稿件 is gone" as getJson formats it. Three places
         * read the failure text for it; one definition, so a change to the
         * text's shape has one place to break instead of three silent ones. */
        gone: function (why) { return String(why).indexOf("-404") >= 0; },

        /* 12345 → "1.2万", the way every count in this file is written. */
        countText: count,

        /* Whether a 番剧 / 影视 episode would play here, asked only to say why it
         * does not: this client has no PGC playback. `redirect` is view()'s
         * …/bangumi/play/ep813154 (or ss…). onAnswer(null) means bilibili would
         * serve it; otherwise its own reason, e.g. 「抱歉您所在地区不可观看！」
         * — what this network was told for 风骚律师 on 2026-10-20. */
        pgcAvailability: function (redirect, cid, onAnswer) {
            var m = /\/bangumi\/play\/(ep|ss)(\d+)/.exec(String(redirect || ""));
            if (!m) { onAnswer("不是番剧链接"); return; }
            var url = BASE + "/pgc/player/web/playurl?" + (m[1] === "ep" ? "ep_id=" : "season_id=") + m[2] +
                      (cid ? "&cid=" + cid : "") + "&qn=16&fnval=16&fnver=0&fourk=1";
            getJson(url, function () { onAnswer(null); }, function (why) {
                onAnswer(String(why).replace(/^code -?\d+\s*/, "") || String(why));
            });
        },

        related: function (bvid, onOk, onFail) {
            getJson(BASE + "/x/web-interface/archive/related?bvid=" + bvid, function (d) {
                onOk((d || []).map(normalise));
            }, onFail);
        },

        /* Progressive first: AVPlay handles durl natively, with real seeking and
         * hardware decode. DASH is only needed when a video has no durl. */
        playurlProgressive: function (bvid, cid, qn, onOk, onFail) {
            var url = BASE + "/x/player/playurl?bvid=" + bvid + "&cid=" + cid +
                      "&qn=" + (qn || 64) + "&fnval=1";
            getJson(url, function (d) {
                if (!d.durl || !d.durl.length) { onFail("no progressive stream"); return; }
                /* AVPlay plays this one, so it gets the http:// twins. */
                var urls = mirrors(d.durl[0].url, d.durl[0].backup_url, true);
                onOk({ url: urls[0], urls: urls,
                       quality: d.quality, accept: d.accept_quality || [] });
            }, onFail);
        },

        playurlDash: function (bvid, cid, qn, onOk, onFail) {
            /* The 4K bit (128) joins the AV1 one when the quality setting reaches
             * 4K — see fnvalFor. */
            /* 2064 = 16 (DASH) | 2048 (AV1). fnval gates which codec families
             * the response carries at all: with plain 16 the answer holds avc
             * and hev tracks only, and the av01-first preference in mpd.js was
             * discovered selecting from a list with zero av01 entries — the
             * web player's av01 default works because its fnval asks for it.
             * Only the AV1 bit is added; HDR/DoVi/8K stay unrequested. */
            var url = BASE + "/x/player/playurl?bvid=" + bvid + "&cid=" + cid +
                      "&qn=" + (qn || 64) + "&fnval=" + fnvalFor(qn) + "&fnver=0&fourk=1";
            getJson(url, function (d) {
                if (!d.dash) { onFail("no dash streams"); return; }

                /* Signed in, bilibili often hands out a PCDN node as the primary
                 * host, and those answer 403 to a plain range request. Every
                 * representation ships alternatives, so carry them all and let
                 * the player work down the list. Deprioritise the mcdn hosts
                 * rather than dropping them: sometimes they are all there is. */
                function candidates(rep) {
                    /* MSE fetches over XHR, so no http:// twins — they would be
                     * the same hosts listed twice. */
                    return mirrors(rep.baseUrl || rep.base_url,
                                   rep.backupUrl || rep.backup_url, false);
                }
                var kinds = ["video", "audio"];
                for (var k = 0; k < kinds.length; k++) {
                    var list = d.dash[kinds[k]] || [];
                    for (var i = 0; i < list.length; i++) {
                        list[i].urls = candidates(list[i]);
                        list[i].baseUrl = list[i].urls[0];
                        list[i].segments = segmentBaseOf(list[i]);
                    }
                }
                /* Carry the tier list across: the panel had to guess it. */
                d.dash.acceptQuality = d.accept_quality || [];
                /* Stream urls expire — `deadline` in the query is unix seconds,
                 * roughly two hours out. Stamped here so the restart paths can
                 * tell a reusable response from one whose every url is already
                 * dead: a manifest rebuilt from expired urls fails on each
                 * segment, which turns "pause overnight, press play" into an
                 * audible exit. The web player re-asks playurl instead. */
                var rep0 = (d.dash.video && d.dash.video[0]) || {};
                var dm = /[?&]deadline=(\d+)/.exec(String(rep0.baseUrl || ""));
                d.dash.deadline = dm ? parseInt(dm[1], 10) : 0;
                d.dash.fetchedAt = new Date().getTime();
                onOk(d.dash);
            }, onFail);
        },

        /* Where the strong-token path is, for a watchdog in app.js. It can sit
         * silent for minutes by construction — 15 header reads, two at a time,
         * 15s timeout and one retry each — and 2026-09-28 it sat 16s with not
         * one line before the app was restarted over it, so nobody could say
         * whether it was the app endpoint or the CDN that was not answering. */
        strongProgress: function () {
            var p = strongState;
            if (!p) { return "没有在铸"; }
            var now = new Date().getTime();
            return "已 " + (now - p.t0) + "ms：app端点=" + (p.app || "未答") +
                   " codecs=" + (p.codecs || "未答") +
                   (p.total ? " 文件头 " + p.ok + " 成 " + p.bad + " 败 " +
                              p.retried + " 重试 / 共 " + p.total + "，在飞 " + p.active +
                              "（最早那个已 " + (p.oldest ? now - p.oldest : 0) + "ms）"
                            : " 文件头还没开始读");
        },

        /* The strong-token path, for videos the web endpoint cannot play.
         *
         * ── Why this exists (2026-08-11, measured to the byte) ──
         * `platform` decides how strong a stream token bilibili mints. The web
         * endpoint /x/player/playurl carries platform=pc and its token is
         * refused (403) by the CDN's strict nodes — the ones serving reuploaded
         * films. app.bilibili.com/x/playurl carries platform=android and its
         * token is accepted. Same file, same host, same second: web 403, app
         * 206. That is the whole of "the phone plays it, the television does
         * not" — the phone is an app-endpoint client. Cookie sessions would
         * also mint strong tokens, but this firmware cannot carry cookies
         * (forbidden header can't be set, jar can't be filled — both measured),
         * so the app endpoint is the only door left, and access_key opens it.
         *
         * ── The catch, and the fix ──
         * The app endpoint hands back base_url + size but no SegmentBase, and
         * Shaka needs the init/index byte ranges. They are not in the response
         * but they are in the file: read the first 16KB, walk the MP4 boxes,
         * moov gives the init range and the sidx that follows gives the index
         * range. Verified against the web endpoint's own SegmentBase on every
         * tier it does return — byte-identical. codecs strings the app endpoint
         * omits are taken from the web endpoint's low tiers (same cid, same box
         * type per family), width/height from the qn.
         *
         * Only reached when the web endpoint's token is refused — normal videos
         * never pay for the header reads. Requires aid: the app endpoint rejects
         * bvid with -400.
         *
         * `webDash`, when the caller has the session's web manifest, lends its
         * segment indexes: see `known` below. */
        playurlDashStrong: function (aid, cid, qn, onOk, onFail, avoid, webDash) {
            if (typeof Auth === "undefined" || !Auth.accessKey()) {
                onFail("无 access_key，app 端点不可用"); return;
            }
            var WH = { 120: [3840, 2160], 116: [1920, 1080], 112: [1920, 1080],
                       80: [1920, 1080], 74: [1280, 720], 64: [1280, 720],
                       32: [854, 480], 16: [640, 360] };

            /* moov ends the init segment; the sidx that follows is the index.
             * Both stated the way a DASH SegmentBase wants them, "start-end". */
            function ranges(buf) {
                var dv = new DataView(buf), off = 0, initEnd = -1, ss = -1, se = -1;
                while (off + 8 <= dv.byteLength) {
                    var size = dv.getUint32(off);
                    var type = String.fromCharCode(dv.getUint8(off + 4), dv.getUint8(off + 5),
                                                   dv.getUint8(off + 6), dv.getUint8(off + 7));
                    if (size < 8) { break; }
                    if (type === "moov") { initEnd = off + size - 1; }
                    if (type === "sidx") { ss = off; se = off + size - 1; break; }
                    off += size;
                }
                if (initEnd < 0 || ss < 0) { return null; }
                return { init: "0-" + initEnd, index: ss + "-" + se };
            }

            function readSidx(url, done) {
                var xhr = new XMLHttpRequest();
                xhr.open("GET", url, true);
                xhr.responseType = "arraybuffer";
                xhr.timeout = 15000;
                /* Only the first ~9KB matters — moov ends near byte 1000 and the
                 * sidx box header (its size field is all `ranges` reads) sits
                 * just after. This CDN truncates a range to a few KB on its edge
                 * nodes, so ask for exactly what the box headers need, not a
                 * round 16KB it may cut short. */
                try { xhr.setRequestHeader("Range", "bytes=0-12287"); } catch (e) {}
                xhr.onreadystatechange = function () {
                    if (xhr.readyState !== 4) { return; }
                    if (xhr.status < 200 || xhr.status >= 300 || !xhr.response) { done(null); return; }
                    try { done(ranges(xhr.response)); } catch (e) { done(null); }
                };
                xhr.ontimeout = xhr.onerror = function () { done(null); };
                xhr.send();
            }

            /* One retry per stream: on the television's HTTP stack a first read
             * fails often enough that a single retry is the difference between
             * 4 tiers surviving and 12 — 2026-08-11 measured exactly that gap. */
            function readSidxRetry(url, done) {
                readSidx(url, function (seg) {
                    if (seg) { done(seg); return; }
                    if (st) { st.retried++; }
                    readSidx(url, done);
                });
            }

            /* At most 2 header reads in flight — a burst is what trips this
             * CDN's per-IP limiter, which is the very thing that was starving
             * the 403'd tiers to begin with; 2 keeps the pipe busy without it. */
            function fillSegments(streams, whenDone) {
                /* Streams whose index was borrowed from a web answer need no read. */
                streams = streams.filter(function (s) { return !s.segments; });
                var i = 0, active = 0, remaining = streams.length;
                if (!remaining) { whenDone(); return; }
                function pump() {
                    while (active < 2 && i < streams.length) {
                        (function (s) {
                            active++;
                            var began = new Date().getTime();
                            if (st) { st.active = active; st.starts.push(began); st.oldest = st.starts[0]; }
                            readSidxRetry(s.baseUrl, function (seg) {
                                s.segments = seg; active--; remaining--;
                                if (st) {
                                    if (seg) { st.ok++; } else { st.bad++; }
                                    st.active = active;
                                    st.starts.splice(st.starts.indexOf(began), 1);
                                    st.oldest = st.starts[0] || 0;
                                }
                                if (remaining === 0) { whenDone(); } else { pump(); }
                            });
                        })(streams[i++]);
                    }
                }
                pump();
            }

            /* access_key goes IN the signed params. withSession() only appends
             * it for api.bilibili.com urls, and this is app.bilibili.com — so
             * without it here the request is anonymous (appkey only) and the
             * "strong" token it mints is exactly the weak, refused one this whole
             * path exists to avoid. This was the real cause of the 4-tiers-of-12
             * 480p result that looked like throttling: it was never authenticated.
             * signTv adds appkey+ts+sign; the token identity is access_key. */
            var appUrl = "https://app.bilibili.com/x/playurl?" +
                Auth.signTv({ access_key: Auth.accessKey(), aid: aid, cid: cid,
                              qn: qn || 80, fnval: fnvalFor(qn), fnver: 0, fourk: 1,
                              platform: "android", mobi_app: "android",
                              build: 7280300 });
            /* codecs the app endpoint omits: the web endpoint's low tiers
             * carry them, and a family's box type is constant within a cid,
             * so the string maps by codecid. Asked in parallel with the app
             * endpoint — it depends on nothing the app answer carries, and
             * serialising the two cost a round trip on a black screen. The
             * three stages are timed and stamped on the response so the log
             * can say where a 9-second strong-token start actually went. */
            var t0 = new Date().getTime(), tApp = 0, tCodecs = 0;
            var st = strongState = { t0: t0, app: "", codecs: "", total: 0, ok: 0, bad: 0,
                                     retried: 0, active: 0, starts: [], oldest: 0 };
            var wdDone = false, wdData = null, adData = null, joined = false;
            var url2 = BASE + "/x/player/playurl?avid=" + aid + "&cid=" + cid +
                       "&qn=" + (qn || 80) + "&fnval=" + fnvalFor(qn) + "&fnver=0&fourk=1";
            function url2Settled(wd) {
                wdData = wd || null; wdDone = true;
                tCodecs = new Date().getTime() - t0;
                st.codecs = (wd ? "" : "失败 ") + tCodecs + "ms";
                joinStrong();
            }
            /* Runs once both answers are in, whichever lands last. */
            function joinStrong() {
                if (!adData || !wdDone || joined) { return; }
                joined = true;
                var ad = adData;
                function go() {
                    var codecsByCid = {}, audioCodecs = "mp4a.40.2";
                    var wd = wdData || {};
                    var wv = (wd.dash && wd.dash.video) || [];
                    for (var w = 0; w < wv.length; w++) { codecsByCid[wv[w].codecid] = wv[w].codecs; }
                    if (wd.dash && wd.dash.audio && wd.dash.audio[0]) {
                        audioCodecs = wd.dash.audio[0].codecs || audioCodecs;
                    }
                    finish(ad.dash, codecsByCid, audioCodecs);
                }
                go();

                function codecsFor(cid2, map) {
                    return map[cid2] ||
                           (cid2 === 7 ? "avc1.640033"
                          : cid2 === 12 ? "hev1.1.6.L153.90"
                          : cid2 === 13 ? "av01.0.08M.08" : "avc1.640033");
                }

                function finish(dash, codecsByCid, audioCodecs) {
                    function candidates(rep) {
                        return mirrors(rep.baseUrl || rep.base_url,
                                       rep.backupUrl || rep.backup_url, false);
                    }
                    var video = dash.video || [], audio = dash.audio || [];
                    /* Tiers above the cap are never in the manifest (Mpd.build
                     * caps at Settings.qnCap()), so their headers are not worth a
                     * read: each one is ~1 s of a black screen at concurrency
                     * two. Free today (this account is offered ≤80) and a
                     * guard for a 大会员 account or a raised cap. */
                    var cap = qn || 80;
                    video = video.filter(function (r) { return !(r.id > cap); });
                    var s, wh;
                    for (var v = 0; v < video.length; v++) {
                        s = video[v];
                        s.urls = candidates(s);
                        s.baseUrl = s.urls[0];
                        s.codecs = codecsFor(s.codecid, codecsByCid);
                        s.mimeType = "video/mp4";
                        wh = WH[s.id] || [1920, 1080];
                        s.width = wh[0]; s.height = wh[1];
                        /* The app endpoint states it snake_case; camelCase is
                         * always undefined, which stamped every rep 25fps. */
                        s.frameRate = s.frame_rate || s.frameRate || "25";
                    }
                    for (var a = 0; a < audio.length; a++) {
                        s = audio[a];
                        s.urls = candidates(s);
                        s.baseUrl = s.urls[0];
                        s.codecs = audioCodecs;
                        s.mimeType = "audio/mp4";
                    }
                    /* The web answers already say where each file's init and
                     * index sit: the codec lookup above (asked at the cap, with
                     * the same fnval, so it lists the same tiers) and the
                     * session's own web manifest. Same path on the CDN is the
                     * same file, whichever endpoint signed the url — the bad-file
                     * list has keyed both by file name since 09-28 — so a strong
                     * stream with a matching path takes the index and skips its
                     * header read. Those reads were 1.8–3.4 s of black screen per
                     * strong start on 10-18 and 3.3 s on 10-20, and a stream
                     * with no match is read exactly as before. */
                    var known = {}, reused = 0;
                    function learnIndex(list) {
                        for (var li = 0; li < (list || []).length; li++) {
                            var r0 = list[li], seg0 = r0.segments || segmentBaseOf(r0);
                            if (!seg0) { continue; }
                            var us0 = [].concat(r0.urls || [], r0.baseUrl || r0.base_url || [],
                                                r0.backupUrl || r0.backup_url || []);
                            for (var lu = 0; lu < us0.length; lu++) { known[streamPath(us0[lu])] = seg0; }
                        }
                    }
                    var wd0 = (wdData && wdData.dash) || {};
                    learnIndex(wd0.video); learnIndex(wd0.audio);
                    if (webDash) { learnIndex(webDash.video); learnIndex(webDash.audio); }
                    var all0 = video.concat(audio);
                    for (var ki = 0; ki < all0.length; ki++) {
                        for (var ku = 0; ku < all0[ki].urls.length; ku++) {
                            var hit = known[streamPath(all0[ki].urls[ku])];
                            if (hit) { all0[ki].segments = hit; reused++; break; }
                        }
                    }
                    /* Read every stream's sidx, then drop the ones that failed —
                     * a rep with no segments cannot go into the manifest. */
                    var tSidx0 = new Date().getTime();
                    st.total = video.length + audio.length;

                    /* Two stages. Every one of these header reads is a first
                     * request for a file the CDN edge has usually never held —
                     * 1–2.5s each, measured 2026-09-28 — and reading all fifteen
                     * two at a time cost 15.7s of black screen, 17.4s to a
                     * picture. The manifest only ever uses one family, so read
                     * that family's tiers and the top audio first, start, and
                     * read the other families and audios once playback has had
                     * the link to itself for a while: they matter only to the
                     * ladder's 换族 rung, which appends to these same arrays. */
                    /* Known-bad files (Player.badFilesFor) are left out of the
                     * choice and of the first read: a family whose top file is
                     * banned would otherwise win with its lower tiers, against
                     * families whose headers have not been read yet. */
                    var avoidSet = {};
                    for (var av = 0; av < (avoid || []).length; av++) { avoidSet[avoid[av]] = 1; }
                    var fileOf = function (r) {
                        return String((r.urls && r.urls[0]) || r.baseUrl || "").split(/[?#]/)[0].split("/").pop();
                    };
                    var candidates1 = video.filter(function (r) { return !avoidSet[fileOf(r)]; });
                    var fam = (typeof Mpd !== "undefined" && Mpd.familyFor) ?
                              Mpd.familyFor(candidates1, cap) : "";
                    var topAudio = audio.slice().sort(function (x, y) {
                        return (y.bandwidth || 0) - (x.bandwidth || 0);
                    })[0];
                    var first = [], later = [];
                    for (var fv = 0; fv < video.length; fv++) {
                        (fam && Mpd.family(video[fv].codecs) === fam && !avoidSet[fileOf(video[fv])]
                            ? first : later).push(video[fv]);
                    }
                    for (var fa = 0; fa < audio.length; fa++) {
                        (audio[fa] === topAudio ? first : later).push(audio[fa]);
                    }
                    if (!fam || !topAudio) { first = video.concat(audio); later = []; }

                    var vAll = video.length, aAll = audio.length;
                    function deliver(staged) {
                        dash.strongTiming = "app端点=" + tApp + "ms codecs=" + tCodecs +
                            "ms 文件头=" + (staged ? first.length + "/" + (vAll + aAll) + "个（" + fam + " 先读）"
                                                   : (vAll + aAll) + "个") +
                            "/并发2=" + (new Date().getTime() - tSidx0) + "ms" +
                            "（其中 " + reused + " 份沿用 web 清单的索引，没读）";
                        dash.video = video.filter(function (r) { return r.segments; });
                        dash.audio = audio.filter(function (r) { return r.segments; });
                        if (!dash.video.length || !dash.audio.length) {
                            onFail("app 端点自读 sidx 后无可用流"); return;
                        }
                        dash.tierNote = dash.video.length + "/" + vAll + " 视频档" +
                            (staged ? "（其余 " + later.filter(function (r) { return !r.segments; }).length +
                                      " 份文件头稍后后台补读）"
                                    : (dash.video.length < vAll ? "（其余 sidx 读失败，已剔）" : ""));
                        dash.acceptQuality = ad.accept_quality || [];
                        dash.duration = Math.round((ad.timelength || 0) / 1000) ||
                                        dash.duration || 0;
                        var rep0 = dash.video[0] || {};
                        var dm = /[?&]deadline=(\d+)/.exec(String(rep0.baseUrl || ""));
                        dash.deadline = dm ? parseInt(dm[1], 10) : 0;
                        dash.fetchedAt = new Date().getTime();
                        dash.strong = true;
                        onOk(dash);
                    }
                    fillSegments(first, function () {
                        var haveV = false, haveA = false;
                        for (var q = 0; q < first.length; q++) {
                            if (!first[q].segments) { continue; }
                            if (first[q].mimeType === "audio/mp4") { haveA = true; } else { haveV = true; }
                        }
                        if (!later.length) { deliver(false); return; }
                        /* Every later stream borrowed its index: nothing left to
                         * read in the background, so it all goes in now. */
                        if (!later.filter(function (r) { return !r.segments; }).length) {
                            deliver(false); return;
                        }
                        if (!haveV || !haveA) {
                            /* The chosen family's headers all failed: nothing to
                             * start on, so read the rest now as before. */
                            fillSegments(later, function () { deliver(false); });
                            return;
                        }
                        deliver(true);
                        /* Only the ones read now: a borrowed index already put
                         * its stream in dash.video at deliver(), and pushing it
                         * again listed it twice (review, 10-20). */
                        var laterTodo = later.filter(function (r) { return !r.segments; });
                        setTimeout(function () {
                            fillSegments(laterTodo, function () {
                                for (var z = 0; z < laterTodo.length; z++) {
                                    var r = laterTodo[z];
                                    if (!r.segments) { continue; }
                                    (r.mimeType === "audio/mp4" ? dash.audio : dash.video).push(r);
                                }
                            });
                        }, STRONG_LATER_DELAY);
                    });
                }
            }
            getJson(url2, url2Settled, function () { url2Settled(null); });
            getJson(appUrl, function (ad) {
                tApp = new Date().getTime() - t0;
                st.app = tApp + "ms";
                if (!ad.dash) { onFail("app 端点无 dash"); return; }
                adData = ad;
                joinStrong();
            }, onFail);
        }
    };
})();
