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

    function getJson(url, onOk, onFail) {
        var xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);

        /* Two routes for the session, because which one works is a property of
         * the firmware, not of the spec. Cookie is a forbidden header name in a
         * normal browser, but a Tizen widget runs under its own <access> policy
         * rather than CORS and this build already lets Referer through. If the
         * header is refused, withCredentials still lets the jar populated by the
         * login poll do the job. */
        if (typeof Auth !== "undefined" && Auth.isLoggedIn()) {
            try { xhr.setRequestHeader("Cookie", Auth.cookieHeader()); } catch (e) {}
            try { xhr.withCredentials = true; } catch (e) {}
        }

        xhr.timeout = 20000;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) { return; }
            if (xhr.status !== 200) { onFail("HTTP " + xhr.status); return; }
            var j;
            try { j = JSON.parse(xhr.responseText); }
            catch (e) { onFail("bad JSON"); return; }
            if (j.code !== 0) { onFail(j.message || ("code " + j.code)); return; }
            /* Most endpoints answer under data; search suggestions use result. */
            onOk(j.data !== undefined ? j.data : j.result);
        };
        xhr.ontimeout = function () { onFail("timeout"); };
        xhr.onerror = function () { onFail("network error"); };
        xhr.send();
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

    function normalise(v) {
        return {
            bvid: v.bvid,
            aid: v.aid,
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

        ranking: function (onOk, onFail) {
            getJson(BASE + "/x/web-interface/ranking/v2?rid=0&type=all", function (d) {
                onOk((d.list || []).map(normalise));
            }, onFail);
        },

        /* search/all/v2 needs no WBI signature, unlike search/type which
         * answers with an HTML challenge page when called bare. */
        search: function (keyword, onOk, onFail) {
            var url = BASE + "/x/web-interface/search/all/v2?keyword=" +
                      encodeURIComponent(keyword);
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
         * server: isLogin true here means the cookies are being applied. */
        nav: function (onOk, onFail) {
            var xhr = new XMLHttpRequest();
            xhr.open("GET", BASE + "/x/web-interface/nav", true);
            if (typeof Auth !== "undefined" && Auth.isLoggedIn()) {
                try { xhr.setRequestHeader("Cookie", Auth.cookieHeader()); } catch (e) {}
                try { xhr.withCredentials = true; } catch (e) {}
            }
            xhr.timeout = 20000;
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) { return; }
                var j;
                try { j = JSON.parse(xhr.responseText); }
                catch (e) { onFail("bad JSON"); return; }
                /* code -101 is "not logged in", which is an answer, not a fault. */
                var d = j.data || {};
                onOk({ isLogin: !!d.isLogin, uname: d.uname || "", level: (d.level_info || {}).current_level });
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

        history: function (onOk, onFail) {
            getJson(BASE + "/x/web-interface/history/cursor?ps=24", function (d) {
                onOk((d.list || []).filter(function (x) { return x.history && x.history.bvid; })
                    .map(function (x) {
                        return {
                            bvid: x.history.bvid,
                            title: x.title,
                            pic: thumb(x.cover || x.pic),
                            author: x.author_name || "",
                            duration: duration(x.duration),
                            play: ""
                        };
                    }));
            }, onFail);
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
                onOk({ url: d.durl[0].url, quality: d.quality, accept: d.accept_quality || [] });
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
                    var all = [rep.baseUrl || rep.base_url]
                        .concat(rep.backupUrl || rep.backup_url || [])
                        .filter(function (u) { return !!u; });
                    var good = [], iffy = [];
                    for (var i = 0; i < all.length; i++) {
                        var host = String(all[i]).split("/")[2] || "";
                        if (host.indexOf("mcdn") >= 0 || host.indexOf("szbdyd") >= 0) {
                            iffy.push(all[i]);
                        } else { good.push(all[i]); }
                    }
                    return good.concat(iffy);
                }
                var kinds = ["video", "audio"];
                for (var k = 0; k < kinds.length; k++) {
                    var list = d.dash[kinds[k]] || [];
                    for (var i = 0; i < list.length; i++) {
                        list[i].urls = candidates(list[i]);
                        list[i].baseUrl = list[i].urls[0];
                    }
                }
                onOk(d.dash);
            }, onFail);
        }
    };
})();
