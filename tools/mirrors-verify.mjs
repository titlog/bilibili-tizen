/* Check the mirror ordering in app/js/api.js against a canned playurl payload.
 *
 * The single most expensive line in this file's history was one that *dropped*
 * a mirror: `upos-sz-mirrorcosov` answered 403 on everything 2026-08-02, so it
 * was discarded — and on 2026-08-03 the primary spent an evening cutting
 * connections while cosov served fine, and the client had no second host to
 * fail over to. The rule this pins: mirrors are ordered, never dropped, and
 * the order is primaries → cosov → PCDN (mcdn/szbdyd) → http twins (AVPlay
 * only). A regression here does not throw anywhere; it plays fine for weeks
 * and then walls a video on the first bad CDN evening.
 *
 *   node tools/mirrors-verify.mjs
 */
import fs from "fs";
import vm from "vm";

const src = fs.readFileSync(new URL("../app/js/api.js", import.meta.url).pathname, "utf8");

/* A fake transport: getJson opens a URL and reads status/responseText. The
 * canned payload plays the part of bilibili's answer. */
let cannedBody = "";
class FakeXHR {
  open(method, url) { this.url = url; }
  setRequestHeader() {}
  send() {
    this.readyState = 4;
    this.status = 200;
    this.responseText = cannedBody;
    if (this.onreadystatechange) this.onreadystatechange();
  }
}

const sandbox = { String, Number, Array, Object, JSON, Math, Date, parseInt,
                  XMLHttpRequest: FakeXHR, encodeURIComponent, decodeURIComponent };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const API = sandbox.API;

let failed = 0, checks = 0;
function eq(label, got, want) {
  checks++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { console.log(`✗ ${label}: got ${g} want ${w}`); failed++; }
}

const AKAM = "https://upos-hz-mirrorakam.akamaized.net/upgcxcode/a.m4s?upsig=1&deadline=1785781900";
const COSOV = "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/a.m4s?upsig=1";
const MCDN = "https://xy123x.mcdn.bilivideo.cn:4483/upgcxcode/a.m4s?upsig=1";

function payload(data) { return JSON.stringify({ code: 0, data }); }

/* ---- DASH: cosov kept, ordered second, PCDN last, no http twins ---- */
cannedBody = payload({
  accept_quality: [80, 64],
  dash: {
    duration: 100,
    video: [{ id: 80, codecs: "avc1.640032", bandwidth: 1,
              baseUrl: MCDN, backupUrl: [AKAM, COSOV],
              SegmentBase: { Initialization: "0-1", indexRange: "2-3" } }],
    audio: [{ id: 30232, codecs: "mp4a.40.2", bandwidth: 1,
              baseUrl: AKAM, backupUrl: [COSOV],
              SegmentBase: { Initialization: "0-1", indexRange: "2-3" } }],
  },
});
API.playurlDash("BV1", 1, 80, (dash) => {
  eq("dash: PCDN primary is demoted, cosov kept second",
     dash.video[0].urls, [AKAM, COSOV, MCDN]);
  eq("dash: baseUrl follows the reordering", dash.video[0].baseUrl, AKAM);
  eq("dash: audio keeps cosov too", dash.audio[0].urls, [AKAM, COSOV]);
  /* The restart paths judge reusability by these two stamps; absent, a kept
   * response would be trusted forever and a long pause ends in an exit. */
  eq("dash: deadline parsed from the url", dash.deadline, 1785781900);
  eq("dash: fetch time stamped", typeof dash.fetchedAt, "number");
}, (why) => { eq("dash normalisation succeeds", why, "(no failure)"); });

/* ---- cosov alone survives: ordered is not dropped ---- */
cannedBody = payload({
  accept_quality: [80],
  dash: {
    duration: 100,
    video: [{ id: 80, codecs: "avc1.640032", bandwidth: 1,
              baseUrl: COSOV, backupUrl: [],
              SegmentBase: { Initialization: "0-1", indexRange: "2-3" } }],
    audio: [{ id: 30232, codecs: "mp4a.40.2", bandwidth: 1,
              baseUrl: COSOV,
              SegmentBase: { Initialization: "0-1", indexRange: "2-3" } }],
  },
});
API.playurlDash("BV1", 1, 80, (dash) => {
  eq("dash: cosov alone is still a url", dash.video[0].urls, [COSOV]);
}, (why) => { eq("dash cosov-only normalisation succeeds", why, "(no failure)"); });

/* ---- progressive: same ordering, plus http twins for AVPlay, twins last ---- */
cannedBody = payload({
  quality: 64, accept_quality: [64, 16],
  durl: [{ url: AKAM, backup_url: [COSOV] }],
});
API.playurlProgressive("BV1", 1, 64, (prog) => {
  eq("progressive: https first, cosov second, twins after — in the same order",
     prog.urls, [AKAM, COSOV,
                 "http://" + AKAM.slice(8), "http://" + COSOV.slice(8)]);
}, (why) => { eq("progressive normalisation succeeds", why, "(no failure)"); });

if (failed) { console.log(`\n${failed} of ${checks} checks failed`); process.exit(1); }
console.log(`✓ mirrors: ordered, never dropped — ${checks} checks`);
