/* Round-trip app/js/md5.js against node's own MD5.
 *
 * The signature on every TV login request is md5(query + appsec). A digest that
 * is wrong only for certain lengths would present as "bilibili rejects the
 * login" with nothing to distinguish it from a bad appkey, so the padding path
 * is exercised across every block boundary rather than spot-checked.
 *
 *   node tools/md5-verify.mjs
 */
import fs from "fs";
import vm from "vm";
import crypto from "crypto";

const src = fs.readFileSync(new URL("../app/js/md5.js", import.meta.url).pathname, "utf8");
const sandbox = { unescape, encodeURIComponent, String, Math };
vm.createContext(sandbox);
vm.runInContext(src + "\nMD5", sandbox);
const MD5 = sandbox.MD5;

const node = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");

let failed = 0;
function check(label, input) {
  const got = MD5(input);
  const want = node(input);
  if (got !== want) {
    console.log(`✗ ${label}: got ${got} want ${want}`);
    failed++;
  }
}

/* The RFC 1321 suite, so a failure is legible against the published vectors. */
const RFC = {
  "": "d41d8cd98f00b204e9800998ecf8427e",
  "a": "0cc175b9c0f1b6a831c399e269772661",
  "abc": "900150983cd24fb0d6963f7d28e17f72",
  "message digest": "f96b697d7cb7938d525a2f31aaf161d0",
  "abcdefghijklmnopqrstuvwxyz": "c3fcd3d76192e4007dfb496cca67e13b",
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789":
    "d174ab98d277d9f5a5611c2c9f419d9f",
  ["1234567890".repeat(8)]: "57edf4a22be3c955ac49da2e2107b67a",
};
for (const [input, want] of Object.entries(RFC)) {
  const got = MD5(input);
  if (got !== want) { console.log(`✗ RFC1321 "${input.slice(0, 20)}": got ${got} want ${want}`); failed++; }
}

/* Every length through two block boundaries: 55/56 and 63/64 are where the
 * padding decides whether it needs another block, and that branch is the one
 * a hand-written MD5 gets wrong. */
for (let n = 0; n <= 200; n++) { check(`len ${n}`, "x".repeat(n)); }

/* Multi-byte input, since the digest is taken over UTF-8 bytes and not over
 * UTF-16 code units. */
check("cjk", "哔哩哔哩干杯");
check("mixed", "appkey=4409e2ce8ffd12b8&局部=值&ts=1754092800");
check("astral", "🍑🍑🍑");

/* The shape the login path actually produces. */
const qs = "appkey=4409e2ce8ffd12b8&local_id=0&ts=1754092800";
check("signature string", qs + "59b43e04ad6965f34319062b478f83dd");

if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log("✓ md5 matches node across 200 lengths, the RFC vectors and UTF-8");
