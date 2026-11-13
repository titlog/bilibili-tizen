/* 播放面板「画质」(11-08, from PRs #11 / #18): a cap for the video on screen
 * only. Runs the real settings.js and app.js functions in a sandbox:
 *   - the choices are one per distinct outcome, named by the tier the video gets;
 *   - the pick reaches Settings.qnCap() (player.js builds the manifest under it)
 *     but never the settings page's saved cap, and never another video;
 *   - a prefetch asked under another cap is not used.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const read = (f) => fs.readFileSync(fileURLToPath(new URL("../app/js/" + f, import.meta.url)), "utf8");
const app = read("app.js");
const anchor = "    window.onload = function () {";
assert.equal(app.split(anchor).length, 2, "app.js test hook location changed");
const hooked = app.replace(anchor, `
    window.__qualityTest = {
        choices: videoQualityChoices,
        setVideoQn: setVideoQn,
        qnCap: qnCap,
        qnCapFor: qnCapFor,
        setPlaying: function (p) { playing = p; },
        putPrefetch: function (key, e) { prefetched[key] = e; },
        takePrefetch: takePrefetch,
        prefetchKey: prefetchKey
    };
` + anchor);

const store = {};
const logged = [];
const sandbox = {
  window: {}, console, Date, Math, JSON, String, Number, Array, Object, RegExp,
  parseInt, parseFloat, isFinite, setTimeout, clearTimeout,
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
  document: { getElementById: () => null, addEventListener: () => {}, body: {} },
  Nav: { onKey: () => {}, onBack: () => {} },
  Player: { on: () => {} },
  Accounts: { activeId: () => "person-1" },
  Diag: { record: (kind, detail) => { logged.push(kind + ": " + detail); }, plain: (d) => d },
  REPORT_TO: "",
};
vm.createContext(sandbox);
vm.runInContext(read("settings.js"), sandbox, { filename: "settings.js" });
vm.runInContext(hooked, sandbox, { filename: "app.js" });
const T = sandbox.window.__qualityTest;
const S = sandbox.Settings;
const names = (list) => list.map((c) => c.value + "=" + c.label).join(" ");

/* One per outcome: 4K's step gets 1080P60 here; 1080P+'s and 1080P's both get
 * 1080P, so it is offered once, as the lower cap. */
T.setPlaying({ detail: { bvid: "BVa" }, tiers: [116, 80, 64, 32, 16] });
assert.equal(names(T.choices()), "120=1080P60 80=1080P 64=720P 32=480P");
/* A single-file video: its accept list. */
T.setPlaying({ detail: { bvid: "BVa" }, accept: [64, 32, 16] });
assert.equal(names(T.choices()), "64=720P 32=480P");
/* Nothing known yet: the settings page's steps. */
T.setPlaying({ detail: { bvid: "BVa" } });
assert.equal(T.choices().length, 5);

/* The pick: the playing video's cap and Settings.qnCap(), not the saved one,
 * not another video's. */
S.set("maxQn", 80);
T.setPlaying({ detail: { bvid: "BVa" } });
T.setVideoQn("BVa", 32);
assert.equal(T.qnCap(), 32);
assert.equal(S.qnCap(), 32, "player.js reads Settings.qnCap(): it must see the pick");
assert.equal(S.savedQnCap(), 80, "the settings page's cap must not move");
assert.equal(T.qnCapFor("BVb"), 80, "another video is asked for under the saved cap");
T.setVideoQn("", 0);
assert.equal(S.qnCap(), 80, "back to 自动: the saved cap again");
assert.equal(T.qnCap(), 80);

/* A prefetch made before the pick is that cap's answer: not used after it. */
T.setVideoQn("BVa", 32);
T.putPrefetch(T.prefetchKey("BVa", 1), { at: Date.now(), qn: 80 });
assert.equal(T.takePrefetch("BVa", 1), null, "a prefetch asked under qn80 must not serve a qn32 pick");
assert.ok(logged.some((l) => /不是现在的 qn32/.test(l)), "and the log says why");
T.putPrefetch(T.prefetchKey("BVa", 2), { at: Date.now(), qn: 32 });
assert.ok(T.takePrefetch("BVa", 2), "a prefetch under the same cap is used");
T.putPrefetch(T.prefetchKey("BVb", 3), { at: Date.now(), qn: 80 });
assert.ok(T.takePrefetch("BVb", 3), "another video's prefetch under the saved cap is used");
T.setVideoQn("", 0);

console.log("✓ video quality: choices per outcome, the pick reaches player.js and not the settings page, stale prefetch dropped");
