/* Self-update, checked off the device. Gates every package (tools/check.sh).
 *
 * Three parts, because the three fail differently:
 *   1. what boot.js declares — a malformed public key or a version out of step
 *      with config.xml fails silently on the sofa (no update ever verifies, or
 *      an old bundle outranks a newer package);
 *   2. update.js's own verification functions, run here under node's WebCrypto
 *      exactly as the television runs them, against a throwaway key: a good
 *      update passes, and every way of tampering is refused with its own reason;
 *   3. boot.js's launch decision, against a fake page: which code runs, and that
 *      a bundle which never reached the home screen is dropped next launch;
 *   4. when the next check runs — a failed one retries in minutes, not hours —
 *      both the arithmetic and update.js's own timers, on a fake clock.
 *
 *   node tools/update-verify.mjs */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import vm from "vm";
import { ROOT, BOOT, buildBundle, configVersion, describePublic, readBoot, sign, KEY_FILE, loadPrivateKey } from "./update-lib.mjs";

let failed = 0;
const ok = (cond, what) => { if (cond) { console.log("  ✓ " + what); } else { failed++; console.log("  ✗ " + what); } };

const bootSrc = fs.readFileSync(BOOT, "utf8");
const updateSrc = fs.readFileSync(path.join(ROOT, "app/js/update.js"), "utf8");
const boot = readBoot(bootSrc);

/* ---------------- 1. declarations ---------------- */
console.log("boot.js 的声明");
const xmlVersion = configVersion(fs.readFileSync(path.join(ROOT, "app/config.xml"), "utf8"));
ok(boot.packagedFallback === xmlVersion, `PACKAGED_FALLBACK（${boot.packagedFallback}）= config.xml 的版本（${xmlVersion}）—— 改了 config.xml 的版本，boot.js 也要改`);
let pubOk = false;
try {
  const k = crypto.createPublicKey({ key: Buffer.from(boot.pubkey, "base64"), format: "der", type: "spki" });
  pubOk = k.asymmetricKeyType === "ec" && k.asymmetricKeyDetails.namedCurve === "prime256v1";
} catch (e) { pubOk = false; }
ok(pubOk, "PUBKEY 是 P-256 的 SPKI" + (pubOk ? "（指纹 " + describePublic(Buffer.from(boot.pubkey, "base64")).fp + "）" : ""));
ok(boot.scripts.every((f) => fs.existsSync(path.join(ROOT, "app/js", f))), "SCRIPTS 里的文件都在");
ok(!boot.scripts.includes("config.js") && !boot.scripts.includes("boot.js"), "SCRIPTS 不含 config.js、boot.js（这两个永远不随更新下发）");
if (fs.existsSync(KEY_FILE)) {
  let same = false;
  try { same = describePublic(crypto.createPublicKey(loadPrivateKey()).export({ type: "spki", format: "der" })).b64 === boot.pubkey; } catch (e) { same = false; }
  ok(same, "本机的私钥和 boot.js 的公钥是一对");
}

