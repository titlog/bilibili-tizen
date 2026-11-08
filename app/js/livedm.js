/* 直播弹幕: the comments of a live room, as they are sent.
 *
 * A video's comments are a file fetched once (danmaku.js); a room's are a
 * WebSocket that never ends. This is the client for it, nothing more — the
 * drawing is danmaku.js's renderer, given each comment through push().
 *
 *   var c = LiveDanmaku.connect(roomId, { onItem(item), onState(text) })
 *   c.close()
 *
 * Anonymous, like the stream itself: `x/v1/dm/list.so` needs no account and
 * neither does this. The room's token comes from the old, unsigned
 * `room/v1/Danmu/getConf` (the signed `getDanmuInfo` answers -352 without a
 * WBI signature and a buvid cookie — measured 2026-11-07), and a uid of 0 is
 * accepted; the comments themselves arrive in the clear either way.
 *
 * The wire (bilibili's live socket, as documented by pskdje/bilibili-API-
 * collect): every packet is a 16-byte header — length u32, header length u16
 * (16), version u16, operation u32, sequence u32, all big-endian — and a
 * body. We send 7 (auth, JSON) and 2 (heartbeat, every 30 s); we get 8 (auth
 * reply), 3 (popularity) and 5 (a command, JSON). Version 2 bodies are zlib
 * holding more packets — the server sends them whatever protover is asked
 * for — and version 3 is brotli, which protover 2 keeps it from using.
 *
 * What is kept: DANMU_MSG, text only. Stickers (an emoticon is a comment whose
 * "text" is a sticker id), gifts, enter notices, everything else is dropped
 * before it costs anything.
 *
 * Verified off the television by tools/livedm-verify.mjs.
 */
