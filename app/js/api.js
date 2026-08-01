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
            onOk(j.data);
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
                onOk(d.dash);
            }, onFail);
        }
    };
})();
