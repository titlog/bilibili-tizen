/* 番剧 / 影视 (PGC, 2026-11-16, from PR #19). Runs the real pgc.js, api.js,
 * episode-nav.js and app.js functions in a sandbox against fixture answers:
 *   - search/all/v2's media_bangumi / media_ft groups become pinned shows;
 *   - the PGC playurl refuses a 试看 (is_preview=1) and says why on screen;
 *   - redirect_url → ep / ss; which episode a season opens on;
 *   - the pinned shows' episode ranges, and what selecting one starts;
 *   - 继续观看 keeps a 番剧 episode's ep_id when the account's copy has none.
 * Behaviour only: nothing here matches app.js's source text.
 */
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

/* ---- api.js / pgc.js: shapes and endpoints ---- */
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
/* Two episodes of one bvid: 上一集 / 下一集 go by ep_id, not bvid. */
assert.deepEqual(plain(EpisodeNav.adjacent({ epId: 1, bvid: "BV1", season }, 1, 1)), { kind: "season", cid: 2, index: 1 });
assert.equal(EpisodeNav.adjacent({ epId: 2, bvid: "BV1", season }, 2, 1), null);
assert.deepEqual(plain(EpisodeNav.ranges(101, 50)), [{ start: 0, end: 50 }, { start: 50, end: 100 }, { start: 100, end: 101 }]);

assert.deepEqual(plain(PGC.redirect("https://www.bilibili.com/bangumi/play/ep32374?x=1")), { kind: "ep", id: 32374 });
assert.deepEqual(plain(PGC.redirect("https://www.bilibili.com/bangumi/play/ss28198")), { kind: "ss", id: 28198 });
assert.equal(PGC.redirect("https://example.com/video/BV1"), null);
assert.equal(PGC.redirect(""), null);

/* Signed out, a 会员 episode answers the PGC playurl code 0 with is_preview=1
 * and three minutes of an 818-second episode: refused, never played. */
response({ is_preview: 1, type: "MP4", durls: [{ durl: [] }] }, true);
API.playurlDash("BV1", 1, 127, assert.fail, (why) => assert.equal(why, "会员专享"), 2);
assert.match(requested, /\/pgc\/player\/web\/playurl\?ep_id=2&cid=1/);
/* The same fnval as an ordinary upload at this qn (DASH + AV1 + 4K). */
assert.match(requested, /[?&]fnval=2192&/);
ctx.Auth = { isLoggedIn: () => true, accessKey: () => "fixture-key", signTv: () => "access_key=fixture-key",
  cookieHeader: () => "", jarIsOurs: () => false };
API.playurlDash("BV1", 1, 127, assert.fail, (why) => assert.equal(why, "会员专享"), 2);
assert.match(requested, /[?&]access_key=fixture-key/);
delete ctx.Auth;
response({ is_preview: 0, accept_quality: [80], dash: { video: [], audio: [] } }, true);
API.playurlDash("BV1", 1, 127, (dash) => assert.equal(dash.acceptQuality[0], 80), assert.fail, 1);
/* An episode's manifest has no strong token to trade up to, and says so: the
 * player walked its 403s straight to 「交给 app 端点强令牌」, app.js does not
 * mint one for an episode, and it went out with every lower tier untried
 * (11-21, 11-25). An upload's manifest is not marked. */
let marked;
API.playurlDash("BV1", 1, 127, (dash) => { marked = dash.noStrong; }, assert.fail, 1);
assert.equal(marked, true);
/* Without an ep_id it is the ordinary endpoint, as before. */
API.playurlDash("BV1", 1, 80, (dash) => { marked = dash.noStrong; }, () => {});
assert.match(requested, /\/x\/player\/playurl\?bvid=BV1&cid=1/);
assert.notEqual(marked, true);
/* …and the player declines both strong-token routes for a marked manifest. */
const playerSource = fs.readFileSync(new URL("../app/js/player.js", import.meta.url), "utf8");
const offer = /function offerStrongToken\(known403\) \{([\s\S]*?)\n    \}/.exec(playerSource);
assert.ok(offer && /lastDash\.dash\.noStrong\) \{ return false; \}/.test(offer[1]), "offerStrongToken must decline a noStrong manifest");
const swap = /function canSwapToken\(\) \{([\s\S]*?)\n    \}/.exec(playerSource);
assert.ok(swap && /!lastDash\.dash\.noStrong/.test(swap[1]), "canSwapToken must decline a noStrong manifest");

response({ season: [{ season_id: 42, title: "电影", rating: { score: 9 }, new_ep: { index_show: "全1话" } }] });
API.pgcRelated(1733, (items) => { assert.equal(items[0].seasonId, 42); }, assert.fail);
assert.match(requested, /\/pgc\/season\/web\/related\/recommend\?season_id=1733/);
console.log("  ✓ 番剧响应、试看拒播、跳转、正片顺序与推荐端点");

