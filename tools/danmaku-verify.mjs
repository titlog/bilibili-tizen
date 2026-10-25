/* app/js/danmaku.js, off the television.
 *
 *   node tools/danmaku-verify.mjs            # parsing, dedupe, lanes (tools/check.sh runs this)
 *   node tools/danmaku-verify.mjs --browser  # also: a real Chromium, a hot-video burst for 30 s,
 *                                            # frame times and screenshots; one real request through
 *                                            # tools/devserver.mjs --no-auth (started here on :8101)
 *
 * The sample is 24 real comments from cid 42681830210 (2026-10-18) with the
 * sender hash and comment id zeroed — this file is public, those are not ours. */
import fs from "fs";
import os from "os";
import path from "path";
import vm from "vm";
import { spawn } from "child_process";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(ROOT, "app/js/danmaku.js"), "utf8");
/* The block app.css gets (the report hands it over; kept here so the browser
 * run looks like the set). Document order puts #danmaku under the subtitles
 * and the player chrome (z-index 40), which is what is wanted. */
const CSS = `
#danmaku { position: absolute; left: 0; top: 0; width: 1920px; height: 756px;
    overflow: hidden; pointer-events: none; opacity: 0.85; }
#danmaku .dm { position: absolute; left: 0; top: 0; white-space: nowrap;
    font-weight: 600; line-height: 1.24; will-change: transform;
    text-shadow: 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 0 0 4px rgba(0,0,0,0.6); }
.comments-open #danmaku { display: none; }`;
let failed = 0;
function check(ok, what) { console.log((ok ? "  ✓ " : "  ✗ ") + what); if (!ok) { failed++; } }

const ctx = {};
vm.createContext(ctx);
vm.runInContext(SRC + "\nthis.Danmaku = Danmaku;", ctx);
const T = ctx.Danmaku.test;

/* Three global display areas are clips on one renderer: switching must not
 * allocate another comment list or alter the density cap. */
console.log("显示区域");
const area = ctx.Danmaku.area, areaClass = ctx.Danmaku.areaClass;
check(["top", "upper", "full", "bad"].map(area).join(",") === "top,upper,full,upper",
  "三种区域、未知设置回到避开字幕");
check(areaClass("top", true) === "dm-area-top" &&
      areaClass("full", false) === "dm-area-full hidden", "开关不丢失区域设置");
const css = fs.readFileSync(path.join(ROOT, "app/css/app.css"), "utf8");
const height = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(escaped + "\\s*\\{[^}]*height:\\s*(\\d+)px").exec(css);
  return match && Number(match[1]);
};
check(height("#danmaku.dm-area-top") === 270 &&
      height("#danmaku.dm-area-upper") === 756 && height("#danmaku") === 756 &&
      height("#danmaku.dm-area-full") === 1080,
  "顶部 1/4、避开字幕（默认，上面 756px）、全屏对应 1080p 画布");
check(height(".options-open #danmaku.dm-area-top") === 270 &&
      height(".options-open #danmaku") === 496,
  "播放面板展开时弹幕不盖住操作区");

