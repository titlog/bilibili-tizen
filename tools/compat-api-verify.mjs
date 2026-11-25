/* Exercise the fork's account-backed read/write routes without a TV or network.
 * The fake transport checks the requests that would leave the device, including
 * the no-credential case where a write must never be sent. */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const src = fs.readFileSync(fileURLToPath(new URL("../app/js/api.js", import.meta.url)), "utf8");
const calls = [];
const replies = [];
const session = { key: "tv-token", csrf: "csrf-token", jar: false };

class FakeXHR {
  constructor() { this.headers = {}; this.readyState = 0; }
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(name, value) { this.headers[name] = value; }
  send(body) {
    calls.push({ method: this.method, url: this.url, body, headers: this.headers });
    const reply = replies.shift();
    assert.ok(reply, `unexpected ${this.method} ${this.url}`);
    this.status = reply.status ?? 200;
    this.responseText = JSON.stringify(reply.body ?? { code: 0, data: {} });
    this.readyState = 4;
    this.onreadystatechange();
  }
}
const Auth = {
  isLoggedIn: () => !!(session.key || session.csrf),
  accessKey: () => session.key,
  csrf: () => session.csrf,
  jarIsOurs: () => session.jar,
  cookieHeader: () => "",
  signTv: (fields) => new URLSearchParams({ ...fields, appkey: "test", sign: "test" }).toString(),
};
const sandbox = { Auth, XMLHttpRequest: FakeXHR, URL, String, Number, Array,
  Object, JSON, Math, Date, RegExp, parseInt, parseFloat, isFinite,
  encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "api.js" });
const API = sandbox.API;

function respond(body, status = 200) { replies.push({ body, status }); }
function take() { const call = calls.shift(); assert.ok(call, "expected HTTP request"); return call; }
function result(run) {
  let got, failure;
  run((...args) => { got = args; }, (why) => { failure = why; });
  assert.equal(failure, undefined, `unexpected failure: ${failure}`);
  assert.ok(got, "success callback was not called");
  return got;
}
function failed(run, pattern) {
  let failure;
  run(() => assert.fail("unexpected success"), (why) => { failure = why; });
  assert.match(failure, pattern);
}
function url(call) { return new URL(call.url); }
function form(call) { return new URLSearchParams(call.body); }

// Read-side failures must not masquerade as an empty personal library.
respond({ code: -101, message: "not logged in" });
failed((ok, fail) => API.favoriteFolders(42, ok, fail), /code -101/);
assert.equal(url(take()).searchParams.get("access_key"), "tv-token");

respond({ code: 0, data: { list: [
  { id: 12, title: "Films", media_count: 3, fav_state: 1 },
  { id: 13, title: "Other", media_count: 0, fav_state: 0 },
] } });
const folders = result((ok, fail) => API.favoriteFolders(42, ok, fail, 99))[0];
assert.equal(folders.length, 2);
assert.equal(folders[0].selected, true);
assert.equal(folders[1].selected, false);
assert.equal(url(take()).searchParams.get("rid"), "99");

respond({ code: 0, data: { replies: [{ rpid: 1 }], page: { count: 41 } } });
let comments = result((ok, fail) => API.comments(99, 2, ok, fail));
assert.equal(comments[0][0].rpid, 1);
assert.equal(comments[1], true);
assert.equal(url(take()).searchParams.get("pn"), "2");
respond({ code: 0, data: { replies: [], page: { count: 20 } } });
comments = result((ok, fail) => API.commentReplies(99, 7, 1, ok, fail));
assert.equal(comments[1], false);
assert.equal(url(take()).searchParams.get("root"), "7");

respond({ code: 0, data: { medias: [
  { id: 99, type: 2, bvid: "BV1", title: "Video", cover: "http://i.example/a.jpg",
    duration: 60, pubtime: 1791849600, upper: { name: "Author", mid: 4 },
    cnt_info: { play: 12000 } },
  { id: 100, type: 12, bvid: "BV2" },
  { id: 101, type: 2, bvid: "BV3", attr: 1 },
], has_more: true } });
const favoritePage = result((ok, fail) => API.favoriteVideos(12, 1, ok, fail));
assert.equal(favoritePage[0].length, 1);
assert.equal(favoritePage[0][0].publishedAt, 1791849600);
assert.equal(favoritePage[1], true);
assert.equal(favoritePage[2], 3); // raw page size, used for pagination
take();

// No auth means no irreversible action leaves the TV.
session.key = ""; session.csrf = ""; session.jar = false;
assert.equal(API.videoActionReady(), false);
const before = calls.length;
failed((ok, fail) => API.videoLike(99, true, ok, fail), /登录凭证/);
failed((ok, fail) => API.videoCoin(99, 1, ok, fail), /登录凭证/);
failed((ok, fail) => API.videoFavorite(99, 12, true, ok, fail), /登录凭证/);
failed((ok, fail) => API.follow(7, true, ok, fail), /登录凭证/);
assert.equal(calls.length, before);

