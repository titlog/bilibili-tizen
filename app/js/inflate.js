/* A zlib/deflate decoder in ES5, for the live danmaku socket.
 *
 * Why it exists: bilibili's live comment socket sends its bundles as zlib
 * (packet version 2) whatever protocol version the client asks for — measured
 * 2026-11-07 with protover 0, 1 and 2, all answered with version 2. The
 * engines this app supports reach back to Chromium 47, and
 * DecompressionStream arrived in Chromium 80, so the one thing that works
 * everywhere is to do it here. Bundles are a few KB; a bit-at-a-time decoder
 * (the shape of zlib's own contrib/puff.c) is fast enough and short enough to
 * check by eye.
 *
 *   Inflate.zlib(Uint8Array) → Uint8Array     (throws Error on bad data)
 *   Inflate.raw(Uint8Array)  → Uint8Array     (deflate stream without the zlib wrapper)
 *
 * Verified against node's zlib by tools/livedm-verify.mjs.
 */
var Inflate = (function () {
    "use strict";

    var LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
    var LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
    var DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073,
                 4097, 6145, 8193, 12289, 16385, 24577];
    var DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
    var CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
    /* Nothing real is this big (a bundle is a few KB); a corrupt stream must
     * not be able to ask for the whole heap. */
    var MAX_OUT = 8 * 1024 * 1024;

    function Stream(src, pos) {
        this.src = src; this.pos = pos || 0; this.bitBuf = 0; this.bitCnt = 0;
        this.out = new Uint8Array(Math.max(1024, src.length * 4)); this.n = 0;
    }
    Stream.prototype.bits = function (need) {
        var val = this.bitBuf;
        while (this.bitCnt < need) {
            if (this.pos >= this.src.length) { throw new Error("inflate: 数据到头了"); }
            val |= this.src[this.pos++] << this.bitCnt;
            this.bitCnt += 8;
        }
        this.bitBuf = val >>> need;
        this.bitCnt -= need;
        return val & ((1 << need) - 1);
    };
    Stream.prototype.put = function (b) {
        if (this.n >= this.out.length) {
            if (this.n >= MAX_OUT) { throw new Error("inflate: 输出太大"); }
            var bigger = new Uint8Array(this.out.length * 2);
            bigger.set(this.out);
            this.out = bigger;
        }
        this.out[this.n++] = b;
    };

    /* count[len] = how many codes have that length; symbol = the symbols
     * ordered by (length, value) — canonical Huffman, as in RFC 1951. */
    function build(lengths, n) {
        var count = [], offs = [], symbol = [], i;
        for (i = 0; i < 16; i++) { count[i] = 0; }
        for (i = 0; i < n; i++) { count[lengths[i]]++; }
        offs[1] = 0;
        for (i = 1; i < 15; i++) { offs[i + 1] = offs[i] + count[i]; }
        for (i = 0; i < n; i++) { if (lengths[i]) { symbol[offs[lengths[i]]++] = i; } }
        return { count: count, symbol: symbol };
    }

    function decodeSym(s, h) {
        var code = 0, first = 0, index = 0;
        for (var len = 1; len <= 15; len++) {
            code |= s.bits(1);
            var cnt = h.count[len];
            if (code - cnt < first) { return h.symbol[index + (code - first)]; }
            index += cnt;
            first += cnt;
            first <<= 1;
            code <<= 1;
        }
        throw new Error("inflate: 码不对");
    }

    function codes(s, lit, dist) {
        for (;;) {
            var sym = decodeSym(s, lit);
            if (sym < 256) { s.put(sym); continue; }
            if (sym === 256) { return; }
            sym -= 257;
            if (sym >= 29) { throw new Error("inflate: 长度码不对"); }
            var len = LBASE[sym] + s.bits(LEXT[sym]);
            var ds = decodeSym(s, dist);
            if (ds >= 30) { throw new Error("inflate: 距离码不对"); }
            var d = DBASE[ds] + s.bits(DEXT[ds]);
            if (d > s.n) { throw new Error("inflate: 距离超出已有的输出"); }
            while (len--) { s.put(s.out[s.n - d]); }
        }
    }

    var FIXED = null;
    function fixedTables() {
        if (FIXED) { return FIXED; }
        var l = [], i;
        for (i = 0; i < 144; i++) { l[i] = 8; }
        for (; i < 256; i++) { l[i] = 9; }
        for (; i < 280; i++) { l[i] = 7; }
        for (; i < 288; i++) { l[i] = 8; }
        var d = [];
        for (i = 0; i < 30; i++) { d[i] = 5; }
        FIXED = { lit: build(l, 288), dist: build(d, 30) };
        return FIXED;
    }

    function dynamic(s) {
        var nlen = s.bits(5) + 257, ndist = s.bits(5) + 1, ncode = s.bits(4) + 4, i;
        if (nlen > 286 || ndist > 30) { throw new Error("inflate: 表太大"); }
        var lengths = [];
        for (i = 0; i < 19; i++) { lengths[i] = 0; }
        for (i = 0; i < ncode; i++) { lengths[CLORDER[i]] = s.bits(3); }
        var lencode = build(lengths, 19);
        var all = [], idx = 0;
        while (idx < nlen + ndist) {
            var sym = decodeSym(s, lencode), len = 0, rep;
            if (sym < 16) { all[idx++] = sym; continue; }
            if (sym === 16) {
                if (idx === 0) { throw new Error("inflate: 没有可重复的长度"); }
                len = all[idx - 1];
                rep = 3 + s.bits(2);
            } else if (sym === 17) { rep = 3 + s.bits(3); }
            else { rep = 11 + s.bits(7); }
            if (idx + rep > nlen + ndist) { throw new Error("inflate: 长度重复过头"); }
            while (rep--) { all[idx++] = len; }
        }
        if (all[256] === 0) { throw new Error("inflate: 没有结束码"); }
        return { lit: build(all.slice(0, nlen), nlen), dist: build(all.slice(nlen), ndist) };
    }

    function stored(s) {
        s.bitBuf = 0; s.bitCnt = 0;   /* drop the rest of the current byte */
        if (s.pos + 4 > s.src.length) { throw new Error("inflate: 数据到头了"); }
        var len = s.src[s.pos] | (s.src[s.pos + 1] << 8);
        var nlen = s.src[s.pos + 2] | (s.src[s.pos + 3] << 8);
        if ((len ^ 0xffff) !== nlen) { throw new Error("inflate: 存储块长度校验不对"); }
        s.pos += 4;
        if (s.pos + len > s.src.length) { throw new Error("inflate: 数据到头了"); }
        while (len--) { s.put(s.src[s.pos++]); }
    }

    function run(src, pos) {
        var s = new Stream(src, pos), last;
        do {
            last = s.bits(1);
            var type = s.bits(2);
            if (type === 0) { stored(s); }
            else if (type === 1) { var f = fixedTables(); codes(s, f.lit, f.dist); }
            else if (type === 2) { var t = dynamic(s); codes(s, t.lit, t.dist); }
            else { throw new Error("inflate: 块类型不对"); }
        } while (!last);
        return s.out.subarray(0, s.n);
    }

    return {
        raw: function (u8) { return run(u8, 0); },
        /* RFC 1950: CMF, FLG, the deflate stream, then an Adler-32 this does
         * not check (the socket's framing already says where a bundle ends). */
        zlib: function (u8) {
            if (u8.length < 2 || (u8[0] & 0x0f) !== 8 || ((u8[0] << 8) | u8[1]) % 31 !== 0) { throw new Error("inflate: 不是 zlib"); }
            if (u8[1] & 0x20) { throw new Error("inflate: zlib 带预设字典"); }
            return run(u8, 2);
        }
    };
})();