/* ---------------- parsing ---------------- */
console.log("解析");
const REAL = "<d p=\"0.97700,5,25,16707842,0,0,0,1,10\">封面我以为claude呢（doge）</d><d p=\"8.21700,1,25,16777215,0,0,0,2,10\">其实类似于听书对吧</d><d p=\"14.44600,1,25,16777215,0,0,0,3,10\">捉个虫，旗子的zi应该是轻声而非三声，不然就成“棋子”了</d><d p=\"7.11100,5,25,16707842,0,0,0,4,10\">我好像有点障碍</d><d p=\"3.78500,5,25,16707842,0,0,0,5,10\">封面我以为雀巢的小花呢（doge）</d><d p=\"0.59200,1,25,16777215,0,0,0,6,10\">请合上眼睛想象画面</d><d p=\"14.19600,1,25,16777215,0,0,0,7,10\">口述影像！</d><d p=\"86.68300,5,25,41194,0,0,0,8,10\">一听这首歌就想哭</d><d p=\"28.87800,1,25,16777215,0,0,0,9,9\">如果我是盲人迪士尼城堡，我没见过呀，我不知道是什么样子呀，除非我是后天性的</d><d p=\"19.14000,1,25,16777215,0,0,0,10,9\">经典迪士尼开场</d><d p=\"25.74400,1,25,16777215,0,0,0,11,9\">这不是变成了听书吗？</d><d p=\"24.12800,1,25,16777215,0,0,0,12,9\">话说盲人知道迪士尼城堡长什么样吗？</d><d p=\"18.36500,5,25,41194,0,0,0,13,9\">《迪 士 尼 绘 本 故 事》</d><d p=\"3.25000,1,25,16777215,0,0,0,14,9\">我也以为是claude（蓝色限定版）</d><d p=\"23.90700,1,25,16777215,0,0,0,15,9\">我好像真的看见了，这个画面感</d><d p=\"24.46100,1,25,16777215,0,0,0,16,9\">什么是迪士尼城堡?</d><d p=\"26.08200,1,25,16777215,0,0,0,17,8\">搞了半天还得自己想</d><d p=\"36.87100,1,25,16777215,0,0,0,18,8\">有声小说？</d><d p=\"45.94100,1,25,16777215,0,0,0,19,8\">什么是城堡？什么是气船…</d><d p=\"29.78800,1,25,16777215,0,0,0,20,8\">烟花是啥，好吃吗</d><d p=\"23.02600,1,25,16777215,0,0,0,21,8\">什么是河流，什么是城堡，什么烟花</d><d p=\"20.49300,1,25,16777215,0,0,0,22,8\">好多年前学校青协做过给盲人讲电影，现在还是有人坚持做这件事啊，突然有点感慨</d><d p=\"32.44600,1,25,16777215,0,0,0,23,8\">大部分盲人不是完全黑的，是视力残疾</d><d p=\"20.32900,1,25,16777215,0,0,0,24,8\">放了个滚木啥意思？</d>";
const EXTRA =
  '<d p="2.0,7,25,16777215,0,0,0,90,10">[0,0,"1-1",4.5,"positioned"]</d>' +   // mode 7: dropped
  '<d p="2.5,8,25,16777215,0,0,0,91,10">code</d>' +                             // mode 8: dropped
  '<d p="3.0,1,25,255,0,0,0,92,10">a &amp; b &lt;c&gt; &#x4e2d;&#25991;</d>' +   // entities
  '<d p="3.2,1,25,255,0,0,0,93,10">  </d>' +                                    // blank: dropped
  '<d p="4.0,1,25,16777215,0,0,0,94,10">重复</d>' +
  '<d p="4.6,1,25,16777215,0,0,0,95,10">重复</d>' +                             // same text < 1 s later: dropped
  '<d p="5.7,1,25,16777215,0,0,0,96,10">重复</d>' +                             // > 1 s after the kept one: kept
  '<d p="6.0,6,36,65280,0,0,0,97,3">逆向</d>' +                                 // mode 6 scrolls
  '<d p="6.1,4,18,65280,0,0,0,98,3">底部</d>';
const xml = '<?xml version="1.0" encoding="UTF-8"?><i><maxlimit>1000</maxlimit>' + REAL + EXTRA + "</i>";
let t0 = performance.now();
const list = T.parse(xml);
const parseMs = performance.now() - t0;
check(list.length === 24 + 5, "条数 " + list.length + "（24 条真样本 + 9 条构造的里留 5 条）");
check(list.every((x, i) => i === 0 || list[i - 1].t <= x.t), "按时间排好");
check(!list.some(x => x.mode === 7 || x.mode === 8), "7、8 模式丢掉");
check(list.some(x => x.text === "a & b <c> 中文"), "实体解码");
check(list.filter(x => x.text === "重复").length === 2, "一秒内重复的去掉、隔开的留下");
check(list.find(x => x.text === "逆向").mode === 1 && list.find(x => x.text === "底部").mode === 4, "6 当滚动、4 是底部");
check(list[0].t === 592 && list[0].mode === 1 && list[0].color === "#ffffff", "第一条：592ms、滚动、#ffffff");
const top977 = list.find(x => x.t === 977);
check(top977 && top977.mode === 5 && top977.color === "#fef102", "977ms 那条：顶部、#fef102（16707842）");
check(list.find(x => x.text === "逆向").weight === 3 && list.find(x => x.text === "逆向").size === 36, "权重、字号");
/* A hot video's pool, for timing: 8000 entries. */
let big = "<i>";
for (let i = 0; i < 8000; i++) big += '<d p="' + (i * 0.9).toFixed(3) + ',1,25,16777215,0,0,0,' + i + ',' + (i % 11) + '">弹幕第' + i + '条 &amp; 一些字</d>';
big += "</i>";
t0 = performance.now();
const bigList = T.parse(big);
const bigMs = performance.now() - t0;
check(bigList.length === 8000, "8000 条解析 " + bigMs.toFixed(1) + "ms（24+9 条 " + parseMs.toFixed(2) + "ms）");

