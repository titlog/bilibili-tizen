/* 弹幕: the comments that fly across a bilibili video.
 *
 * Fetched once per part from `x/v1/dm/list.so?oid=<cid>` — no login, no
 * signature, an XML pool capped at the video's `maxlimit` (1000 on a short
 * upload, a few thousand on a long one). That cap is welcome here: a living
 * room screen wants a readable stream, not every comment ever posted.
 *
 * Drawn as DOM nodes moved by compositor animations (Element.animate on
 * transform), never re-laid-out per frame and never filtered — the douyin
 * client measured CSS filters as the expensive thing on this set. Positions
 * are scheduled in media time, not wall time: a paused video pauses every
 * animation, a 1.5x video plays them at 1.5x, and the lane arithmetic stays
 * true either way.
 *
 *   Danmaku.load(cid, onOk(list), onFail(why))
 *   var r = Danmaku.renderer(containerEl)
 *   r.set(list) / r.tick(positionMs, playing) / r.pause(bool) / r.rate(x)
 *   r.density("off"|"low"|"normal"|"high") / r.clear()
 */
var Danmaku = (function () {
    "use strict";

    var BASE = "https://api.bilibili.com";

    var WIDTH = 1920;           /* the canvas this app is laid out on */
    /* px per media-ms: four whole pixels per frame at 60 Hz (the set's rate;
     * rAF 16.7 ms there), and 3 / 5 / 6 / 8 at 0.75x / 1.25x / 1.5x / 2x. At a
     * fractional step (it was 1920/7000, 4.57 px a frame) a comment lands between
     * pixels on most frames and the compositor draws it filtered — the text goes
     * soft and sharp from frame to frame, which reads as a stutter in the
     * scroll (10-18, the viewer: 「从右往左飘的时候还是能看出一点点卡顿感」).
     * Keyframes start and end on whole pixels for the same reason. A short
     * comment crosses in ~8.5 s. */
    var SPEED = 0.24;
    var GAP = 48;               /* px between the tail of one comment and the next in a lane */
    var FIXED_MS = 4000;        /* top / bottom comments stay this long */
    var FONT = 44;              /* px for bilibili's standard size 25, read from across a room */
    var LINE = 1.24;            /* line height as a multiple of the font size */
    var LATE_MS = 3000;         /* a comment this far behind the playhead is not worth showing */
    var JUMP_MS = 2000;         /* a playhead move larger than this is a seek, not playback */
    var DUP_MS = 1000;          /* the same text twice within this is one comment */

    var CAPS = { low: 15, normal: 30, high: 60 };
    /* bilibili's own shielding uses the weight (0–10, higher is more trusted);
     * the sparse setting keeps the trusted ones rather than the first ones. */
    var MIN_WEIGHT = { low: 5, normal: 0, high: 0 };

    /* ---------------- fetch & parse ---------------- */

    var ENTITY = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
    function unescapeXml(s) {
        return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, function (m, e) {
            if (e.charAt(0) === "#") {
                var n = e.charAt(1) === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
                return isNaN(n) ? m : String.fromCharCode(n);
            }
            return ENTITY[e] !== undefined ? ENTITY[e] : m;
        });
    }

    function hexColor(n) {
        var s = ((Number(n) || 0) & 0xffffff).toString(16);
        while (s.length < 6) { s = "0" + s; }
        return "#" + s;
    }

    /* `<d p="time,mode,size,color,sent,pool,midHash,dmid,weight">text</d>`.
     * A regex rather than DOMParser: the shape is fixed, the pool can run to
     * thousands of entries, and nothing else in the document is wanted. Modes
     * 1–3 and 6 scroll (bilibili's variants of the same thing), 4 sits at the
     * bottom, 5 at the top; 7 (positioned) and 8 (scripted) are dropped — they
     * are drawn for a particular player's geometry and mean nothing here. */
    function parse(xml) {
        var re = /<d p="([^"]*)">([^<]*)<\/d>/g, m, out = [];
        while ((m = re.exec(xml))) {
            var p = m[1].split(",");
            var mode = parseInt(p[1], 10);
            if (mode === 7 || mode === 8 || !(mode >= 1 && mode <= 6)) { continue; }
            var text = unescapeXml(m[2]).replace(/[\r\n\t]+/g, " ").replace(/^\s+|\s+$/g, "");
            if (!text) { continue; }
            out.push({
                t: Math.max(0, Math.round(parseFloat(p[0]) * 1000) || 0),
                mode: mode === 4 || mode === 5 ? mode : 1,
                size: parseInt(p[2], 10) || 25,
                color: hexColor(p[3]),
                text: text,
                weight: p.length > 8 ? (parseInt(p[8], 10) || 0) : 10
            });
        }
        out.sort(function (a, b) { return a.t - b.t; });
        /* The same line posted twice inside a second is one comment shouted
         * twice; on a hot video it is the bulk of a burst. */
        var seen = {}, kept = [];
        for (var i = 0; i < out.length; i++) {
            var last = seen[out[i].text];
            if (last !== undefined && out[i].t - last < DUP_MS) { continue; }
            seen[out[i].text] = out[i].t;
            kept.push(out[i]);
        }
        return kept;
    }

    /* The server answers raw deflate with `Content-Encoding: deflate` whether
     * or not it was asked to. On the set the engine inflates it; behind
     * tools/devserver.mjs (which forwards the body but not that header) the
     * bytes arrive compressed, so inflate them here when the engine can. */
    function bytesToText(buf, done, fail) {
        var u8 = new Uint8Array(buf);
        var i = 0;
        while (i < u8.length && (u8[i] === 0x20 || u8[i] === 0x0a || u8[i] === 0x0d || u8[i] === 0x09 || u8[i] === 0xef || u8[i] === 0xbb || u8[i] === 0xbf)) { i++; }
        if (u8[i] === 0x3c) { done(decode(u8)); return; }
        /* Through window: neither exists on Chromium 69, and only the dev path needs them. */
        var Inflate = window.DecompressionStream;
        var Resp = window.Response;
        if (!Inflate || !Resp || !Blob.prototype.stream) {
            fail("响应是没解压的 deflate（缺 Content-Encoding，引擎也没有 DecompressionStream）");
            return;
        }
        try {
            var stream = new Blob([u8]).stream().pipeThrough(new Inflate("deflate-raw"));
            new Resp(stream).arrayBuffer().then(function (out) {
                done(decode(new Uint8Array(out)));
            }, function (e) { fail("deflate 解不开（" + (e && e.message) + "）"); });
        } catch (e) { fail("deflate 解不开（" + (e && e.message) + "）"); }
    }
    function decode(u8) {
        if (typeof TextDecoder !== "undefined") { return new TextDecoder("utf-8").decode(u8); }
        var s = "";
        for (var i = 0; i < u8.length; i += 8192) {
            s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(u8.length, i + 8192)));
        }
        try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
    }

    /* No session on purpose: the pool is public, and an access_key is a
     * credential with no business in a comment request. No Referer either,
     * same as every other call (index.html's referrer policy). */
    function load(cid, onOk, onFail) {
        var xhr = new XMLHttpRequest(), settled = false;
        function fail(why) { if (!settled) { settled = true; onFail(why); } }
        function ok(list) { if (!settled) { settled = true; onOk(list); } }
        try { xhr.open("GET", BASE + "/x/v1/dm/list.so?oid=" + encodeURIComponent(cid), true); }
        catch (e) { fail("open 失败"); return; }
        xhr.responseType = "arraybuffer";
        xhr.timeout = 15000;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) { return; }
            if (xhr.status !== 200) { fail("HTTP " + xhr.status); return; }
            bytesToText(xhr.response, function (text) {
                if (text.indexOf("<i") < 0) { fail("不是弹幕 XML（" + text.slice(0, 40).replace(/\s+/g, " ") + "）"); return; }
                ok(parse(text));
            }, fail);
        };
        xhr.ontimeout = function () { fail("15 秒没回"); };
        xhr.onerror = function () { fail("连接失败"); };
        try { xhr.send(); } catch (e) { fail("send 抛异常"); }
    }

    /* ---------------- lanes ----------------
     * Every scrolling comment moves at the same speed, so two in the same lane
     * can never close on each other: the only check is at entry — the previous
     * one's tail (plus a gap) must already be on screen. `free[i]` is the media
     * time lane i next accepts a scroller.
     *
     * Top and bottom comments sit centred in the same rows (top-down and
     * bottom-up). The first version gave them their own bookkeeping and drew
     * them straight over whatever was scrolling through the middle of that row
     * (the verifier's screenshot: 「UP 主辛名场面来了」). Now a fixed comment
     * takes a row only once that row's last scroller has its tail left of the
     * centred box, and the row admits no new scroller until it is gone. */
    function Lanes(count) {
        this.count = count;
        this.reset();
    }
    Lanes.prototype.reset = function () {
        this.free = []; this.lastStart = []; this.lastW = []; this.fixedUntil = [];
        for (var i = 0; i < this.count; i++) {
            this.free.push(-Infinity); this.lastStart.push(-Infinity); this.lastW.push(0); this.fixedUntil.push(-Infinity);
        }
    };
    /* The rows on screen changed: the play panel covers the bottom of the
     * area while it is open. Shrinking keeps the bookkeeping of the rows it
     * hides, so when the panel closes and they come back, the comments still
     * crossing them are not run over by new ones. */
    Lanes.prototype.resize = function (count) {
        while (this.free.length < count) {
            this.free.push(-Infinity); this.lastStart.push(-Infinity); this.lastW.push(0); this.fixedUntil.push(-Infinity);
        }
        this.count = count;
    };
    /* → the lane (row index from the top), or -1 when nothing fits: dropped. */
    Lanes.prototype.scroll = function (now, width) {
        for (var i = 0; i < this.count; i++) {
            if (this.free[i] <= now && this.fixedUntil[i] <= now) {
                this.free[i] = now + (width + GAP) / SPEED;
                this.lastStart[i] = now;
                this.lastW[i] = width;
                return i;
            }
        }
        return -1;
    };
    Lanes.prototype.fixed = function (now, top, width) {
        var left = (WIDTH - width) / 2;
        for (var k = 0; k < this.count; k++) {
            var i = top ? k : this.count - 1 - k;
            if (this.fixedUntil[i] > now) { continue; }
            /* The last scroller's tail must already be left of the box. */
            if (this.lastStart[i] > -Infinity &&
                    now < this.lastStart[i] + (WIDTH + this.lastW[i] - left) / SPEED) { continue; }
            this.fixedUntil[i] = now + FIXED_MS;
            return i;
        }
        return -1;
    };

    /* ---------------- the renderer ---------------- */

    function renderer(box) {
        var list = [], idx = 0, lastPos = -1;
        var paused = false, speed = 1, density = "normal";
        var live = [], pool = [];
        var lineH = Math.round(FONT * LINE);
        var lanes = null, laneCount = 0;
        var measureCtx = null, family = "";

        function area() {
            var h = box.clientHeight || Math.round(1080 * 0.7);
            var n = Math.max(1, Math.floor(h / lineH));
            if (!lanes) { lanes = new Lanes(n); }
            else if (n !== laneCount) { lanes.resize(n); }
            laneCount = n;
            return lanes;
        }

        /* Widths come from canvas measureText with the container's own font,
         * not from offsetWidth: reading a layout per comment is a forced
         * reflow per comment, and a burst is dozens. */
        function fontPx(item) { return Math.max(30, Math.min(60, Math.round(FONT * item.size / 25))); }
        var warmed = false;
        function warm() {
            if (warmed) { return; }
            warmed = true;
            try { measureCtx = document.createElement("canvas").getContext("2d"); } catch (e) { measureCtx = null; }
            try { family = window.getComputedStyle(box).fontFamily || "sans-serif"; } catch (e2) { family = "sans-serif"; }
            /* The first measureText of CJK text resolves the font fallback:
             * ~18 ms on a desktop, a few times that on the set. Paid once, in
             * an idle moment after the list arrives, not inside the first burst. */
            if (measureCtx) {
                measureCtx.font = "600 " + FONT + "px " + family;
                try { measureCtx.measureText("弹幕测试 Danmaku 123"); } catch (e3) {}
            }
        }
        function measure(item) {
            if (!warmed) { warm(); }
            var px = fontPx(item);
            if (!measureCtx) { return Math.round(item.text.length * px * 0.9); }
            measureCtx.font = "600 " + px + "px " + family;
            return Math.ceil(measureCtx.measureText(item.text).width) + 8;
        }

        function take() {
            var node = pool.pop();
            if (!node) {
                node = document.createElement("div");
                node.className = "dm";
            }
            return node;
        }
        function release(entry) {
            var at = live.indexOf(entry);
            if (at >= 0) { live.splice(at, 1); }
            if (entry.anim) { try { entry.anim.onfinish = null; entry.anim.cancel(); } catch (e) {} entry.anim = null; }
            var node = entry.node;
            if (node.parentNode) { node.parentNode.removeChild(node); }
            if (pool.length < 80) { pool.push(node); }
        }

        /* Start on the frame grid. Left to the engine, the start time falls
         * between frames and every position after it carries the same
         * fraction: whole-pixel steps, but between two pixels for the whole
         * crossing. The timeline's current time is a frame's (between frames
         * Chromium rounds it onto the frame interval), so starting there puts
         * every later frame on a whole pixel — the desktop run measured 86%
         * of positions between pixels without this. */
        function alignStart(anim) {
            try {
                var t = document.timeline ? document.timeline.currentTime : null;
                if (typeof t === "number") { anim.startTime = t; }
            } catch (e) {}
        }

        function spawn(item, now) {
            var lanesNow = area();
            var w = measure(item), row, frames, duration;
            if (item.mode === 1) {
                row = lanesNow.scroll(now, w);
                if (row < 0) { return false; }
                duration = (WIDTH + w) / SPEED;
                frames = [{ transform: "translate3d(" + WIDTH + "px,0,0)" },
                          { transform: "translate3d(" + (-w) + "px,0,0)" }];
            } else {
                row = lanesNow.fixed(now, item.mode === 5, w);
                if (row < 0) { return false; }
                duration = FIXED_MS;
                var x = Math.round((WIDTH - w) / 2);
                frames = [{ transform: "translate3d(" + x + "px,0,0)" },
                          { transform: "translate3d(" + x + "px,0,0)" }];
            }
            var node = take();
            node.textContent = item.text;
            node.style.top = (row * lineH) + "px";
            node.style.fontSize = fontPx(item) + "px";
            node.style.color = item.color;
            /* Starts at its first keyframe before it is in the tree, so it is
             * never painted at left:0 for a frame. */
            node.style.transform = frames[0].transform;
            box.appendChild(node);
            var entry = { node: node, anim: null };
            var anim = node.animate(frames, { duration: duration, easing: "linear", fill: "forwards" });
            anim.playbackRate = speed;
            if (paused) { anim.pause(); } else { alignStart(anim); }
            anim.onfinish = function () { release(entry); };
            entry.anim = anim;
            live.push(entry);
            return true;
        }

        function lowerBound(pos) {
            var lo = 0, hi = list.length;
            while (lo < hi) {
                var mid = (lo + hi) >> 1;
                if (list[mid].t < pos) { lo = mid + 1; } else { hi = mid; }
            }
            return lo;
        }

        function clear() {
            while (live.length) { release(live[live.length - 1]); }
            if (lanes) { lanes.reset(); }
        }

        function pause(on) {
            on = !!on;
            if (on === paused) { return; }
            paused = on;
            for (var i = 0; i < live.length; i++) {
                try { if (on) { live[i].anim.pause(); } else { live[i].anim.play(); } } catch (e) {}
            }
        }

        return {
            set: function (l) {
                clear();
                list = l || [];
                idx = 0;
                lastPos = -1;
                if (!warmed && list.length) {
                    if (window.requestIdleCallback) { window.requestIdleCallback(warm, { timeout: 1500 }); }
                    else { setTimeout(warm, 0); }
                }
            },

            /* Called on every position report (~250–500 ms apart). Only spawns:
             * movement belongs to the compositor. */
            tick: function (pos, playing) {
                if (typeof playing === "boolean") { pause(!playing); }
                if (density === "off" || !list.length) { lastPos = pos; return; }
                if (lastPos < 0 || pos < lastPos - JUMP_MS || pos > lastPos + JUMP_MS) {
                    /* A seek (or the first report): start from here, no backlog. */
                    if (lastPos >= 0) { clear(); }
                    idx = lowerBound(pos);
                    lastPos = pos;
                    return;
                }
                if (pos <= lastPos) { return; }
                var cap = CAPS[density] || CAPS.normal, minW = MIN_WEIGHT[density] || 0;
                while (idx < list.length && list[idx].t <= pos) {
                    var item = list[idx++];
                    if (pos - item.t > LATE_MS || item.weight < minW) { continue; }
                    if (live.length >= cap) { continue; }
                    spawn(item, pos);
                }
                lastPos = pos;
            },

            pause: pause,

            rate: function (x) {
                speed = Number(x) || 1;
                for (var i = 0; i < live.length; i++) {
                    try { live[i].anim.playbackRate = speed; } catch (e) {}
                }
            },

            density: function (d) {
                if (!CAPS[d] && d !== "off") { d = "normal"; }
                density = d;
                if (d === "off") { clear(); }
            },

            clear: clear,

            /* For the log and the verifier. */
            stats: function () { return { live: live.length, pool: pool.length, lanes: laneCount, next: idx, total: list.length }; }
        };
    }

    return {
        load: load,
        renderer: renderer,
        /* Area is a CSS clip on the existing renderer, not a second layer or
         * another copy of the comment list. Invalid stored values stay safe. */
        area: function (v) { return v === "top" || v === "full" ? v : "upper"; },
        areaClass: function (v, visible) { return "dm-area-" + (v === "top" || v === "full" ? v : "upper") +
                   (visible ? "" : " hidden"); },
        /* Pure pieces, exposed for tools/danmaku-verify.mjs. */
        test: { parse: parse, Lanes: Lanes, SPEED: SPEED, GAP: GAP, FIXED_MS: FIXED_MS, WIDTH: WIDTH,
                /* deploy.sh --dmperf compares speeds within one run. */
                speed: function (v) { if (v > 0) { SPEED = v; } return SPEED; } }
    };
})();