/* ---- app.js: the real functions, reached through a test hook ---- */
const appSource = fs.readFileSync(new URL("../app/js/app.js", import.meta.url), "utf8");
const anchor = "    window.onload = function () {";
assert.equal(appSource.split(anchor).length, 2, "app.js test hook location changed");
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
/* #results as a fake node: its controls are parsed back out of the HTML the
 * painter writes, so what is selected is what was painted. */
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
const nodes = { results, shell: { className: "" }, "loading-title": {}, "loading-status": {}, "player-loading": {},
  nextup: { className: "hidden" } };
const appCtx = vm.createContext({ window: {}, document: { getElementById: (id) => nodes[id], addEventListener() {}, body: {} },
  Date, Math, JSON, String, Number, Array, Object, RegExp, parseInt, parseFloat, isFinite, setTimeout, clearTimeout,
  HoldSpeed: { create: () => ({ key: () => false, begin() {}, cancel() {}, interrupt() {} }) }, /* hold-speed-verify drives the real one */ 
  Nav: { onKey() {}, onBack() {}, current: () => null, focus: (n) => { focused = n; } },
  Player: { on() {} }, Settings: { get: () => 3 }, PGC, EpisodeNav,
  API: { view: (bvid, ok) => ok({ redirect: "https://www.bilibili.com/bangumi/play/ep32374" }, "fixture") },
  Auth: { isLoggedIn: () => true }, Diag: { record() {}, priv: (v) => v, plain: (v) => v, incident() {} }, REPORT_TO: "" });
vm.runInContext(hooked, appCtx);
const T = appCtx.window.pgcTest;
T.setScreenEl({ querySelector: () => null });
T.setPgc((ep, ss, card) => { dispatched = [ep, ss]; });

/* Pinned shows: up to 50 episodes flat, past that ranges of 50. */
const many = { seasonId: 9, title: "测试", pic: "", score: 9, indexShow: "全51话", badges: [], desc: "",
  episodes: Array.from({ length: 51 }, (_, i) => ({ epId: i + 1, title: String(i + 1), badge: i === 50 ? "会员" : "" })) };
T.search([{ ...many, episodes: many.episodes.slice(0, 50) }]);
assert.doesNotMatch(html, /pgc-range/);
assert.equal((html.match(/class="opt focusable pgc-episode"/g) || []).length, 50);
T.search([many]);
assert.match(html, /1–50/); assert.match(html, /51–51/);
assert.equal((html.match(/class="opt focusable pgc-episode"/g) || []).length, 50);
let controls = results.querySelectorAll(".pgc-watch, .pgc-range, .pgc-episode");
controls.find((n) => n.getAttribute("data-range") === "1").onselect();
assert.match(html, /51 · 会员/); assert.equal(focused.getAttribute("data-episode"), "50");
controls = results.querySelectorAll(".pgc-watch, .pgc-range, .pgc-episode");
appCtx.Resume = { recent: () => [] };
controls.find((n) => n.getAttribute("data-episode") === "50").onselect();
assert.deepEqual(dispatched, [51, 9], "a pinned episode starts that ep_id");
controls.find((n) => n.className.includes("pgc-watch")).onselect();
assert.deepEqual(dispatched, [0, 9], "立即观看 starts the season");

/* Which cards go to PGC. */
T.playVideo({ bvid: "BV1", title: "test" }, true);
assert.deepEqual(dispatched, [32374, 0], "no cid: view's ep redirect");
appCtx.API.view = (bvid, ok) => ok({ redirect: "https://www.bilibili.com/bangumi/play/ss28198" });
T.playVideo({ bvid: "BV1", title: "test" }, true);
assert.deepEqual(dispatched, [0, 28198], "no cid: view's ss redirect");
T.playVideo({ bvid: "BV1", cid: 101, epId: 7, seasonId: 9, progressMs: 65000 }, true);
assert.deepEqual(dispatched, [7, 9], "a 继续观看 card that remembers its ep_id");
/* A card with a cid and no ep_id plays as the upload, without asking view():
 * a 番剧 episode among 推荐 plays the same (ordinary playurl: full DASH for a
 * free episode, -404 for a 会员 one, measured 11-16). */
dispatched = null;
let viewAsked = false, ordinary = null;
appCtx.API.view = () => { viewAsked = true; };
T.setPlay((detail, cid) => { ordinary = { detail, cid }; });
appCtx.Resume = { recent: () => [], positionMs: () => 0, lastPart: () => null };
T.playVideo({ bvid: "BV9", cid: 909, title: "card" }, true);
assert.equal(dispatched, null); assert.equal(viewAsked, false);
assert.equal(ordinary.detail.bvid, "BV9"); assert.equal(ordinary.cid, 909);
/* No UGC prefetch for an episode: its playurl is the PGC one. */
T.prefetch({ epId: 2, bvid: "BV1", cid: 1 }, true);
T.prefetch({ seasonId: 9, bvid: "BV1", cid: 1 }, true);