/* ---------------- 2. update.js verification ---------------- */
function storage(init) {
  const m = new Map(Object.entries(init || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}

function loadUpdate(extra) {
  const ctx = Object.assign({ console, TextEncoder, TextDecoder, atob, btoa, Uint8Array, Promise, JSON, Math, Date, String, parseInt,
                localStorage: storage(), Settings: { get: (k, d) => d, set() {} } }, extra || {});
  ctx.window = ctx;
  ctx.crypto = crypto.webcrypto;
  vm.createContext(ctx);
  vm.runInContext(bootSrc + "\n" + updateSrc + "\nthis.Boot = Boot; this.Update = Update;", ctx);
  return ctx;
}

console.log("update.js 验证（一把临时钥匙）");
const U = loadUpdate();
const sub = crypto.webcrypto.subtle;
const test = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const other = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const testPub = test.publicKey.export({ type: "spki", format: "der" }).toString("base64");

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const bundle = buildBundle({ version: "9.0.0", indexHtml: read("app/index.html"), bootSrc, readFile: read });
const bundleBytes = Buffer.from(JSON.stringify(bundle), "utf8");
const payload = JSON.stringify({ version: "9.0.0", shell: 1, sha256: crypto.createHash("sha256").update(bundleBytes).digest("hex"),
  size: bundleBytes.length, date: "2026-10-18T00:00:00Z", urls: ["https://example.invalid/bundle-9.0.0.json"] });
const manifestBytes = (pl, sig) => new Uint8Array(Buffer.from(JSON.stringify({ manifest: pl, sig }), "utf8"));
const T = U.Update._test;

const good = await T.readManifest(sub, testPub, manifestBytes(payload, sign(test.privateKey, payload)));
ok(good.manifest && good.manifest.version === "9.0.0", "签名对的 manifest 读得出来");
const gb = await T.readBundle(sub, good.manifest, new Uint8Array(bundleBytes));
ok(gb.bundle && gb.bundle.scripts.length === boot.scripts.length && typeof gb.bundle.files.body === "string",
   `bundle 对得上 sha256（${Math.round(bundleBytes.length / 1024)}KB，${gb.bundle ? gb.bundle.scripts.length : 0} 个脚本）`);

const tamperedBundle = Buffer.from(bundleBytes);
tamperedBundle[200] = tamperedBundle[200] === 0x41 ? 0x42 : 0x41;
const tb = await T.readBundle(sub, good.manifest, new Uint8Array(tamperedBundle));
ok(tb.why === "bundle sha256 不对", "改一个字节的 bundle → " + tb.why);
const sb = await T.readBundle(sub, good.manifest, new Uint8Array(bundleBytes.subarray(0, bundleBytes.length - 1)));
ok(/大小不对/.test(sb.why || ""), "短一个字节的 bundle → " + sb.why);

const forged = payload.replace('"9.0.0"', '"9.9.9"');
const tm = await T.readManifest(sub, testPub, manifestBytes(forged, sign(test.privateKey, payload)));
ok(tm.why === "manifest 签名不对", "签名后改过版本号的 manifest → " + tm.why);
const wk = await T.readManifest(sub, testPub, manifestBytes(payload, sign(other.privateKey, payload)));
ok(wk.why === "manifest 签名不对", "别的钥匙签的 manifest → " + wk.why);
const der = crypto.sign("sha256", Buffer.from(payload), test.privateKey).toString("base64");
const dr = await T.readManifest(sub, testPub, manifestBytes(payload, der));
ok(dr.why === "manifest 签名不对", "DER 格式的签名（node 的默认）→ " + dr.why + "（所以发布工具要 ieee-p1363）");
const junk = await T.readManifest(sub, testPub, new Uint8Array(Buffer.from("<html>404</html>")));
ok(junk.why === "manifest 格式不对", "不是 manifest 的东西 → " + junk.why);

const m = good.manifest;
const ctx = (o) => Object.assign({ running: "1.1.0", shell: 1, bad: {}, downloaded: "" }, o);
ok(T.judge(m, ctx()) === "", "比正在跑的新 → 下载");
ok(/^版本不更高/.test(T.judge(m, ctx({ running: "9.0.0" }))), "一样的版本 → " + T.judge(m, ctx({ running: "9.0.0" })));
ok(/^版本不更高/.test(T.judge(m, ctx({ running: "10.0" }))), "更旧的版本 → 不下");
ok(/要新的安装包/.test(T.judge(Object.assign({}, m, { shell: 2 }), ctx())), "shell 比这台的 boot.js 新 → " + T.judge(Object.assign({}, m, { shell: 2 }), ctx()));
ok(/启动失败过/.test(T.judge(m, ctx({ bad: { "9.0.0": 1 } }))), "这台电视上标坏过的版本 → " + T.judge(m, ctx({ bad: { "9.0.0": 1 } })));
ok(/已经下载好了/.test(T.judge(m, ctx({ downloaded: "9.0.0" }))), "已经下载过 → 不重下");

/* ---------------- 3. boot.js launch decisions ---------------- */
console.log("boot.js 启动时选哪份代码");
function launch(store) {
  const written = [], bodyKids = [{ nodeName: "DIV" }, { nodeName: "#text" }, { nodeName: "SCRIPT" }, { nodeName: "SCRIPT" }];
  let inserted = "", styles = 0, reloaded = false, blobs = 0;
  const links = [{ parentNode: { removeChild() { links.removed = (links.removed || 0) + 1; } } },
                 { parentNode: { removeChild() { links.removed = (links.removed || 0) + 1; } } }];
  const document = {
    write: (s) => written.push(s),
    body: { childNodes: bodyKids, removeChild: (n) => bodyKids.splice(bodyKids.indexOf(n), 1), insertAdjacentHTML: (w, h) => { inserted = h; } },
    head: { appendChild: (n) => { if (n.tag === "style") { styles++; } } },
    querySelectorAll: () => links,
    createElement: (t) => ({ tag: t }),
  };
  const listeners = {};
  const c = { document, localStorage: store, JSON, parseInt, Math, Date, String,
    window: { addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); } },
    Blob: function () {}, URL: { createObjectURL: () => "blob:" + (++blobs) }, location: { reload: () => { reloaded = true; } } };
  vm.createContext(c);
  vm.runInContext(bootSrc + "\nthis.Boot = Boot;", c);
  const fire = (type) => (listeners[type] || []).forEach((fn) => fn({}));
  return { Boot: c.Boot, written, inserted, styles, linksRemoved: links.removed || 0, reloaded, kids: bodyKids, fire };
}
const bundleText = JSON.stringify(bundle);
const meta = (v, extra) => JSON.stringify(Object.assign({ version: v, shell: 1 }, extra));

