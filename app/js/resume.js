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

    function load() {
        if (map) { return map; }
        try { map = JSON.parse(localStorage.getItem(KEY) || "{}"); }
        catch (e) { map = {}; }
        return map;
    }

    function flush() {
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
        record: function (bvid, cid, positionMs, durationMs) {
            if (!bvid || !positionMs) { return; }
            var pos = positionMs / 1000, dur = (durationMs || 0) / 1000;
            var m = load();
            var key = id(bvid, cid);

            if (pos < MIN_SECONDS || (dur && pos > dur - END_MARGIN)) {
                if (m[key]) { delete m[key]; dirty = true; flush(); }
                return;
            }
            m[key] = { pos: Math.floor(pos), dur: Math.floor(dur), at: new Date().getTime() };
            dirty = true;
        },

        flush: flush,

        positionMs: function (bvid, cid) {
            var e = load()[id(bvid, cid)];
            return e ? e.pos * 1000 : 0;
        },

        /* 0..1 for the sliver drawn across a card's thumbnail. */
        fraction: function (bvid, cid) {
            var e = load()[id(bvid, cid)];
            if (!e || !e.dur) { return 0; }
            return Math.min(1, e.pos / e.dur);
        },

        forget: function (bvid, cid) {
            var m = load();
            if (m[id(bvid, cid)]) { delete m[id(bvid, cid)]; dirty = true; flush(); }
        }
    };
})();
