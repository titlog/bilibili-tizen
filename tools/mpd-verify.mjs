/* Check app/js/mpd.js against a real playurl payload.
 *
 * An invalid manifest does not throw anywhere useful — the player refuses it
 * and the viewer sees a spinner — so the shape is pinned here. The urls carry
 * `&` in quantity, and one unescaped ampersand makes the whole document
 * malformed, which is the failure most likely to happen and least likely to be
 * obvious.
 *
 *   node tools/mpd-verify.mjs
 */
import fs from "fs";
import vm from "vm";
import { XMLParser, XMLValidator } from "fast-xml-parser";

const src = fs.readFileSync(new URL("../app/js/mpd.js", import.meta.url).pathname, "utf8");
const sandbox = { String, Number, Array };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const Mpd = sandbox.Mpd;

let failed = 0, checks = 0;
function ok(label, cond, detail) {
  checks++;
  if (!cond) { console.log(`✗ ${label}${detail ? " — " + detail : ""}`); failed++; }
}
function eq(label, got, want) {
  checks++;
  if (got !== want) { console.log(`✗ ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); failed++; }
}

/* Shaped like what api.js hands the player, including a url with the query
 * string bilibili really produces. */
const AMPY = "https://upos-hz-mirrorakam.akamaized.net/a.m4s?e=ig8e&deadline=1&os=akam&upsig=abc&uparams=e,deadline,os";
const dash = {
  duration: 1234,
  video: [
    { id: 120, codecs: "avc1.640033", bandwidth: 20000000, width: 3840, height: 2160,
      frameRate: "60", urls: [AMPY, "http://backup.example/a.m4s?x=1&y=2"],
      segments: { init: "0-944", index: "945-3976" } },
    { id: 80, codecs: "avc1.640032", bandwidth: 2997485, width: 1920, height: 1080,
      frameRate: "25", urls: [AMPY], segments: { init: "0-944", index: "945-3976" } },
    { id: 32, codecs: "avc1.640033", bandwidth: 523565, width: 852, height: 480,
      frameRate: "25", urls: [AMPY], segments: { init: "0-916", index: "917-1292" } },
    /* hevc: filtered out, the set decodes avc1 on this path */
    { id: 80, codecs: "hev1.1.6.L120.90", bandwidth: 1500000, width: 1920, height: 1080,
      urls: [AMPY], segments: { init: "0-900", index: "901-1200" } },
    /* no SegmentBase: unusable, must not reach the manifest */
    { id: 64, codecs: "avc1.640032", bandwidth: 1000000, width: 1280, height: 720,
      urls: [AMPY], segments: null },
  ],
  audio: [
    { id: 30232, codecs: "mp4a.40.2", bandwidth: 66227, urls: [AMPY],
      segments: { init: "0-836", index: "837-1212" } },
    { id: 30216, codecs: "mp4a.40.2", bandwidth: 30000, urls: [AMPY],
      segments: { init: "0-800", index: "801-1100" } },
  ],
};

const xml = Mpd.build(dash, 80);

/* Well-formedness first: this is what an unescaped & breaks. */
const valid = XMLValidator.validate(xml);
ok("manifest is well-formed XML", valid === true, JSON.stringify(valid));
ok("no raw ampersand survived escaping", !/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml));

const PARSE = { ignoreAttributes: false, attributeNamePrefix: "@", parseAttributeValue: true };
const doc = new XMLParser(PARSE).parse(xml);
const sets = doc.MPD.Period.AdaptationSet;
const video = sets.find((s) => s["@contentType"] === "video");
const audio = sets.find((s) => s["@contentType"] === "audio");
const vreps = [].concat(video.Representation);
const areps = [].concat(audio.Representation);

eq("duration carried through", doc.MPD["@mediaPresentationDuration"], "PT1234S");
eq("on-demand profile", doc.MPD["@profiles"], "urn:mpeg:dash:profile:isoff-on-demand:2011");

eq("4K is capped out by maxId", vreps.length, 2);
eq("best remaining tier is 1080p", vreps[0]["@id"], 80);
eq("and the ladder descends", vreps[1]["@id"], 32);
/* Without a MediaSource to ask — which is this harness, and any engine too old
 * to have one — only H.264 is assumed. Every other family has to be measured on
 * the set before it is used. */
ok("hevc is excluded when nothing can be asked",
   !vreps.some((r) => String(r["@codecs"]).startsWith("hev")));
eq("and the chosen family says so", Mpd.chosen(), "avc1");
ok("a representation without SegmentBase is excluded",
   !vreps.some((r) => r["@id"] === 64));

eq("audio tiers present", areps.length, 2);
eq("quietest audio first", areps[0]["@id"], 30216);

/* The byte ranges are the whole point: a wrong one is a video that never
 * starts, with nothing in any log. */
eq("indexRange survives", vreps[0].SegmentBase["@indexRange"], "945-3976");
eq("init range survives", vreps[0].SegmentBase.Initialization["@range"], "0-944");
eq("audio indexRange survives", areps[0].SegmentBase["@indexRange"], "801-1100");

/* Mirrors become alternative BaseURLs so failover is the player's job. */
const firstUrls = [].concat(vreps[0].BaseURL);
eq("single mirror yields one BaseURL", firstUrls.length, 1);
ok("the url round-trips unescaped", firstUrls[0] === AMPY, firstUrls[0]);

const capped4k = new XMLParser(PARSE)
  .parse(Mpd.build(dash, 120));
const all = [].concat(capped4k.MPD.Period.AdaptationSet.find((s) => s["@contentType"] === "video").Representation);
eq("raising the cap admits 4K", all.length, 3);
const multi = [].concat(all[0].BaseURL);
eq("backup mirrors become extra BaseURLs", multi.length, 2);

/* Refusals: an empty string is a manifest the player will never be handed. */
eq("no video means no manifest", Mpd.build({ duration: 10, video: [], audio: dash.audio }, 80), "");
eq("no audio means no manifest", Mpd.build({ duration: 10, video: dash.video, audio: [] }, 80), "");
eq("nothing at all means no manifest", Mpd.build(null, 80), "");
eq("a cap below every tier means no manifest", Mpd.build(dash, 1), "");

/* Now with a set that says it decodes H.265 — which the real one does, measured
 * 2026-08-02. The manifest has to switch families wholesale: an AdaptationSet is
 * a set of alternatives a player may swap between mid-stream, and two codecs are
 * not that. */
sandbox.MediaSource = { isTypeSupported: (t) => !/av01/.test(t) };
const hevcDoc = new XMLParser(PARSE).parse(Mpd.build(dash, 80));
const hevcReps = [].concat(
  hevcDoc.MPD.Period.AdaptationSet.find((s) => s["@contentType"] === "video").Representation);
eq("with hevc support the family switches", Mpd.chosen(), "hev1");
ok("and every video representation is hevc",
   hevcReps.every((r) => String(r["@codecs"]).startsWith("hev")));
eq("pinning avc1 overrides the preference", (() => {
  Mpd.build(dash, 80, "avc1"); return Mpd.chosen();
})(), "avc1");

/* A family that cannot reach the tier H.264 reaches is not an improvement:
 * fewer bytes for a smaller picture is a downgrade wearing a disguise. */
const shortHevc = {
  duration: 10, audio: dash.audio,
  video: [
    { id: 80, codecs: "avc1.640032", bandwidth: 3000000, segments: { init: "0-1", index: "2-3" }, baseUrl: AMPY },
    { id: 32, codecs: "hev1.1.6.L120.90", bandwidth: 500000, segments: { init: "0-1", index: "2-3" }, baseUrl: AMPY }
  ]
};
Mpd.build(shortHevc, 80);
eq("a shorter hevc ladder is refused", Mpd.chosen(), "avc1");
sandbox.MediaSource = undefined;

if (failed) { console.log(`\n${failed} of ${checks} checks failed`); process.exit(1); }
console.log(`✓ mpd: well-formed, escaped, laddered and capped — ${checks} checks`);
