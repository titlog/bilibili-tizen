/* app/js/inflate.js and app/js/livedm.js, off the television.
 *
 *   node tools/livedm-verify.mjs          # decoder, packets, comment filter, connection life-cycle (tools/check.sh runs this)
 *   node tools/livedm-verify.mjs --live   # also: one real room, anonymous, ten seconds — needs the network, reads
 *                                         # comment counts only (nothing of what people wrote is printed)
 *
 * The decoder is checked against node's own zlib; the connection against a fake
 * WebSocket and fake timers, so every retry and give-up path runs in
 * milliseconds. Packets are built here the way the server builds them (a
 * version-2 packet whose body is zlib holding more packets), with invented
 * comments — the shape is bilibili's, the words are not anyone's. */
import fs from "fs";
import path from "path";
import vm from "vm";
import zlib from "zlib";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, "app/js", f), "utf8");
let failed = 0;
function check(ok, what) { console.log((ok ? "  ✓ " : "  ✗ ") + what); if (!ok) { failed++; } }

/* ---- a fake clock and a fake socket ---- */
let now = 0, timers = [], nextId = 1;
const clock = {
  setTimeout: (fn, ms) => { const t = { id: nextId++, at: now + ms, fn, every: 0 }; timers.push(t); return t.id; },
  setInterval: (fn, ms) => { const t = { id: nextId++, at: now + ms, fn, every: ms }; timers.push(t); return t.id; },
  clearTimeout: (id) => { timers = timers.filter((t) => t.id !== id); },
  clearInterval: (id) => { timers = timers.filter((t) => t.id !== id); },
  advance(ms) {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) { break; }
      now = due.at;
      if (due.every) { due.at += due.every; } else { timers = timers.filter((t) => t !== due); }
      due.fn();
    }
    now = end;
  },
};
const sockets = [];
class FakeWS {
  constructor(url) { this.url = url; this.sent = []; this.closed = false; sockets.push(this); }
  send(b) { this.sent.push(b); }
  close() { this.closed = true; }
  open() { this.onopen && this.onopen(); }
  recv(buf) { this.onmessage && this.onmessage({ data: buf }); }
  drop(code = 1006) { this.onclose && this.onclose({ code }); }
}
let confAnswers = [], confAsked = [];
class FakeXHR {
  open(m, url) { this.url = url; }
  send() {
    confAsked.push(this.url);
    const a = confAnswers.length ? confAnswers.shift() : { status: 200, body: { code: 0, data: CONF } };
    this.status = a.status; this.responseText = JSON.stringify(a.body); this.readyState = 4;
    queueMicrotask(() => this.onreadystatechange && this.onreadystatechange());
  }
}
const CONF = {
  token: "TOKEN-123",
  host_server_list: [
    { host: "a.chat.example", port: 2243, wss_port: 443, ws_port: 2244 },
    { host: "b.chat.example", port: 2243, wss_port: 4443, ws_port: 2244 },
  ],
};

const ctx = { ...clock, WebSocket: FakeWS, XMLHttpRequest: FakeXHR, TextDecoder, TextEncoder, JSON, Math, Date,
              Uint8Array, DataView, ArrayBuffer, Error, Number, String, escape, unescape, decodeURIComponent,
              encodeURIComponent, parseInt, queueMicrotask };
vm.createContext(ctx);
vm.runInContext(src("inflate.js") + "\nthis.Inflate = Inflate;", ctx);
vm.runInContext(src("livedm.js") + "\nthis.LiveDanmaku = LiveDanmaku;", ctx);
const { Inflate, LiveDanmaku } = ctx;
const T = LiveDanmaku.test;
const tick = () => new Promise((r) => setImmediate(r));

