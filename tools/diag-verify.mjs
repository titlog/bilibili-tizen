/* Diagnostics upload (app/js/diag.js) and its receiving end (server/diag-worker.mjs).
 *
 * Gated in check.sh because both ways this can go wrong are silent: a name or a
 * title leaking into what leaves the television looks exactly like a working
 * upload, and an upload that never happens looks like a television with no
 * problems. So: what is scrubbed, when it is sent and when it is not, and that
 * the worker accepts what the app sends and refuses what it should — run under
 * node, the worker on node:sqlite standing in for D1. Plus a source check that
 * every title, name and author reaching report() in app.js is wrapped. */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { d1 } from "./d1-sqlite.mjs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const SRC = fs.readFileSync(here("../app/js/diag.js"), "utf8");
let failures = 0;
async function t(name, fn) {
  try { await fn(); console.log("✓ " + name); }
  catch (e) { failures++; console.log("✗ " + name + "\n    " + (e && e.message || e).split("\n").join("\n    ")); }
}

/* ---------------- a television for diag.js ---------------- */

function television({ ua = "Mozilla/5.0 (SMART-TV; LINUX; Tizen 3.0) AppleWebKit/538.1", storage = new Map(), settings = {}, reportTo = "", diagTo = "https://diag.test/v1/upload", selftest = false, start = Date.UTC(2026, 9, 21, 4) } = {}) {
  let clock = start;
  const timers = new Map(); let nextTimer = 1;
  const sent = [], reported = [];
  const responder = { fn: () => [200, JSON.stringify({ id: "abc23456" })] };
  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [clock])); }
    static now() { return clock; }
  }
  class XHR {
    constructor() { this.readyState = 0; this.status = 0; this.headers = {}; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(k, v) { this.headers[k] = v; }
    send(body) {
      this.body = body;
      sent.push(this);
      const [status, text] = responder.fn(this);
      this.status = status; this.responseText = text; this.readyState = 4;
      if (status === 0 && this.onerror) { this.onerror(); }
      if (this.onreadystatechange) { this.onreadystatechange(); }
    }
  }
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => { storage.set(k, String(v)); },
    removeItem: (k) => { storage.delete(k); },
  };
  const Settings = { get: (k, f) => (k in settings ? settings[k] : f), set: (k, v) => { settings[k] = v; } };
  const sandbox = {
    Date: FakeDate, Math, JSON, String, Number, Uint8Array, RegExp,
    localStorage, Settings, XMLHttpRequest: XHR,
    navigator: { userAgent: ua },
    window: { crypto: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 11) % 256; return a; } },
              addEventListener() {} },
    document: { hidden: false, addEventListener() {} },
    Boot: { info: () => ({ packaged: "1.2.5", running: "1.3.2", note: "" }) },
    REPORT_TO: reportTo, DIAG_TO: diagTo, SELFTEST: selftest,
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: clock + (ms || 0) }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
  };
  /* null: a config.js from before these existed. */
  if (diagTo === null) { delete sandbox.DIAG_TO; }
  if (selftest === null) { delete sandbox.SELFTEST; }
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "diag.js" });
  const Diag = sandbox.Diag;
  Diag.init({ report: (k, d) => { reported.push(k + ": " + d); Diag.record(k, d); } });
  function advance(ms) {
    const until = clock + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, v]) => v.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); clock = due[1].at; due[1].fn();
    }
    clock = until;
  }
  return { Diag, sent, reported, storage, settings, advance, responder, sandbox };
}

const lastBody = (tv) => JSON.parse(tv.sent[tv.sent.length - 1].body);

/* ---------------- what may leave ---------------- */

await t("包起来的标题、用户名换成 …，bvid 和 mid=0 留着", () => {
  const { Diag } = television();
  const line = "player: BV1xx4y1z7Ab " + Diag.priv("某个视频标题") + " cid=11112222333 — requesting qn=120";
  assert.equal(Diag.scrub(line), "player: BV1xx4y1z7Ab … cid=11112222333 — requesting qn=120");
  assert.equal(Diag.plain(line), "player: BV1xx4y1z7Ab 某个视频标题 cid=11112222333 — requesting qn=120");
  assert.match(Diag.scrub("whoami: 启动 裸请求 → isLogin=false mid=0 uname=-"), /mid=0 /);
});

