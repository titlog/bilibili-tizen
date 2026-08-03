/* Run the client in a desktop browser.
 *
 * The app is plain HTML and JS, so most of it runs anywhere — the parts that
 * need the television are AVPlay (progressive playback) and `webapis`, and
 * everything else is browse, search, login, and the DASH path, which is Shaka
 * over MSE and works in any modern browser.
 *
 * Two things stop it from just working off `file://`:
 *
 *   1. CORS. On the TV, `<access origin="*">` in config.xml replaces the browser
 *      CORS model entirely, which is why XHR to bilibili returns real status
 *      codes there. A browser has no such escape, so every API call would fail
 *      opaquely. This proxies them and adds the headers.
 *   2. Credentials. The TV holds its own accounts. Here the session is borrowed
 *      from your desktop Chrome, read out of its cookie store, so the feed and
 *      「我的」 look like they do on the set instead of logged-out.
 *
 * It exists for screenshots and for changing the interface without a deploy
 * cycle — about fifteen seconds each, which adds up when the change is a
 * margin. It is not a substitute for the device: AVPlay, the remote's real key
 * codes, and every timing measurement in CLAUDE.md belong to the television.
 *
 *   node tools/devserver.mjs            # then open http://localhost:8100
 *   node tools/devserver.mjs --no-auth  # logged out, for the login screens
 */
import http from "http";
import https from "https";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "app");
const PORT = Number(process.env.DEV_PORT || 8100);
const NO_AUTH = process.argv.includes("--no-auth");

/* Hosts the app talks to, each mapped onto a path prefix the shim rewrites to.
 * Keep in step with the constants in api.js and auth.js. */
const HOSTS = {
  "/__api/": "api.bilibili.com",
  "/__passport/": "passport.bilibili.com",
  "/__search/": "s.search.bilibili.com",
};

/* ---------------- borrow the desktop browser's session ---------------- */

/* Chrome encrypts cookie values with a key held in the login keychain; reading
 * it prompts once, and only for this process. Failure is not fatal — the app
 * runs logged out, which is exactly what `--no-auth` asks for anyway. */
function chromeCookieHeader() {
  if (NO_AUTH) return "";
  try {
    const script = `
import sqlite3, shutil, subprocess, os, tempfile, sys
from hashlib import pbkdf2_hmac
try: from Crypto.Cipher import AES
except ImportError: from Cryptodome.Cipher import AES
db = os.path.expanduser("~/Library/Application Support/Google/Chrome/Default/Cookies")
pw = subprocess.check_output(["security","find-generic-password","-w","-s","Chrome Safe Storage"]).strip()
key = pbkdf2_hmac("sha1", pw, b"saltysalt", 1003, 16)
tmp = tempfile.mktemp(); shutil.copy(db, tmp)
rows = sqlite3.connect(tmp).execute(
    "select name, encrypted_value from cookies where host_key like '%bilibili.com'").fetchall()
os.unlink(tmp)
out = []
for name, enc in rows:
    if enc[:3] not in (b"v10", b"v11"): continue
    d = AES.new(key, AES.MODE_CBC, b" "*16).decrypt(enc[3:])
    d = d[:-d[-1]]
    d = d[32:] if len(d) > 32 else d
    out.append("%s=%s" % (name, d.decode("utf-8","replace")))
print("; ".join(out))
`;
    const header = execFileSync("python3", ["-c", script], { encoding: "utf8" }).trim();
    const names = header.split(";").map((c) => c.trim().split("=")[0]);
    console.log(`[dev] borrowed ${names.length} cookies from Chrome` +
                (names.includes("SESSDATA") ? " (signed in)" : " (no SESSDATA — logged out)"));
    return header;
  } catch (e) {
    console.log("[dev] no Chrome cookies (" + String(e.message).split("\n")[0] + ") — running logged out");
    return "";
  }
}
const COOKIE = chromeCookieHeader();

/* ---------------- the shim ---------------- */

/* Injected ahead of every other script. It rewrites the absolute bilibili URLs
 * the app builds, rather than the app being changed to know about this file —
 * the client must stay exactly what ships to the television. */
const SHIM = `<script>
(function () {
  var MAP = ${JSON.stringify(Object.entries(HOSTS).map(([p, h]) => [h, p]))};
  function rewrite(u) {
    if (typeof u !== "string") return u;
    for (var i = 0; i < MAP.length; i++) {
      var host = MAP[i][0], prefix = MAP[i][1];
      var at = u.indexOf("https://" + host + "/");
      if (at === 0) return prefix + u.slice(("https://" + host + "/").length);
    }
    return u;
  }
  var open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) {
    arguments[1] = rewrite(u);
    return open.apply(this, arguments);
  };
  var f = window.fetch;
  if (f) { window.fetch = function (u, o) { return f.call(this, rewrite(u), o); }; }

  /* AVPlay does not exist here. Progressive playback is the one route that
   * cannot run in a browser, so it is stubbed to fail immediately and let the
   * player fall through to DASH — the route this app uses most anyway. */
  window.webapis = window.webapis || { avplay: new Proxy({}, { get: function () {
    return function () { throw new Error("AVPlay is TV-only; use the DASH route"); };
  } }) };
  window.tizen = window.tizen || undefined;

  /* The remote's keys, on a keyboard. Arrow keys and Enter already match;
   * these are the ones a desktop has no equivalent for. */
  window.addEventListener("keydown", function (e) {
    if (e.key === "Backspace" || e.key === "Escape") {
      var ev = new KeyboardEvent("keydown", { keyCode: 10009, bubbles: true });
      window.dispatchEvent(ev); e.preventDefault();
    }
  });
  console.log("[dev shim] bilibili hosts proxied; AVPlay stubbed; Backspace = 返回");
})();
</script>
`;

/* ---------------- server ---------------- */

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".json": "application/json" };

function proxy(req, res, host, rest) {
  const headers = {
    /* The same shape the TV sends: a browser-ish UA and no Referer. bilibili
     * 403s `curl/*` agents and rejects a Referer it does not recognise, while
     * accepting none at all — see CLAUDE.md. */
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "*/*",
  };
  if (COOKIE) headers.Cookie = COOKIE;
  const up = https.request({ host, path: "/" + rest, method: req.method, headers }, (r) => {
    res.writeHead(r.statusCode, {
      "Content-Type": r.headers["content-type"] || "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    r.pipe(res);
  });
  up.on("error", (e) => { res.writeHead(502).end(JSON.stringify({ code: -1, message: e.message })); });
  req.pipe(up);
}

http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  for (const [prefix, host] of Object.entries(HOSTS)) {
    if (u.pathname.startsWith(prefix)) {
      return proxy(req, res, host, u.pathname.slice(prefix.length) + u.search);
    }
  }

  let rel = u.pathname === "/" ? "/index.html" : u.pathname;
  const file = path.join(APP, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end("not found: " + rel);
    return;
  }
  let body = fs.readFileSync(file);
  if (file.endsWith("index.html")) {
    /* Ahead of every other script, so the rewrite is in place before any of
     * them can build a URL. */
    body = Buffer.from(String(body).replace("<script", SHIM + "<script"));
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  res.end(body);
}).listen(PORT, () => {
  console.log(`[dev] http://localhost:${PORT}`);
  console.log(`[dev] 方向键移动，回车选中，Backspace/Esc 返回`);
  console.log(`[dev] AVPlay 那条路在浏览器里不存在，播放会走 DASH（Shaka + MSE）`);
});