/* ---------------- the decoder ---------------- */
console.log("inflate 对着 node 的 zlib");
function same(a, b) { return a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0; }
const rnd = (n, seed = 1) => { const b = Buffer.alloc(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = x >> 16; } return b; };
const text = Buffer.from(JSON.stringify({ cmd: "DANMU_MSG", info: [[0, 1, 25, 16777215], "你好 hello 弹幕 ".repeat(40)] }).repeat(30));
const cases = {
  "空": Buffer.alloc(0),
  "一个字节": Buffer.from("a"),
  "重复文本（固定码）": Buffer.from("abcabcabcabcabcabcabc"),
  "JSON 文本（动态码）": text,
  "随机 5 KB（几乎压不动）": rnd(5000),
  "随机 70 KB": rnd(70000, 7),
  "全零 1 MB（长距离重复）": Buffer.alloc(1 << 20),
};
for (const [name, buf] of Object.entries(cases)) {
  for (const level of [0, 1, 6, 9]) {
    const z = zlib.deflateSync(buf, { level });
    let out = null, err = "";
    try { out = Inflate.zlib(new Uint8Array(z)); } catch (e) { err = e.message; }
    check(out && same(out, buf), `${name} · level ${level}（${z.length} 字节）${err}`);
  }
}
check(same(Inflate.raw(new Uint8Array(zlib.deflateRawSync(text))), text), "裸 deflate（没有 zlib 头）");
for (const [name, bad] of [
  ["不是 zlib", new Uint8Array([1, 2, 3, 4])],
  ["截断", new Uint8Array(zlib.deflateSync(text)).subarray(0, 30)],
  ["带预设字典的头", new Uint8Array([0x78, 0xbb, 0, 0, 0, 0, 0, 0])],
  ["全是 1（块类型 3）", new Uint8Array([0x78, 0x01, 0xff, 0xff, 0xff])],
]) {
  let threw = false;
  try { Inflate.zlib(bad); } catch (e) { threw = true; }
  check(threw, `坏数据抛错而不是返回垃圾：${name}`);
}

/* ---------------- packets ---------------- */
console.log("封包");
const cmd = (o) => Buffer.from(JSON.stringify(o));
const msg = (text, mode = 1, color = 16777215, extra = {}) => ({
  cmd: "DANMU_MSG",
  info: [[0, mode, 25, color, 1700000000000, 1, 0, "hash", 0, 0, 0, "", extra.emote ? 1 : 0, {}], text, [1, "u", 0], []],
});
function packet(op, body, ver = 1) {
  const h = Buffer.alloc(16);
  h.writeUInt32BE(16 + body.length, 0); h.writeUInt16BE(16, 4); h.writeUInt16BE(ver, 6); h.writeUInt32BE(op, 8); h.writeUInt32BE(0, 12);
  return Buffer.concat([h, body]);
}
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
const inner = Buffer.concat([
  packet(5, cmd(msg("第一条"))),
  packet(5, cmd({ cmd: "SEND_GIFT", data: { giftName: "x" } })),
  packet(5, cmd(msg("[dog]", 1, 16777215, { emote: true }))),
  packet(5, cmd(msg("顶部", 5, 255))),
]);
const bundle = packet(5, zlib.deflateSync(inner), 2);
const un = T.unpack(ab(bundle));
check(un.skipped === 0 && un.packets.length === 4 && un.packets.every((p) => p.op === 5), "version 2 的包拆成里面的四个包");
const items = un.packets.map((p) => T.toItem(JSON.parse(T.utf8(p.body)))).filter(Boolean);
check(items.length === 2 && items[0].text === "第一条" && items[0].mode === 1 && items[0].color === "#ffffff",
  "只留下文字弹幕：礼物和表情（info[0][12]=1）不画");
