/* The two ways round bilibili's gates (2026-10-25), with no TV and no network:
 *
 *   - 排行 / 分区 answering -352: the app ranking first (asked twice when it
 *     comes back empty), then the web route once more with a buvid3, each step
 *     noted — and nothing of it when the web route answers or fails otherwise;
 *   - a write refused by the gateway for its Origin (HTTP 403, an HTML page):
 *     sent again from a frame on api.bilibili.com, and every write after it
 *     straight there; not for other hosts, not for a JSON 403, and a frame the
 *     engine will not let us script fails the write with the reason.
 *
 * And the aid → bvid mapping the app routes need, against pairs read from the
 * web ranking the same day. */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const src = fs.readFileSync(fileURLToPath(new URL("../app/js/api.js", import.meta.url)), "utf8");
const flush = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* One fresh api.js per scenario: the gate and the frame are per run. */
function load({ frame = "ok" } = {}) {
  const calls = [], replies = [], notes = [], frames = [], fetches = [], fetchReplies = [];
  class FakeXHR {
    constructor() { this.readyState = 0; this.headers = {}; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(k, v) { this.headers[k] = v; }
    send(body) {
      calls.push({ method: this.method, url: this.url, body });
      const r = replies.shift();
      assert.ok(r, `unexpected ${this.method} ${this.url}`);
      this.status = r.status ?? 200;
      this.responseText = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
      this.readyState = 4;
      this.onreadystatechange();
    }
  }
  const frameWin = {
    get location() {
      if (frame === "cross") { const e = new Error("Blocked"); e.name = "SecurityError"; throw e; }
      return { href: "https://api.bilibili.com/robots.txt" };
    },
    fetch(url, init) {
      fetches.push({ url, ...init });
      const r = fetchReplies.shift();
      assert.ok(r, `unexpected frame fetch ${url}`);
      const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
      return Promise.resolve({ status: r.status ?? 200, text: () => Promise.resolve(text) });
    },
  };
  const document = {
    createElement(tag) {
      assert.equal(tag, "iframe");
      const f = { style: {}, parentNode: null, contentWindow: frameWin };
      frames.push(f);
      return f;
    },
    body: {
      appendChild(f) {
        f.parentNode = this;
        if (frame !== "never") { setTimeout(() => f.onload(), 0); }
      },
      removeChild(f) { f.parentNode = null; },
    },
  };
  const session = { key: "tv-token", csrf: "", jar: false };
  const Auth = {
    isLoggedIn: () => !!session.key,
    accessKey: () => session.key,
    csrf: () => session.csrf,
    jarIsOurs: () => session.jar,
    cookieHeader: () => "",
    signTv: (fields) => new URLSearchParams({ ...fields, appkey: "test", sign: "test" }).toString(),
  };
  const sandbox = { Auth, XMLHttpRequest: FakeXHR, document, URL, String, Number, Array, Object,
    JSON, Math, Date, RegExp, Promise, Error, parseInt, parseFloat, isFinite,
    encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "api.js" });
  sandbox.API.onNote((kind, line) => notes.push(kind + ": " + line));
  return {
    API: sandbox.API, calls, notes, frames, fetches, session,
    respond: (body, status = 200) => replies.push({ body, status }),
    frameRespond: (body, status = 200) => fetchReplies.push({ body, status }),
    left: () => replies.length + fetchReplies.length,
  };
}

function settle(run) {
  const out = {};
  run((...a) => { out.ok = a; }, (why) => { out.fail = why; });
  return out;
}

const GATE_PAGE = '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">\n<html lang="zh-cn"><head>';

// ── aid → bvid ──
{
  const { API } = load();
  for (const [aid, bvid] of [[117488360692339, "BV1U3n46GEzY"], [117465862377753, "BV1xwnE6jEUZ"],
    [117494736158923, "BV1fjHP6eECY"], [117488545172306, "BV1nsn46YEYf"], [117483344238170, "BV1SAn168E4B"],
    [117483931441323, "BV16xnm6pE3d"], [170001, "BV17x411w7KC"]]) {
    assert.equal(API.bvidOf(aid), bvid, `av${aid}`);
    assert.equal(API.bvidOf(String(aid)), bvid, `"${aid}"`);
  }
  assert.equal(API.bvidOf(0), "");
  assert.equal(API.bvidOf("x"), "");
}

