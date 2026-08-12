/* Where each video was left off.
 *
 * Kept locally *as well as* pushed to bilibili's history — see `API.report`.
 * The local copy is not redundant: it is instant, which is what makes the
 * progress slivers appear with the cards rather than a request later; it knows
 * about the last thirty seconds, which the report interval does not; it works
 * for accounts added through the web fallback, which have no CSRF token to
 * write with; and it survives a failed request.
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

    /* Videos bilibili itself says are gone — playurl and view both answer
     * `-404 啥都木有`, which is what a takedown looks like from here. Reuploads
     * of films and shows are removed constantly while the card that opens them
     * lives on in a feed, in the account's history and in this television's own
     * 继续观看 row.
     *
     * Device level on purpose — the raw key, not `Accounts.scope()`. A takedown
     * is a fact about the video, not about the viewer, so one person meeting it
     * spares everyone else on this television the same dead card.
     *
     * It hides the card from 继续观看 and does nothing else. The watch record
     * stays: 我的 answers 「这台电视放过什么」, and something watched and later
     * deleted is still part of that answer — and deleting entries outright is a
     * mistake this file has already made twice, in `record()` and in the call
     * that became `finished()`, both of which quietly emptied 我的.
     *
     * Marks expire, and playing the video clears one. A -404 is usually a
     * takedown, but 审核中 answers identically and comes back a day later; a
     * mark with no end would hide such a video from the row for good, on
     * evidence that had stopped being true. */
    var DEAD_KEY = "bili.dead.v1";
    var DEAD_TTL = 7 * 24 * 3600 * 1000;
    var DEAD_CAP = 200;

    function writeDead(m) {
        var keys = [], k;
        for (k in m) { if (m.hasOwnProperty(k)) { keys.push(k); } }
        keys.sort(function (a, b) { return (m[a] || 0) - (m[b] || 0); });
        while (keys.length > DEAD_CAP) { delete m[keys.shift()]; }
        try { localStorage.setItem(DEAD_KEY, JSON.stringify(m)); } catch (e) {}
    }

    function readDead() {
        var m;
        try { m = JSON.parse(localStorage.getItem(DEAD_KEY) || "{}"); }
        catch (e) { m = {}; }
        var now = new Date().getTime(), expired = false, k;
        for (k in m) {
            if (!m.hasOwnProperty(k)) { continue; }
            if (now - (m[k] || 0) > DEAD_TTL) { delete m[k]; expired = true; }
        }
        if (expired) { writeDead(m); }
        return m;
    }

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

        /* Most-recent-first, for the 我的 screen.
         *
         * The server-side history is now written too — accounts added through
         * the TV login carry the CSRF token that needs — but this list stays,
         * and stays first: it is instant, it survives a failed request, and it
         * knows about the last thirty seconds, which the server does not.
         *
         * Each card is copied and stamped with `at`. Copied because the caller
         * merges these with the server's cards and writes to the winner, and
         * the originals here are what gets persisted; stamped because a merged
         * list has to sort by time and a card alone carries none. */
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
                var copy = {};
                for (var f in e.card) {
                    if (e.card.hasOwnProperty(f)) { copy[f] = e.card[f]; }
                }
                copy.at = e.at || 0;
                out.push(copy);
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
        },

        /* bilibili answered -404 for this video: it is gone, and no amount of
         * pressing play will change that. */
        markDead: function (bvid) {
            if (!bvid) { return; }
            var m = readDead();
            m[bvid] = new Date().getTime();
            writeDead(m);
        },

        /* It played — so whatever the -404 was, it is over. Self-correction
         * costs one read in the common case and writes nothing. */
        markAlive: function (bvid) {
            if (!bvid) { return; }
            var m = readDead();
            if (!m[bvid]) { return; }
            delete m[bvid];
            writeDead(m);
        },

        /* The whole set at once, pruned. Callers filter a list against it, and
         * asking per card would re-read and re-parse storage for every card on
         * the screen. */
        dead: readDead
    };
})();
