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

    /* The route that actually arrives. Confined to api.bilibili.com: the token
     * is a credential and the suggestion host has no business holding one. */
    function withSession(url) {
        if (typeof Auth === "undefined" || !Auth.isLoggedIn()) { return url; }
        if (url.indexOf(BASE) !== 0) { return url; }
        var key = Auth.accessKey();
        if (!key) { return url; }   /* web-fallback account — the jar is all it has */
        return url + (url.indexOf("?") < 0 ? "?" : "&") +
               Auth.signTv({ access_key: key });
    }

    function getJson(url, onOk, onFail) {
        var xhr = new XMLHttpRequest();
        var settled = false;
        /* A dropped request reaches readyState 4 with status 0 AND fires
         * onerror, so an unguarded pair of handlers reports the same failure
         * twice — and callers that retry on failure then retry twice. */
        function fail(why) { if (!settled) { settled = true; onFail(why); } }
        function ok(data) { if (!settled) { settled = true; onOk(data); } }
        xhr.open("GET", withSession(url), true);

        applySession(xhr);

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

    /* The one write this app makes. Everything else here reads.
     *
     * bilibili's history endpoint wants the CSRF token that came with the
     * session. The TV login hands it over in the response body, so accounts
     * added that way can report; the web fallback leaves it in a cookie jar
     * this engine will not read back, so those accounts silently cannot. That
     * is why `Auth.csrf()` is checked by the caller rather than here — a write
     * that cannot be signed is not an error worth surfacing on a television. */
    function postForm(url, fields, headers, onOk, onFail) {
        var xhr = new XMLHttpRequest();
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
            if (xhr.status !== 200) { fail("HTTP " + xhr.status); return; }
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

    /* Thumbnails come back as http:// or protocol-relative, and some are huge.
     * bilibili's image service resizes on demand via the @wxh suffix. */
    function thumb(url, w, h) {
        if (!url) { return ""; }
        var u = url.replace(/^http:/, "https:");
        if (u.indexOf("//") === 0) { u = "https:" + u; }
        return u + "@" + (w || 480) + "w_" + (h || 300) + "h_1c.webp";
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

    function normalise(v) {
        return {
            bvid: v.bvid,
            aid: v.aid,
            /* Kept when the feed supplies it, but most do not — Resume therefore
             * keys on bvid alone for the card marker. */
            cid: v.cid || null,
            title: stripEm(v.title),
            pic: thumb(v.pic),
            author: (v.owner && v.owner.name) || v.author || "",
            duration: duration(v.duration),
            play: count(v.stat ? v.stat.view : v.play)
        };
    }

    return {
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
        ranking: function (rid, onOk, onFail) {
            getJson(BASE + "/x/web-interface/ranking/v2?type=all&rid=" + (rid || 0), function (d) {
                onOk((d.list || []).map(normalise));
            }, onFail);
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
                    level: (d.level_info || {}).current_level
                });
            };
            xhr.ontimeout = function () { onFail("timeout"); };
            xhr.onerror = function () { onFail("network error"); };
            xhr.send();
        },

        /* Video posts from followed accounts. Login only — signed out this
         * answers -101 rather than an empty list. */
        dynamic: function (page, onOk, onFail) {
            getJson(BASE + "/x/polymer/web-dynamic/v1/feed/all?type=video&page=" + (page || 1), function (d) {
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
                        duration: arch.duration_text || "",
                        play: (arch.stat || {}).play || ""
                    });
                }
                onOk(out);
            }, onFail);
        },

        /* Search-as-you-type suggestions. Handy on a TV, where every extra
         * character costs several button presses. */
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
                        duration: duration(secs),
                        play: "",
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
                    chapters: vp
                });
            }, onFail);
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

        view: function (bvid, onOk, onFail) {
            getJson(BASE + "/x/web-interface/view?bvid=" + bvid, function (d) {
                onOk({
                    bvid: d.bvid,
                    aid: d.aid,
                    cid: d.cid,
                    title: d.title,
                    desc: d.desc,
                    pic: thumb(d.pic, 960, 600),
                    author: (d.owner || {}).name,
                    duration: duration(d.duration),
                    play: count((d.stat || {}).view),
                    pages: (d.pages || []).map(function (p) {
                        return { cid: p.cid, page: p.page, part: p.part };
                    })
                });
            }, onFail);
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
            /* 2064 = 16 (DASH) | 2048 (AV1). fnval gates which codec families
             * the response carries at all: with plain 16 the answer holds avc
             * and hev tracks only, and the av01-first preference in mpd.js was
             * discovered selecting from a list with zero av01 entries — the
             * web player's av01 default works because its fnval asks for it.
             * Only the AV1 bit is added; HDR/DoVi/8K stay unrequested. */
            var url = BASE + "/x/player/playurl?bvid=" + bvid + "&cid=" + cid +
                      "&qn=" + (qn || 64) + "&fnval=2064&fnver=0&fourk=1";
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
                /* Where the init segment and the segment index live inside the
                 * file, kept as the "0-916" strings the API states them in —
                 * that is the form a DASH manifest wants, and Shaka reads the
                 * index itself. bilibili gives both casings; take either. */
                function segments(rep) {
                    var sb = rep.SegmentBase || rep.segment_base || {};
                    var init = sb.Initialization || sb.initialization || "";
                    var index = sb.indexRange || sb.index_range || "";
                    if (!/^\d+-\d+$/.test(init) || !/^\d+-\d+$/.test(index)) { return null; }
                    return { init: init, index: index };
                }
                var kinds = ["video", "audio"];
                for (var k = 0; k < kinds.length; k++) {
                    var list = d.dash[kinds[k]] || [];
                    for (var i = 0; i < list.length; i++) {
                        list[i].urls = candidates(list[i]);
                        list[i].baseUrl = list[i].urls[0];
                        list[i].segments = segments(list[i]);
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
         * bvid with -400. */
        playurlDashStrong: function (aid, cid, qn, onOk, onFail) {
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
                    if (seg) { done(seg); } else { readSidx(url, done); }
                });
            }

            /* At most 2 header reads in flight — a burst is what trips this
             * CDN's per-IP limiter, which is the very thing that was starving
             * the 403'd tiers to begin with; 2 keeps the pipe busy without it. */
            function fillSegments(streams, whenDone) {
                var i = 0, active = 0, remaining = streams.length;
                if (!remaining) { whenDone(); return; }
                function pump() {
                    while (active < 2 && i < streams.length) {
                        (function (s) {
                            active++;
                            readSidxRetry(s.baseUrl, function (seg) {
                                s.segments = seg; active--; remaining--;
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
                              qn: qn || 80, fnval: 2064, fnver: 0, fourk: 1,
                              platform: "android", mobi_app: "android",
                              build: 7280300 });
            getJson(appUrl, function (ad) {
                if (!ad.dash) { onFail("app 端点无 dash"); return; }
                /* codecs the app endpoint omits: the web endpoint's low tiers
                 * carry them, and a family's box type is constant within a cid,
                 * so the string maps by codecid. */
                var url2 = BASE + "/x/player/playurl?avid=" + aid + "&cid=" + cid +
                           "&qn=16&fnval=2064&fnver=0&fourk=1";
                getJson(url2, function (wd) {
                    var codecsByCid = {}, audioCodecs = "mp4a.40.2";
                    var wv = (wd.dash && wd.dash.video) || [];
                    for (var w = 0; w < wv.length; w++) { codecsByCid[wv[w].codecid] = wv[w].codecs; }
                    if (wd.dash && wd.dash.audio && wd.dash.audio[0]) {
                        audioCodecs = wd.dash.audio[0].codecs || audioCodecs;
                    }
                    finish(ad.dash, codecsByCid, audioCodecs);
                }, function () { finish(ad.dash, {}, "mp4a.40.2"); });

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
                    /* Read every stream's sidx, then drop the ones that failed —
                     * a rep with no segments cannot go into the manifest. */
                    fillSegments(video.concat(audio), function () {
                        var vAll = video.length, aAll = audio.length;
                        dash.video = video.filter(function (r) { return r.segments; });
                        dash.audio = audio.filter(function (r) { return r.segments; });
                        if (!dash.video.length || !dash.audio.length) {
                            onFail("app 端点自读 sidx 后无可用流"); return;
                        }
                        /* How many tiers survived the header reads, carried out
                         * so app.js can say it — a tier lost to a failed sidx read
                         * or a moov+sidx past 12KB otherwise reads as "the CDN
                         * only offered 4" months later. api.js has no logger. */
                        dash.tierNote = dash.video.length + "/" + vAll + " 视频档" +
                                        (dash.video.length < vAll ? "（其余 sidx 读失败，已剔）" : "");
                        dash.acceptQuality = ad.accept_quality || [];
                        /* Without this the manifest's mediaPresentationDuration
                         * is garbage (2^32 was observed), and Shaka lands the
                         * playhead at the file's end and stalls. The app
                         * endpoint states length in milliseconds at the top
                         * level, not inside dash. */
                        dash.duration = Math.round((ad.timelength || 0) / 1000) ||
                                        dash.duration || 0;
                        var rep0 = dash.video[0] || {};
                        var dm = /[?&]deadline=(\d+)/.exec(String(rep0.baseUrl || ""));
                        dash.deadline = dm ? parseInt(dm[1], 10) : 0;
                        dash.fetchedAt = new Date().getTime();
                        dash.strong = true;
                        onOk(dash);
                    });
                }
            }, onFail);
        }
    };
})();