/* ---------------- lanes ---------------- */
console.log("轨道");
function laneRun(seed, n, count) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const lanes = new T.Lanes(count), placed = [];
  let now = 0, dropped = 0;
  for (let i = 0; i < n; i++) {
    now += rnd() * 400;                       // bursts: up to ~5 per second per lane set
    const w = 80 + Math.floor(rnd() * 900);
    const lane = lanes.scroll(now, w);
    if (lane < 0) { dropped++; continue; }
    placed.push({ lane, start: now, w });
  }
  /* Same speed for all, so overlap can only happen if a new one enters before
   * the previous tail (plus gap) is on screen. Check it pairwise per lane, and
   * check positions directly at sampled moments too. */
  let bad = 0;
  const byLane = {};
  for (const p of placed) (byLane[p.lane] = byLane[p.lane] || []).push(p);
  for (const k in byLane) {
    const ps = byLane[k];
    for (let i = 1; i < ps.length; i++) {
      const prev = ps[i - 1], cur = ps[i];
      for (let t = cur.start; t < cur.start + (T.WIDTH + cur.w) / T.SPEED; t += 50) {
        const xPrev = T.WIDTH - (t - prev.start) * T.SPEED, xCur = T.WIDTH - (t - cur.start) * T.SPEED;
        if (xPrev + prev.w + T.GAP > xCur + 0.5 && xPrev + prev.w > 0) { bad++; break; }
      }
    }
  }
  return { placed: placed.length, dropped, bad, lanesUsed: Object.keys(byLane).length };
}
const r1 = laneRun(7, 3000, 15);
check(r1.bad === 0, "15 条轨道、3000 条随机宽度：放了 " + r1.placed + "、丢了 " + r1.dropped + "，重叠 " + r1.bad);
const r2 = laneRun(99, 3000, 3);
check(r2.bad === 0 && r2.dropped > 0, "3 条轨道挤不下就丢：放了 " + r2.placed + "、丢了 " + r2.dropped + "，重叠 " + r2.bad);
const fl = new T.Lanes(4);
const tops = [fl.fixed(0, true, 300), fl.fixed(10, true, 300), fl.fixed(20, true, 300), fl.fixed(30, true, 300), fl.fixed(40, true, 300), fl.fixed(T.FIXED_MS + 1, true, 300)];
check(tops.join(",") === "0,1,2,3,-1,0", "顶部：一行一条、满了丢、" + T.FIXED_MS + "ms 后空出来（" + tops.join(",") + "）");
/* The play panel takes the bottom rows away and gives them back: new comments
 * only go to the rows in view, and a row that comes back still remembers the
 * comment crossing it. */
const rz = new T.Lanes(6);
for (let i = 0; i < 6; i++) rz.scroll(0, 400);          /* every row busy until ~1750ms */
rz.resize(3);
const whileOpen = [rz.scroll(5000, 400), rz.scroll(5000, 400), rz.scroll(5000, 400), rz.scroll(5000, 400)];
rz.scroll(5000, 400);
const busyRow5 = (rz.resize(6), rz.scroll(100, 400));    /* back to six, early: rows 3–5 still busy from t=0 */
const freeLater = rz.scroll(5000, 400);
check(whileOpen.join(",") === "0,1,2,-1" && busyRow5 === -1 && freeLater === 3,
  "面板打开时只用上面的轨道（" + whileOpen.join(",") + "），关上后下面的轨道还记得没飘完的（" + busyRow5 + "，之后 " + freeLater + "）");
const fb = new T.Lanes(4);
const bottoms = [fb.fixed(0, false, 300), fb.fixed(1, false, 300)];
check(bottoms.join(",") === "3,2", "底部从下往上（" + bottoms.join(",") + "）");

/* Mixed: scrollers and fixed comments in the same rows must never overlap —
 * the first version drew top comments straight over the scrollers. */
