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

console.log("✓ per-video quality cap");
