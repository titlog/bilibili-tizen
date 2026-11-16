/* What a live room does with a failure (11-16 diag uploads, a Tizen 4.0 set),
 * and what a refused write says. Runs app.js's real onLiveEvent / applyLiveQn /
 * actionRefused in a sandbox:
 *   - a 画质 the viewer picks that MSE cannot decode goes back to the tier this
 *     room played on MSE, even with both steps down already spent — not to
 *     AVPlay;
 *   - AVPlay's 「prepare failed」 is a start that failed (FLV: next route, no
 *     reconnect spent), not a dropped connection;
 *   - a room that never showed a picture is not told 「直播断了」;
 *   - -352 on a write is said plainly and not uploaded; other codes still are.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("../app/js/app.js", import.meta.url)), "utf8");
const anchor = "    window.onload = function () {";
assert.equal(source.split(anchor).length, 2, "app.js test hook location changed");
const hooked = source.replace(anchor, `
    window.__errTest = {
        setRoom: function (room) { liveRoom = room; },
        event: onLiveEvent,
        applyQn: applyLiveQn,
        pendQn: function (q) { dmPanel.qnPending = q; },
        flvDead: function () { return liveFlvDead; },
        resetRun: function () { liveFlvDead = false; liveFmp4Dead = false; liveNative = false; liveMseOk = true; },
        stub: function (o) {
            startLiveRoom = o.start; stopLive = o.stop; trouble = o.trouble; toast = o.toast; report = o.report;
            startLiveDanmaku = function () {}; showLiveUi = function () {};
        },
        actionRefused: actionRefused
    };
` + anchor);

const nodes = new Proxy({}, { get: (t, id) => (t[id] = t[id] || { className: "", textContent: "", style: {} }) });
let mode = "live";
const sandbox = {
  window: {}, console, Date, Math, JSON, String, Number, Array, Object, RegExp,
  parseInt, parseFloat, isFinite, setTimeout: () => 1, clearTimeout: () => {},
  document: { getElementById: (id) => nodes[id], addEventListener() {}, body: {}, querySelector: () => null },
  localStorage: { getItem: () => null, setItem() {} },
  Nav: { onKey() {}, onBack() {}, KEY: {} },
  Player: { on() {}, mode: () => mode, stop() {}, timings: () => "" },
  Settings: { get: (k, d) => d, set() {} },
  Diag: { record() {}, priv: (v) => v, plain: (v) => v, incident() {} },
  REPORT_TO: "",
};
vm.createContext(sandbox);
vm.runInContext(hooked, sandbox, { filename: "app.js" });
const T = sandbox.window.__errTest;

let starts = 0, stopped = 0, troubles = [], toasts = [], lines = [];
T.stub({
  start: () => { starts++; }, stop: () => { stopped++; },
  trouble: (t) => { troubles.push(t); }, toast: (t) => { toasts.push(t); }, report: (k, l) => { lines.push(k + ": " + l); },
});
function room(extra) {
  return Object.assign({ list: [{ roomid: 1 }], index: 0, tries: 0, token: 1, failing: false, okTimer: null,
    qnName: "原画", qnUsed: 10000, qnAccept: [10000, 400, 250, 150], qnAsk: 0, nativeFmt: "", nativeFor: "1",
    mseRefused: false, mseSteps: 0, mseTry: false, moved: false, steps: 0, tsBelow: 0, tsGaveUp: false,
    flvGaveUp: false, mseOk: 0, played: false, timed: false }, extra);
}
const DECODE = "直播：shaka code=3016 category=3 severity=2 data[0]=3";

/* The 11-16 set: in at 原画, 3016, 蓝光, 3016, 超清 plays (both steps gone).
 * The viewer picks 原画 in the panel; it cannot be decoded. */
