/* A QR encoder, byte mode, error correction level L, versions 1..10.
 *
 * This is here rather than a call to some qr-image web service on purpose: the
 * payload is a single-use bilibili login token, and anything that can read it
 * can complete the login as the user. It never leaves the TV.
 *
 * Verified module-for-module against the `qrcode` npm package by
 * tools/qr-verify.mjs — run that after touching anything in here.
 */
var QR = (function () {
    "use strict";

    /* [ec codewords per block, blocks in group 1, data per block in group 1,
     *  blocks in group 2, data per block in group 2] */
    var RS = {
        1:  [7,  1, 19, 0, 0],
        2:  [10, 1, 34, 0, 0],
        3:  [15, 1, 55, 0, 0],
        4:  [20, 1, 80, 0, 0],
        5:  [26, 1, 108, 0, 0],
        6:  [18, 2, 68, 0, 0],
        7:  [20, 2, 78, 0, 0],
        8:  [24, 2, 97, 0, 0],
        9:  [30, 2, 116, 0, 0],
        10: [18, 2, 68, 2, 69]
    };

    var ALIGN = {
        1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
        6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
    };

    /* ---- GF(256) ---- */
    var EXP = new Array(512), LOG = new Array(256);
    (function () {
        var x = 1;
        for (var i = 0; i < 255; i++) {
            EXP[i] = x;
            LOG[x] = i;
            x <<= 1;
            if (x & 0x100) { x ^= 0x11d; }
        }
        for (var j = 255; j < 512; j++) { EXP[j] = EXP[j - 255]; }
    })();

    function gmul(a, b) {
        if (a === 0 || b === 0) { return 0; }
        return EXP[LOG[a] + LOG[b]];
    }

    function rsGenerator(n) {
        var poly = [1];
        for (var i = 0; i < n; i++) {
            var next = poly.slice();
            next.push(0);
            for (var j = 0; j < poly.length; j++) {
                next[j + 1] ^= gmul(poly[j], EXP[i]);
            }
            poly = next;
        }
        return poly;
    }

    function rsEncode(data, ecLen) {
        var gen = rsGenerator(ecLen);
        var res = new Array(ecLen);
        for (var i = 0; i < ecLen; i++) { res[i] = 0; }
        for (var k = 0; k < data.length; k++) {
            var factor = data[k] ^ res[0];
            res.shift();
            res.push(0);
            for (var j = 0; j < gen.length - 1; j++) {
                res[j] ^= gmul(gen[j + 1], factor);
            }
        }
        return res;
    }

    /* ---- BCH for format and version information ---- */

    function bch(value, poly, bits) {
        var v = value << bits;
        var polyBits = 0, t = poly;
        while (t) { polyBits++; t >>= 1; }
        var vb = 0, u = v;
        while (u) { vb++; u >>= 1; }
        while (vb >= polyBits) {
            v ^= poly << (vb - polyBits);
            vb = 0; u = v;
            while (u) { vb++; u >>= 1; }
        }
        return v;
    }

    function formatBits(mask) {
        /* 01 is error correction level L. */
        var data = (0x01 << 3) | mask;
        var full = (data << 10) | bch(data, 0x537, 10);
        return full ^ 0x5412;
    }

    function versionBits(version) {
        return (version << 12) | bch(version, 0x1f25, 12);
    }

    /* ---- module grid ---- */

    function make(version) {
        var size = version * 4 + 17;
        var m = [], reserved = [];
        for (var r = 0; r < size; r++) {
            m.push(new Array(size));
            reserved.push(new Array(size));
            for (var c = 0; c < size; c++) { m[r][c] = 0; reserved[r][c] = 0; }
        }

        function finder(r0, c0) {
            for (var r = -1; r <= 7; r++) {
                for (var c = -1; c <= 7; c++) {
                    var rr = r0 + r, cc = c0 + c;
                    if (rr < 0 || cc < 0 || rr >= size || cc >= size) { continue; }
                    var on = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                             (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                             (r >= 2 && r <= 4 && c >= 2 && c <= 4);
                    m[rr][cc] = on ? 1 : 0;
                    reserved[rr][cc] = 1;
                }
            }
        }
        finder(0, 0);
        finder(0, size - 7);
        finder(size - 7, 0);

        var centres = ALIGN[version];
        for (var i = 0; i < centres.length; i++) {
            for (var j = 0; j < centres.length; j++) {
                var ar = centres[i], ac = centres[j];
                if (reserved[ar][ac]) { continue; }
                for (var dr = -2; dr <= 2; dr++) {
                    for (var dc = -2; dc <= 2; dc++) {
                        m[ar + dr][ac + dc] =
                            (Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)) ? 1 : 0;
                        reserved[ar + dr][ac + dc] = 1;
                    }
                }
            }
        }

        for (var k = 8; k < size - 8; k++) {
            m[6][k] = (k % 2 === 0) ? 1 : 0; reserved[6][k] = 1;
            m[k][6] = (k % 2 === 0) ? 1 : 0; reserved[k][6] = 1;
        }

        /* Always-dark module, and the format areas are reserved before data. */
        m[size - 8][8] = 1; reserved[size - 8][8] = 1;
        for (var f = 0; f < 9; f++) {
            if (!reserved[8][f]) { reserved[8][f] = 1; }
            if (!reserved[f][8]) { reserved[f][8] = 1; }
        }
        for (var g = 0; g < 8; g++) {
            reserved[8][size - 1 - g] = 1;
            reserved[size - 1 - g][8] = 1;
        }
        if (version >= 7) {
            for (var v = 0; v < 18; v++) {
                var rr2 = Math.floor(v / 3), cc2 = v % 3;
                reserved[rr2][size - 11 + cc2] = 1;
                reserved[size - 11 + cc2][rr2] = 1;
            }
        }
        return { size: size, m: m, reserved: reserved };
    }

    function placeData(grid, bits) {
        var size = grid.size, m = grid.m, reserved = grid.reserved;
        var idx = 0, upward = true;
        for (var right = size - 1; right > 0; right -= 2) {
            if (right === 6) { right = 5; }
            for (var step = 0; step < size; step++) {
                var row = upward ? size - 1 - step : step;
                for (var col = right; col > right - 2; col--) {
                    if (reserved[row][col]) { continue; }
                    m[row][col] = idx < bits.length ? bits[idx] : 0;
                    idx++;
                }
            }
            upward = !upward;
        }
    }

    function maskFn(n, r, c) {
        switch (n) {
            case 0: return (r + c) % 2 === 0;
            case 1: return r % 2 === 0;
            case 2: return c % 3 === 0;
            case 3: return (r + c) % 3 === 0;
            case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
            case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
            case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
            default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
        }
    }

    function penalty(m, size) {
        var score = 0, r, c, i, run, dark = 0;

        for (r = 0; r < size; r++) {
            run = 1;
            for (c = 1; c < size; c++) {
                if (m[r][c] === m[r][c - 1]) { run++; }
                else { if (run >= 5) { score += 3 + (run - 5); } run = 1; }
            }
            if (run >= 5) { score += 3 + (run - 5); }
        }
        for (c = 0; c < size; c++) {
            run = 1;
            for (r = 1; r < size; r++) {
                if (m[r][c] === m[r - 1][c]) { run++; }
                else { if (run >= 5) { score += 3 + (run - 5); } run = 1; }
            }
            if (run >= 5) { score += 3 + (run - 5); }
        }
        for (r = 0; r < size - 1; r++) {
            for (c = 0; c < size - 1; c++) {
                var s = m[r][c] + m[r][c + 1] + m[r + 1][c] + m[r + 1][c + 1];
                if (s === 0 || s === 4) { score += 3; }
            }
        }
        var pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
        var pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
        function hit(get, len) {
            for (var k = 0; k + 11 <= len; k++) {
                var a = true, b = true;
                for (i = 0; i < 11; i++) {
                    if (get(k + i) !== pat1[i]) { a = false; }
                    if (get(k + i) !== pat2[i]) { b = false; }
                }
                if (a || b) { score += 40; }
            }
        }
        for (r = 0; r < size; r++) {
            (function (row) { hit(function (i2) { return m[row][i2]; }, size); })(r);
        }
        for (c = 0; c < size; c++) {
            (function (col) { hit(function (i2) { return m[i2][col]; }, size); })(c);
        }
        for (r = 0; r < size; r++) {
            for (c = 0; c < size; c++) { dark += m[r][c]; }
        }
        var pct = (dark * 100) / (size * size);
        score += Math.floor(Math.abs(pct - 50) / 5) * 10;
        return score;
    }

    function applyFormat(grid, mask, version) {
        var size = grid.size, m = grid.m;
        var fmt = formatBits(mask);
        for (var i = 0; i < 15; i++) {
            var bit = (fmt >> i) & 1;
            if (i < 6) { m[i][8] = bit; }
            else if (i === 6) { m[7][8] = bit; }
            else if (i === 7) { m[8][8] = bit; }
            else if (i === 8) { m[8][7] = bit; }
            else { m[8][14 - i] = bit; }

            if (i < 8) { m[8][size - 1 - i] = bit; }
            else { m[size - 15 + i][8] = bit; }
        }
        m[size - 8][8] = 1;

        if (version >= 7) {
            var vb = versionBits(version);
            for (var v = 0; v < 18; v++) {
                var b = (vb >> v) & 1;
                var rr = Math.floor(v / 3), cc = v % 3;
                m[rr][size - 11 + cc] = b;
                m[size - 11 + cc][rr] = b;
            }
        }
    }

    function encode(text) {
        /* UTF-8 bytes; bilibili's login url is ASCII but this keeps it general. */
        var utf8 = unescape(encodeURIComponent(text));
        var bytes = [];
        for (var i = 0; i < utf8.length; i++) { bytes.push(utf8.charCodeAt(i) & 0xff); }

        var version = 0;
        for (var v = 1; v <= 10; v++) {
            var spec = RS[v];
            var dataCw = spec[1] * spec[2] + spec[3] * spec[4];
            var headerBits = 4 + (v >= 10 ? 16 : 8);
            if (dataCw * 8 - headerBits >= bytes.length * 8) { version = v; break; }
        }
        if (!version) { throw new Error("payload too long for version 10"); }

        var spec2 = RS[version];
        var ecLen = spec2[0];
        var totalData = spec2[1] * spec2[2] + spec2[3] * spec2[4];
        var lenBits = version >= 10 ? 16 : 8;

        var bits = [];
        function push(value, n) {
            for (var k = n - 1; k >= 0; k--) { bits.push((value >> k) & 1); }
        }
        push(4, 4);                       /* byte mode */
        push(bytes.length, lenBits);
        for (var b = 0; b < bytes.length; b++) { push(bytes[b], 8); }

        var cap = totalData * 8;
        for (var t = 0; t < 4 && bits.length < cap; t++) { bits.push(0); }
        while (bits.length % 8 !== 0) { bits.push(0); }

        var codewords = [];
        for (var q = 0; q < bits.length; q += 8) {
            var byteVal = 0;
            for (var w = 0; w < 8; w++) { byteVal = (byteVal << 1) | bits[q + w]; }
            codewords.push(byteVal);
        }
        var pad = [0xec, 0x11], pi = 0;
        while (codewords.length < totalData) { codewords.push(pad[pi++ % 2]); }

        /* Split into blocks, compute ECC, then interleave as the spec requires. */
        var blocks = [], offset = 0, n;
        for (n = 0; n < spec2[1]; n++) {
            blocks.push(codewords.slice(offset, offset + spec2[2]));
            offset += spec2[2];
        }
        for (n = 0; n < spec2[3]; n++) {
            blocks.push(codewords.slice(offset, offset + spec2[4]));
            offset += spec2[4];
        }
        var eccBlocks = blocks.map(function (blk) { return rsEncode(blk, ecLen); });

        var maxData = Math.max(spec2[2], spec2[4] || 0);
        var out = [];
        for (var d = 0; d < maxData; d++) {
            for (n = 0; n < blocks.length; n++) {
                if (d < blocks[n].length) { out.push(blocks[n][d]); }
            }
        }
        for (var e = 0; e < ecLen; e++) {
            for (n = 0; n < eccBlocks.length; n++) { out.push(eccBlocks[n][e]); }
        }

        var finalBits = [];
        for (var o = 0; o < out.length; o++) {
            for (var z = 7; z >= 0; z--) { finalBits.push((out[o] >> z) & 1); }
        }

        var best = null, bestScore = Infinity;
        for (var mask = 0; mask < 8; mask++) {
            var grid = make(version);
            placeData(grid, finalBits);
            for (var r = 0; r < grid.size; r++) {
                for (var c = 0; c < grid.size; c++) {
                    if (!grid.reserved[r][c] && maskFn(mask, r, c)) {
                        grid.m[r][c] ^= 1;
                    }
                }
            }
            applyFormat(grid, mask, version);
            var s = penalty(grid.m, grid.size);
            if (s < bestScore) { bestScore = s; best = grid; }
        }
        return { size: best.size, modules: best.m, version: version };
    }

    /* Rendered as a table of divs: canvas is available but this keeps the
     * renderer trivial and the quiet zone explicit. */
    function toHtml(text, moduleSize) {
        var q = encode(text);
        var px = moduleSize || 8;
        var quiet = 4;
        var side = (q.size + quiet * 2) * px;
        var html = '<div class="qr" style="width:' + side + 'px;height:' + side +
                   'px;background:#fff;padding:' + (quiet * px) + 'px">';
        for (var r = 0; r < q.size; r++) {
            html += '<div style="height:' + px + 'px;line-height:0;font-size:0">';
            for (var c = 0; c < q.size; c++) {
                html += '<span style="display:inline-block;width:' + px + 'px;height:' + px +
                        'px;background:' + (q.modules[r][c] ? "#000" : "#fff") + '"></span>';
            }
            html += "</div>";
        }
        return html + "</div>";
    }

    return { encode: encode, toHtml: toHtml };
})();