// A TV token takes the app routes. Coin does not opt into an automatic like.
session.key = "tv-token";
assert.equal(API.videoActionReady(), true);
respond({ code: 0, data: {} });
result((ok, fail) => API.videoLike(99, true, ok, fail));
let request = take();
assert.equal(url(request).pathname, "/x/v2/view/like");
assert.equal(form(request).get("like"), "0");
assert.equal(form(request).get("access_key"), "tv-token");
respond({ code: 0, data: {} });
result((ok, fail) => API.videoCoin(99, 2, ok, fail));
request = take();
assert.equal(url(request).pathname, "/x/v2/view/coin/add");
assert.equal(form(request).get("multiply"), "2");
assert.equal(form(request).get("select_like"), "0");
respond({ code: 0, data: {} });
/* The panel's 投币 likes too, as the web page's ticked-by-default box does. */
result((ok, fail) => API.videoCoin(99, 1, ok, fail, true));
request = take();
assert.equal(url(request).pathname, "/x/v2/view/coin/add");
assert.equal(form(request).get("multiply"), "1");
assert.equal(form(request).get("select_like"), "1");
respond({ code: 0, data: {} });
result((ok, fail) => API.videoFavorite(99, 12, false, ok, fail));
request = take();
assert.equal(url(request).pathname, "/medialist/gateway/coll/resource/deal");
assert.equal(form(request).get("del_media_ids"), "12");
assert.equal(form(request).get("add_media_ids"), "");
/* 关注 (2026-10-20): signed with the TV token, act 1 / 2. */
respond({ code: 0, data: {} });
result((ok, fail) => API.follow(7, true, ok, fail));
request = take();
assert.equal(url(request).pathname, "/x/relation/modify");
assert.equal(form(request).get("fid"), "7");
assert.equal(form(request).get("act"), "1");
assert.equal(form(request).get("access_key"), "tv-token");
respond({ code: 22014, message: "已经关注" });
result((ok, fail) => API.follow(7, true, ok, fail));
take();
respond({ code: 0, data: {} });
result((ok, fail) => API.follow(7, false, ok, fail));
request = take();
assert.equal(form(request).get("act"), "2");

// An engine-jar session uses browser + CSRF routes instead of the TV token.
session.key = ""; session.csrf = "csrf-token"; session.jar = true;
respond({ code: 0, data: {} });
result((ok, fail) => API.videoLike(99, false, ok, fail));
request = take();
assert.equal(url(request).pathname, "/x/web-interface/archive/like");
assert.equal(form(request).get("like"), "2");
assert.equal(form(request).get("csrf"), "csrf-token");
respond({ code: 0, data: {} });
result((ok, fail) => API.follow(7, true, ok, fail));
request = take();
assert.equal(url(request).pathname, "/x/relation/modify");
assert.equal(form(request).get("csrf"), "csrf-token");
assert.equal(form(request).get("access_key"), null);

// A stale state read can disagree with the server; the explicit duplicate
// response means the requested final state is already true.
session.key = "tv-token";
respond({ code: 65006, message: "already liked" });
result((ok, fail) => API.videoLike(99, true, ok, fail));
take();