check(items[1].mode === 5 && items[1].color === "#0000ff", "顶部弹幕 mode 5、颜色按 24 位补零");
const mixed = Buffer.concat([packet(3, Buffer.from([0, 0, 0, 9])), packet(5, cmd(msg("明文 version 1")))]);
const un2 = T.unpack(ab(mixed));
check(un2.packets.length === 2 && un2.packets[0].op === 3 && un2.skipped === 0, "version 1 的明文包照收（人气包、命令包）");
const brotli = Buffer.concat([packet(5, Buffer.from([1, 2, 3]), 3), packet(5, cmd(msg("后面的")))]);
const un3 = T.unpack(ab(brotli));
check(un3.skipped === 1 && un3.packets.length === 1, "version 3（brotli）读不了就记一笔、不吞掉后面的包");
const trunc = T.unpack(ab(bundle.subarray(0, bundle.length - 5)));
check(trunc.skipped >= 1 && trunc.packets.length === 0, "截断的包记为读不了，不抛异常");
const badZ = T.unpack(ab(packet(5, Buffer.from("not zlib at all"), 2)));
check(badZ.skipped === 1 && badZ.packets.length === 0, "version 2 里不是 zlib：记一笔");
const nested = T.unpack(ab(packet(5, zlib.deflateSync(bundle), 2)));
check(nested.skipped === 1, "zlib 里面再套 zlib 不展开（防炸弹）");
check(new Uint8Array(T.pack(2, "")).length === 16 && new DataView(T.pack(7, "{}")).getUint32(0) === 18 &&
      new DataView(T.pack(7, "{}")).getUint32(8) === 7 && new DataView(T.pack(2, "")).getUint16(4) === 16,
  "发出去的包：头 16 字节、长度含头、操作码在 8 字节处");
check(T.toItem(msg("x".repeat(81))) === null && T.toItem(msg("x".repeat(80))) !== null, "超过 80 字的当粘贴，不画");
check(T.toItem(msg("  \n ")) === null && T.toItem({ cmd: "DANMU_MSG", info: [] }) === null &&
      T.toItem({ cmd: "DANMU_MSG:4:0:2:2:2:0", info: msg("带后缀").info }).text === "带后缀", "空白、残缺的丢弃；带后缀的 cmd 认");
check(T.endpoints(CONF).join() === "wss://a.chat.example/sub,wss://b.chat.example:4443/sub,wss://broadcastlv.chat.bilibili.com/sub" &&
      T.endpoints({}).join() === "wss://broadcastlv.chat.bilibili.com/sub",
  "地址：房间给的优先，443 不写端口，最后是通用的那台");

/* ---------------- the connection ---------------- */
console.log("连接");
async function start(room = 777, h = {}) {
  const got = [], states = [];
  const c = LiveDanmaku.connect(room, { onItem: (i) => got.push(i), onState: (s) => states.push(s), ...h });
  await tick();
  return { c, got, states };
}
const authBody = (ws) => JSON.parse(Buffer.from(ws.sent[0]).subarray(16).toString());
const reply = (code = 0) => ab(packet(8, Buffer.from(JSON.stringify({ code }))));

let r = await start();
let ws = sockets[sockets.length - 1];
check(confAsked[0].endsWith("room_id=777") && !/access_key|sign/.test(confAsked[0]), "先要房间的令牌，不带账号");
check(ws.url === "wss://a.chat.example/sub", "连的是房间给的第一台");
ws.open();
const a = authBody(ws);
check(a.uid === 0 && a.roomid === 777 && a.key === "TOKEN-123" && a.protover === 2 && new DataView(ws.sent[0]).getUint32(8) === 7,
  "认证包：uid 0、房间号是数字、带令牌、protover 2");
ws.recv(reply(0));
check(ws.sent.length === 2 && new DataView(ws.sent[1]).getUint32(8) === 2 && r.states.some((s) => /连上了/.test(s)), "认证通过：立刻心跳一次，记一行连上了");
clock.advance(30000);
check(ws.sent.length === 3, "之后每 30 秒一次心跳");
ws.recv(ab(bundle));
check(r.got.length === 2 && r.c.stats().comments === 2 && r.c.stats().connected, "收到的弹幕交给 onItem，只算文字的");
ws.drop();
check(r.states[r.states.length - 1].includes("1.5 秒后重连") || /重连/.test(r.states[r.states.length - 1]), "通了之后断开：1.5 秒就重连");
clock.advance(1500); await tick();
const ws2 = sockets[sockets.length - 1];
check(ws2 !== ws && ws2.url === "wss://b.chat.example:4443/sub", "重连换下一台地址");
r.c.close();
check(ws2.closed && timers.length === 0, "close() 之后没有遗留的定时器，socket 关了");
ws2.drop(); clock.advance(60000); await tick();
check(sockets[sockets.length - 1] === ws2, "close() 之后断开不再重连");

