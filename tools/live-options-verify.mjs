/* Exercise the real live key and room-choice functions without a television.
 * A direction must open the sheet; only selecting a different room may tune. */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("../app/js/app.js", import.meta.url)), "utf8");
const anchor = "    window.onload = function () {";
assert.equal(source.split(anchor).length, 2, "app.js test hook location changed");
const hooked = source.replace(anchor, `
    window.__liveTest = {
        setRoom: function (room) { liveRoom = room; },
        key: liveKey,
        isOpen: function () { return liveOptionsOpen; },
        showUi: showLiveUi,
        setSwitch: function (fn) { switchLive = fn; }
    };
` + anchor);

const nodes = {};
for (const id of ["options", "live-panel", "live-panel-title", "live-panel-meta",
    "live-room-list", "live-ui", "live-title", "live-meta", "live-hint"]) {
    nodes[id] = { className: id === "options" || id === "live-panel" ? "hidden" : "", textContent: "" };
}
let choices = [];
Object.defineProperty(nodes["live-room-list"], "innerHTML", {
    get() { return this.html || ""; },
    set(html) {
        this.html = html;
        choices = [...html.matchAll(/class="live-room-choice ([^"]+)" data-index="(\d+)"/g)]
            .map((m) => ({
                className: "live-room-choice " + m[1], index: Number(m[2]), offsetParent: {},
                getAttribute: (name) => name === "data-index" ? m[2] : null,
                getBoundingClientRect() {
                    const top = Math.floor(this.index / 3) * 120;
                    return { top, bottom: top + 100 };
                },
            }));
    },
});
nodes["live-room-list"].querySelectorAll = () => choices;
const document = {
    getElementById: (id) => nodes[id] || null,
    querySelectorAll: (selector) => selector === "#options .focusable" ? choices : [],
    addEventListener: () => {},
    body: { className: "" },
};
let focus = null;
const KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, RETURN: 10009, EXIT: 10182,
    PLAY_PAUSE: 10252, PLAY: 415, PAUSE: 19 };
const sandbox = {
    window: {}, document, console, Date, Math, JSON, String, Number, Array, Object, RegExp,
    parseInt, parseFloat, isFinite, setTimeout: () => 1, clearTimeout: () => {},
    Nav: { KEY, current: () => focus, focus: (node) => { focus = node; }, onKey: () => {}, onBack: () => {} },
    Player: { on: () => {}, userPaused: () => false },
};
vm.createContext(sandbox);
vm.runInContext(hooked, sandbox, { filename: "app.js" });
const test = sandbox.window.__liveTest;
const list = [
    { roomid: 1, title: "Room one", author: "One" },
    { roomid: 2, title: "Room two", author: "Two" },
    { roomid: 3, title: "Room three", author: "Three" },
    { roomid: 4, title: "Room four", author: "Four" },
];
test.setRoom({ list, index: 1, item: list[1], qnName: "原画" });
const switches = [];
test.setSwitch((step) => { switches.push(step); });

assert.equal(test.key(KEY.DOWN), true);
assert.equal(test.isOpen(), true, "down opens the live sheet");
assert.equal(focus.index, 1, "current room starts focused");
assert.deepEqual(switches, [], "opening the sheet must not change rooms");
assert.equal(nodes["live-ui"].className, "hidden", "banner does not cover the sheet");
assert.equal(test.key(KEY.RIGHT), false, "directional movement belongs to navigation");
assert.equal(test.key(KEY.DOWN), false, "down within the sheet navigates rooms");
assert.equal(test.key(KEY.ENTER), false, "enter within the sheet selects the focused room");
choices[1].onselect();
assert.equal(test.isOpen(), false);
assert.deepEqual(switches, [], "confirming the current room must not restart playback");

assert.equal(test.key(KEY.UP), true, "up also opens the live sheet");
choices[2].onselect();
assert.deepEqual(switches, [1], "a different room switches only after confirmation");
assert.equal(test.isOpen(), false);
assert.equal(nodes.options.className, "hidden scroll rows");

test.key(KEY.DOWN);
assert.equal(test.key(KEY.RETURN), true);
assert.equal(test.isOpen(), false, "return closes the sheet without leaving live");
assert.deepEqual(switches, [1]);
test.key(KEY.DOWN);
focus = choices[3];
assert.equal(test.key(KEY.UP), false, "up from a lower row navigates within the sheet");
focus = choices[0];
assert.equal(test.key(KEY.UP), true, "up from the top row closes the sheet");
assert.equal(test.isOpen(), false);
console.log("✓ live options: directions open chooser, navigation stays inside, selection switches, back closes");