// An account switch must not let a leftover browser CSRF write for another user.
session.key = ""; session.jar = false;
const after = calls.length;
failed((ok, fail) => API.videoFavorite(99, 12, false, ok, fail), /登录凭证/);
assert.equal(calls.length, after);
assert.equal(replies.length, 0);
// Live (issue #7): a room with TS and no fMP4 still plays (AVPlay takes the
// TS); one with neither fails, and says what the room did offer.
function liveRoom(hls) {
  const hosts = [{ host: "https://d1--cn-gotcha104.bilivideo.com", extra: "x=1" },
                 { host: "https://d1--cn-gotcha204.bilivideo.com", extra: "x=2" }];
  return { code: 0, data: { live_status: 1, playurl_info: { playurl: {
    g_qn_desc: [{ qn: 10000, desc: "原画" }, { qn: 250, desc: "超清" }],
    stream: [
      { protocol_name: "http_stream", format: [{ format_name: "flv", codec: [{ codec_name: "avc", current_qn: 10000,
        base_url: "/live/a.flv?", accept_qn: [10000], url_info: [{ host: "https://d1--ov-gotcha105.bilivideo.com", extra: "" }] }] }] },
      { protocol_name: "http_hls", format: hls.map((name) => ({ format_name: name, codec: [{ codec_name: "avc", current_qn: 10000,
        base_url: `/live/${name}.m3u8?`, accept_qn: [10000, 250], url_info: hosts }] })) },
    ] } } } };
}
function liveFails(body) {
  let got;
  respond(body);
  API.livePlay(5, () => assert.fail("a room with nothing to play played"), (why, shape) => { got = { why, shape }; });
  take();
  assert.ok(got, "failure callback was not called");
  return got;
}
respond(liveRoom(["fmp4", "ts"]));
let live = result((ok, fail) => API.livePlay(5, ok, fail))[0];
take();
assert.equal(live.urls[0], "https://d1--cn-gotcha104.bilivideo.com/live/fmp4.m3u8?x=1");
assert.equal(live.tsUrls.length, 2);
respond(liveRoom(["ts"]));
live = result((ok, fail) => API.livePlay(5, ok, fail))[0];
take();
assert.deepEqual(Array.from(live.urls), []);
assert.equal(live.tsUrls[1], "https://d1--cn-gotcha204.bilivideo.com/live/ts.m3u8?x=2");
assert.equal(live.tsQnName, "原画");
assert.deepEqual(Array.from(live.tsAcceptQn), [10000, 250]);
assert.match(live.shape, /http_hls\/ts\(avc qn10000 d1--cn-gotcha104 ×2\)/);
/* Only FLV is still a room: AVPlay plays it (10-24, rooms that offer only 原画). */
respond(liveRoom([]));
live = result((ok, fail) => API.livePlay(5, ok, fail))[0];
take();
assert.deepEqual(Array.from(live.urls), []);
assert.deepEqual(Array.from(live.tsUrls), []);
assert.equal(live.flvUrls[0], "https://d1--ov-gotcha105.bilivideo.com/live/a.flv?");
assert.equal(live.flvQnName, "原画");
let nothing = liveFails({ code: 0, data: { live_status: 1, playurl_info: { playurl: { stream: [] } } } });
assert.equal(nothing.why, "没给电视放得了的流");
assert.equal(nothing.shape, "一路流都没有");
nothing = liveFails({ code: 0, data: { live_status: 1, playurl_info: null } });
assert.equal(nothing.shape, "没有 playurl_info");
/* 11-24, a room a set opened: live, no address at all, special type 1 (付费). */
nothing = liveFails({ code: 0, data: { live_status: 1, all_special_types: [1, 203, 204],
                                       playurl_info: { conf_json: "{}", playurl: null } } });
assert.equal(nothing.why, "付费直播间");
assert.match(nothing.shape, /all_special_types=\[1,203,204\]/);
/* The same empty answer without the mark is still 「没给电视放得了的流」. */
nothing = liveFails({ code: 0, data: { live_status: 1, all_special_types: [203], playurl_info: { playurl: null } } });
assert.equal(nothing.why, "没给电视放得了的流");
/* Codecs this engine cannot decode are not picked (11-18…11-24: rooms whose
 * best tier is AV1, on sets with av01=false). The shape measured from here on a popular room. */
function codecRoom() {
  const c = (name, qn, accept) => ({ codec_name: name, current_qn: qn, base_url: `/live/${name}.m3u8?`, accept_qn: accept,
                                     url_info: [{ host: "https://d1--ov-gotcha207.bilivideo.com", extra: "" }] });
  return { code: 0, data: { live_status: 1, playurl_info: { playurl: {
    g_qn_desc: [{ qn: 10000, desc: "原画" }, { qn: 400, desc: "蓝光" }, { qn: 250, desc: "超清" }],
    stream: [{ protocol_name: "http_hls", format: [{ format_name: "fmp4",
      codec: [c("avc", 250, [10000, 400, 250]), c("hevc", 250, [10000, 400, 250]), c("av1", 400, [10000, 400])] }] }] } } } };
}
sandbox.MediaSource = { isTypeSupported: (t) => !/av01/.test(t) };
respond(codecRoom());
live = result((ok, fail) => API.livePlay(5, ok, fail))[0];
take();
assert.equal(live.codec, "avc");
assert.equal(live.qn, 250);
assert.match(live.shape, /这台电视解不了 av1/);
/* Only AV1, on a set that cannot: nothing to play, and the line says why. */
const onlyAv1 = codecRoom();
const fmp4 = onlyAv1.data.playurl_info.playurl.stream[0].format[0];
fmp4.codec = fmp4.codec.filter((c) => c.codec_name === "av1");
nothing = liveFails(onlyAv1);
assert.equal(nothing.why, "没给电视放得了的流");
assert.match(nothing.shape, /这台电视解不了 av1/);
sandbox.MediaSource = undefined;
assert.equal(replies.length, 0);
console.log("✓ compat API: library, comments, auth boundaries, video writes and live streams");
