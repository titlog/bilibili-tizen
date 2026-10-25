/* A stand-in for the diagnostics endpoint on this machine: server/diag-worker.mjs
 * itself, on :8097 over node:sqlite, printing each upload as it lands. For
 * `zsh tools/deploy.sh --diag` (which points the build here) and for trying
 * tools/diag-logs.mjs without touching the real one:
 *
 *   node tools/diag-local.mjs
 *   BILI_DIAG_URL=http://localhost:8097 BILI_DIAG_TOKEN=local node tools/diag-logs.mjs
 *
 * In memory: stopping it forgets everything.
 *
 * FAIL=404 node tools/diag-local.mjs refuses every upload with that status, as
 * the real hostname did for eight hours on 10-25 — to stage a missed upload
 * that the next start sends again (diag.js, retryMissed). */
import http from "node:http";
import { d1 } from "./d1-sqlite.mjs";

const worker = (await import("../server/diag-worker.mjs")).default;
const PORT = Number(process.env.PORT || 8097);
const env = { DB: d1(), READ_TOKEN: "local" };
const FAIL = Number(process.env.FAIL || 0);

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request("http://" + (req.headers.host || "localhost") + req.url, {
    method: req.method, headers: req.headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });
  const staged = FAIL && req.url.startsWith("/v1/upload") && req.method === "POST";
  const response = staged
    ? new Response(JSON.stringify({ error: "staged" }), { status: FAIL, headers: { "Content-Type": "application/json" } })
    : await worker.fetch(request, env);
  const text = await response.text();
  if (req.url.startsWith("/v1/upload") && req.method === "POST") {
    let d = {}; try { d = JSON.parse(body.toString("utf8")); } catch (e) {}
    console.log(`${new Date().toTimeString().slice(0, 8)}  ${response.status} ${text}  ${d.app || "?"} ${d.device || "?"} ` +
      `${d.running || "?"}（装的 ${d.version || "?"}）${d.manual ? " 手动" : ""}  ${(d.lines || []).length} 行  ${d.reason || ""}`);
  }
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(text);
}).listen(PORT, () => console.log(`diag stand-in on :${PORT}（读取令牌 local）`));