var LiveDanmaku = (function () {
    "use strict";

    var CONF = "https://api.live.bilibili.com/room/v1/Danmu/getConf?platform=pc&player=web&room_id=";
    var FALLBACK_HOST = "broadcastlv.chat.bilibili.com";
    var HEARTBEAT_MS = 30000;
    var AUTH_WAIT_MS = 8000;       /* open, but no answer to the auth: that host is not working */
    var MAX_TEXT = 80;             /* a comment longer than this is a paste, not a comment */
    var GIVE_UP = 6;               /* connection attempts in a row that never got as far as an auth reply */

    /* ---------------- the wire ---------------- */

    function utf8(u8) {
        if (typeof TextDecoder !== "undefined") { return new TextDecoder("utf-8").decode(u8); }
        var s = "";
        for (var i = 0; i < u8.length; i += 8192) {
            s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(u8.length, i + 8192)));
        }
        try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
    }
    function utf8Bytes(str) {
        if (typeof TextEncoder !== "undefined") { return new TextEncoder().encode(str); }
        var bin = unescape(encodeURIComponent(str)), u8 = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) { u8[i] = bin.charCodeAt(i); }
        return u8;
    }

    /* One packet to send → ArrayBuffer. */
    function pack(op, bodyText) {
        var body = utf8Bytes(bodyText || ""), buf = new ArrayBuffer(16 + body.length), dv = new DataView(buf);
        dv.setUint32(0, 16 + body.length);
        dv.setUint16(4, 16);
        dv.setUint16(6, 1);
        dv.setUint32(8, op);
        dv.setUint32(12, 1);
        new Uint8Array(buf, 16).set(body);
        return buf;
    }

    /* Everything in a received frame → [{op, ver, body: Uint8Array}].
     * Version-2 packets are unwrapped into the packets inside them. `skipped`
     * counts what could not be read (brotli, a truncated bundle, bad zlib): a
     * decoder that silently turns those into "no comments" would make a
     * server-side change look like a quiet room. */
    function unpack(buf, depth) {
        var u8 = ArrayBuffer.isView(buf) ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : new Uint8Array(buf),
            out = [], off = 0, skipped = 0;
        var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        depth = depth || 0;
        while (off + 16 <= u8.length) {
            var len = dv.getUint32(off), hl = dv.getUint16(off + 4), ver = dv.getUint16(off + 6), op = dv.getUint32(off + 8);
            if (len < hl || hl < 16 || off + len > u8.length) { skipped++; break; }
            var body = u8.subarray(off + hl, off + len);
            if (ver === 2 && op === 5) {
                if (depth > 0) { skipped++; }
                else {
                    try {
                        var inner = unpack(Inflate.zlib(body), 1);
                        for (var i = 0; i < inner.packets.length; i++) { out.push(inner.packets[i]); }
                        skipped += inner.skipped;
                    } catch (e) { skipped++; }
                }
            } else if (ver === 3) { skipped++; }
            else { out.push({ op: op, ver: ver, body: body }); }
            off += len;
        }
        return { packets: out, skipped: skipped };
    }

    function hexColor(n) {
        var s = ((Number(n) || 0) & 0xffffff).toString(16);
        while (s.length < 6) { s = "0" + s; }
        return "#" + s;
    }

    /* A DANMU_MSG command → the item danmaku.js's renderer draws, or null.
     * info[0] = [?, mode, fontsize, color, sent, rnd, ?, midHash, ?, ?, ?, ?, emoticonType, …];
     * info[1] = the text. Mode is 1 (scrolling), 4 (bottom) or 5 (top), as on demand. */
    function toItem(j) {
        if (!j || typeof j.cmd !== "string" || j.cmd.indexOf("DANMU_MSG") !== 0) { return null; }
        var info = j.info;
        if (!info || !info[0] || typeof info[1] !== "string") { return null; }
        var meta = info[0];
        if (Number(meta[12]) === 1) { return null; }   /* a sticker: the text is its id */
        var text = info[1].replace(/[\r\n\t]+/g, " ").replace(/^\s+|\s+$/g, "");
        if (!text || text.length > MAX_TEXT) { return null; }
        var mode = Number(meta[1]);
        return {
            t: 0,
            mode: mode === 4 || mode === 5 ? mode : 1,
            size: Number(meta[2]) || 25,
            color: hexColor(meta[3]),
            text: text,
            weight: 10
        };
    }

    /* ---------------- the connection ---------------- */

    function fetchConf(roomId, onOk, onFail) {
        var xhr = new XMLHttpRequest(), settled = false;
        function fail(why) { if (!settled) { settled = true; onFail(why); } }
        try { xhr.open("GET", CONF + encodeURIComponent(roomId), true); }
        catch (e) { fail("open 失败"); return; }
        xhr.timeout = 10000;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || settled) { return; }
            if (xhr.status !== 200) { fail("getConf HTTP " + xhr.status); return; }
            var j;
            try { j = JSON.parse(xhr.responseText); } catch (e) { fail("getConf 不是 JSON"); return; }
            if (!j || j.code !== 0 || !j.data) { fail("getConf code " + (j && j.code)); return; }
            settled = true;
            onOk(j.data);
        };
        xhr.ontimeout = function () { fail("getConf 超时"); };
        xhr.onerror = function () { fail("getConf 连不上"); };
        try { xhr.send(); } catch (e2) { fail("getConf send 抛异常"); }
    }

    /* The sockets to try, best first: the room's own list, then the generic host. */
    function endpoints(conf) {
        var out = [], seen = {};
        function add(host, port) {
            if (!host) { return; }
            var url = "wss://" + host + (port && port !== 443 ? ":" + port : "") + "/sub";
            if (!seen[url]) { seen[url] = true; out.push(url); }
        }
        var list = (conf && conf.host_server_list) || [];
        for (var i = 0; i < list.length; i++) { add(list[i].host, Number(list[i].wss_port) || 443); }
        add(FALLBACK_HOST, 443);
        return out;
    }

    function connect(roomId, h) {
        var closed = false, ws = null, hb = null, authTimer = null, retryTimer = null;
        var fails = 0, attempt = 0, authed = false, conf = null, total = 0, skippedTotal = 0;
        function state(text) { if (h.onState && !closed) { try { h.onState(text); } catch (e) {} } }

        function teardown() {
            if (hb) { clearInterval(hb); hb = null; }
            if (authTimer) { clearTimeout(authTimer); authTimer = null; }
            if (ws) {
                ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
                try { ws.close(); } catch (e) {}
                ws = null;
            }
        }

        function retry(why) {
            teardown();
            if (closed) { return; }
            /* Reaching an auth reply and then losing the link is a link that
             * worked; only attempts that never got that far run the budget out. */
            if (!authed) { fails++; }
            if (fails >= GIVE_UP) { state("连不上，不再试了（" + why + "）"); closed = true; return; }
            var wait = authed ? 1500 : Math.min(30000, 2000 * Math.pow(2, Math.max(0, fails - 1)));
            authed = false;
            state("断开（" + why + "），" + Math.round(wait / 1000) + " 秒后重连");
            retryTimer = setTimeout(function () { retryTimer = null; open(); }, wait);
        }

        function open() {
            if (closed) { return; }
            if (!conf) {
                fetchConf(roomId, function (c) { conf = c; open(); }, function (why) { retry(why); });
                return;
            }
            var urls = endpoints(conf), url = urls[attempt++ % urls.length];
            try { ws = new WebSocket(url); }
            catch (e) { retry("WebSocket 建不起来"); return; }
            ws.binaryType = "arraybuffer";
            var sock = ws;
            ws.onopen = function () {
                if (sock !== ws) { return; }
                var auth = { uid: 0, roomid: Number(roomId), protover: 2, platform: "web", type: 2 };
                if (conf.token) { auth.key = conf.token; }
                try { ws.send(pack(7, JSON.stringify(auth))); } catch (e) { retry("发不出认证"); return; }
                authTimer = setTimeout(function () { authTimer = null; if (sock === ws && !authed) { retry("认证 " + AUTH_WAIT_MS / 1000 + " 秒没回"); } }, AUTH_WAIT_MS);
            };
            ws.onmessage = function (ev) {
                if (sock !== ws || closed || !ev.data || typeof ev.data === "string") { return; }
                var r;
                try { r = unpack(ev.data); } catch (e) { skippedTotal++; return; }
                skippedTotal += r.skipped;
                for (var i = 0; i < r.packets.length; i++) {
                    var p = r.packets[i];
                    if (p.op === 8) {
                        var code = -1;
                        try { code = JSON.parse(utf8(p.body)).code; } catch (e) {}
                        if (code !== 0) { retry("认证被拒（code " + code + "）"); return; }
                        authed = true;
                        fails = 0;
                        if (authTimer) { clearTimeout(authTimer); authTimer = null; }
                        try { ws.send(pack(2, "")); } catch (e) {}
                        hb = setInterval(function () { try { if (ws) { ws.send(pack(2, "")); } } catch (e) {} }, HEARTBEAT_MS);
                        state("连上了（" + url.replace(/^wss:\/\//, "").replace(/\/sub$/, "") + "）");
                    } else if (p.op === 5) {
                        var item = null;
                        try { item = toItem(JSON.parse(utf8(p.body))); } catch (e) {}
                        if (item) { total++; h.onItem(item); }
                    }
                }
            };
            ws.onerror = function () { /* onclose follows and carries the retry */ };
            ws.onclose = function (ev) { if (sock === ws) { retry("连接断了" + (ev && ev.code ? " " + ev.code : "")); } };
        }

        open();
        return {
            close: function () {
                closed = true;
                if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
                teardown();
            },
            /* For the log: comments handed on, and packets that could not be read. */
            stats: function () { return { comments: total, skipped: skippedTotal, connected: !!authed }; }
        };
    }

    return {
        connect: connect,
        /* Pure pieces, exposed for tools/livedm-verify.mjs. */
        test: { pack: pack, unpack: unpack, toItem: toItem, endpoints: endpoints, utf8: utf8 }
    };
})();
