/* The way round bilibili's gateway (2026-10-25), with no TV and no network:
 *
 *   - a write refused by the gateway for its Origin (HTTP 403, an HTML page):
 *     sent again from a frame on api.bilibili.com, and every write after it
 *     straight there; not for other hosts, not for a JSON 403, and a frame the
 *     engine will not let us script fails the write with the reason. */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const src = fs.readFileSync(fileURLToPath(new URL("../app/js/api.js", import.meta.url)), "utf8");
const flush = () => new Promise((r) => setTimeout(r, 0));

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

console.log("✓ gates: gateway-refused writes go through the frame");
