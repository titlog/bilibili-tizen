/* Read-only live comments. The socket is opened only after the first picture,
 * and is closed when the viewer turns comments off or leaves the room. */
var LiveDanmaku = (function () {
    "use strict";

    var inflateWaiters = null;
    function withInflater(done) {
        if (window.pako && window.pako.inflate) { done(true); return; }
        if (inflateWaiters) { inflateWaiters.push(done); return; }
        inflateWaiters = [done];
        var script = document.createElement("script");
        script.src = "vendor/pako_inflate.min.js";
        function finish(ok) {
            var waiters = inflateWaiters;
            inflateWaiters = null;
            for (var i = 0; i < waiters.length; i++) { waiters[i](ok); }
        }
        script.onload = function () { finish(!!(window.pako && window.pako.inflate)); };
        script.onerror = function () { finish(false); };
        document.head.appendChild(script);
    }

    function packet(op, body) {
        /* The auth JSON is UTF-8; TextEncoder is absent on older Tizen. */
        var utf8 = unescape(encodeURIComponent(body || ""));
        var bytes = new Uint8Array(16 + utf8.length), view = new DataView(bytes.buffer);
        view.setUint32(0, bytes.length);
        view.setUint16(4, 16);
        view.setUint16(6, 1);
        view.setUint32(8, op);
        view.setUint32(12, 1);
        for (var i = 0; i < utf8.length; i++) { bytes[16 + i] = utf8.charCodeAt(i); }
        return bytes.buffer;
    }

    function utf8(bytes) {
        if (window.TextDecoder) {
            try { return new TextDecoder("utf-8").decode(bytes); } catch (e) {}
        }
        var s = "";
        for (var i = 0; i < bytes.length; i += 4096) {
            s += String.fromCharCode.apply(null, bytes.subarray(i, i + 4096));
        }
        try { return decodeURIComponent(escape(s)); } catch (e2) { return ""; }
    }

    function messages(bytes, onComment, depth, onAuth) {
        if (depth > 2 || bytes.length > 2 * 1024 * 1024) { return; }
        var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (var at = 0, n = 0; at + 16 <= bytes.length && n < 200; n++) {
            var len = view.getUint32(at), header = view.getUint16(at + 4);
            if (len < 16 || header < 16 || at + len > bytes.length) { break; }
            var version = view.getUint16(at + 6), op = view.getUint32(at + 8);
            var body = bytes.subarray(at + header, at + len);
            if (op === 5 && version === 2 && window.pako) {
                try { messages(window.pako.inflate(body), onComment, depth + 1, onAuth); } catch (e) {}
            } else if (op === 5 && version <= 1) {
                try {
                    var msg = JSON.parse(utf8(body));
                    if (/^DANMU_MSG/.test(msg.cmd || "") && msg.info && typeof msg.info[1] === "string") {
                        onComment(msg.info[1]);
                    }
                } catch (e2) {}
            } else if (op === 8 && onAuth) {
                try { onAuth(JSON.parse(utf8(body)).code); } catch (e3) { onAuth(-1); }
            }
            at += len;
        }
    }

    function connect(roomId, onComment, onStatus) {
        var stopped = false, ws = null, heartbeat = null, retry = null, failures = 0;
        function closeSocket() {
            if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
            if (ws) {
                var old = ws;
                ws = null;
                old.onclose = old.onerror = old.onmessage = old.onopen = null;
                try { old.close(); } catch (e) {}
            }
        }
        function again(why) {
            if (stopped) { return; }
            closeSocket();
            if (++failures > 3) { onStatus("直播弹幕连接失败：" + why); return; }
            retry = setTimeout(start, Math.min(8000, failures * 2000));
        }
        function start() {
            retry = null;
            if (stopped) { return; }
            API.liveDanmuInfo(roomId, function (info) {
                if (stopped) { return; }
                var host = info.hosts[(failures || 0) % info.hosts.length];
                try { ws = new WebSocket("wss://" + host.host + ":" + host.wss_port + "/sub"); }
                catch (e) { again("WebSocket 无法打开"); return; }
                ws.binaryType = "arraybuffer";
                ws.onopen = function () {
                    if (stopped) { return; }
                    var auth = { uid: 0, roomid: info.roomId, protover: 2, buvid: info.buvid,
                                 platform: "web", type: 2, key: info.token };
                    ws.send(packet(7, JSON.stringify(auth)));
                    ws.send(packet(2, ""));
                    heartbeat = setInterval(function () {
                        if (ws && ws.readyState === 1) { ws.send(packet(2, "")); }
                    }, 30000);
                };
                ws.onmessage = function (event) {
                    if (stopped) { return; }
                    function auth(code) {
                        if (code === 0) { failures = 0; }
                        else { again("鉴权失败"); }
                    }
                    if (event.data instanceof ArrayBuffer) {
                        messages(new Uint8Array(event.data), onComment, 0, auth);
                    } else if (window.Blob && event.data instanceof Blob) {
                        var reader = new FileReader();
                        reader.onload = function () {
                            if (!stopped) { messages(new Uint8Array(reader.result), onComment, 0, auth); }
                        };
                        reader.readAsArrayBuffer(event.data);
                    }
                };
                ws.onerror = function () { /* onclose makes the one retry */ };
                ws.onclose = function () { again("连接断开"); };
            }, function (why) { again(why); });
        }
        withInflater(function (ok) {
            if (stopped) { return; }
            if (!ok) { onStatus("直播弹幕解压组件未加载"); return; }
            start();
        });
        return { close: function () {
            stopped = true;
            if (retry) { clearTimeout(retry); retry = null; }
            closeSocket();
        } };
    }

    return { connect: connect };
})();
