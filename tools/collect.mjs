/* Results collector for spike runs.
 *
 * The TV cannot be read over dlog (Samsung closes it on retail sets), so the app
 * posts each finished test here instead. Run this in one terminal, deploy in
 * another, press the centre button once, and the whole run lands as text.
 *
 *   node tools/collect.mjs
 */
import http from "http";

const PORT = 8099;
const NAMES = {
  1: "raw range request",
  2: "AVPlay progressive",
  3: "HTML5 video tag",
  4: "bilibili API from TV",
  5: "DASH via built MPD",
};

function stamp() {
  return new Date().toTimeString().slice(0, 8);
}

const server = http.createServer((req, res) => {
  /* The widget is a null origin, so answer the preflight permissively. */
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
  if (req.method !== "POST") { res.writeHead(200).end("collector up"); return; }

  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    res.writeHead(200).end("ok");
    let msg;
    try { msg = JSON.parse(body); } catch { console.log(stamp(), "unparseable:", body.slice(0, 200)); return; }

    if (msg.event === "verdict") {
      const r = msg.results || {};
      const line = [1, 2, 3, 4, 5]
        .map((n) => `${n}:${r[n] === true ? "PASS" : r[n] === false ? "FAIL" : "—"}`)
        .join("  ");
      console.log(`\n${stamp()}  VERDICT  ${msg.detail}`);
      console.log(`${" ".repeat(10)}${line}\n`);
      return;
    }

    const n = Number(String(msg.event).replace("test", ""));
    const d = msg.detail || {};
    const ok = (msg.results || {})[n];
    const mark = ok === true ? "PASS" : ok === false ? "FAIL" : "????";
    console.log(`${stamp()}  ${mark}  0${n} ${NAMES[n] || ""} — ${d.chip}`);
    if (d.detail && d.detail !== "—") {
      console.log(`${" ".repeat(16)}${d.detail.replace(/&mdash;/g, "-").slice(0, 300)}`);
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`collector listening on 0.0.0.0:${PORT} — waiting for a run…`);
});
