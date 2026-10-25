/* Remote-control regressions: a hold opens the secondary menu, while D-pad
 * movement goes straight to the next card in a four-column grid. */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const src = fs.readFileSync(fileURLToPath(new URL("../app/js/nav.js", import.meta.url)), "utf8");
const events = {};
const windowEvents = {};
const timers = new Map();
let nextTimer = 1;
const body = { className: "", scrollHeight: 0, clientHeight: 0 };
const cards = [];
let veiled = null;   /* #shell behind the player: { contains(node) } */
function card(index, x, y) {
  const node = {
    className: "card focusable", offsetParent: body, parentNode: body,
    scrollHeight: 0, clientHeight: 0,
    getBoundingClientRect: () => ({ left: x, top: y, right: x + 200,
      bottom: y + 120, width: 200, height: 120 }),
    getAttribute: (name) => name === "data-i" ? String(index) : null,
  };
  cards.push(node);
  return node;
}
const document = {
  body,
  getElementById: () => null,
  querySelectorAll: () => cards,
  querySelector: (sel) => sel === ".veiled" ? veiled : cards[0],
  addEventListener: (name, fn) => { events[name] = fn; },
};
const window = { addEventListener: (name, fn) => { windowEvents[name] = fn; } };
const sandbox = { document, window, Date, Math, Infinity,
  setTimeout: (fn) => { const id = nextTimer++; timers.set(id, fn); return id; },
  clearTimeout: (id) => { timers.delete(id); } };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "nav.js" });
const Nav = sandbox.Nav;
function press(type, keyCode) {
  assert.ok(events[type], `${type} listener missing`);
  events[type]({ keyCode, preventDefault() {} });
}

const first = card(0, 0, 0);
const secondRow = card(4, 0, 145);
let plays = 0, menus = 0;
first.onselect = () => { plays++; };
first.onlongselect = () => { menus++; };
Nav.focus(first);

press("keydown", 40);
assert.equal(Nav.current(), secondRow, "Down from first card must enter next row");
Nav.focus(first);
press("keydown", 13);
assert.equal(plays, 0, "keydown must not play before hold is resolved");
press("keyup", 13);
assert.equal(plays, 1, "short Enter plays exactly once");
assert.equal(menus, 0);

press("keydown", 13);
press("keydown", 13); // Samsung remote repeat must not start another action
assert.equal(timers.size, 1);
for (const callback of [...timers.values()]) { callback(); }
assert.equal(menus, 1, "long Enter opens the menu");
assert.equal(plays, 1, "long Enter must not start playback");
press("keyup", 13);
assert.equal(menus, 1, "keyup after hold must not open a second menu");

press("keydown", 13);
press("keydown", 40); // moving focus cancels a pending hold
for (const callback of [...timers.values()]) { callback(); }
press("keyup", 13);
assert.equal(Nav.current(), secondRow);
assert.equal(menus, 1);
assert.equal(plays, 1);
assert.ok(windowEvents.blur, "blur handler should cancel an in-flight hold");

/* The browse screen behind the player keeps its boxes (visibility: hidden):
 * its cards measure like any others, and the remote must not reach them. */
const panelBelow = card(9, 0, 600);
veiled = { contains: (n) => n === secondRow };
Nav.focus(first);
press("keydown", 40);
assert.equal(Nav.current(), panelBelow, "Down must skip a card inside the veiled shell");
veiled = null;

/* The player's panel ("rows", 10-25): down from anywhere in the button row
 * lands on 上一集 / 下一集, not on the 合集 tile under it. Laid out the way the
 * panel was photographed: six buttons and a speed chip, two short buttons at
 * the left edge, four tiles a row. */
function panel(cls) {
  const box = { className: cls, offsetParent: body, parentNode: body, scrollTop: 0,
    scrollHeight: 0, clientHeight: 0,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1920, bottom: 580, width: 1920, height: 580 }) };
  const at = (x, y, w, h) => {
    const node = { className: "btn focusable", offsetParent: body, parentNode: box,
      scrollHeight: 0, clientHeight: 0, getAttribute: () => null,
      getBoundingClientRect: () => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h }) };
    cards.push(node);
    return node;
  };
  cards.length = 0;
  const row = [64, 260, 470, 670, 880].map((x) => at(x, 0, 180, 56));
  const speed = at(1200, 4, 100, 48);
  const prev = at(64, 120, 136, 56), next = at(220, 120, 136, 56);
  const tiles = [64, 516, 968, 1420].map((x) => at(x, 230, 436, 70));
  return { row, speed, prev, next, tiles };
}
let p = panel("scroll rows");
for (const from of [...p.row, p.speed]) {
  Nav.focus(from);
  press("keydown", 40);
  assert.ok(Nav.current() === p.prev || Nav.current() === p.next,
    "Down from any button in the panel's top row must land on 上一集 / 下一集");
}
Nav.focus(p.speed); press("keydown", 40);
assert.equal(Nav.current(), p.next, "…the nearer of the two");
Nav.focus(p.prev); press("keydown", 40);
assert.equal(Nav.current(), p.tiles[0], "Down from 上一集 goes to the tile under it");
Nav.focus(p.tiles[2]); press("keydown", 38);
assert.equal(Nav.current(), p.next, "Up from a tile goes back to the episode row");
Nav.focus(p.next); press("keydown", 38);
assert.equal(Nav.current(), p.row[1], "Up from 下一集 goes to the button over it");
p = panel("scroll");
Nav.focus(p.row[3]); press("keydown", 40);
assert.equal(Nav.current(), p.tiles[1], "Without \"rows\", down stays column-first (the tile under 收藏)");
console.log("✓ navigation: next row, short Enter, long Enter and repeat, nothing behind the player, the panel goes row by row");
