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

    /* Attaching the session, which multiple accounts made delicate.
     *
     * The Cookie header is a forbidden header name in a normal browser, but a
     * Tizen widget runs under its own <access> policy rather than CORS, so it
     * is worth setting and it is the route that carries a *chosen* account.
     *
     * withCredentials is the other route, and it is no longer set whenever
     * signed in. The engine's jar is global and holds at most one account, so
     * on a set with several people on it that flag would quietly attach
     * whoever logged in through the web fallback last — to requests made under
     * somebody else's name. It goes on only when the active account is the one
     * the jar actually belongs to, which Accounts tracks. */
    function applySession(xhr) {
        if (typeof Auth === "undefined" || !Auth.isLoggedIn()) { return; }
        var header = Auth.cookieHeader();
        if (header) {
            try { xhr.setRequestHeader("Cookie", header); } catch (e) {}
        }
        if (Auth.jarIsOurs()) {
            try { xhr.withCredentials = true; } catch (e) {}
        }
    }

    function getJson(url, onOk, onFail) {
        var xhr = new XMLHttpRequest();
        var settled = false;
        /* A dropped request reaches readyState 4 with status 0 AND fires
         * onerror, so an unguarded pair of handlers reports the same failure
         * twice — and callers that retry on failure then retry twice. */
        function fail(why) { if (!settled) { settled = true; onFail(why); } }
        function ok(data) { if (!settled) { settled = true; onOk(data); } }
        xhr.open("GET", url, true);

        applySession(xhr);

        xhr.timeout = 20000;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) { return; }
            if (xhr.status !== 200) { fail("HTTP " + xhr.status); return; }
            var j;
            try { j = JSON.parse(xhr.responseText); }
            catch (e) { fail("bad JSON"); return; }
            if (j.code !== 0) { fail(j.message || ("code " + j.code)); return; }
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
        nav: function (onOk, onFail) {
            var xhr = new XMLHttpRequest();
            xhr.open("GET", BASE + "/x/web-interface/nav", true);
            applySession(xhr);
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
        history: function (onOk, onFail) {
            getJson(BASE + "/x/web-interface/history/cursor?ps=24", function (d) {
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
                onOk(out, all.length);
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
            var url = BASE + "/x/player/playurl?bvid=" + bvid + "&cid=" + cid +
                      "&qn=" + (qn || 64) + "&fnval=16&fnver=0&fourk=1";
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
        }
    };
})();