let s = storage();
let r = launch(s);
ok(r.written.length === boot.scripts.length && r.written.every((w, i) => w.indexOf('src="js/' + boot.scripts[i] + '"') > 0),
   "没有下载过 → 写安装包的 " + boot.scripts.length + " 个脚本，按 SCRIPTS 的顺序");
ok(r.Boot.info().running === boot.packagedFallback, "running = 安装包版本");

s = storage({ "bili.update.meta": meta("9.0.0"), "bili.update.bundle": bundleText });
r = launch(s);
ok(r.written.length === bundle.scripts.length && r.written.every((w) => /src="blob:\d+"/.test(w)), "有更新的 9.0.0 → 脚本全从 bundle 来（blob:）");
ok(r.inserted === bundle.files.body && r.kids.every((k) => k.nodeName === "SCRIPT"), "body 的静态 DOM 换成 bundle 的，脚本标签留着");
ok(r.linksRemoved === 2 && r.styles === bundle.styles.length, "样式换成 bundle 的");
ok(s.getItem("bili.update.booting") === "9.0.0#1", "记下 booting=9.0.0#1，等首页起来");
ok(r.Boot.info().running === "9.0.0", "running = 9.0.0");

/* 11-07 / 11-14: one launch over within seconds, no error, no log line. */
r = launch(s);   /* 上一次没调 Boot.ok()，也没出错 */
ok(r.Boot.info().running === "9.0.0" && r.written.every((w) => /src="blob:\d+"/.test(w)), "上次用 9.0.0 没走到首页、没出错 → 再试一次 9.0.0");
ok(!r.Boot.isBad("9.0.0") && s.getItem("bili.update.booting") === "9.0.0#2", "没标坏，booting=9.0.0#2");
ok(/再试一次/.test(r.Boot.info().note) && !/标坏/.test(r.Boot.info().note), "note 说再试一次、不说标坏（不算出事）：" + r.Boot.info().note);

r = launch(s);   /* 连着第二次没调 Boot.ok() */
ok(r.written.every((w) => w.indexOf('src="js/') > 0), "连着两次没走到首页 → 这次用安装包");
ok(r.Boot.isBad("9.0.0") && !s.getItem("bili.update.bundle") && !s.getItem("bili.update.booting"), "9.0.0 标坏、更新包删掉");
ok(/没走到首页（连着 2 次）.*标坏/.test(r.Boot.info().note), "说明写在 note 里：" + r.Boot.info().note);

s = storage({ "bili.update.meta": meta("9.0.0"), "bili.update.bundle": bundleText });
r = launch(s);
r.fire("error");   /* 启动时出了 js 错误：不是被打断，是这份代码坏 */
ok(s.getItem("bili.update.booting") === "9.0.0#!", "启动时出错 → booting=9.0.0#!");
r = launch(s);
ok(r.Boot.info().running === boot.packagedFallback && r.Boot.isBad("9.0.0"), "启动时出过错 → 下一次就用安装包、标坏");
ok(/启动时出了错.*标坏/.test(r.Boot.info().note), "note：" + r.Boot.info().note);

s = storage({ "bili.update.meta": meta("9.0.0"), "bili.update.bundle": bundleText });
r = launch(s);
r.Boot.fail();   /* app.js：两秒了屏幕还是空的 */
ok(s.getItem("bili.update.booting") === "9.0.0#!", "Boot.fail() → booting=9.0.0#!");
r = launch(s);
ok(r.Boot.info().running === boot.packagedFallback && r.Boot.isBad("9.0.0"), "Boot.fail() 之后下一次就用安装包、标坏");

