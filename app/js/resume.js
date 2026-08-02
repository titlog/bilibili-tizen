/* Where each video was left off.
 *
 * Kept locally rather than pushed to bilibili's history endpoint: that one wants
 * a CSRF token from the session, and the web login path never exposes one.
 * Local is also what makes the progress bars on cards instant.
 *
 * The television is shared, so this is stored per account — nobody wants their
 * half-watched videos showing up under somebody else's name, and a resume point
 * from another person is worse than none at all. The namespace is re-derived on
 * every access rather than captured once: an account switch that happened
 * between two calls then repairs itself, and the data still in memory is written
 * back to the person it belongs to before the new namespace is read.
 */
var Resume = (function () {
    "use strict";

    var KEY = "bili.resume";
    var LIMIT = 300;          /* entries; a TV that runs for months should not grow forever */
    var MIN_SECONDS = 30;     /* below this there is nothing worth resuming */
    var END_MARGIN = 30;      /* treat the last half minute as finished */

    var map = null;
    var mapKey = null;        /* the namespace `map` was read from */
    var dirty = false;

    /* Turning the television off is the normal way to stop watching, and it
     * gives no unload event worth trusting, so writes are flushed on a timer
     * rather than only when playback ends. */
    setInterval(function () { flushNow(); }, 10000);

    function trim(m) {
        var keys = [];
        for (var k in m) { if (m.hasOwnProperty(k)) { keys.push(k); } }
        if (keys.length <= LIMIT) { return; }
        keys.sort(function (a, b) { return (m[b].at || 0) - (m[a].at || 0); });
        for (var i = LIMIT; i < keys.length; i++) { delete m[keys[i]]; }
    }

    function writeTo(k, m) {
        if (!k) { return; }
        trim(m);
        try { localStorage.setItem(k, JSON.stringify(m)); } catch (e) {}
    }

    function load() {
        var k = Accounts.scope(KEY);
        if (map && mapKey === k) { return map; }

        /* Somebody else is watching now. What has not been written yet belongs
         * to the person who was. */
        if (map && dirty) { writeTo(mapKey, map); }
        dirty = false;
        mapKey = k;
        try { map = JSON.parse(localStorage.getItem(k) || "{}"); }
        catch (e) { map = {}; }
        return map;
    }

    function flush() { flushNow(); }

    function flushNow() {
        /* load() writes the previous account's entries out itself if the
         * namespace moved, and clears the flag when it does. */
        var m = load();
        if (!dirty) { return; }
        dirty = false;
        writeTo(mapKey, m);
    }

    function id(bvid, cid) { return bvid + ":" + cid; }

    return {
        /* Called on every time update, so it only touches storage now and then. */
        record: function (bvid, cid, positionMs, durationMs, card) {
            if (!bvid || !positionMs) { return; }
            var pos = positionMs / 1000, dur = (durationMs || 0) / 1000;
            var m = load();
            var key = id(bvid, cid);

            var prev = m[key] || {};

            /* Too early to be worth resuming, or close enough to the end to
             * count as finished. Either way there is no position to keep — but
             * it was still watched, and this list is the only record of what
             * this television played. Deleting the entry outright meant a video
             * opened and left after a minute never appeared in 我的 at all, and
             * so did one watched all the way through. */
            var resumable = pos >= MIN_SECONDS && !(dur && pos > dur - END_MARGIN);

            m[key] = {
                pos: resumable ? Math.floor(pos) : 0,
                dur: Math.floor(dur),
                at: new Date().getTime(),
                card: card || prev.card    /* enough to redraw it in 我的 */
            };
            dirty = true;
        },

        flush: flush,

        positionMs: function (bvid, cid) {
            var e = load()[id(bvid, cid)];
            return e ? e.pos * 1000 : 0;
        },

        /* Which part of a multi-part upload was watched last, and where it was
         * left. Without this, opening a series from the feed or from 我的 always
         * restarted at P1 — the position for the part you were actually on was
         * stored all along, but nothing ever asked which part that was. */
        lastPart: function (bvid) {
            var m = load(), best = null, bestAt = -1, prefix = bvid + ":";
            for (var k in m) {
                if (!m.hasOwnProperty(k)) { continue; }
                if (k.indexOf(prefix) !== 0) { continue; }
                var at = m[k].at || 0;
                if (at <= bestAt) { continue; }
                bestAt = at;
                best = {
                    cid: Number(k.slice(prefix.length)) || 0,
                    positionMs: (m[k].pos || 0) * 1000,
                    page: (m[k].card && m[k].card.page) || 0,
                    part: (m[k].card && m[k].card.part) || ""
                };
            }
            return best;
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

        /* Watched to the end: there is nothing left to resume, but it belongs in
         * the history more than anything else does. This used to delete the
         * entry, which quietly removed finished videos from 我的. */
        finished: function (bvid, cid) {
            var m = load(), e = m[id(bvid, cid)];
            if (!e) { return; }
            e.pos = 0;
            e.at = new Date().getTime();
            dirty = true;
            flush();
        }
    };
})();
