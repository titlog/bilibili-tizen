/* Catch what `node --check` cannot: code that parses but refers to things that
 * do not exist.
 *
 * This exists because a block delete removed `playVideo` along with the dead
 * detail screen it sat next to. Every file still parsed, the build shipped, and
 * the only symptom was that pressing OK on the home screen did nothing at all.
 *
 *   node tools/lint.mjs
 */
import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";

const APP = fileURLToPath(new URL("../app/js/", import.meta.url));

/* Load order matters: the app is a series of plain scripts sharing globals.
 *
 * Read from where the app reads it rather than listed here. The hand-kept list
 * had silently fallen two files behind — `selftest.js` and `updater.js` shipped
 * unchecked, which is precisely the gap this tool exists to close: a call to
 * something that does not exist parses fine and fails only on the sofa. Same
 * lesson as deploy.sh deriving the wgt name from the build instead of
 * hardcoding it. Since self-update (2026-10-18) index.html carries only
 * config.js and boot.js, and boot.js's SCRIPTS is the order everything else
 * loads in. */
const INDEX = fileURLToPath(new URL("../app/index.html", import.meta.url));
const TAGS = [...fs.readFileSync(INDEX, "utf8")
  .matchAll(/<script\s+src="js\/([^"]+)"><\/script>/g)].map((m) => m[1]);
const BOOT_LIST = /var SCRIPTS = \[([^\]]*)\]/.exec(fs.readFileSync(path.join(APP, "boot.js"), "utf8"));
const ORDER = TAGS.concat(BOOT_LIST ? [...BOOT_LIST[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : []);

if (TAGS.join(",") !== "config.js,boot.js") {
  console.error("✗ index.html 的脚本标签应该正好是 config.js、boot.js（其余由 boot.js 按 SCRIPTS 写入），现在是：" + TAGS.join(", "));
  process.exit(1);
}
if (ORDER.length <= 2) {
  console.error("✗ boot.js 里读不到 SCRIPTS —— lint 什么都没检查");
  process.exit(1);
}
for (const f of ORDER) {
  if (!fs.existsSync(path.join(APP, f))) {
    console.error(`✗ index.html 引用了 js/${f}，但文件不存在`);
    process.exit(1);
  }
}

/* Browser and Tizen surface the app is allowed to assume. */
const HOST = [
  "window", "document", "navigator", "location", "localStorage", "console",
  "XMLHttpRequest", "WebSocket", "MediaSource", "URL", "Image", "setTimeout", "clearTimeout",
  "setInterval", "clearInterval", "Math", "JSON", "Date", "String", "Number",
  "Boolean", "Array", "Object", "RegExp", "Error", "parseInt", "parseFloat",
  "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent", "escape",
  "unescape", "btoa", "atob", "Uint8Array", "Uint8ClampedArray", "ArrayBuffer",
  "DataView", "Promise", "Blob", "Function", "fetch", "shaka",
  "TextEncoder", "TextDecoder",
  "tizen", "webapis",
];

let failed = false;

/* A sandbox that answers for anything, so evaluation reaches the whole file
 * without a real DOM, and records which globals each file defines. */
/* Comments and string literals mention functions too — "view()" in prose is not
 * a call — so they come out before anything is counted. */
function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))   /* keeps line numbers */
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

function scanFile(file, known) {
  const src = strip(fs.readFileSync(path.join(APP, file), "utf8"));

  /* Identifiers used as `name(` or `name.` or bare, excluding property access
   * and declarations, are checked against what earlier files defined plus what
   * this file declares itself. */
  const declared = new Set();
  for (const m of src.matchAll(/(?:^|\s)(?:function\s+|var\s+)([A-Za-z_$][\w$]*)/g)) {
    declared.add(m[1]);
  }
  /* var a = 1, b = 2; */
  for (const m of src.matchAll(/var\s+([^;=]+)=/g)) {
    for (const part of m[1].split(",")) { declared.add(part.trim()); }
  }
  /* function parameters and catch bindings */
  for (const m of src.matchAll(/function\s*[\w$]*\s*\(([^)]*)\)/g)) {
    for (const p of m[1].split(",")) { if (p.trim()) { declared.add(p.trim()); } }
  }
  for (const m of src.matchAll(/catch\s*\(\s*([\w$]+)\s*\)/g)) { declared.add(m[1]); }
  for (const m of src.matchAll(/for\s*\(\s*var\s+([\w$]+)/g)) { declared.add(m[1]); }

  const calls = new Set();
  for (const m of src.matchAll(/(?<![.\w$"'])([A-Za-z_$][\w$]*)\s*\(/g)) {
    calls.add(m[1]);
  }

  const keywords = new Set(["if", "for", "while", "switch", "catch", "return",
    "function", "typeof", "new", "delete", "void", "in", "instanceof", "do",
    "else", "throw", "case"]);

  const missing = [...calls].filter((n) =>
    !keywords.has(n) && !declared.has(n) && !known.has(n) && !HOST.includes(n));

  if (missing.length) {
    console.log(`✗ ${file}: calls undefined ${missing.join(", ")}`);
    failed = true;
  } else {
    console.log(`✓ ${file}`);
  }

  for (const d of declared) { known.add(d); }
}

const known = new Set();
for (const f of ORDER) { scanFile(f, known); }

/* play() returns undefined on Chromium 47 (Tizen 3.0), so chaining on it throws
 * after a load that worked — issue #5 lost every video to this. startPlaying()
 * in player.js is the way through. */
for (const f of ORDER) {
  const src = strip(fs.readFileSync(path.join(APP, f), "utf8"));
  const lines = src.split("\n");
  const bad = lines.flatMap((l, i) => /\.play\(\)\s*(?:\.|\[)/.test(l) ? [i + 1] : []);
  if (bad.length) {
    console.log(`✗ ${f}:${bad.join(",")}: play() 的返回值在 Chromium 47 上是 undefined，用 startPlaying()`);
    failed = true;
  }
}

/* Every id the app reaches for must exist in the markup or be built by it. */
const html = fs.readFileSync(INDEX, "utf8");
const htmlIds = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
const jsIds = new Set();
for (const f of ORDER) {
  const src = fs.readFileSync(path.join(APP, f), "utf8");
  /* `el(` on its own: setDanmakuLevel("off") ends in el("off") too. */
  for (const m of src.matchAll(/(?<![\w$.])el\("([\w-]+)"\)/g)) { jsIds.add(m[1]); }
  /* ids created from template strings count as present */
  for (const m of src.matchAll(/id="([\w-]+)"/g)) { htmlIds.add(m[1]); }
}
const missingIds = [...jsIds].filter((id) => !htmlIds.has(id));
if (missingIds.length) {
  console.log(`✗ index.html: missing ids ${missingIds.join(", ")}`);
  failed = true;
} else {
  console.log("✓ element ids");
}

process.exit(failed ? 1 : 0);
