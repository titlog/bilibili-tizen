/* Self-update in a real browser, end to end: the page boots, finds a newer
 * signed version on an update host, downloads it, and the next load runs it;
 * a version that cannot reach the home screen is dropped the launch after.
 *
 *   node tools/update-e2e.mjs
 *
 * Not part of check.sh — it needs Chromium (Playwright, from the douyin-tizen
 * desktop harness) and two local ports. What it uses:
 *   - tools/devserver.mjs --no-auth serves app/ as it ships (with its shim);
 *     every bilibili API call is answered locally with an error, so nothing
 *     here reaches bilibili;
 *   - a throwaway signing key: the test browser gets a boot.js whose PUBKEY is
 *     the throwaway's, by routing, so the real key never signs anything that
 *     exists only for a test — a leaked test manifest signed with it would be a
 *     real update for every set;
 *   - config.js is routed to a development build's (REPORT_TO set), which is
 *     what lets `bili.update.source` point the check at the local host. */
import crypto from "crypto";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { createRequire } from "module";
import { ROOT, buildBundle, readBoot, sign } from "./update-lib.mjs";

const require = createRequire(os.homedir() + "/code/tizen/douyin-tizen/spike/desktop-harness/package.json");
const { chromium } = require("playwright-core");
const CHROME = os.homedir() + "/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const DEV_PORT = 8123, HOST_PORT = 8124;
const HOST = `http://localhost:${HOST_PORT}/`;
let failed = 0;
const ok = (cond, what) => { if (cond) { console.log("  ✓ " + what); } else { failed++; console.log("  ✗ " + what); } };
const sleep = (t) => new Promise((r) => setTimeout(r, t));

/* ---- the update host: whatever manifest/bundle the current step publishes ---- */
const published = {};
const reports = [];
const hostServer = http.createServer((req, res) => {
  if (req.method === "POST") {           /* the app's report() lines */
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
      try { reports.push(JSON.parse(b).detail.msg); } catch (e) { /* not a report */ }
      res.writeHead(200, { "Access-Control-Allow-Origin": "*" }).end("ok");
    });
    return;
  }
  const name = req.url.split("?")[0].slice(1);
  if (!published[name]) { res.writeHead(404, { "Access-Control-Allow-Origin": "*" }).end("nope"); return; }
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }).end(published[name]);
}).listen(HOST_PORT);

const dev = spawn("node", [path.join(ROOT, "tools/devserver.mjs"), "--no-auth"], { env: { ...process.env, DEV_PORT: String(DEV_PORT) }, stdio: "ignore" });
await sleep(800);

/* ---- signing, with a throwaway key ---- */
const key = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pubB64 = key.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const bootSrc = fs.readFileSync(path.join(ROOT, "app/js/boot.js"), "utf8");
const testBoot = bootSrc.replace(/var PUBKEY = "[^"]*";/, `var PUBKEY = "${pubB64}";`);
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

/* Publish `version`: the working tree's bundle, `tweak` applied to it, signed. */
function publish(version, tweak, { corrupt } = {}) {
  const b = buildBundle({ version, indexHtml: read("app/index.html"), bootSrc, readFile: read });
  if (tweak) { tweak(b); }
  const name = `bundle-${version}.json`;
  const bytes = Buffer.from(JSON.stringify(b), "utf8");
  const manifest = JSON.stringify({ version, shell: b.shell, sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length, date: new Date().toISOString(), urls: [HOST + name] });
  if (corrupt) { bytes[300] = bytes[300] === 0x61 ? 0x62 : 0x61; }
  published[name] = bytes;
  published["manifest.json"] = JSON.stringify({ manifest, sig: sign(key.privateKey, manifest) });
}
const marker = (v) => (b) => {
  b.files["js/app.js"] += `\nwindow.__bundleMarker = "${v}";` +
    `\nwindow.addEventListener("load", function () { window.__loadAfterBundle = "${v}"; });`;
  b.files.body = '<div id="__bundle_dom"></div>' + b.files.body;
};

