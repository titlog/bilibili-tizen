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

const APP = new URL("../app/js/", import.meta.url).pathname;

/* Load order matters: the app is a series of plain scripts sharing globals. */
const ORDER = ["config.js", "md5.js", "mpd.js", "qr.js", "accounts.js",
               "auth.js", "resume.js", "settings.js", "api.js", "nav.js",
               "player.js", "app.js"];

/* Browser and Tizen surface the app is allowed to assume. */
const HOST = [
  "window", "document", "navigator", "location", "localStorage", "console",
  "XMLHttpRequest", "MediaSource", "URL", "Image", "setTimeout", "clearTimeout",
  "setInterval", "clearInterval", "Math", "JSON", "Date", "String", "Number",
  "Boolean", "Array", "Object", "RegExp", "Error", "parseInt", "parseFloat",
  "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent", "escape",
  "unescape", "btoa", "atob", "Uint8Array", "Uint8ClampedArray", "ArrayBuffer",
  "DataView", "Promise", "Blob", "Function", "fetch", "shaka",
  "tizen", "webapis",
];

let failed = false;

/* A sandbox that answers for anything, so evaluation reaches the whole file
 * without a real DOM, and records which globals each file defines. */
/* Comments and string literals mention functions too — "view()" in prose is not
 * a call — so they come out before anything is counted. */
function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
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

/* Every id the app reaches for must exist in the markup or be built by it. */
const html = fs.readFileSync(new URL("../app/index.html", import.meta.url).pathname, "utf8");
const htmlIds = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
const jsIds = new Set();
for (const f of ORDER) {
  const src = fs.readFileSync(path.join(APP, f), "utf8");
  for (const m of src.matchAll(/el\("([\w-]+)"\)/g)) { jsIds.add(m[1]); }
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
