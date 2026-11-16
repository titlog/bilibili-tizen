import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

let body = "", requested = "";
class FakeXHR {
  open(method, url) { requested = url; }
  setRequestHeader() {}
  send() { this.readyState = 4; this.status = 200; this.responseText = body; this.onreadystatechange(); }
}
const ctx = vm.createContext({ XMLHttpRequest: FakeXHR, encodeURIComponent, decodeURIComponent });
for (const name of ["pgc", "api", "episode-nav"]) {
  vm.runInContext(fs.readFileSync(new URL(`../app/js/${name}.js`, import.meta.url), "utf8"), ctx);
}
const plain = (v) => JSON.parse(JSON.stringify(v));
const { API, PGC, EpisodeNav } = ctx;
const response = (data, result = false) => { body = JSON.stringify({ code: 0, [result ? "result" : "data"]: data }); };
response({ result: [
  { result_type: "media_bangumi", data: [{ season_id: 1733, title: '<em class="keyword">小黑</em>', cover: "http://i0.hdslb.com/bfs/bangumi/x.jpg",
    media_score: { score: 9.9, user_count: 20 }, ep_size: 2, index_show: "更新至第2话",
    eps: [{ id: 1, title: "1", badges: [{ text: "会员" }] }] }] },
  { result_type: "media_ft", data: [{ pgc_season_id: 42, title: "电影" }] },
  { result_type: "video", data: [] },
] });
API.search("test", 1, (videos, media) => {
  assert.equal(videos.length, 0); assert.equal(media.length, 2);
  assert.equal(media[0].title, "小黑"); assert.equal(media[0].episodes[0].badge, "会员");
  assert.equal(media[1].seasonId, 42);
  /* Posters through thumb(): https, sized to .pgc-cover. */
  assert.match(media[0].pic, /^https:\/\/i0\.hdslb\.com\/bfs\/bangumi\/x\.jpg@205w_275h_1c\./);
  assert.equal(media[1].pic, "");
}, assert.fail);
assert.match(requested, /\/x\/web-interface\/search\/all\/v2\?/);
response({ season_id: 1733, title: "番剧", rating: { score: 9.9 }, payment: { tip: "大会员" },
  episodes: [{ id: 1, bvid: "BV1", cid: 1 }, { ep_id: 2, bvid: "BV1", cid: 2 }],
  section: [{ title: "花絮", episodes: [{ id: 3 }] }], seasons: [{ season_id: 42, season_title: "电影" }] }, true);
let season;
API.pgcSeason(1733, false, (s) => { season = s; }, assert.fail);
assert.match(requested, /\/pgc\/view\/web\/season\?season_id=1733/);
assert.equal(season.sections[0].episodes[0].epId, 3);
assert.equal(season.seasons[0].seasonId, 42);
assert.deepEqual(plain(EpisodeNav.adjacent({ epId: 1, bvid: "BV1", season }, 1, 1)),
  { kind: "season", cid: 2, index: 1 });
assert.equal(EpisodeNav.adjacent({ epId: 2, bvid: "BV1", season }, 2, 1), null);
assert.deepEqual(plain(PGC.redirect("https://www.bilibili.com/bangumi/play/ep32374?x=1")), { kind: "ep", id: 32374 });
assert.deepEqual(plain(PGC.redirect("https://www.bilibili.com/bangumi/play/ss28198")), { kind: "ss", id: 28198 });
assert.equal(PGC.redirect("https://example.com/video/BV1"), null);
response({ is_preview: 1, type: "MP4", durls: [{ durl: [] }] }, true);
API.playurlDash("BV1", 1, 127, assert.fail, (why) => assert.equal(why, "会员专享"), 2);
assert.match(requested, /\/pgc\/player\/web\/playurl\?ep_id=2&cid=1/);
/* The same fnval as an ordinary upload at this qn (DASH + AV1 + 4K): HDR,
 * Dolby Vision and 8K stay unasked here too. ep 32374 answers DASH to it. */
assert.match(requested, /[?&]fnval=2192&/);
ctx.Auth = { isLoggedIn: () => true, accessKey: () => "fixture-key", signTv: () => "access_key=fixture-key",
  cookieHeader: () => "", jarIsOurs: () => false };
