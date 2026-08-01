/* Verify app/js/qr.js by decoding what it produces.
 *
 * A wrong QR is invisible until someone points a phone at a television, so the
 * encoder is checked by round-trip: render the modules to a bitmap, run a real
 * decoder over it, and require the original text back.
 *
 * Comparing bitmaps against another encoder was tried first and rejected — a
 * different mask choice yields a different but equally valid symbol, so that
 * test failed on correct output.
 *
 *   node tools/qr-verify.mjs
 */
import fs from "fs";
import jsQR from "jsqr";

const src = fs.readFileSync(new URL("../app/js/qr.js", import.meta.url), "utf8");
const QR = new Function(src + "; return QR;")();

const CASES = [
  "hi",
  "https://bilibili.com",
  "https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=8c9d27502145fbc213f7565a6c8ae4fc&from=",
  "x".repeat(40),
  "x".repeat(100),
  "x".repeat(131),
  "x".repeat(150),
  "x".repeat(220),
  "中文也要能编码",
];

/* jsQR wants RGBA pixels, with a quiet zone or it will not lock on. */
function toImage(q, scale = 4, quiet = 4) {
  const side = (q.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let r = 0; r < q.size; r++) {
    for (let c = 0; c < q.size; c++) {
      if (!q.modules[r][c]) { continue; }
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const y = (r + quiet) * scale + dy;
          const x = (c + quiet) * scale + dx;
          const i = (y * side + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return { data, side };
}

let failures = 0;

for (const text of CASES) {
  let q;
  try { q = QR.encode(text); }
  catch (e) { console.log(`✗ ${text.length} chars: encode threw ${e.message}`); failures++; continue; }

  const img = toImage(q);
  const got = jsQR(img.data, img.side, img.side);

  if (!got) {
    console.log(`✗ ${text.length} chars (v${q.version}): decoder could not read the symbol`);
    failures++;
  } else if (got.data !== text) {
    console.log(`✗ ${text.length} chars (v${q.version}): decoded to ${JSON.stringify(got.data.slice(0, 40))}`);
    failures++;
  } else {
    console.log(`✓ ${text.length} chars: v${q.version}, ${q.size}x${q.size}, round-trips`);
  }
}

if (failures) {
  console.log(`\n${failures} case(s) failed — do not ship this encoder.`);
  process.exit(1);
}
console.log("\nevery case decodes back to its input.");