T.resetRun();
mode = "live";
let r = room({ qnUsed: 250, qnName: "超清", mseSteps: 2 });
T.setRoom(r);
T.event("playing");
assert.equal(r.mseOk, 250, "the tier MSE played is remembered");
assert.equal(r.played, true);
T.pendQn(10000);
T.applyQn();
assert.equal(r.qnAsk, 10000); assert.equal(r.mseSteps, 0, "a new ask gets its own steps");
r.mseSteps = 2;                       /* and even with none left */
r.qnUsed = 10000; r.qnName = "原画"; r.failing = false;
starts = 0;
T.event("error", DECODE);
assert.equal(r.mseRefused, false, "not sent to AVPlay");
assert.equal(r.qnAsk, 250, "back to the tier that played");
assert.equal(starts, 1);
assert.ok(lines.some((l) => /回到刚才放得了的 qn250/.test(l)));

/* No tier known on MSE yet: the old two steps, then AVPlay. */
r = room({ qnUsed: 10000 });
T.setRoom(r);
T.event("error", DECODE);
assert.equal(r.qnAsk, 400); assert.equal(r.mseSteps, 1);
r.failing = false; r.qnUsed = 400;
T.event("error", DECODE);
assert.equal(r.qnAsk, 250); assert.equal(r.mseSteps, 2);
r.failing = false; r.qnUsed = 250;
T.event("error", DECODE);
assert.equal(r.mseRefused, true, "out of steps with nothing known: AVPlay");

/* AVPlay prepare failing on FLV: next route, run-wide, no reconnect spent. */
T.resetRun();
mode = "avplay";
r = room({ nativeFmt: "HTTP-FLV", mseRefused: true });
T.setRoom(r);
starts = 0;
T.event("error", "prepare failed: undefined: Unknown error");
assert.equal(T.flvDead(), true); assert.equal(r.flvGaveUp, true);
assert.equal(r.tries, 0, "no reconnect spent"); assert.equal(starts, 1);
/* A connection that failed is the network: a reconnect, FLV kept. */
T.resetRun();
r = room({ nativeFmt: "HTTP-FLV", mseRefused: true });
T.setRoom(r);
T.event("error", "prepare failed: InvalidAccessError: PLAYER_ERROR_CONNECTION_FAILED");
assert.equal(T.flvDead(), false, "one host not answering does not end FLV");
assert.equal(r.tries, 1, "a reconnect");
/* …and on TS it steps the TS down. */
r = room({ nativeFmt: "HLS-TS", mseRefused: true, qnUsed: 10000 });
T.setRoom(r);
T.event("error", "prepare failed: undefined: Unknown error");
assert.equal(r.qnAsk, 400); assert.equal(r.tries, 0);

/* Out of reconnects: 「断了」 only for a room that was on screen. */
for (const played of [false, true]) {
  troubles = [];
  r = room({ nativeFmt: "HLS-fMP4", mseRefused: true, tries: 3, played, moved: played });
  T.setRoom(r);
  T.event("error", "直播：什么别的错误");
  assert.equal(troubles.length, 1);
  assert.equal(troubles[0], played ? "直播断了，重新连了三次也没接上" : "这个直播间现在放不了");
}
console.log("✓ live errors: a picked 画质 MSE refuses goes back to the tier that played; prepare failed is a failed start; 「断了」 only after a picture");

/* Writes refused by bilibili's risk control. */
troubles = []; toasts = []; lines = [];
T.actionRefused("关注", "code -352 -352");
assert.equal(troubles.length, 0, "-352 is not uploaded");
assert.match(toasts[0], /^关注没成功：B 站这次拦下了/);
assert.ok(lines.some((l) => /不算出事（B 站风控）/.test(l)));
T.actionRefused("投币", "code -400 请求错误");
assert.equal(troubles[0], "投币没成功：code -400 请求错误");
T.actionRefused("点赞", "code -3520 x");
assert.equal(troubles.length, 2, "-3520 is not -352");
console.log("✓ writes: -352 said plainly, not uploaded; other codes still are");