/* auth refused → retries with backoff, gives up after six */
sockets.length = 0; confAsked.length = 0;
r = await start();
let attempts = 0;
for (let i = 0; i < 10; i++) {
  ws = sockets[sockets.length - 1];
  if (!ws || ws.opened) { break; }
  ws.opened = true; ws.open(); ws.recv(reply(-101)); attempts++;
  clock.advance(40000); await tick();
}
check(attempts === 6 && r.states.some((s) => /不再试了/.test(s)) && timers.length === 0, "认证一直被拒：试六次就停，状态里说明，不留定时器");

/* auth never answered → timeout → retry */
sockets.length = 0;
r = await start();
ws = sockets[sockets.length - 1]; ws.open();
clock.advance(7999);
check(!ws.closed, "认证 8 秒内不算超时");
clock.advance(2); await tick();
check(ws.closed && r.states.some((s) => /认证 8 秒没回/.test(s)), "认证 8 秒没回：放弃这台");
r.c.close();

/* getConf fails → retry, then works */
sockets.length = 0; confAsked.length = 0;
confAnswers = [{ status: 200, body: { code: -352, message: "-352" } }];
r = await start();
check(r.states.some((s) => /getConf code -352/.test(s)) && sockets.length === 0, "getConf 被拒：记原因，不乱连");
clock.advance(2000); await tick();
check(sockets.length === 1 && confAsked.length === 2, "两秒后重要一次令牌，然后连上");
r.c.close();

/* a late event from a socket that was replaced does nothing */
sockets.length = 0;
r = await start();
ws = sockets[sockets.length - 1]; ws.open(); ws.recv(reply(0));
const stale = ws.onmessage;
r.c.close();
r.got.length = 0;
stale && stale({ data: ab(bundle) });
check(r.got.length === 0, "关掉之后迟到的消息不再交出去");

/* ---------------- a real room ---------------- */
if (process.argv.includes("--live")) {
  console.log("真实直播间（匿名，十秒，只数条数）");
  const get = async (u) => (await fetch(u, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36" } })).json();
  const l = await get("https://api.live.bilibili.com/room/v1/Area/getListByAreaID?areaId=0&sort=online&pageSize=30&page=1");
  const room = (l.data || [])[0] && l.data[0].roomid;
  if (!room) { check(false, "取不到一个正在直播的房间"); }
  else {
    const real = { WebSocket, TextDecoder, TextEncoder, JSON, Math, Date, Uint8Array, DataView, ArrayBuffer, Error, Number, String,
                   escape, unescape, decodeURIComponent, encodeURIComponent, parseInt, setTimeout, clearTimeout, setInterval, clearInterval,
                   XMLHttpRequest: class {
                     open(m, u) { this.u = u; }
                     send() { fetch(this.u).then(async (res) => { this.status = res.status; this.responseText = await res.text(); this.readyState = 4; this.onreadystatechange(); },
                                                 () => this.onerror()); }
                   } };
    vm.createContext(real);
    vm.runInContext(src("inflate.js") + "\n" + src("livedm.js") + "\nthis.L = LiveDanmaku;", real);
    const states = []; let n = 0, shape = "";
    const c = real.L.connect(room, { onItem: (i) => { n++; if (!shape) { shape = Object.keys(i).join(",") + " mode=" + i.mode + " size=" + i.size + " color=" + i.color; } }, onState: (s) => states.push(s) });
    await new Promise((res) => setTimeout(res, 10000));
    const s = c.stats(); c.close();
    console.log("    状态：" + states.join(" | "));
    console.log("    收到 " + n + " 条，读不了 " + s.skipped + " 包；一条的形状：" + shape);
    check(states.some((x) => /连上了/.test(x)), "匿名连上了真实的直播间");
    check(n > 0 && s.skipped === 0, "解出了弹幕（zlib 真的是这么发的），没有读不了的包");
  }
}

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