const appItem = (aid, extra = {}) => ({ title: "t" + aid, cover: "http://i0.hdslb.com/bfs/archive/a.jpg", param: String(aid),
  goto: "av", play: 1704021, mid: 8960728, name: "日食记", pub_date: 1792659600, duration: 990, cid: 42950856166, ...extra });

// ── 排行: web answers → nothing else is asked, nothing noted ──
{
  const t = load();
  t.respond({ code: 0, data: { list: [{ aid: 170001, bvid: "BV17x411w7KC", title: "a", pic: "x", duration: 60 }] } });
  const r = settle((ok, fail) => t.API.ranking(1004, ok, fail));
  assert.equal(r.ok[0].length, 1);
  assert.equal(t.calls.length, 1);
  assert.deepEqual(t.notes, []);
}

// ── another failure is not -352: straight to the caller ──
{
  const t = load();
  t.respond({ code: -404, message: "啥都木有" });
  const r = settle((ok, fail) => t.API.ranking(1004, ok, fail));
  assert.match(r.fail, /^code -404/);
  assert.equal(t.calls.length, 1);
}

// ── -352 on a zone → app rank/region, items in the card shape with a bvid ──
{
  const t = load();
  t.respond({ code: -352, message: "-352" });
  t.respond({ code: 0, data: [appItem(117483931441323), appItem(117488360692339, { goto: "live" }), { param: "" }] });
  const r = settle((ok, fail) => t.API.ranking(1004, ok, fail));
  assert.equal(r.fail, undefined);
  const items = r.ok[0];
  assert.equal(items.length, 1, "only goto=av with an aid");
  assert.equal(items[0].bvid, "BV16xnm6pE3d");
  assert.equal(items[0].aid, 117483931441323);
  assert.equal(items[0].cid, 42950856166);
  assert.equal(items[0].author, "日食记");
  assert.equal(items[0].mid, 8960728);
  assert.equal(items[0].duration, "16:30");
  assert.match(items[0].pic, /^https:\/\/i0\.hdslb\.com\//);
  const app = new URL(t.calls[1].url);
  assert.equal(app.origin + app.pathname, "https://app.bilibili.com/x/v2/rank/region");
  assert.equal(app.searchParams.get("rid"), "1004");
  assert.equal(app.searchParams.get("ps"), "100");
  assert.deepEqual(t.notes, ["feed: 分区 1004 的排行 code -352 -352，改走 app 端排行：1 条"]);
}

// ── -352 on 排行 itself → the app's whole-site ranking ──
{
  const t = load();
  t.respond({ code: -352, message: "-352" });
  t.respond({ code: 0, data: [appItem(170001)] });
  const r = settle((ok, fail) => t.API.ranking(0, ok, fail));
  assert.equal(r.ok[0][0].bvid, "BV17x411w7KC");
  const app = new URL(t.calls[1].url);
  assert.equal(app.pathname, "/x/v2/rank");
  assert.equal(app.searchParams.get("order"), "all");
  assert.equal(app.searchParams.get("rid"), null);
}

// ── the app route comes back empty (one time in four, any zone) → asked once more ──
{
  const t = load();
  t.respond({ code: -352, message: "-352" });
  t.respond({ code: 0, data: [] });
  t.respond({ code: 0, data: [appItem(170001)] });
  let r;
  t.API.ranking(1011, (items) => { r = { ok: items }; }, (why) => { r = { fail: why }; });
  assert.equal(r, undefined, "the second ask waits");
  await sleep(600);
  assert.equal(r.ok.length, 1);
  assert.equal(new URL(t.calls[2].url).searchParams.get("rid"), "1011");
  assert.deepEqual(t.notes, ["feed: 分区 1011 的排行 code -352 -352，改走 app 端排行（第 2 次）：1 条"]);
  assert.equal(t.left(), 0);
}

// ── empty twice → the web route again with a buvid3 ──
{
  const t = load();
  t.respond({ code: -352, message: "-352" });
  t.respond({ code: 0, data: [] });
  t.respond({ code: 0, data: [] });
  t.respond({ code: 0, data: { b_3: "D1F0C0DE-0000-0000-0000-000000000000infoc", b_4: "x" } });
  t.respond({ code: 0, data: { list: [{ aid: 170001, bvid: "BV17x411w7KC", title: "v" }] } });
  let r;
  t.API.ranking(1009, (items) => { r = { ok: items }; }, (why) => { r = { fail: why }; });
  await sleep(600);
  assert.equal(r.ok.length, 1);
  assert.match(t.calls[3].url, /\/x\/frontend\/finger\/spi$/, "spi is asked without the account");
  const again = new URL(t.calls[4].url);
  assert.equal(again.searchParams.get("rid"), "1009");
  assert.equal(again.searchParams.get("buvid3"), "D1F0C0DE-0000-0000-0000-000000000000infoc");
  assert.deepEqual(t.notes, ["feed: 分区 1009 的排行 code -352 -352，app 端排行两次都是空的，带 buvid3 重问：1 条"]);

  // The buvid3 is asked for once a run.
  t.respond({ code: -352, message: "-352" });
  t.respond({ code: 0, data: [] });
  t.respond({ code: 0, data: [] });
  t.respond({ code: -352, message: "-352" });
  let r2;
  t.API.ranking(1006, (items) => { r2 = { ok: items }; }, (why) => { r2 = { fail: why }; });
  await sleep(600);
  assert.match(r2.fail, /^code -352/, "the screen keeps the first answer");
  assert.equal(t.calls.filter((c) => /finger\/spi/.test(c.url)).length, 1);
  assert.match(t.notes[1], /^feed: 分区 1006 的排行 code -352 -352，app 端排行两次都是空的，带 buvid3 重问：code -352/);
  assert.equal(t.left(), 0);
}

// ── the app route fails too, and no buvid3 comes back → the original failure ──
{
  const t = load();
  t.respond({ code: -352, message: "-352" });
  t.respond({ code: -3, message: "API校验密匙错误" });
  t.respond({ code: -412, message: "请求被拦截" });
  const r = settle((ok, fail) => t.API.ranking(1020, ok, fail));
  assert.match(r.fail, /^code -352/);
  assert.deepEqual(t.notes, ["feed: 分区 1020 的排行 code -352 -352，app 端排行也不行：code -3 API校验密匙错误，也拿不到 buvid3"]);
  assert.equal(t.left(), 0);
}

// ── a write refused by the gateway → once more from the frame, and after that only there ──
{
  const t = load();
  t.respond(GATE_PAGE, 403);
  t.frameRespond({ code: 0, data: {} });
  const r = {};
  t.API.follow(2, true, (j) => { r.ok = j; }, (why) => { r.fail = why; });
  assert.equal(t.frames.length, 1, "a frame is opened");
  assert.equal(t.frames[0].src, "https://api.bilibili.com/robots.txt");
  await flush(); await flush(); await flush();
  assert.equal(r.fail, undefined);
  assert.ok(r.ok, "the write went through the frame");
  assert.equal(t.fetches.length, 1);
  const f = t.fetches[0];
  assert.equal(f.url, "https://api.bilibili.com/x/relation/modify");
  assert.equal(f.method, "POST");
  assert.equal(f.body, t.calls[0].body, "the same signed bytes");
  assert.equal(f.credentials, "omit", "access_key in the body: not the jar's cookies");
  assert.equal(f.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(t.notes[0], "api: 写操作被 B 站网关按来源拒了（/x/relation/modify HTTP 403 网页），这次运行的写操作改从 api.bilibili.com 的框里发");
  assert.match(t.notes[1], /^api: 从框里发过去了（\d+ms，code 0）$/);

  // The next write skips the refused route; the frame is reused. Codes keep
  // their shape, so 22014 (「已经关注了」) still counts as done.
  t.frameRespond({ code: 22014, message: "已经关注用户，无法重复关注" });
  const r2 = {};
  t.API.follow(2, true, (j) => { r2.ok = j; }, (why) => { r2.fail = why; });
  await flush(); await flush(); await flush();
  assert.ok(r2.ok, "22014 is the state asked for");
  assert.equal(t.calls.length, 1, "no second XHR");
  assert.equal(t.frames.length, 1, "one frame");
  assert.equal(t.notes.length, 2, "the frame's line is said once");

  // History through the same frame.
  t.frameRespond({ code: 0 });
  const r3 = {};
  t.API.report(2, 62131, 30, () => { r3.ok = true; }, (why) => { r3.fail = why; });
  await flush(); await flush(); await flush();
  assert.equal(r3.fail, undefined);
  assert.equal(t.fetches[2].url, "https://api.bilibili.com/x/v2/history/report");

  // A like goes to app.bilibili.com, which the gateway does not check: still a plain XHR.
  t.respond({ code: 0 });
  settle((ok, fail) => t.API.videoLike(2, false, ok, fail));
  assert.equal(new URL(t.calls[1].url).host, "app.bilibili.com");
  assert.equal(t.left(), 0);
}

// ── the csrf route through the frame sends the jar's cookies (it is the jar's session) ──
{
  const t = load();
  Object.assign(t.session, { key: "", csrf: "csrf-token", jar: true });
  t.respond(GATE_PAGE, 403);
  t.frameRespond({ code: 0 });
  t.API.follow(2, true, () => {}, (why) => assert.fail(why));
  await flush(); await flush(); await flush();
  assert.equal(t.fetches[0].credentials, "same-origin");
}

// ── a JSON 403, or a 403 page from another host, is not the gate ──
{
  const t = load();
  t.respond({ code: -403, message: "访问权限不足" }, 403);
  const r = settle((ok, fail) => t.API.follow(2, true, ok, fail));
  assert.equal(r.fail, "HTTP 403");
  assert.equal(t.frames.length, 0);

  t.respond(GATE_PAGE, 403);
  const r2 = settle((ok, fail) => t.API.videoLike(2, false, ok, fail));
  assert.equal(r2.fail, "HTTP 403");
  assert.equal(t.frames.length, 0);
  assert.deepEqual(t.notes, []);
}

// ── an engine that will not let the frame be scripted: the write fails, saying why ──
{
  const t = load({ frame: "cross" });
  t.respond(GATE_PAGE, 403);
  const r = {};
  t.API.follow(2, true, () => { r.ok = true; }, (why) => { r.fail = why; });
  await flush(); await flush();
  assert.equal(r.ok, undefined);
  assert.equal(r.fail, "HTTP 403；从框里发：这台电视不让脚本进跨域框（SecurityError）");
  assert.equal(t.notes[1], "api: 框用不了：这台电视不让脚本进跨域框（SecurityError），写操作只能失败");
  assert.equal(t.frames[0].parentNode, null, "the frame is taken down");

  // Known broken: the next write fails at once, without another frame.
  const r2 = {};
  t.API.report(2, 62131, 30, () => { r2.ok = true; }, (why) => { r2.fail = why; });
  await flush();
  assert.match(r2.fail, /这台电视不让脚本进跨域框/);
  assert.equal(t.frames.length, 1);
}

// ── the frame refused as well ──
{
  const t = load();
  t.respond(GATE_PAGE, 403);
  t.frameRespond(GATE_PAGE, 403);
  const r = {};
  t.API.follow(2, true, () => { r.ok = true; }, (why) => { r.fail = why; });
  await flush(); await flush(); await flush();
  assert.equal(r.fail, "HTTP 403；从框里发：HTTP 403");
  assert.equal(t.notes[1], "api: 从框里发也被拒：HTTP 403 网页");
}

console.log("✓ gates: ranking -352 falls back to the app route then buvid3, gateway-refused writes go through the frame, aid→bvid");
