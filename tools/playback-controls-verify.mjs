import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("../app/", import.meta.url));
const store = new Map();
const ctx = { localStorage: {
    getItem: (key) => store.get(key) || null,
    setItem: (key, value) => store.set(key, value),
}, Uint8Array, DataView, ArrayBuffer, Date, Math, JSON, String, Number,
encodeURIComponent, decodeURIComponent, escape, unescape };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(app + "js/settings.js", "utf8"), ctx);
assert.equal(ctx.Settings.qnCap(), 120);
ctx.Settings.setPlaybackQnCap(80);
assert.equal(ctx.Settings.qnCap(), 80, "video selection caps stream requests");
assert.equal(ctx.Settings.savedQnCap(), 120, "selection does not change TV setting");
ctx.Settings.set("maxQn", 64);
assert.equal(ctx.Settings.qnCap(), 80, "video choice remains independent of TV setting");
ctx.Settings.setPlaybackQnCap(0);
assert.equal(ctx.Settings.qnCap(), 64, "next video returns to the saved limit");
assert.doesNotMatch(store.get("bili.settings"), /playbackQn/, "transient choice is not persisted");

let signedQuery = "";
ctx.XMLHttpRequest = class {
    open(method, url) { this.url = url; }
    setRequestHeader() {}
    send() {
        queueMicrotask(() => {
            const url = new URL(this.url);
            let reply;
            if (url.pathname.endsWith("room_init")) {
                reply = { code: 0, data: { room_id: 123456 } };
            } else if (url.pathname.endsWith("/nav")) {
                reply = { code: -101, data: { wbi_img: {
                    img_url: "https://example.test/" + "a".repeat(32) + ".png",
                    sub_url: "https://example.test/" + "b".repeat(32) + ".png",
                } } };
            } else if (url.pathname.endsWith("/finger/spi")) {
                reply = { code: 0, data: { b_3: "test-buvid" } };
            } else if (url.pathname.endsWith("getDanmuInfo")) {
                signedQuery = url.search.slice(1);
                reply = { code: 0, data: { token: "test-token", host_list: [{ host: "example.test", wss_port: 2245 }] } };
            } else { throw Error("unexpected API " + url.pathname); }
            this.status = 200;
            this.readyState = 4;
            this.responseText = JSON.stringify(reply);
            this.onreadystatechange();
        });
    }
};
vm.runInContext(fs.readFileSync(app + "js/md5.js", "utf8"), ctx);
vm.runInContext(fs.readFileSync(app + "js/api.js", "utf8"), ctx);
const info = await new Promise((resolve, reject) => ctx.API.liveDanmuInfo(6, resolve, reject));
assert.equal(info.roomId, 123456, "short room id resolves before authentication");
assert.equal(info.token, "test-token");
const params = new URLSearchParams(signedQuery);
const sentSign = params.get("w_rid");
params.delete("w_rid");
assert.equal(params.get("buvid3"), "test-buvid");
assert.equal(params.get("id"), "123456");
const raw = "a".repeat(32) + "b".repeat(32);
const table = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,
    33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,
    26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
const key = table.map((index) => raw[index]).join("").slice(0, 32);
assert.equal(sentSign, ctx.MD5(params.toString() + key), "WBI signature covers the sent query");

vm.runInContext(fs.readFileSync(app + "vendor/pako_inflate.min.js", "utf8"), ctx);
assert.equal(typeof ctx.pako.inflate, "function");
const src = fs.readFileSync(app + "js/live-danmaku.js", "utf8");
assert.equal(src.split("return { connect: connect };").length, 2);
vm.runInContext(src.replace("return { connect: connect };",
    "return { connect: connect, decode: messages, packet: packet };"), ctx);

const auth = new DataView(ctx.LiveDanmaku.packet(7, '{"roomid":1}'));
assert.equal(auth.getUint32(0), 28);
assert.equal(auth.getUint16(4), 16);
assert.equal(auth.getUint32(8), 7);

function frame(op, version, body) {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const out = Buffer.alloc(16 + data.length);
    out.writeUInt32BE(out.length, 0);
    out.writeUInt16BE(16, 4);
    out.writeUInt16BE(version, 6);
    out.writeUInt32BE(op, 8);
    out.writeUInt32BE(1, 12);
    data.copy(out, 16);
    return out;
}
const inner = Buffer.concat([
    frame(5, 0, JSON.stringify({ cmd: "DANMU_MSG:4:0:2:2:2:0", info: [[], "你好，直播间"] })),
    frame(5, 0, JSON.stringify({ cmd: "SEND_GIFT", data: {} })),
]);
const outer = frame(5, 2, zlib.deflateSync(inner));
const found = [];
ctx.LiveDanmaku.decode(new Uint8Array(outer), (text) => found.push(text), 0);
assert.deepEqual(found, ["你好，直播间"], "inflate nested packets and ignore other events");
ctx.LiveDanmaku.decode(new Uint8Array([0, 1, 2]), () => { throw Error("malformed packet emitted text"); }, 0);
console.log("✓ per-video quality cap and compressed live comments");