/* ---- the browser ---- */
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.route("**/js/boot.js", (r) => r.fulfill({ contentType: "application/javascript", body: testBoot }));
await page.route("**/js/config.js", (r) => r.fulfill({ contentType: "application/javascript", body:
  read("app/js/config.js").replace(/var REPORT_TO = "[^"]*";/, `var REPORT_TO = "${HOST}report";`).replace(/var SELFTEST = true;/, "var SELFTEST = false;") }));
for (const p of ["**/__api/**", "**/__passport/**", "**/__search/**"]) {
  await page.route(p, (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"code":-1,"message":"e2e: bilibili blocked"}' }));
}

const state = () => page.evaluate(() => ({
  info: Boot.info(), marker: window.__bundleMarker || "", loadAfter: window.__loadAfterBundle || "",
  dom: !!document.getElementById("__bundle_dom"), booting: localStorage.getItem("bili.update.booting"),
  onload: typeof window.onload === "function", screen: (document.getElementById("screen") || {}).innerHTML ? true : false,
  status: Update.status(),
}));
const check = () => page.evaluate(() => new Promise((res) => Update.check(res)));
const load = async () => { await page.reload({ waitUntil: "load" }); await sleep(1500); };

await page.goto(`http://localhost:${DEV_PORT}/`, { waitUntil: "load" });
await page.evaluate((src) => { localStorage.clear(); localStorage.setItem("bili.update.source", src); }, HOST + "manifest.json");
await load();

console.log("安装包");
let s = await state();
ok(s.info.running === s.info.packaged && !s.marker, `跑的是安装包 ${s.info.packaged}`);
ok(s.onload && s.screen, "app.js 的 window.onload 跑了（首页画出来了东西）");

console.log("发布 9.0.0 → 检查 → 下载 → 下次打开生效");
publish("9.0.0", marker("9.0.0"));
let r = await check();
ok(/^已下载 9\.0\.0，下次打开生效/.test(r), "检查：" + r);
ok((await state()).status.downloaded === "9.0.0", "status().downloaded = 9.0.0");
await load();
s = await state();
ok(s.info.running === "9.0.0" && s.marker === "9.0.0", "重新打开跑的是 9.0.0（bundle 里加的那一行生效了）");
ok(s.loadAfter === "9.0.0", "bundle 的脚本在 load 事件之前执行完（document.write 的时机对）");
ok(s.onload && s.screen, "app.js 照样从 window.onload 启动、画出了首页");
ok(s.dom, "body 换成了 bundle 里的 DOM");
ok(s.booting === "9.0.0#1", "booting=9.0.0#1 挂着，等 Boot.ok()");
await page.evaluate(() => Boot.ok());
ok((await state()).booting === null, "Boot.ok() 之后清掉");
r = await check();
ok(/版本不更高/.test(r), "再查一次（还是 9.0.0）：" + r);

console.log("发布一个启动就抛错的 9.1.0");
publish("9.1.0", (b) => { b.files["js/app.js"] = 'throw new Error("e2e: broken build");\n' + b.files["js/app.js"]; });
r = await check();
ok(/^已下载 9\.1\.0/.test(r), "检查：" + r);
await load();
s = await state();
ok(s.info.running === "9.1.0" && !s.onload && s.booting === "9.1.0#!", "9.1.0 起来了但 app 没启动，启动时的错误 boot.js 自己看见了（booting=" + s.booting + "）");
await load();
s = await state();
ok(s.info.running === s.info.packaged && s.onload && s.screen, "再打开一次：退回安装包 " + s.info.packaged + "，首页正常");
ok(/没走到首页（启动时出了错）.*标坏/.test(s.info.note), "原因：" + s.info.note);
r = await check();
ok(/启动失败过/.test(r), "线上还是 9.1.0 时：" + r);

console.log("篡改和旧版本");
publish("9.2.0", null, { corrupt: true });
r = await check();
ok(/sha256 不对/.test(r), "bundle 被改过一个字节：" + r);
published["manifest.json"] = JSON.stringify({ ...JSON.parse(published["manifest.json"]), manifest: JSON.parse(published["manifest.json"]).manifest.replace("9.2.0", "9.3.0") });
r = await check();
ok(/签名不对/.test(r), "签名之后改了 manifest：" + r);
publish("1.0.9", null);
r = await check();
ok(/版本不更高/.test(r), "线上版本比安装包还旧：" + r);
s = await state();
ok(s.info.running === s.info.packaged, "这些都没影响正在跑的安装包");

ok(errors.filter((e) => !/e2e: broken build/.test(e)).length === 0, "页面上没有别的 JS 错误" + (errors.length ? "（" + errors.join(" | ").slice(0, 300) + "）" : ""));
console.log("  上报的 update 行：\n    " + reports.filter((x) => /^update: /.test(x)).join("\n    "));

await browser.close();
dev.kill();
hostServer.close();
console.log(failed ? `✗ ${failed} 处不对` : "✓ 端到端全部通过");
process.exit(failed ? 1 : 0);