s = storage({ "bili.update.meta": meta("9.0.0"), "bili.update.bundle": bundleText });
r = launch(s);
r.Boot.ok();
r.fire("error");   /* 首页起来之后的错误不算启动失败 */
r.Boot.fail();
ok(!s.getItem("bili.update.booting"), "Boot.ok() 之后的错误和 Boot.fail() 不留 booting");

s = storage({ "bili.update.meta": meta("9.0.0"), "bili.update.bundle": bundleText, "bili.update.booting": "9.0.0" });
r = launch(s);   /* 1.5.1 之前的 boot.js 写的是光版本号 */
ok(r.Boot.info().running === "9.0.0" && s.getItem("bili.update.booting") === "9.0.0#2", "老格式 booting=9.0.0 算一次 → 再试一次，booting=9.0.0#2");

s = storage({ "bili.update.meta": meta("9.0.0"), "bili.update.bundle": bundleText, "bili.update.booting": "8.0.0#1" });
r = launch(s);
ok(r.Boot.info().running === "9.0.0" && s.getItem("bili.update.booting") === "9.0.0#1" && !r.Boot.info().note, "别的版本留下的 booting 不算这一份的");

s = storage({ "bili.update.meta": meta("9.0.0"), "bili.update.bundle": bundleText, "bili.update.booting": "9.0.0#1" });
r = launch(s);
r.Boot.ok();
r = launch(s);
ok(r.Boot.info().running === "9.0.0" && s.getItem("bili.update.booting") === "9.0.0#1" && !r.Boot.info().note, "再试那次走到了首页 → 从头记");

s = storage({ "bili.update.meta": meta("9.0.0"), "bili.update.bundle": bundleText });
r = launch(s);
r.Boot.ok();
ok(!s.getItem("bili.update.booting"), "Boot.ok() 清掉 booting");
r = launch(s);
ok(r.Boot.info().running === "9.0.0", "清掉之后下一次照样用 9.0.0");

s = storage({ "bili.update.meta": meta("1.0.9"), "bili.update.bundle": JSON.stringify(Object.assign({}, bundle, { version: "1.0.9" })) });
r = launch(s);
ok(r.Boot.info().running === boot.packagedFallback && !s.getItem("bili.update.meta"), "下载的比安装包旧（手动装了新包）→ 删掉，用安装包：" + r.Boot.info().note);

s = storage({ "bili.update.meta": meta("9.0.0", { shell: 2 }), "bili.update.bundle": bundleText });
r = launch(s);
ok(r.Boot.info().running === boot.packagedFallback && !s.getItem("bili.update.meta"), "shell 比这个 boot.js 新 → 删掉：" + r.Boot.info().note);

s = storage({ "bili.update.meta": meta("9.0.0"), "bili.update.bundle": bundleText.slice(0, 1000) });
r = launch(s);
ok(r.Boot.info().running === boot.packagedFallback && !s.getItem("bili.update.meta"), "更新包存了一半 → 删掉：" + r.Boot.info().note);

s = storage({ "bili.update.meta": meta("9.0.0"), "bili.update.bundle": bundleText, "bili.update.bad": JSON.stringify({ "9.0.0": 1 }) });
r = launch(s);
ok(r.Boot.info().running === boot.packagedFallback, "标坏过的版本 → 用安装包");

/* ---------------- 4. when the next check runs ---------------- */
console.log("下一次什么时候查（失败之后早点再查）");
const MIN = 60000, R = T.RETRY, E = T.EVERY, t0 = Date.UTC(2026, 9, 18, 8);
ok(T.waitAfter(null, t0) === 0, "没查过 → 现在就查");
ok(T.waitAfter({ at: t0 - 60 * MIN, error: false }, t0) === E - 60 * MIN, "一小时前查完了 → 再等 5 小时");
ok(T.waitAfter({ at: t0 - 10 * MIN, error: true, fails: 1 }, t0) === R - 10 * MIN, "十分钟前失败一次 → 再等 5 分钟");
ok(T.waitAfter({ at: t0 - 55 * MIN, error: true, fails: 1 }, t0) === 0, "10-18 那种：55 分钟前 404 过一次，这次开机照查（以前要等满 6 小时）");
const gaps = [1, 2, 3, 4, 5, 6, 9].map((n) => T.waitAfter({ at: t0, error: true, fails: n }, t0) / MIN);
ok(gaps.join() === "15,30,60,120,240,360,360", "连着失败的间隔 " + gaps.join(" / ") + " 分钟，封顶 6 小时");
ok(T.waitAfter({ at: t0, error: true }, t0) === R, "1.2.0 写的失败记录（没有 fails）当成失败一次");
ok(T.waitAfter({ at: t0 + 30 * 24 * 60 * MIN, error: false }, t0) === E, "记录在将来（时钟往回调了）→ 最多等一个间隔");
const r1 = T.record(null, "x", true, t0), r2 = T.record(r1, "x", true, t0), r3 = T.record(r2, "x", false, t0);
ok(r1.fails === 1 && r2.fails === 2 && r3.fails === 0, "失败计数 1、2，成了一次清零");