API.playurlDash("BV1", 1, 127, assert.fail, (why) => assert.equal(why, "会员专享"), 2);
assert.match(requested, /[?&]access_key=fixture-key/);
delete ctx.Auth;
response({ is_preview: 0, accept_quality: [80], dash: { video: [], audio: [] } }, true);
API.playurlDash("BV1", 1, 127, (dash) => assert.equal(dash.acceptQuality[0], 80), assert.fail, 1);
response({ season: [{ season_id: 42, title: "电影", rating: { score: 9 }, new_ep: { index_show: "全1话" } }] });
API.pgcRelated(1733, (items) => { assert.equal(items[0].seasonId, 42); }, assert.fail);
assert.match(requested, /\/pgc\/season\/web\/related\/recommend\?season_id=1733/);
console.log("  ✓ 番剧响应、试看拒播、跳转、正片顺序与推荐端点");

/* Exercise the real search painter and redirect dispatch without exposing test
 * hooks in the app. The fake nodes are built from the painter's own HTML. */
const appSource = fs.readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
const anchor = "    window.onload = function () {";
assert.equal(appSource.split(anchor).length, 2);
const hooked = appSource.replace(anchor, `
    window.pgcTest = {
        search: function (media) { state.searchMedia = media; state.results = []; paintResults([]); },
        playVideo: playVideo,
        startPgc: playPgc,
        setPlay: function (fn) { play = fn; },
        setPgc: function (fn) { playPgc = fn; },
        dash: playDetailDash,
        prefetch: prefetchCard,
        fold: foldList,
        next: nextUp,
        merge: mergeHistory,
        setPlaying: function (s) { playing = s; },
        setScreenEl: function (e) { screenEl = e; },
        setFailOut: function (fn) { failOut = fn; },
        setToast: function (fn) { toast = fn; },
        setAskLogin: function (fn) { askLogin = fn; }
    };
` + anchor);
let html = "", focused, dispatched, cachedNodes;
const results = {
  set innerHTML(v) { html = v; cachedNodes = null; }, get innerHTML() { return html; },
  querySelectorAll(sel) {
    if (sel !== ".pgc-watch, .pgc-range, .pgc-episode") return [];
    if (cachedNodes) return cachedNodes;
    cachedNodes = [...html.matchAll(/<div class="([^"]*pgc-(?:watch|range|episode)[^"]*)" ([^>]*)>/g)].map((m) => {
      const attrs = Object.fromEntries([...m[2].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
      return { className: m[1], getAttribute: (k) => attrs[k] ?? null };
    });
    return cachedNodes;
  },
  querySelector(sel) { return this.querySelectorAll(".pgc-watch, .pgc-range, .pgc-episode").find((n) =>
    sel === ".focusable" || (sel.includes("pgc-episode") && n.className.includes("pgc-episode"))); },
};
const nodes = { results, shell: { className: "" }, "loading-title": {}, "loading-status": {}, "player-loading": {} };
const appCtx = vm.createContext({ window: {}, document: { getElementById: (id) => nodes[id], addEventListener() {}, body: {} },
  Date, Math, JSON, String, Number, Array, Object, RegExp, parseInt, parseFloat, isFinite, setTimeout, clearTimeout,
  Nav: { onKey() {}, onBack() {}, current: () => null, focus: (n) => { focused = n; } },
  Player: { on() {} }, Settings: { get: () => 3 }, PGC, EpisodeNav, API: { view: (bvid, ok) => ok({ redirect: "https://www.bilibili.com/bangumi/play/ep32374" }, "fixture") },
  Auth: { isLoggedIn: () => true }, Diag: { record() {}, priv: (v) => v, plain: (v) => v, incident() {} }, REPORT_TO: "" });
vm.runInContext(hooked, appCtx);
const T = appCtx.window.pgcTest;
T.setScreenEl({ querySelector: () => null });
T.setPgc((ep, ss) => { dispatched = [ep, ss]; });
const many = { seasonId: 9, title: "测试", pic: "", score: 9, indexShow: "全51话", badges: [], desc: "",
  episodes: Array.from({ length: 51 }, (_, i) => ({ epId: i + 1, title: String(i + 1), badge: i === 50 ? "会员" : "" })) };
assert.deepEqual(plain(EpisodeNav.ranges(101, 50)), [{ start: 0, end: 50 }, { start: 50, end: 100 }, { start: 100, end: 101 }]);
const fifty = { ...many, episodes: many.episodes.slice(0, 50) };
T.search([fifty]);
assert.doesNotMatch(html, /pgc-range/);
assert.equal((html.match(/class="opt focusable pgc-episode"/g) || []).length, 50);
T.search([many]);
assert.match(html, /1–50/); assert.match(html, /51–51/);
assert.equal((html.match(/class="opt focusable pgc-episode"/g) || []).length, 50);
let controls = results.querySelectorAll(".pgc-watch, .pgc-range, .pgc-episode");
controls.find((n) => n.getAttribute("data-range") === "1").onselect();
assert.match(html, /51 · 会员/); assert.equal(focused.getAttribute("data-episode"), "50");
controls = results.querySelectorAll(".pgc-watch, .pgc-range, .pgc-episode");
// Selecting a search episode calls the PGC entry point.
appCtx.Resume = { recent: () => [] };
controls.find((n) => n.getAttribute("data-episode") === "50").onselect();
assert.deepEqual(dispatched, [51, 9]);
T.playVideo({ bvid: "BV1", title: "test" }, true);
assert.deepEqual(dispatched, [32374, 0], "view redirect dispatches to episode entry");
appCtx.API.view = (bvid, ok) => ok({ redirect: "https://www.bilibili.com/bangumi/play/ss28198" });
T.playVideo({ bvid: "BV1", title: "test" }, true);
assert.deepEqual(dispatched, [0, 28198], "season redirect dispatches to season entry");
T.playVideo({ bvid: "BV1", cid: 101, epId: 7, seasonId: 9, progressMs: 65000 }, true);
assert.deepEqual(dispatched, [7, 9], "history episode goes straight to its PGC entry");
T.prefetch({ epId: 2, bvid: "BV1", cid: 1 }, true);
T.prefetch({ seasonId: 9, bvid: "BV1", cid: 1 }, true);


// Opening a searched season resolves its episode identities and resumes the
// most recent locally resumable episode. Explicit selections keep their ep_id.
appCtx.API = API;
let started;
T.setPlay((detail, cid) => { started = { detail, cid }; });
appCtx.Resume = { recent: () => [{ bvid: "BV2" }], positionMs: (bvid) => bvid === "BV2" ? 30000 : 0 };
response({ season_id: 9, title: "番剧", episodes: [
  { id: 1, bvid: "BV1", cid: 101 }, { id: 2, bvid: "BV2", cid: 102 }
], section: [], payment: { tip: "会员专享" } }, true);
T.startPgc(0, 9, {});
assert.equal(started.detail.epId, 2); assert.equal(started.cid, 102);
T.startPgc(1, 9, {});
assert.equal(started.detail.epId, 1); assert.equal(started.detail.seasonId, 9);

// A successful PGC playurl response containing only a preview is refused on
// every call through the shared startup/refetch entry.
appCtx.API = API;
let refused = 0, message = "";
T.setFailOut(() => { refused++; });
T.setToast((text) => { message = text; });
const session = { detail: { bvid: "BV1", epId: 2, paymentTip: "大会员专享观看特权哦~" } };
T.setPlaying(session);
for (const path of ["startup", "dash fallback", "deadline", "restart"]) {
  response({ is_preview: 1, durls: [{ durl: [] }] }, true);
  T.dash(session.detail, 1, 127, () => assert.fail(path), () => assert.fail(path));
  assert.match(requested, /\/pgc\/player\/web\/playurl\?ep_id=2/);
}
assert.equal(refused, 4);
assert.equal(message, "大会员专享观看特权哦~");
appCtx.Auth.isLoggedIn = () => false;
T.setAskLogin((text) => { message = text; });
response({ is_preview: 1 }, true);
T.dash(session.detail, 1, 127, () => assert.fail("preview"), () => assert.fail("preview"));
assert.match(message, /大会员专享.*我的.*扫码登录/);
assert.equal(refused, 5);
appCtx.Auth.isLoggedIn = () => true;
body = JSON.stringify({ code: -10403, message: "抱歉您所在地区不可观看！" });
T.dash(session.detail, 1, 127, () => assert.fail("region"), () => assert.fail("region"));
assert.equal(message, "B 站说：抱歉您所在地区不可观看！");
assert.equal(refused, 6);

const panelSeason = { seasonId: 9, title: "番剧", episodes: Array.from({length: 51}, (_, i) =>
  ({epId: i + 1, bvid: "BV" + (i + 1), cid: i + 1, title: String(i + 1), badge: i === 1 ? "会员" : ""})), sections: [], seasons: [] };
const panelDetail = { epId: 1, bvid: "BV1", cid: 1, season: panelSeason, pages: [{cid: 1}] };
T.setPlaying({ detail: panelDetail, cid: 1 });
const fold = T.fold("season");
assert.equal(fold.count, 51); assert.equal(fold.name, "正片"); assert.match(fold.label(1), /会员/);
let next;
T.next((n) => { next = n; });
assert.equal(next.detail.epId, 2); assert.equal(next.cid, 2);
assert.deepEqual(plain(EpisodeNav.ranges(fold.count, 50)), [{start: 0, end: 50}, {start: 50, end: 51}]);

const storage = {};
const resumeCtx = vm.createContext({ Accounts: { scope: (k) => k }, localStorage: {
  getItem: (k) => storage[k] || null, setItem: (k, v) => { storage[k] = v; }
}, setInterval: () => {}, Date, JSON, Math, Number });
vm.runInContext(fs.readFileSync(new URL("../app/js/resume.js", import.meta.url), "utf8"), resumeCtx);
const R = resumeCtx.Resume;
R.record("BV1", 1, 60000, 600000, {bvid: "BV1", cid: 1, epId: 11, seasonId: 9});
R.record("BV1", 2, 90000, 600000, {bvid: "BV1", cid: 2, epId: 12, seasonId: 9});
assert.equal(R.positionMs("BV1", 1, 11), 60000);
assert.equal(R.positionMs("BV1", 2, 12), 90000);
assert.equal(R.recent(10).length, 2);
assert.equal(R.fraction("BV1", 11), 0.1); assert.equal(R.fraction("BV1", 12), 0.15);
appCtx.Resume = R;
const merged = T.merge(R.recent(10), [{bvid: "BV1", cid: 2, progressMs: 95000, at: Date.now() + 1}]);
assert.equal(merged.length, 2); assert.equal(merged[0].epId, 12); assert.equal(merged[0].seasonId, 9);
assert.equal(merged[0].progressMs, 95000);


// All four production DASH call sites share the wrapper; prefetched UGC data is
// explicitly excluded once the episode identity is known.
assert.equal((appSource.match(/playDetailDash\(/g) || []).length, 5);
assert.equal((appSource.match(/API\.playurlDash\(/g) || []).length, 2);
assert.match(appSource, /detail\.epId \? null : takePrefetch/);
assert.match(appSource, /v\.epId \|\| v\.seasonId/);
assert.match(appSource, /redirected\.kind === "ss" \? redirected\.id : 0/);
assert.match(appSource, /pgcRedirect\.kind === "ss" \? pgcRedirect\.id : 0/);
assert.match(appSource, /d\.epId \? API\.pgcRelated : API\.related/);
assert.match(appSource, /if \(detail\.epId\) \{ fail\("番剧仅使用 DASH"\)/);
assert.match(appSource, /!playing\.detail\.epId && !playing\.triedStrong/);
assert.match(appSource, /playing\.detail\.epId \|\| playing\.route/);
const site = (start, end) => appSource.slice(appSource.indexOf(start), appSource.indexOf(end, appSource.indexOf(start)));
assert.match(site("function askStreams(fresh)", "askStreams(false)"), /playDetailDash\(detail, cid/);
assert.match(site("function downgrade(", "function videoTag("), /playDetailDash\(d, cid/);
assert.match(site("var webExp = function", "if (wantStrong)"), /playDetailDash\(sessExp\.detail, sessExp\.cid/);
assert.match(site("var session3 = playing", "} else if (playing.urls"), /playDetailDash\(playing\.detail, playing\.cid/);

/* Ordinary cards that carry a cid start without a view() round trip (the
 * reason that path exists); 番剧 episodes among them are found by the view()
 * behind the video. Asking first cost every 推荐 card the round trip. */
const openCard = site("function playVideo(", "var token = newView();");
assert.match(openCard, /if \(v\.cid\) \{[\s\S]*play\(provisional, resumeCid\(provisional\)\);\s*return;/);
assert.match(site("function loadMetaForPlaying(", "absorbMeta(session, full);"), /PGC\.redirect\(full && full\.redirect\)[\s\S]*playPgc\([^;]*, d, true\);/);
/* Switched while playing: no loading screen to cancel over a video still
 * going, the PGC start carries the position, a failed season plays on. */
const pgcStart = site("function playPgc(", "function pgcEpisodeDetail(");
assert.match(pgcStart, /if \(!keep\) \{ showOpening\(/);
assert.match(pgcStart, /play\(pgcEpisodeDetail\(season, chosen\), chosen\.cid, at, Player\.userPaused\(\)\)/);
assert.match(pgcStart, /if \(keep\) \{ report\("player", "番剧信息没拿到，继续按普通稿件放：" \+ why\); return; \}/);

console.log("  ✓ 搜索折段、选集与普通入口跳转；播放重取共用番剧端点；带 cid 的卡片不先问 view、转番剧时接着放");