await t("被截断、没收尾的包裹一直抹到行尾", () => {
  const { Diag } = television();
  const cut = ("meta: BV1xx " + Diag.priv("一个很长很长的标题")).slice(0, 16);
  assert.equal(Diag.scrub(cut + " 后面的字"), "meta: BV1xx …");
});

await t("whoami / account 行：mid、用户名、凭证指纹都不出门", () => {
  const { Diag } = television();
  const lines = [
    "whoami: 启动 活动=a1 access_key=有 header=有 5f3c9e1d jar主=无 withCred=否 | a1 mid=20481024 " + Diag.priv("某人") +
      " 凭证=7b2a6c40；a2 mid=12345678 " + Diag.priv("另一个人") + " 凭证=9d4e8f13",
    "whoami: 启动 常规 → isLogin=true mid=20481024 uname=" + Diag.priv("某人") + " 会员=无(status=0 type=0)",
    "whoami: 万一忘了包 → isLogin=true mid: 20481024 uname=没包的名字 会员=无",
    "account: 2 个账号，当前 route=access_key，服务器认得 " + Diag.priv("某人"),
  ];
  for (const l of lines) {
    const s = Diag.scrub(l);
    assert.doesNotMatch(s, /20481024|12345678|某人|另一个人|没包的名字|5f3c9e1d|7b2a6c40|9d4e8f13/, s);
  }
});

await t("地址里的签名和会话参数抹掉，主机和路径留着", () => {
  const { Diag } = television();
  const u = "player: 失败 https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/60/83/1-1-30080.m4s?e=ig8eux&uipk=5&deadline=1761000000" +
            "&mid=20481024&upsig=0123456789abcdef0123456789abcdef&uparams=e,deadline&access_key=fedcba9876543210fedcba9876543210&ts=1";
  const s = Diag.scrub(u);
  assert.match(s, /upos-sz-mirrorcos\.bilivideo\.com\/upgcxcode\/60\/83\/1-1-30080\.m4s\?e=ig8eux/);
  assert.doesNotMatch(s, /20481024|0123456789abcdef|fedcba9876543210/, s);
  assert.doesNotMatch(Diag.scrub("cookie SESSDATA=abc%2C123; bili_jct=zzz"), /abc%2C123|zzz/);
});

await t("观众的 IP 不出门：CDN 的 403 页、响应头、流地址里的 oi；CDN 节点的地址和版本号留着", () => {
  const { Diag } = television();
  /* Made-up addresses (documentation ranges), in the shapes 10-24's uploads carried. */
  const lines = [
    "live: 直播：shaka 可恢复的错误 code=1001 data[0]=https://d1--ov-gotcha208.bilivideo.com/live-bvc/1/live_1_bluray/index.m3u8" +
      "?expires=1792832256&len=0&oi=3405803777&pt=web&qn=10000 data[1]=403 data[2]=<html> <p>Client_ip: 203.0.113.7</p> " +
      "<p>Client_ip: 2001:db8::7</p> </html> data[3]={\"server\":\"nginx\",\"x-debug-rmt-addr\":\"198.51.100.23\",\"status\":\"403\"}",
    "player: 加载失败 upos-sz-mirrorcosov.bilivideo.com /upgcxcode/1.m4s os=cosovbv oi=3405803777 platform=pc",
    "probe: 你的地址 192.0.2.44 被拒",
  ];
  for (const l of lines) {
    const s = Diag.scrub(l);
    assert.doesNotMatch(s, /203\.0\.113\.7|2001:db8::7|198\.51\.100\.23|3405803777|192\.0\.2\.44/, s);
  }
  assert.match(Diag.scrub(lines[0]), /d1--ov-gotcha208\.bilivideo\.com\/live-bvc/);
  assert.match(Diag.scrub("player: https://192.0.2.80:4483/upgcxcode/1.m4s 403"), /https:\/\/192\.0\.2\.80:4483/);
  assert.match(Diag.scrub("engine: Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36"), /Chrome\/120\.0\.0\.0/);
});