/* The same through update.js's own timers: offline twice, then a manifest
 * with nothing newer. The clock only moves when a timer fires. */
let clock = t0;
const timers = [], reports = [];
let answer = () => null;
function FakeXhr() {
  let url = "";
  this.open = (m, u) => { url = u; };
  this.send = () => Promise.resolve().then(() => {
    const a = answer(url);
    if (!a) { this.onerror(); return; }
    this.status = a.status; this.response = a.body; this.onload();
  });
}
const S = loadUpdate({ Date: function () { return { getTime: () => clock }; },
  setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, XMLHttpRequest: FakeXhr });
S.Update.init({ report: (k, t) => reports.push(t), busy: () => false });
const fire = async () => {
  const t = timers[timers.length - 1];
  clock += t.ms;
  t.fn();
  await new Promise((r) => setTimeout(r, 150));
  return timers[timers.length - 1].ms;
};
const lastReport = () => reports[reports.length - 1] || "";
ok(timers.length === 1 && timers[0].ms === 60000, "开机一分钟后查");
let next = await fire();
ok(next === R && /15 分钟后再查/.test(lastReport()), "断网 → " + Math.round(next / MIN) + " 分钟后再查：「" + lastReport() + "」");
next = await fire();
ok(next === 2 * R, "又断网 → " + Math.round(next / MIN) + " 分钟后");
S.Boot.PUBKEY = testPub;
/* Already downloaded (this harness runs no launch, so there is no running
 * version to be "not newer" than). */
S.localStorage.setItem("bili.update.meta", JSON.stringify({ version: "9.0.0", shell: 1 }));
const same = JSON.stringify({ version: "9.0.0", shell: 1, sha256: "0".repeat(64), size: 1, date: "", urls: ["https://example.invalid/b.json"] });
answer = () => ({ status: 200, body: Uint8Array.from(manifestBytes(same, sign(test.privateKey, same))).buffer });
next = await fire();
ok(next === E && /^不用下载：.*已经下载好了/.test(lastReport()), "联网了、没有要下的 → " + Math.round(next / MIN / 60) + " 小时后再查：「" + lastReport() + "」");
ok(JSON.parse(S.localStorage.getItem("bili.update.last")).fails === 0, "记录里的失败计数清零");

/* 10-22: a launch a minute after a successful check still checks — the record
 * only paces checks within one run. */
const before = reports.length;
const S2 = loadUpdate({ Date: function () { return { getTime: () => clock }; }, localStorage: S.localStorage,
  setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, XMLHttpRequest: FakeXhr });
S2.Boot.PUBKEY = testPub;
S2.Update.init({ report: (k, t) => reports.push(t), busy: () => false });
ok(timers[timers.length - 1].ms === 60000, "刚查过又开机 → 还是一分钟后查");
next = await fire();
ok(reports.length > before + 1 && /^不用下载/.test(lastReport()) && next === E,
   "开机这一次照查（「" + lastReport() + "」），之后 " + Math.round(next / MIN / 60) + " 小时");
/* Back from the background: only when the last check is over WAKE_GAP old. */
const n0 = timers.length;
S2.Update.wake();
ok(timers.length === n0, "刚查过就从后台回来 → 不另查");
clock += T.WAKE_GAP + MIN;
S2.Update.wake();
ok(timers.length === n0 + 1 && timers[timers.length - 1].ms === 60000, "离上次检查一个多小时、从后台回来 → 一分钟后查");
next = await fire();
ok(/^不用下载/.test(lastReport()) && next === E, "从后台回来的那次照查，之后 " + Math.round(next / MIN / 60) + " 小时");
ok(!/titdev|githubusercontent|jsdelivr|清单来自/.test(S2.Update.status().lastResult), "设置页能读到的结果里没有下载地址：「" + S2.Update.status().lastResult + "」");

console.log(failed ? `✗ ${failed} 处不对` : "✓ 自更新全部通过");
process.exit(failed ? 1 : 0);
