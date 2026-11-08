/* Reproduce a phone watch arriving after the TV cached its history. The test
 * runs the real app functions with a fake history API and a deep grid focus. */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("../app/js/app.js", import.meta.url)), "utf8");
const anchor = "    window.onload = function () {";
assert.equal(source.split(anchor).length, 2, "app.js test hook location changed");
const hooked = source.replace(anchor, `
    window.__historyTest = {
        setHistory: function (items) { serverHistory = { at: new Date().getTime(), items: items, complete: true }; },
        getHistory: function () { return serverHistory.items; },
        refresh: refreshHistoryIfStale,
        setFeed: function (items) { feedCache.rcmd = { items: items }; },
        setScreen: function (screen) { state.screen = screen; },
        setScreenEl: function (node) { screenEl = node; },
        maybeRefreshRow: maybeRefreshResumeRow,
        repaintRow: repaintResumeStrip,
        setPaintCards: function (fn) { paintCards = fn; },
        setRepaint: function (fn) {
            repaintResumeStrip = function () {
                fn();
                resumeRowSig = rowSignature(resumeRowItems());
            };
        },
        bindTab: bindTab,
        setLoadFeed: function (fn) { loadFeed = fn; }
    };
` + anchor);

let requestCount = 0;
let respond;
let focused = { id: "deep-card" };
let rowAttached = true;
let row = {
    id: "resume-row", cards: [],
    querySelectorAll: () => row.cards,
    parentNode: { removeChild: () => { rowAttached = false; } },
};
const document = {
    getElementById: (id) => id === "resume-row" ? row : null,
    addEventListener: () => {},
    body: { contains: (node) => rowAttached && !!node.attached },
};
const sandbox = {
    window: {}, document, console, Date, Math, JSON, String, Number, Array,
    Object, RegExp, parseInt, parseFloat, isFinite, setTimeout, clearTimeout,
    Auth: { isLoggedIn: () => true },
    Accounts: { activeId: () => "person-1" },
    API: { history: (ok) => { requestCount++; respond = ok; } },
    Nav: {
        current: () => focused, focus: (node) => { focused = node; },
        reset: () => {}, onKey: () => {}, onBack: () => {},
    },
    Player: { on: () => {} },
    Settings: { get: () => 3 },
    Resume: { recent: () => [], dead: () => ({}), clearedAt: () => 0, fraction: () => 0 },
};
vm.createContext(sandbox);
vm.runInContext(hooked, sandbox, { filename: "app.js" });
const test = sandbox.window.__historyTest;
const oldItem = { bvid: "BVold", at: 1000, seen: 0.1, progressMs: 1000 };
const newItem = { bvid: "BVnew", at: 2000, seen: 0.1, progressMs: 3000 };

test.setHistory([oldItem]);
test.setScreen("rcmd");
test.setFeed([oldItem]);
test.setScreenEl({ querySelector: () => ({ id: "first-card" }) });
let repaints = 0;
test.setRepaint(() => { repaints++; });
test.refresh();
assert.equal(requestCount, 0, "automatic arrival should reuse recent history");
test.refresh(true);
test.refresh(true);
assert.equal(requestCount, 1, "manual refresh must bypass cache but share an in-flight request");
respond([newItem, oldItem], 2, true);
assert.equal(test.getHistory()[0].bvid, "BVnew");
assert.equal(repaints, 1, "existing strip should update even when focus is deeper in the grid");

// The actual strip painter keeps focus on the same video after a phone watch
// puts a newer card before it, and never focuses a detached card on removal.
test.setPaintCards((container, items) => {
    container.cards = items.map((video) => ({ __video: video, parentNode: container, attached: true }));
});
focused = { __video: oldItem, parentNode: row, attached: false };
test.repaintRow();
assert.equal(focused.__video.bvid, "BVold", "focus should follow the same video after reorder");
test.setHistory([]);
let resetTo;
sandbox.Nav.reset = (selector) => { resetTo = selector; };
test.repaintRow();
assert.equal(resetTo, "#feed-grid .card", "removing the strip must leave focus in the grid");

let tabArgs;
test.setLoadFeed((...args) => { tabArgs = args; });
const tab = { getAttribute: () => "rcmd" };
sandbox.Auth.cancelLogin = () => {};
test.bindTab(tab);
tab.onselect();
assert.equal(tabArgs[1], false, "reselecting 推荐 should reload recommendations");
assert.equal(tabArgs[3], true, "reselecting 推荐 must request fresh history");
test.setScreen("mine");
tab.onselect();
assert.equal(tabArgs[1], true, "returning to 推荐 should restore recommendations");
assert.equal(tabArgs[3], true, "returning to 推荐 must request fresh history");
console.log("✓ history refresh: tab routes, cache bypass, shared requests, row repaint and focus");