function mixedRun(seed, n, count) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const lanes = new T.Lanes(count), scrolls = [], fixeds = [];
  let now = 0;
  for (let i = 0; i < n; i++) {
    now += rnd() * 300;
    const w = 80 + Math.floor(rnd() * 700), kind = rnd();
    if (kind < 0.15) {
      const row = lanes.fixed(now, kind < 0.08, w);
      if (row >= 0) fixeds.push({ row, start: now, w });
    } else {
      const row = lanes.scroll(now, w);
      if (row >= 0) scrolls.push({ row, start: now, w });
    }
  }
  let bad = 0;
  for (const f of fixeds) {
    const left = (T.WIDTH - f.w) / 2, right = left + f.w;
    for (const sc of scrolls) {
      if (sc.row !== f.row) continue;
      for (let t = f.start; t < f.start + T.FIXED_MS; t += 50) {
        const x = T.WIDTH - (t - sc.start) * T.SPEED;
        if (t >= sc.start && x < right && x + sc.w > left) { bad++; break; }
      }
    }
  }
  return { scrolls: scrolls.length, fixeds: fixeds.length, bad };
}
const mx = mixedRun(5, 4000, 13);
check(mx.bad === 0 && mx.fixeds > 50, "滚动和顶部 / 底部混着来：滚动 " + mx.scrolls + "、固定 " + mx.fixeds + "，压在一起 " + mx.bad);

/* ---------------- browser ---------------- */
if (process.argv.includes("--browser")) {
  await browserRun();
}

console.log(failed ? "✗ " + failed + " 项不对" : "✓ 弹幕全部通过");
process.exit(failed ? 1 : 0);