await t("上传的整份内容里没有任何包起来的东西（原因也过一遍）", () => {
  const tv = television();
  tv.Diag.record("player", "BV1abc " + tv.Diag.priv("秘密标题") + " 播放错误");
  tv.Diag.incident("收藏没成功：" + tv.Diag.priv("我的收藏夹") + " mid=20481024");
  tv.advance(tv.Diag._test.SETTLE);
  assert.equal(tv.sent.length, 1);
  assert.doesNotMatch(tv.sent[0].body, /秘密标题|我的收藏夹|20481024||/);
  assert.match(tv.sent[0].body, /BV1abc/);
});

/* ---------------- the ring ---------------- */

await t("关着：不记、不传；关掉时清空本地的", () => {
  const tv = television();
  tv.Diag.record("player", "第一行");
  tv.advance(20000);
  assert.ok(tv.storage.get("bili.diag.ring").includes("第一行"));
  tv.Diag.setEnabled(false);
  assert.equal(tv.storage.has("bili.diag.ring"), false);
  tv.Diag.record("player", "关着时的一行");
  tv.Diag.incident("播放错误");
  tv.advance(60000);
  assert.equal(tv.sent.length, 0);
  assert.equal(tv.Diag._test.ring().length, 0);
  let r; tv.Diag.upload((x) => { r = x; });
  assert.equal(r.ok, false);
  assert.equal(tv.Diag.status().enabled, false);
});

await t("最多 600 行、16 万字，挤掉最老的", () => {
  const tv = television();
  for (let i = 0; i < 700; i++) tv.Diag.record("player", "行 " + i);
  const ring = tv.Diag._test.ring();
  assert.equal(ring.length, 600);
  assert.match(ring[ring.length - 1], /行 699$/);
  for (let i = 0; i < 100; i++) tv.Diag.record("player", "长".repeat(3000));
  const total = tv.Diag._test.ring().reduce((n, l) => n + l.length, 0);
  assert.ok(total <= 160000, "ring holds " + total + " chars");
  tv.Diag.record("player", "x".repeat(9000));
  assert.ok(tv.Diag._test.ring().pop().length < 4100);
});

