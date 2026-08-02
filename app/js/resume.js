/* Where each video was left off.
 *
 * Kept locally rather than pushed to bilibili's history endpoint: that one wants
 * a CSRF token from the session, and this code never gets to see the cookies.
 * Local is also what makes the progress bars on cards instant.
 */
var Resume = (function () {
    "use strict";

    var KEY = "bili.resume";
    var LIMIT = 300;          /* entries; a TV that runs for months should not grow forever */
    var MIN_SECONDS = 30;     /* below this there is nothing worth resuming */
    var END_MARGIN = 30;      /* treat the last half minute as finished */

    var map = null;
    var dirty = false;

    /* Turning the television off is the normal way to stop watching, and it
     * gives no unload event worth trusting, so writes are flushed on a timer
     * rather than only when playback ends. */
    setInterval(function () { if (dirty) { flushNow(); } }, 10000);

    function load() {
        if (map) { return map; }
        try { map = JSON.parse(localStorage.getItem(KEY) || "{}"); }
        catch (e) { map = {}; }
        return map;
    }

    function flush() { flushNow(); }

    function flushNow() {
        if (!dirty) { return; }
        dirty = false;
        var m = load();

        var keys = [];
        for (var k in m) { if (m.hasOwnProperty(k)) { keys.push(k); } }
        if (keys.length > LIMIT) {
            keys.sort(function (a, b) { return (m[b].at || 0) - (m[a].at || 0); });
            for (var i = LIMIT; i < keys.length; i++) { delete m[keys[i]]; }
        }
        try { localStorage.setItem(KEY, JSON.stringify(m)); } catch (e) {}
    }

    function id(bvid, cid) { return bvid + ":" + cid; }

    return {
        /* Called on every time update, so it only touches storage now and then. */
        record: function (bvid, cid, positionMs, durationMs, card) {
            if (!bvid || !positionMs) { return; }
            var pos = positionMs / 1000, dur = (durationMs || 0) / 1000;
            var m = load();
            var key = id(bvid, cid);

            if (pos < MIN_SECONDS || (dur && pos > dur - END_MARGIN)) {
                if (m[key]) { delete m[key]; dirty = true; flush(); }
                return;
            }
            var prev = m[key] || {};
            m[key] = {
                pos: Math.floor(pos), dur: Math.floor(dur), at: new Date().getTime(),
                card: card || prev.card    /* enough to redraw it in 我的 */
            };
            dirty = true;
        },

        flush: flush,

        positionMs: function (bvid, cid) {
            var e = load()[id(bvid, cid)];
            return e ? e.pos * 1000 : 0;
        },

        /* 0..1 for the sliver drawn across a card's thumbnail.
         * Feeds carry no cid — search, 动态 and history never have one — so the
         * marker matches on the video and takes its furthest part. Keying on
         * bvid:cid meant the sliver silently never appeared on exactly the
         * screens where "where did I get to" matters most. */
        fraction: function (bvid) {
            var m = load(), best = 0;
            for (var k in m) {
                if (!m.hasOwnProperty(k)) { continue; }
                if (k.indexOf(bvid + ":") !== 0) { continue; }
                var e = m[k];
                if (e.dur) { best = Math.max(best, Math.min(1, e.pos / e.dur)); }
            }
            return best;
        },

        /* Most-recent-first, for the 我的 screen. bilibili's own history endpoint
         * needs a CSRF token from the session, and this login path never exposes
         * one, so nothing this app plays ever reaches the server-side history.
         * Keeping it locally is the only version that actually works. */
        recent: function (limit) {
            var m = load(), seen = {}, out = [];
            var keys = [];
            for (var k in m) { if (m.hasOwnProperty(k)) { keys.push(k); } }
            keys.sort(function (a, b) { return (m[b].at || 0) - (m[a].at || 0); });
            for (var i = 0; i < keys.length && out.length < (limit || 24); i++) {
                var e = m[keys[i]];
                if (!e.card) { continue; }
                if (seen[e.card.bvid]) { continue; }
                seen[e.card.bvid] = 1;
                out.push(e.card);
            }
            return out;
        },

        forget: function (bvid, cid) {
            var m = load();
            if (m[id(bvid, cid)]) { delete m[id(bvid, cid)]; dirty = true; flush(); }
        }
    };
})();