async function browserRun() {
  console.log("浏览器");
  const require = createRequire(os.homedir() + "/code/tizen/douyin-tizen/spike/desktop-harness/package.json");
  const { chromium } = require("playwright-core");
  const PORT = 8101;
  const dev = spawn("node", [path.join(ROOT, "tools/devserver.mjs"), "--no-auth"], { env: { ...process.env, DEV_PORT: String(PORT) }, stdio: "ignore" });
  await new Promise(r => setTimeout(r, 1200));
  const shots = process.env.SHOTS || os.tmpdir();
  const browser = await chromium.launch({
    executablePath: os.homedir() + "/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    page.on("pageerror", e => { check(false, "pageerror " + e.message); });
    /* A page on the devserver's origin holding only the module, so the one real
     * request goes through the same shim the app gets. The CSS is the block the
     * report hands to app.css. */
    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">' +
      '<style>html,body{margin:0;width:1920px;height:1080px;background:#203040;font-family:"Samsung One","Noto Sans CJK SC",sans-serif}' +
      '#bg{position:absolute;inset:0;background:linear-gradient(135deg,#2a4a6a,#6a3a2a)}' +
      CSS + '</style></head><body><div id="bg"></div>' +
      '<div id="danmaku"></div><script src="/js/danmaku.js"></script></body></html>';
    /* devserver's URL-rewriting shim is what the app gets (it is injected into
     * index.html); take that very script so this page goes through it too. */
    const index = await (await fetch("http://localhost:" + PORT + "/index.html")).text();
    const shim = (index.match(/<script>[\s\S]*?<\/script>/) || [""])[0];
    check(/XMLHttpRequest\.prototype\.open/.test(shim), "拿到 devserver 的改写脚本");
    await page.route("http://localhost:" + PORT + "/__dm.html", r => r.fulfill({ contentType: "text/html", body: html.replace("<script", shim + "<script") }));
    await page.goto("http://localhost:" + PORT + "/__dm.html");

    /* One real request: cid 42681830210 had 80 comments on 2026-10-18. */
    const real = await page.evaluate(() => new Promise(res => {
      var t0 = performance.now();
      Danmaku.load(42681830210, l => res({ n: l.length, ms: Math.round(performance.now() - t0), first: l[0] }),
                   why => res({ err: why }));
    }));
    check(!real.err && real.n > 0, "真请求（经 devserver）：" + (real.err || real.n + " 条，" + real.ms + "ms，第一条 " + JSON.stringify(real.first)));

    /* A hot video: 30 s of comments at ~25 per second, mixed widths, a few
     * top/bottom ones, run at real time with a 250 ms position report. */
    const res = await page.evaluate(async () => {
      var words = ["哈哈哈哈", "前方高能", "这也太好看了吧", "awsl", "名场面来了", "泪目", "有一说一，这段剪辑真的绝", "第一次看到这么离谱的操作",
                   "233333", "UP 主辛苦了", "好家伙", "建议改成：这个视频每一帧都可以当壁纸", "？？？", "妙啊"];
      var colors = ["#ffffff", "#ffffff", "#ffffff", "#fe0302", "#ffff00", "#00cd00"];
      var list = [];
      for (var i = 0; i < 750; i++) {
        var mode = i % 23 === 0 ? 5 : i % 29 === 0 ? 4 : 1;
        list.push({ t: Math.round(i * 40 + (i * 7919 % 37)), mode: mode, size: i % 13 === 0 ? 36 : 25,
                    color: colors[i % colors.length], text: words[i % words.length] + (i % 3 ? "" : " #" + i), weight: i % 11 });
      }
      list.sort(function (a, b) { return a.t - b.t; });
      var box = document.getElementById("danmaku");
      var r = Danmaku.renderer(box);
      r.density("high");
      r.set(list);
      var longTasks = [], frames = [], maxLive = 0, lastF = performance.now();
      try {
        new PerformanceObserver(function (l) { l.getEntries().forEach(function (e) { longTasks.push(Math.round(e.duration)); }); })
          .observe({ entryTypes: ["longtask"] });
      } catch (e) {}
      var running = true;
      (function raf() { requestAnimationFrame(function (t) { frames.push(t - lastF); lastF = t; if (running) { raf(); } }); })();
      var t0 = performance.now(), tickCost = [];
      await new Promise(function (done) {
        var iv = setInterval(function () {
          var pos = performance.now() - t0;
          var a = performance.now();
          r.tick(pos, true);
          tickCost.push(performance.now() - a);
          maxLive = Math.max(maxLive, r.stats().live);
          if (pos > 30000) { clearInterval(iv); done(); }
        }, 250);
      });
      running = false;
      /* Pause holds, seek clears, off clears. */
      r.pause(true);
      var before = r.stats().live;
      await new Promise(function (d) { setTimeout(d, 600); });
      var nodes = box.querySelectorAll(".dm"), xs = [];
      for (var k = 0; k < Math.min(3, nodes.length); k++) { xs.push(nodes[k].getBoundingClientRect().left); }
      await new Promise(function (d) { setTimeout(d, 400); });
      var still = true;
      for (k = 0; k < xs.length; k++) { if (Math.abs(nodes[k].getBoundingClientRect().left - xs[k]) > 0.5) { still = false; } }
      r.pause(false);
      r.tick(5000, true);   // a seek back 25 s
      var afterSeek = r.stats().live;
      r.density("off");
      var afterOff = r.stats().live;
      frames.sort(function (a, b) { return a - b; });
      tickCost.sort(function (a, b) { return a - b; });
      return {
        maxLive: maxLive, frames: frames.length,
        p50: frames[Math.floor(frames.length * 0.5)], p95: frames[Math.floor(frames.length * 0.95)], max: frames[frames.length - 1],
        long: longTasks, tickP95: tickCost[Math.floor(tickCost.length * 0.95)], tickMax: tickCost[tickCost.length - 1],
        pausedLive: before, still: still, afterSeek: afterSeek, afterOff: afterOff, stats: r.stats()
      };
    });
    console.log("  30 秒、750 条、high：同屏最多 " + res.maxLive + " 条；帧间隔 p50 " + res.p50.toFixed(1) + "ms p95 " + res.p95.toFixed(1) +
                "ms 最长 " + res.max.toFixed(1) + "ms（" + res.frames + " 帧）；tick p95 " + res.tickP95.toFixed(2) + "ms 最长 " + res.tickMax.toFixed(2) +
                "ms；长任务 " + (res.long.length ? res.long.join(",") + "ms" : "无"));
    check(res.maxLive > 10, "同屏真的有弹幕（" + res.maxLive + "）");
    check(res.still && res.pausedLive > 0, "暂停时停住不清（" + res.pausedLive + " 条没动）");
    check(res.afterSeek === 0 && res.afterOff === 0, "跳转清屏、关掉清屏");

    /* Looks: a fresh run, screenshot mid-burst, normal density. */
    await page.evaluate(() => new Promise(done => {
      var box = document.getElementById("danmaku"), list = [];
      var words = ["哈哈哈哈", "前方高能", "这也太好看了吧", "awsl", "名场面来了", "有一说一，这段剪辑真的绝", "UP 主辛苦了", "好家伙", "妙啊", "泪目"];
      for (var i = 0; i < 200; i++) list.push({ t: i * 60, mode: i % 17 === 0 ? 5 : i % 19 === 0 ? 4 : 1, size: 25, color: i % 7 === 0 ? "#fe0302" : "#ffffff", text: words[i % words.length], weight: 10 });
      var r = window.__r = Danmaku.renderer(box);
      r.set(list); r.density("normal");
      var t0 = performance.now();
      var iv = setInterval(function () { var p = performance.now() - t0; r.tick(p, true); if (p > 5000) { clearInterval(iv); done(); } }, 250);
    }));
    const shot = path.join(shots, "danmaku-normal.png");
    await page.screenshot({ path: shot });
    console.log("  截图 " + shot);
  } finally {
    await browser.close();
    dev.kill();
  }
}