await t("重开应用：上次的日志还在，中间有一行分界", () => {
  const storage = new Map();
  const a = television({ storage });
  a.Diag.record("player", "上一次的最后一行");
  a.advance(20000);
  const b = television({ storage });
  const ring = b.Diag._test.ring();
  assert.ok(ring.some((l) => l.includes("上一次的最后一行")));
  assert.match(ring[ring.length - 1], /新的一次启动/);
  assert.equal(b.Diag.status().device, a.Diag.status().device);
  assert.match(a.Diag.status().device, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
});

/* ---------------- when it is sent ---------------- */

await t("出事后等 8 秒再传，期间的几件事合成一份", () => {
  const tv = television();
  tv.Diag.incident("播放错误：A");
  tv.advance(3000);
  tv.Diag.record("probe", "后到的探测 xhr=403");
  tv.Diag.incident("所有路都试过");
  assert.equal(tv.sent.length, 0);
  tv.advance(tv.Diag._test.SETTLE);
  assert.equal(tv.sent.length, 1);
  const b = lastBody(tv);
  assert.equal(b.reason, "播放错误：A / 所有路都试过");
  assert.ok(b.lines.some((l) => l.includes("后到的探测")));
  assert.equal(b.app, "bilibili-tizen");
  assert.match(b.device, /^[A-Z2-9]{8}$/);
  assert.equal(b.version, "1.2.5");
  assert.equal(b.running, "1.3.2");
  assert.equal(b.manual, false);
  assert.match(b.ua, /Tizen 3\.0/);
  assert.equal(tv.sent[0].headers["Content-Type"], "text/plain;charset=UTF-8");
  assert.equal(tv.Diag.status().last.id, "abc23456");
  assert.ok(tv.reported.some((l) => /传了 \d+ 行，编号 abc23456，走 https/.test(l)));
});

await t("自动上传：三分钟一份、一天十二份；手动不受这个限制", () => {
  const tv = television();
  const { SETTLE, AUTO_GAP, AUTO_PER_DAY } = tv.Diag._test;
  tv.Diag.incident("一"); tv.advance(SETTLE);
  tv.Diag.incident("二"); tv.advance(SETTLE);
  assert.equal(tv.sent.length, 1, "second within three minutes is held back");
  assert.ok(tv.reported.some((l) => l.includes("没传（三分钟内")));
  let r; tv.Diag.upload((x) => { r = x; });
  assert.equal(r.ok, true, "manual is not held back by the automatic gap");
  assert.equal(lastBody(tv).manual, true);
  for (let i = 0; i < 20; i++) { tv.advance(AUTO_GAP); tv.Diag.incident("循环 " + i); tv.advance(SETTLE); }
  assert.equal(tv.sent.filter((x) => !JSON.parse(x.body).manual).length, AUTO_PER_DAY);
  assert.ok(tv.reported.some((l) => l.includes("今天已经自动传了")));
});

await t("手动连按：十秒内第二次被拒，状态里写着原因", () => {
  const tv = television();
  tv.Diag.upload(() => {});
  let r; tv.Diag.upload((x) => { r = x; });
  assert.equal(r.ok, false);
  assert.equal(tv.sent.length, 1);
  assert.match(tv.Diag.status().last.why, /刚传过/);
});

await t("https 连不上时用 http 再试一次，日志写明走的哪条", () => {
  const tv = television();
  tv.responder.fn = (x) => (x.url.startsWith("https:") ? [0, ""] : [200, JSON.stringify({ id: "viahttp2" })]);
  tv.Diag.upload(() => {});
  assert.deepEqual(tv.sent.map((x) => x.url), ["https://diag.test/v1/upload", "http://diag.test/v1/upload"]);
  assert.equal(tv.Diag.status().last.id, "viahttp2");
  assert.ok(tv.reported.some((l) => l.includes("走 http（https")));
});

await t("服务器拒绝：写进状态，不当成功", () => {
  const tv = television();
  tv.responder.fn = () => [429, JSON.stringify({ error: "too many from this device" })];
  let r; tv.Diag.upload((x) => { r = x; });
  assert.equal(r.ok, false);
  assert.match(tv.Diag.status().last.why, /HTTP 429 too many/);
});

/* 10-25: the endpoint answered 404 for eight hours and every upload in that
 * time was dropped. A missed one now goes again after the next start. */
const START = Date.UTC(2026, 9, 21, 4);
const RING_KEY = "bili.diag.ring";
function missedRing(line) {
  return new Map([[RING_KEY, JSON.stringify(["10-25 03:00:00 player: 出事前的一行", "10-25 03:00:09 diag: " + line])]]);
}

await t("没传上的，下次启动一分钟后补传一次；传上了就不再补", () => {
  const storage = new Map();
  const a = television({ storage });
  a.responder.fn = () => [404, JSON.stringify({ error: "not found" })];
  a.Diag.record("player", "出事前的一行");
  a.Diag.incident("播放错误：A");
  a.advance(a.Diag._test.SETTLE + 20000);
  assert.equal(a.sent.length, 1);
  assert.ok(a.reported.some((l) => l.includes("没传上：HTTP 404 not found")));
  assert.equal(a.Diag.status().pending, true);
  const b = television({ storage, start: START + 10 * 60000 });
  const { RETRY_AFTER } = b.Diag._test;
  b.advance(RETRY_AFTER - 1000);
  assert.equal(b.sent.length, 0, "not before a minute in");
  b.advance(2000);
  assert.equal(b.sent.length, 1);
  const body = lastBody(b);
  assert.equal(body.reason, "补传：播放错误：A");
  assert.equal(body.manual, false);
  assert.ok(body.lines.some((l) => l.includes("出事前的一行")), "the missed upload's lines go with it");
  assert.ok(b.reported.some((l) => l.includes("上次没传上（HTTP 404 not found），补传一次")));
  assert.equal(b.Diag.status().pending, false);
  b.Diag.incident("紧接着又出事");
  b.advance(b.Diag._test.SETTLE);
  assert.equal(b.sent.length, 2, "the retry does not hold back the next incident");
  assert.equal(lastBody(b).reason, "紧接着又出事");
  b.advance(20000);
  const c = television({ storage, start: START + 20 * 60000 });
  c.advance(5 * 60000);
  assert.equal(c.sent.length, 0, "sent once is enough");
});

await t("补传认得旧版本写的那一行：http 兜底、原因里带括号、已经是补传的", () => {
  const cases = [
    ["没传上：连不上，走 http（https 连不上）（这个直播间现在放不了：没在直播（live_status=0））",
     "补传：这个直播间现在放不了：没在直播（live_status=0）"],
    ["没传上：HTTP 404 not found，走 https（补传：所有路都试过）", "补传：所有路都试过"],
    ["没传上：HTTP 429 too many from this device，走 https（在设置里手动上传）", "补传：在设置里手动上传"],
  ];
  for (const [line, reason] of cases) {
    const tv = television({ storage: missedRing(line) });
    tv.advance(tv.Diag._test.RETRY_AFTER + 1000);
    assert.equal(tv.sent.length, 1, line);
    assert.equal(lastBody(tv).reason, reason);
  }
});

await t("不补传：接收端拒收的（400、413）、后来传上过的、关着的、自测构建", () => {
  for (const line of ["没传上：HTTP 413 too large，走 https（播放错误）", "没传上：HTTP 400 bad shape，走 https（播放错误）"]) {
    const tv = television({ storage: missedRing(line) });
    tv.advance(5 * 60000);
    assert.equal(tv.sent.length, 0, line);
    assert.equal(tv.Diag.status().pending, false);
  }
  const later = missedRing("没传上：HTTP 404 not found，走 https（播放错误）");
  const ring = JSON.parse(later.get(RING_KEY));
  ring.push("10-25 03:10:00 diag: 传了 3 行，编号 abc23456，走 https（在设置里手动上传）");
  later.set(RING_KEY, JSON.stringify(ring));
  const sentSince = television({ storage: later });
  sentSince.advance(5 * 60000);
  assert.equal(sentSince.sent.length, 0);
  const off = television({ storage: missedRing("没传上：连不上，走 http（https 连不上）（播放错误）"), settings: { diag: false } });
  off.advance(5 * 60000);
  assert.equal(off.sent.length, 0);
  const selftest = television({ storage: missedRing("没传上：连不上，走 http（https 连不上）（播放错误）"), diagTo: "", selftest: true });
  selftest.advance(5 * 60000);
  assert.equal(selftest.sent.length, 0);
});

await t("刚失败就重开：补传等到三分钟的间隔过了，不是被它拦下", () => {
  const storage = new Map();
  const a = television({ storage });
  a.responder.fn = () => [0, ""];
  a.Diag.incident("播放错误：B");
  a.advance(a.Diag._test.SETTLE + 20000);
  const b = television({ storage, start: START + 60000 });
  const { AUTO_GAP, SETTLE, RETRY_AFTER } = b.Diag._test;
  b.advance(RETRY_AFTER + 1000);
  assert.equal(b.sent.length, 0, "still inside the gap");
  b.advance(AUTO_GAP);
  assert.equal(b.sent.length, 1);
  assert.equal(lastBody(b).reason, "补传：播放错误：B");
  assert.ok(!b.reported.some((l) => l.includes("没传（三分钟内")), "not held back: it waited");
  assert.ok(SETTLE < AUTO_GAP);
});

await t("从源码装的和发布包一样传；DIAG_TO=off、自测构建不传；DIAG_TO 给了地址就传那里", () => {
  const ENDPOINT = /var ENDPOINT = "([^"]*)";/.exec(SRC)[1];
  const lan = "http://10.0.0.2:8099/report";
  const release = television({ reportTo: "", diagTo: "" });
  assert.equal(release.Diag._test.endpoint(), ENDPOINT);
  const source = television({ reportTo: lan, diagTo: "" });
  assert.equal(source.Diag._test.endpoint(), ENDPOINT);
  assert.equal(source.Diag.status().configured, true);
  /* A package from before DIAG_TO and SELFTEST existed, updated to this diag.js. */
  const old = television({ reportTo: lan, diagTo: null, selftest: null });
  assert.equal(old.Diag._test.endpoint(), ENDPOINT);
  for (const quiet of [television({ reportTo: lan, diagTo: "off" }),
                       television({ reportTo: lan, diagTo: "", selftest: true }),
                       television({ reportTo: lan, diagTo: "", selftest: "tokenswap" })]) {
    quiet.Diag.incident("播放错误"); quiet.advance(60000);
    assert.equal(quiet.sent.length, 0);
    assert.equal(quiet.Diag.status().configured, false);
  }
  const pointed = television({ reportTo: lan, diagTo: "http://10.0.0.2:8097/v1/upload", selftest: "diag" });
  assert.equal(pointed.Diag._test.endpoint(), "http://10.0.0.2:8097/v1/upload");
});

