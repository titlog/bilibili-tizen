/* Exercise the multi-account layer without a television.
 *
 * Everything that can go wrong here is silent on the device: history filed
 * under the wrong person, a cookie from the previous account riding along on
 * the next one's requests, an account whose credentials were never really
 * stored still reporting itself signed in. None of that throws, none of it
 * reaches the collector, and all of it looks like "bilibili is being weird".
 *
 * So the account store, the storage namespaces and the cookie routing are
 * driven here against a fake localStorage and a fake XHR, where a wrong answer
 * is an assertion rather than a puzzle on the sofa three days later.
 *
 *   node tools/accounts-verify.mjs
 */
import fs from "fs";
import vm from "vm";

const APP = new URL("../app/js/", import.meta.url).pathname;

let failed = 0;
let checks = 0;
function ok(label, cond, detail) {
  checks++;
  if (!cond) { failed++; console.log(`✗ ${label}${detail ? " — " + detail : ""}`); }
}
function eq(label, got, want) {
  ok(label, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

/* ---------------- the fake device ---------------- */

function makeStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    keys: () => [...m.keys()],
    raw: m,
  };
}

/* Responses are delivered inside send(), so a test reads the outcome on the
 * next line instead of waiting on timers it would then have to flush. */
function makeXHR(state) {
  return class FakeXHR {
    constructor() { this.readyState = 0; this.status = 200; this.responseText = ""; this.headers = {}; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(k, v) { this.headers[k] = v; }
    send(body) {
      const call = { method: this.method, url: this.url, body, headers: this.headers };
      state.calls.push(call);
      const route = state.routes.find((r) => this.url.indexOf(r.match) >= 0);
      if (!route) { throw new Error("no fake route for " + this.url); }
      const res = typeof route.reply === "function" ? route.reply(call) : route.reply;
      this.status = res.status === undefined ? 200 : res.status;
      this.responseText = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
      this.readyState = 4;
      if (this.onreadystatechange) { this.onreadystatechange(); }
    }
  };
}

function boot(seed = {}, opts = {}) {
  const storage = makeStorage(seed);
  const net = { calls: [], routes: opts.routes || [] };
  const timers = new Map();
  let nextTimer = 1;

  const sandbox = {
    localStorage: storage,
    Math, JSON, Date, String, Number, Boolean, Array, Object, RegExp, Error,
    parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent, escape, unescape,
    setInterval: (fn) => { const id = nextTimer++; timers.set(id, fn); return id; },
    clearInterval: (id) => { timers.delete(id); },
    setTimeout: (fn) => { const id = nextTimer++; timers.set(id, fn); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    XMLHttpRequest: makeXHR(net),
  };
  /* tizen is deliberately absent unless a test supplies it: the jar-clearing
   * API is not on every firmware and the code has to cope either way. */
  if (opts.tizen) { sandbox.tizen = opts.tizen; }
  vm.createContext(sandbox);

  for (const f of ["md5.js", "accounts.js", "auth.js", "resume.js"]) {
    vm.runInContext(fs.readFileSync(APP + f, "utf8"), sandbox, { filename: f });
  }
  return { sandbox, storage, net, timers, fire: (n = 1) => {
    const fns = [...timers.values()];
    for (let i = 0; i < n && i < fns.length; i++) { fns[i](); }
  } };
}

/* Fires the poll timer specifically — resume.js registers one at load, so the
 * login poller is whichever was registered after it. */
function firePoll(env) {
  const fns = [...env.timers.values()];
  fns[fns.length - 1]();
}

/* ---------------- migrating what was already there ---------------- */

{
  const env = boot({
    "bili.session": JSON.stringify({ viaCookieJar: true, savedAt: 1 }),
    "bili.resume": JSON.stringify({ "BV1:2": { pos: 90, dur: 600, at: 5 } }),
  });
  const { Accounts, Auth, Resume } = env.sandbox;

  eq("migration keeps the one session as an account", Accounts.count(), 1);
  const a = Accounts.active();
  ok("migrated account is active", !!a);
  eq("migrated jar session still signed in", Auth.isLoggedIn(), true);
  ok("migrated jar session owns the jar", !Accounts.needsRelogin(a));
  eq("migrated history followed the account", Resume.positionMs("BV1", 2), 90000);
  eq("the old single-session key is gone", env.storage.getItem("bili.session"), null);
  eq("the old history key is gone", env.storage.getItem("bili.resume"), null);
}

{
  /* Nobody was signed in, but somebody was watching. That history belongs to
   * the guest, not to the first person who happens to sign in later. */
  const env = boot({ "bili.resume": JSON.stringify({ "BV9:1": { pos: 60, dur: 600, at: 5 } }) });
  const { Accounts, Resume } = env.sandbox;
  eq("no session means no accounts", Accounts.count(), 0);
  eq("guest is active", Accounts.activeId(), "guest");
  eq("guest keeps the existing history", Resume.positionMs("BV9", 1), 60000);
}

/* ---------------- two people, one television ---------------- */

{
  const env = boot();
  const { Accounts, Auth, Resume } = env.sandbox;

  const mum = Accounts.remember(
    { SESSDATA: "SESS-MUM", bili_jct: "JCT-MUM", DedeUserID: "111" }, { mid: 111, uname: "妈妈" });
  Resume.record("BVmum", 1, 120000, 600000, { bvid: "BVmum", title: "妈妈看的" });
  Resume.flush();

  const me = Accounts.remember(
    { SESSDATA: "SESS-ME", bili_jct: "JCT-ME", DedeUserID: "222" }, { mid: 222, uname: "我" });
  Resume.record("BVme", 1, 300000, 600000, { bvid: "BVme", title: "我看的" });
  Resume.flush();

  eq("two accounts", Accounts.count(), 2);
  eq("the newest login is active", Accounts.activeId(), me.id);

  eq("active account's own history is visible", Resume.positionMs("BVme", 1), 300000);
  eq("the other account's history is not", Resume.positionMs("BVmum", 1), 0);
  eq("nor does it show on a card", Resume.fraction("BVmum"), 0);

  Accounts.switchTo(mum.id);
  eq("switched history comes back", Resume.positionMs("BVmum", 1), 120000);
  eq("and the other one is now hidden", Resume.positionMs("BVme", 1), 0);
  eq("recent() is per account", Resume.recent(10).length, 1);
  eq("recent() shows the right video", Resume.recent(10)[0].bvid, "BVmum");

  /* The credentials replayed on a request must be the active account's, and
   * must carry that account's own device fingerprint. */
  const header = Auth.cookieHeader();
  ok("cookie header carries the active account", header.indexOf("SESSDATA=SESS-MUM") >= 0, header);
  ok("cookie header does not leak the other one", header.indexOf("SESS-ME") < 0, header);
  ok("cookie header carries a stable buvid", header.indexOf("buvid3=" + mum.buvid) >= 0, header);
  eq("csrf token is the active account's", Auth.csrf(), "JCT-MUM");

  /* Readable credentials mean the jar is never needed, so a request must not
   * be allowed to attach it. */
  eq("a readable session never asks for the jar", Auth.jarIsOurs(), false);
  eq("a readable session does not need MSE", Auth.needsJar(), false);

  Accounts.switchTo("guest");
  eq("guest sees nobody's history", Resume.recent(10).length, 0);
  eq("guest sends no cookies", Auth.cookieHeader(), "");
  eq("guest is not signed in", Auth.isLoggedIn(), false);
}

/* ---------------- 我的 is the only record of what this TV played ---------- */

{
  /* Both of these used to delete the entry outright, so a video watched
   * briefly and a video watched to the end were equally absent from 我的 —
   * which is where "the videos I just played are not in my history" came
   * from. */
  const env = boot();
  const { Accounts, Resume } = env.sandbox;
  Accounts.remember({ SESSDATA: "S" }, { mid: 1, uname: "A" });

  /* Ten seconds in: nothing worth resuming, but it was watched. */
  Resume.record("BVshort", 1, 10000, 600000, { bvid: "BVshort", title: "看了一会儿" });
  Resume.flush();
  eq("a short watch still lands in the history", Resume.recent(10).length, 1);
  eq("and it is the right video", Resume.recent(10)[0].bvid, "BVshort");
  eq("but offers no resume point", Resume.positionMs("BVshort", 1), 0);
  eq("and draws no progress sliver", Resume.fraction("BVshort"), 0);

  /* Past the end margin, then the ended event. */
  Resume.record("BVdone", 1, 595000, 600000, { bvid: "BVdone", title: "看完了" });
  Resume.finished("BVdone", 1);
  Resume.flush();
  const recent = Resume.recent(10).map((c) => c.bvid);
  ok("a finished video stays in the history", recent.indexOf("BVdone") >= 0, recent.join(","));
  eq("with no resume point", Resume.positionMs("BVdone", 1), 0);

  /* A genuine mid-video position still works as before. */
  Resume.record("BVmid", 1, 300000, 600000, { bvid: "BVmid", title: "看到一半" });
  Resume.flush();
  eq("a real resume point survives", Resume.positionMs("BVmid", 1), 300000);
  eq("and shows a sliver", Resume.fraction("BVmid"), 0.5);
  eq("all three are in the history", Resume.recent(10).length, 3);
  /* Not their order: these three are written inside the same millisecond, so
   * `at` ties and the tie-break is arbitrary. On the device they are minutes
   * apart and record() restamps whatever is playing on every time event, so
   * most-recent-first falls out of that. */
  const all = Resume.recent(10).map((c) => c.bvid).sort().join(",");
  eq("and they are the three that were watched", all, "BVdone,BVmid,BVshort");
}

/* ---------------- 被删掉的稿件：从继续观看里去掉，但不销毁记录 ---------- */

{
  /* A takedown answers `-404 啥都木有` on both playurl forms and on view()
   * (2026-08-12, BV1GAu163EXE). The card outlives the streams, so 继续观看
   * keeps offering a video that can never play. Everything here is silent on
   * the device — a card that quietly stays, or quietly goes, and neither
   * throws — which is why it is tested off it. */
  const env = boot({ "bili.dead.v1": JSON.stringify({ BVancient: 1 }) });
  const { Accounts, Resume } = env.sandbox;
  const a = Accounts.remember({ SESSDATA: "A" }, { mid: 1, uname: "A" });
  const b = Accounts.remember({ SESSDATA: "B" }, { mid: 2, uname: "B" });
  Accounts.switchTo(a.id);

  eq("a mark from 1970 is pruned on read", Resume.dead().BVancient, undefined);

  Resume.record("BVgone", 1, 300000, 600000, { bvid: "BVgone", title: "被删了" });
  Resume.flush();
  Resume.markDead("BVgone");
  ok("the dead video is marked", !!Resume.dead().BVgone);
  ok("and only it is", Object.keys(Resume.dead()).join(",") === "BVgone",
     Object.keys(Resume.dead()).join(","));

  /* The deliberate half: the record stays. Deleting it is the mistake this
   * file has already made twice, and 我的 is where it shows up. */
  const kept = Resume.recent(10).map((c) => c.bvid);
  ok("the watch record survives the takedown", kept.indexOf("BVgone") >= 0, kept.join(","));
  eq("and so does its position", Resume.positionMs("BVgone", 1), 300000);

  /* A takedown is a fact about the video, not about the viewer. */
  Accounts.switchTo(b.id);
  ok("the mark is device level, not per account", !!Resume.dead().BVgone);
  Accounts.remove(a.id);
  ok("and removing an account does not take it", !!Resume.dead().BVgone);

  /* 审核中 answers the same way and comes back. */
  Resume.markAlive("BVgone");
  eq("playing it again clears the mark", Resume.dead().BVgone, undefined);
  eq("and clearing an unmarked video is a no-op", Object.keys(Resume.dead()).length, 0);
}

/* ---------------- unwritten progress belongs to whoever earned it ---------- */

{
  const env = boot();
  const { Accounts, Resume } = env.sandbox;
  const a = Accounts.remember({ SESSDATA: "A" }, { mid: 1, uname: "A" });
  const b = Accounts.remember({ SESSDATA: "B" }, { mid: 2, uname: "B" });

  Accounts.switchTo(a.id);
  /* Recorded and deliberately not flushed — the television being switched to
   * another account mid-video is exactly when this is lost. */
  Resume.record("BVx", 1, 200000, 600000, { bvid: "BVx", title: "x" });
  Accounts.switchTo(b.id);
  eq("B does not inherit A's unwritten position", Resume.positionMs("BVx", 1), 0);
  Accounts.switchTo(a.id);
  eq("A's unwritten position was written to A", Resume.positionMs("BVx", 1), 200000);
}

/* ---------------- removing somebody takes their data with them ---------- */

{
  const env = boot();
  const { Accounts, Resume } = env.sandbox;
  const a = Accounts.remember({ SESSDATA: "A" }, { mid: 1, uname: "A" });
  const b = Accounts.remember({ SESSDATA: "B" }, { mid: 2, uname: "B" });

  Accounts.switchTo(a.id);
  Resume.record("BVa", 1, 120000, 600000, { bvid: "BVa", title: "a" });
  Resume.flush();
  ok("A's history is on disk", env.storage.getItem("bili.resume@" + a.id) !== null);

  Accounts.switchTo(b.id);
  Accounts.remove(a.id);
  eq("account is gone", Accounts.count(), 1);
  eq("and so is its history", env.storage.getItem("bili.resume@" + a.id), null);
  eq("the survivor is untouched", Accounts.activeId(), b.id);

  Accounts.remove(b.id);
  eq("removing the last account falls back to guest", Accounts.activeId(), "guest");
}

{
  /* Signing in again as somebody already on the set must not produce a second
   * face on the switcher. */
  const env = boot();
  const { Accounts } = env.sandbox;
  const first = Accounts.remember({ SESSDATA: "OLD" }, { mid: 42, uname: "同一个人" });
  const again = Accounts.remember({ SESSDATA: "NEW" }, { mid: 42, uname: "同一个人" });
  eq("same mid reuses the row", Accounts.count(), 1);
  eq("and the id is stable", again.id, first.id);
  eq("with the fresh credentials", Accounts.active().session.SESSDATA, "NEW");
  eq("and the same device fingerprint", again.buvid, first.buvid);
}

{
  /* nav() is how a row learns its name, and nav answers for whoever the request
   * actually carried — not for whoever the app believes is active. On 2026-08-09
   * that gap was real for every request on the television: the firmware drops
   * the Cookie header, so nav kept answering as one person while a second and
   * third account were being added, and describe() renamed all of them to him.
   * Three rows, three distinct credentials, one mid and one face — and nothing
   * anywhere said so. A mid that disagrees is evidence about the transport, not
   * about the account. */
  const env = boot();
  const { Accounts } = env.sandbox;
  const mine = Accounts.remember({ SESSDATA: "A" }, { mid: 42 });
  const theirs = Accounts.remember({ SESSDATA: "B" }, { mid: 7 });

  eq("a matching answer is accepted",
     Accounts.describe(theirs.id, { mid: 7, uname: "乙" }).uname, "乙");
  eq("an answer about somebody else is refused",
     Accounts.describe(theirs.id, { mid: 42, uname: "甲" }), null);
  eq("so the row keeps its own name", Accounts.get(theirs.id).uname, "乙");
  eq("and its own mid", Accounts.get(theirs.id).mid, 7);
  eq("the other row is untouched", Accounts.get(mine.id).mid, 42);

  /* A row whose mid is not known yet still has to be fillable — that is the
   * web fallback's only way to ever learn who it belongs to. */
  const unknown = Accounts.remember({ viaCookieJar: true }, {});
  ok("an unidentified row accepts an identity",
     !!Accounts.describe(unknown.id, { mid: 99, uname: "丙" }));
  eq("and keeps it", Accounts.get(unknown.id).mid, 99);
}

/* ---------------- the jar holds at most one account ---------------- */

{
  const env = boot();
  const { Accounts, Auth } = env.sandbox;

  /* Two accounts that only ever existed in the cookie jar — the web fallback's
   * ticket flow, where this code never sees the credentials. */
  const one = Accounts.remember({ viaCookieJar: true }, {});
  eq("a fresh jar login owns the jar", Accounts.needsRelogin(one), false);
  eq("and is treated as signed in", Auth.isLoggedIn(), true);
  eq("and must play through MSE", Auth.needsJar(), true);
  eq("and may attach the jar", Auth.jarIsOurs(), true);

  const two = Accounts.remember({ viaCookieJar: true }, {});
  eq("the newer jar login takes ownership", Accounts.needsRelogin(two), false);
  eq("the older one has lost its credentials", Accounts.needsRelogin(one), true);

  Accounts.switchTo(one.id);
  eq("so it does not claim to be signed in", Auth.isLoggedIn(), false);
  eq("and never attaches somebody else's jar", Auth.jarIsOurs(), false);
  eq("and sends no cookie header either", Auth.cookieHeader(), "");
}

{
  /* With the websetting API present, switching empties the jar — nobody owns
   * it afterwards, which is the honest answer. */
  let cleared = 0;
  const env = boot({}, { tizen: { websetting: { removeAllCookies: () => { cleared++; } } } });
  const { Accounts, Auth } = env.sandbox;
  const jarAcc = Accounts.remember({ viaCookieJar: true }, {});
  const other = Accounts.remember({ SESSDATA: "S" }, { mid: 7 });

  Accounts.switchTo(jarAcc.id);
  ok("switching cleared the jar", cleared > 0);
  eq("the jar account can no longer be restored", Auth.isLoggedIn(), false);
  eq("a readable account is unaffected by the jar", (Accounts.switchTo(other.id), Auth.isLoggedIn()), true);
}

{
  /* Removing whoever is active promotes somebody else. If that somebody is the
   * account the jar holds, emptying the jar on the way past would strand the
   * very session about to be handed the screen. */
  let cleared = 0;
  const env = boot({}, { tizen: { websetting: { removeAllCookies: () => { cleared++; } } } });
  const { Accounts, Auth } = env.sandbox;
  const jarAcc = Accounts.remember({ viaCookieJar: true }, {});
  const tv = Accounts.remember({ SESSDATA: "S" }, { mid: 5 });

  eq("the readable login is active", Accounts.activeId(), tv.id);
  Accounts.remove(tv.id);
  eq("the jar account is promoted", Accounts.activeId(), jarAcc.id);
  eq("and still has its credentials", Auth.isLoggedIn(), true);
  eq("and may still attach the jar", Auth.jarIsOurs(), true);
}

/* ---------------- the TV login request ---------------- */

{
  const authCode = "AUTH-CODE-1";
  const routes = [
    { match: "qrcode/auth_code", reply: { body: { code: 0, data: { url: "https://qr.example/x", auth_code: authCode } } } },
    { match: "qrcode/poll", reply: { body: { code: 0, data: {
        token_info: { mid: 900, access_token: "AT", refresh_token: "RT", expires_in: 2592000 },
        cookie_info: { cookies: [
          { name: "SESSDATA", value: "SESS-TV" },
          { name: "bili_jct", value: "JCT-TV" },
          { name: "DedeUserID", value: "900" },
        ] },
      } } } },
  ];
  const env = boot({}, { routes });
  const { Auth, Accounts } = env.sandbox;

  const seen = [];
  Auth.startLogin((s) => seen.push(s));

  const authCall = env.net.calls[0];
  eq("auth_code is a POST", authCall.method, "POST");
  ok("to the TV login endpoint", authCall.url.indexOf("passport-tv-login/qrcode/auth_code") >= 0, authCall.url);
  eq("form encoded", authCall.headers["Content-Type"], "application/x-www-form-urlencoded");

  const params = new URLSearchParams(authCall.body);
  eq("carries the TV appkey", params.get("appkey"), "4409e2ce8ffd12b8");
  ok("carries a timestamp", /^\d{10}$/.test(params.get("ts") || ""), params.get("ts"));
  ok("carries a signature", /^[0-9a-f]{32}$/.test(params.get("sign") || ""), params.get("sign"));

  /* The signature must be over the sorted parameters, appsec appended. Rebuild
   * it the way the server does and compare. */
  const signed = [...params.entries()].filter(([k]) => k !== "sign")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&");
  eq("signature is md5(sorted params + appsec)",
     params.get("sign"), env.sandbox.MD5(signed + "59b43e04ad6965f34319062b478f83dd"));
  ok("parameters are in sorted order in the body",
     authCall.body.indexOf(signed) === 0, authCall.body);

  eq("the QR is shown before anything is stored", seen[0].kind, "qr");
  eq("and it is the TV flow", seen[0].via, "tv");
  eq("nothing is stored yet", Accounts.count(), 0);

  firePoll(env);
  const pollCall = env.net.calls[1];
  ok("polls the TV endpoint", pollCall.url.indexOf("passport-tv-login/qrcode/poll") >= 0, pollCall.url);
  ok("with the auth code", new URLSearchParams(pollCall.body).get("auth_code") === authCode);

  eq("login completes", seen[seen.length - 1].kind, "done");
  eq("an account was created", Accounts.count(), 1);
  const acc = Accounts.active();
  eq("with the mid from the token", acc.mid, 900);
  eq("and readable credentials", acc.session.SESSDATA, "SESS-TV");
  eq("and the CSRF token the web flow never gives us", acc.session.bili_jct, "JCT-TV");
  eq("and a refresh token", acc.session.refresh_token, "RT");
  eq("so it is switchable, not jar-bound", Accounts.needsRelogin(acc), false);
  eq("and needs no jar", env.sandbox.Auth.jarIsOurs(), false);
}

{
  /* A poll that answers without cookies must not leave a signed-in account
   * with nothing behind it. */
  const routes = [
    { match: "qrcode/auth_code", reply: { body: { code: 0, data: { url: "u", auth_code: "AC" } } } },
    { match: "qrcode/poll", reply: { body: { code: 0, data: { token_info: { mid: 1, access_token: "AT" } } } } },
  ];
  const env = boot({}, { routes });
  const seen = [];
  env.sandbox.Auth.startLogin((s) => seen.push(s));
  firePoll(env);
  eq("a credential-less success is an error", seen[seen.length - 1].kind, "error");
  eq("and stores nothing", env.sandbox.Accounts.count(), 0);
  eq("and leaves nobody signed in", env.sandbox.Auth.isLoggedIn(), false);
}

{
  /* TV endpoint unavailable: fall back to the web flow, and do it before a QR
   * has reached the screen. */
  const routes = [
    { match: "qrcode/auth_code", reply: { status: 500, body: "nope" } },
    { match: "web/qrcode/generate", reply: { body: { code: 0, data: { url: "web-url", qrcode_key: "K" } } } },
  ];
  const env = boot({}, { routes });
  const seen = [];
  env.sandbox.Auth.startLogin((s) => seen.push(s));
  eq("the fallback is announced", seen[0].kind, "fallback");
  eq("and the only QR shown is the web one", seen[1].kind, "qr");
  eq("marked as such", seen[1].via, "web");
  eq("with no TV QR shown first", seen.filter((s) => s.kind === "qr").length, 1);
}

{
  /* Cancelling has to silence a poller that is already in flight, or it
   * announces over whatever the viewer is doing next. */
  const routes = [
    { match: "qrcode/auth_code", reply: { body: { code: 0, data: { url: "u", auth_code: "AC" } } } },
    { match: "qrcode/poll", reply: { body: { code: 0, data: {
        cookie_info: { cookies: [{ name: "SESSDATA", value: "LATE" }] } } } } },
  ];
  const env = boot({}, { routes });
  const seen = [];
  env.sandbox.Auth.startLogin((s) => seen.push(s));
  const before = seen.length;
  env.sandbox.Auth.cancelLogin();
  firePoll(env);
  eq("a cancelled login reports nothing further", seen.length, before);
  eq("and stores nothing", env.sandbox.Accounts.count(), 0);
}

if (failed) { console.log(`\n${failed} of ${checks} checks failed`); process.exit(1); }
console.log(`✓ accounts, storage namespaces, cookie routing and TV login — ${checks} checks`);