/* Which episode a season opens on. */
appCtx.API = API;
let started;
T.setPlay((detail, cid) => { started = { detail, cid }; });
const twoEpisodes = () => response({ season_id: 9, title: "番剧", episodes: [
  { id: 1, bvid: "BV1", cid: 101 }, { id: 2, bvid: "BV2", cid: 102 }
], section: [], payment: { tip: "会员专享" } }, true);
appCtx.Resume = { recent: () => [{ bvid: "BV2" }], positionMs: (bvid) => bvid === "BV2" ? 30000 : 0 };
twoEpisodes(); T.startPgc(0, 9, {});
assert.equal(started.detail.epId, 2, "立即观看: the episode watched here last"); assert.equal(started.cid, 102);
twoEpisodes(); T.startPgc(1, 9, {});
assert.equal(started.detail.epId, 1); assert.equal(started.detail.seasonId, 9);
appCtx.Resume = { recent: () => [], positionMs: () => 0 };
twoEpisodes(); T.startPgc(0, 9, { bvid: "BV2", cid: 102 });
assert.equal(started.detail.epId, 2, "an ss… redirect keeps the card's own episode, not the first");
twoEpisodes(); T.startPgc(0, 9, {});
assert.equal(started.detail.epId, 1, "nothing watched: the first episode");

/* A 试看 is refused on every playurl request of the playback (they all go
 * through playDetailDash), and the screen says why. */
let refused = 0, message = "";
T.setFailOut(() => { refused++; });
T.setToast((text) => { message = text; });
const session = { detail: { bvid: "BV1", epId: 2, paymentTip: "大会员专享观看特权哦~" } };
T.setPlaying(session);
response({ is_preview: 1, durls: [{ durl: [] }] }, true);
T.dash(session.detail, 1, 127, () => assert.fail("preview"), () => assert.fail("preview"));
assert.match(requested, /\/pgc\/player\/web\/playurl\?ep_id=2/);
assert.equal(refused, 1); assert.equal(message, "大会员专享观看特权哦~");
appCtx.Auth.isLoggedIn = () => false;
T.setAskLogin((text) => { message = text; });
response({ is_preview: 1 }, true);
T.dash(session.detail, 1, 127, () => assert.fail("preview"), () => assert.fail("preview"));
assert.match(message, /大会员专享.*我的.*扫码登录/);
assert.equal(refused, 2);
appCtx.Auth.isLoggedIn = () => true;
body = JSON.stringify({ code: -10403, message: "抱歉您所在地区不可观看！" });
T.dash(session.detail, 1, 127, () => assert.fail("region"), () => assert.fail("region"));
assert.equal(message, "B 站说：抱歉您所在地区不可观看！");
assert.equal(refused, 3);
/* An ordinary upload's failure is still the caller's to handle. */
let passed = "";
T.setPlaying({ detail: { bvid: "BV1" } });
body = JSON.stringify({ code: -404, message: "啥都木有" });
T.dash({ bvid: "BV1" }, 1, 80, () => assert.fail("ugc"), (why) => { passed = why; });
assert.match(passed, /-404/); assert.equal(refused, 3);

/* The panel's 正片, and 下一集 by it. */
const panelSeason = { seasonId: 9, title: "番剧", episodes: Array.from({ length: 51 }, (_, i) =>
  ({ epId: i + 1, bvid: "BV" + (i + 1), cid: i + 1, title: String(i + 1), badge: i === 1 ? "会员" : "" })), sections: [], seasons: [] };
T.setPlaying({ detail: { epId: 1, bvid: "BV1", cid: 1, season: panelSeason, pages: [{ cid: 1 }] }, cid: 1 });
const fold = T.fold("season");
assert.equal(fold.count, 51); assert.equal(fold.name, "正片"); assert.match(fold.label(1), /会员/);
let next;
T.next((n) => { next = n; });
assert.equal(next.detail.epId, 2); assert.equal(next.cid, 2);
assert.match(next.title, /^正片第 2 集/);
console.log("  ✓ 搜索置顶与折段、哪些卡片走番剧、开哪一集、试看拒播、面板正片");

/* 继续观看: progress stays keyed bvid:cid, the card carries the ep_id. The
 * account's copy of the same part has none; merged, the card keeps it (and
 * so reopens through PGC), whichever side is newer. */
appCtx.Resume = { clearedAt: () => 0, fraction: () => 0 };
const local = [{ bvid: "BV1", cid: 2, epId: 12, seasonId: 9, at: 100, progressMs: 60000 }];
let merged = T.merge(local, [{ bvid: "BV1", cid: 2, aid: 5, progressMs: 95000, at: 200 }]);
assert.equal(merged.length, 1);
assert.equal(merged[0].epId, 12); assert.equal(merged[0].seasonId, 9);
assert.equal(merged[0].progressMs, 95000); assert.equal(merged[0].aid, 5);
/* Another part of the same bvid: the newer side decides, and an ep_id does
 * not cross onto a part it does not name. */
merged = T.merge(local, [{ bvid: "BV1", cid: 3, progressMs: 5000, at: 200 }]);
assert.equal(merged.length, 1); assert.equal(merged[0].cid, 3); assert.equal(merged[0].epId, undefined);
console.log("  ✓ 继续观看保留番剧的 ep_id");