/* ---------------- app.js: nothing unwrapped reaches report() ---------------- */


await t("desktop browsers send nothing (no Tizen in the UA), not even a release build or one given an address", () => {
  const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  for (const desk of [television({ ua: MAC, reportTo: "", diagTo: "" }),
                      television({ ua: MAC, reportTo: "http://10.0.0.2:8099/report", diagTo: "http://10.0.0.2:8097/v1/upload" })]) {
    desk.Diag.incident("播放错误"); desk.advance(60000);
    assert.equal(desk.sent.length, 0);
    assert.equal(desk.Diag.status().configured, false);
  }
});
await t("app.js：进 report() 的标题、用户名、作者都包在 Diag.priv 里", () => {
  const app = fs.readFileSync(here("../app/js/app.js"), "utf8");
  const bad = [];
  const re = /(?<![\w.])report\(/g;
  let m;
  while ((m = re.exec(app))) {
    let i = m.index + m[0].length, depth = 1, q = null;
    while (i < app.length && depth) {
      const c = app[i];
      if (q) { if (c === "\\") i++; else if (c === q) q = null; }
      else if (c === '"' || c === "'") q = c;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
      i++;
    }
    const call = app.slice(m.index, i);
    /* Strip what is wrapped, then look for what should have been. */
    let rest = call, prev;
    do { prev = rest; rest = rest.replace(/Diag\.priv\((?:[^()]|\([^()]*(?:\([^()]*\)[^()]*)*\))*\)/g, "PRIV"); } while (rest !== prev);
    if (/\.(title|uname|author)\b|\bkeyword\b|state\.query/.test(rest)) {
      bad.push(app.slice(0, m.index).split("\n").length + ": " + call.replace(/\s+/g, " ").slice(0, 140));
    }
  }
  const tag = /function videoTag\(d\) \{([\s\S]*?)\}/.exec(app);
  assert.ok(tag && /Diag\.priv\(/.test(tag[1]), "videoTag must wrap the title");
  assert.deepEqual(bad, [], "unwrapped:\n" + bad.join("\n"));
});

/* ---------------- the worker ---------------- */

const worker = (await import(here("../server/diag-worker.mjs"))).default;
const workerTest = (await import(here("../server/diag-worker.mjs")))._test;

async function call(env, method, path, { body, token, scheme = "https" } = {}) {
  const req = new Request(scheme + "://diag.test" + path, {
    method, body, headers: token ? { Authorization: "Bearer " + token } : {},
  });
  const res = await worker.fetch(req, env);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
const envelope = (o = {}) => JSON.stringify({ v: 1, app: "bilibili-tizen", device: "K7QM3XTA", version: "1.2.5",
  running: "1.3.2", reason: "所有路都试过", manual: false, tvAt: 1, tz: -480, ua: "Tizen 3.0", lines: ["a", "b"], ...o });

await t("worker：收下 diag.js 发的那份，凭令牌能列、能取", async () => {
  const env = { DB: d1(), READ_TOKEN: "s3cret" };
  const up = await call(env, "POST", "/v1/upload", { body: envelope() });
  assert.equal(up.status, 200);
  assert.match(up.body.id, /^[a-z2-9]{8}$/);
  assert.equal(up.headers.get("access-control-allow-origin"), "*");
  const listed = await call(env, "GET", "/v1/list?device=K7QM-3XTA", { token: "s3cret" });
  assert.equal(listed.body.results.length, 1);
  assert.equal(listed.body.results[0].via, "https");
  assert.equal(listed.body.results[0].body, undefined, "list carries no bodies");
  const one = await call(env, "GET", "/v1/get?id=" + up.body.id, { token: "s3cret" });
  assert.equal(one.body.body, "a\nb");
  assert.equal(one.body.reason, "所有路都试过");
  const viaHttp = await call(env, "POST", "/v1/upload", { body: envelope(), scheme: "http" });
  assert.equal((await call(env, "GET", "/v1/get?id=" + viaHttp.body.id, { token: "s3cret" })).body.via, "http");
});

await t("worker：旧版本没去掉的 IP，这一头也不存（CDN 节点的地址留着）", async () => {
  const env = { DB: d1(), READ_TOKEN: "s3cret" };
  const lines = ["live: data[0]=https://d1--ov-gotcha208.bilivideo.com/x/index.m3u8?oi=3405803777&pt=web data[2]=<p>Client_ip: 203.0.113.7</p>",
                 "player: data[3]={\"x-debug-rmt-addr\":\"198.51.100.23\"} https://192.0.2.80:4483/upgcxcode/1.m4s",
                 "probe: 你的地址 192.0.2.44，Client_ip: 2001:db8::7"];
  const up = await call(env, "POST", "/v1/upload", { body: envelope({ lines, reason: "被拒 Client_ip: 203.0.113.7" }) });
  const one = (await call(env, "GET", "/v1/get?id=" + up.body.id, { token: "s3cret" })).body;
  assert.doesNotMatch(one.body + one.reason, /203\.0\.113\.7|198\.51\.100\.23|3405803777|192\.0\.2\.44|2001:db8::7/, one.body);
  assert.match(one.body, /https:\/\/d1--ov-gotcha208\.bilivideo\.com\/x\/index\.m3u8/);
  assert.match(one.body, /https:\/\/192\.0\.2\.80:4483/);
  assert.equal(workerTest.noIp("engine: Chrome/120.0.0.0"), "engine: Chrome/120.0.0.0");
});

await t("worker：没令牌或令牌不对读不到；没设令牌谁都读不到", async () => {
  const env = { DB: d1(), READ_TOKEN: "s3cret" };
  assert.equal((await call(env, "GET", "/v1/list")).status, 401);
  assert.equal((await call(env, "GET", "/v1/list", { token: "s3creT" })).status, 401);
  assert.equal((await call({ DB: d1() }, "GET", "/v1/list", { token: "" })).status, 401);
});

await t("worker：形状不对、太大、不认识的应用都拒", async () => {
  const env = { DB: d1(), READ_TOKEN: "x" };
  assert.equal((await call(env, "POST", "/v1/upload", { body: "not json" })).status, 400);
  assert.equal((await call(env, "POST", "/v1/upload", { body: envelope({ app: "other" }) })).status, 400);
  assert.equal((await call(env, "POST", "/v1/upload", { body: envelope({ device: "k7qm3xta" }) })).status, 400);
  assert.equal((await call(env, "POST", "/v1/upload", { body: envelope({ lines: [1, 2] }) })).status, 400);
  assert.equal((await call(env, "POST", "/v1/upload", { body: envelope({ lines: ["长".repeat(4000)].concat(Array(60).fill("长".repeat(4000))) }) })).status, 413);
  assert.equal((await call(env, "GET", "/v1/upload")).status, 404);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM uploads").get().n, 0);
});

await t("worker：同一台电视一小时最多 20 份", async () => {
  const env = { DB: d1(), READ_TOKEN: "x" };
  for (let i = 0; i < workerTest.PER_DEVICE_HOUR; i++) {
    assert.equal((await call(env, "POST", "/v1/upload", { body: envelope() })).status, 200);
  }
  assert.equal((await call(env, "POST", "/v1/upload", { body: envelope() })).status, 429);
  assert.equal((await call(env, "POST", "/v1/upload", { body: envelope({ device: "ABCD2345" }) })).status, 200);
});

await t("worker：每天的总量封顶", async () => {
  const env = { DB: d1(), READ_TOKEN: "x" };
  env.DB.raw.prepare("INSERT INTO daily (day, n) VALUES (?, ?)").run(new Date().toISOString().slice(0, 10), workerTest.PER_DAY);
  assert.equal((await call(env, "POST", "/v1/upload", { body: envelope() })).status, 429);
});

await t("worker：30 天前的删掉，之内的留着", async () => {
  const env = { DB: d1(), READ_TOKEN: "x" };
  await call(env, "POST", "/v1/upload", { body: envelope() });
  await workerTest.prune(env, Date.now() + workerTest.KEEP_MS - 60000);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM uploads").get().n, 1);
  await workerTest.prune(env, Date.now() + workerTest.KEEP_MS + 60000);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM uploads").get().n, 0);
});

await t("diag.js 发出的那份，worker 收得下", async () => {
  const tv = television();
  for (let i = 0; i < 600; i++) tv.Diag.record("player", "传输 播放中 upos-hz-mirrorakam.akamaized.net=?×38 " + "汉字".repeat(120));
  tv.Diag.upload(() => {});
  const env = { DB: d1(), READ_TOKEN: "x" };
  const up = await call(env, "POST", "/v1/upload", { body: tv.sent[0].body });
  assert.equal(up.status, 200, JSON.stringify(up.body));
});

await t("worker：自更新的中转——清单取 master、包取 tag，别的一概不转", async () => {
  const realFetch = globalThis.fetch, asked = [];
  globalThis.fetch = async (u, init) => {
    asked.push({ u: String(u), ttl: init && init.cf && init.cf.cacheTtl });
    if (/bundle-9\.9\.9/.test(u)) return new Response("nope", { status: 404 });
    if (/bundle-8\.8\.8/.test(u)) throw new TypeError("network");
    return new Response(JSON.stringify({ from: String(u) }), { status: 200 });
  };
  try {
    const env = { DB: d1(), READ_TOKEN: "x" };
    const man = await call(env, "GET", "/v1/update/douyin-tizen/manifest.json");
    assert.equal(man.status, 200);
    assert.equal(man.body.from, "https://raw.githubusercontent.com/titlog/douyin-tizen/master/update/manifest.json");
    assert.equal(man.headers.get("access-control-allow-origin"), "*");
    assert.equal(asked[0].ttl, workerTest.MANIFEST_TTL);
    const b = await call(env, "GET", "/v1/update/bilibili-tizen/bundle-1.3.5.json");
    assert.equal(b.body.from, "https://raw.githubusercontent.com/titlog/bilibili-tizen/v1.3.5/update/bundle-1.3.5.json");
    assert.equal(asked[1].ttl, workerTest.BUNDLE_TTL);
    assert.equal((await call(env, "GET", "/v1/update/bilibili-tizen/bundle-9.9.9.json")).status, 404);
    assert.equal((await call(env, "GET", "/v1/update/bilibili-tizen/bundle-8.8.8.json")).status, 502);
    const before = asked.length;
    for (const p of ["/v1/update/other-app/manifest.json", "/v1/update/bilibili-tizen/README.md",
                     "/v1/update/bilibili-tizen/../../x/manifest.json", "/v1/update/bilibili-tizen/bundle-1.3.json",
                     "/v1/update/bilibili-tizen/manifest.json?x=1/../app"]) {
      const r = await call(env, "GET", p);
      if (p.endsWith("?x=1/../app")) { assert.equal(r.status, 200, p); continue; }   /* the query is not part of the path */
      assert.equal(r.status, 404, p);
    }
    assert.equal(asked.length, before + 1, "only the well-formed one went upstream");
    assert.equal((await call(env, "POST", "/v1/update/bilibili-tizen/manifest.json", { body: "x" })).status, 404);
  } finally { globalThis.fetch = realFetch; }
});

if (failures) { console.log(failures + " 项失败"); process.exit(1); }
console.log("诊断日志：全部通过");
