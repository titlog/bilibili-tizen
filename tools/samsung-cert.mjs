/* Headless Samsung TV certificate issuance.
 *
 * Reimplements what Tizen Studio's Certificate Manager GUI does, using the
 * endpoints and multipart shapes read out of org.tizen.common.cert:
 *   login   account.samsung.com OAuth2 -> http://localhost:4794/signin/callback
 *   author  POST svdca.samsungqbe.com/apis/v3/authors
 *   distrib POST svdca.samsungqbe.com/apis/v3/distributors  (+ v1 for the xml)
 *
 * The user's Samsung password goes to Samsung directly in their own browser.
 * Only the OAuth callback token reaches this process.
 */
import fs from "fs";
import path from "path";
import http from "http";
import https from "https";
import { execFile } from "child_process";
import forge from "node-forge";

const HOME = process.env.HOME;
const OUT = path.join(HOME, "tizen-studio-data", "SamsungCertificate", "BiliSpike");
const CA_DIR = path.join(HOME, "tizen-studio-data", "samsung-ca");

const DUID = process.env.TV_DUID || "YOURDUIDHERE";
const PASSWORD = process.env.CERT_PASSWORD || "CHANGEME";
const PRIVILEGE = "Public";

const AUTHOR_URL = "https://svdca.samsungqbe.com/apis/v3/authors";
const DIST_URL_V3 = "https://svdca.samsungqbe.com/apis/v3/distributors";
const DIST_URL_V1 = "https://svdca.samsungqbe.com/apis/v1/distributors";
const LOGIN_URL =
  "https://account.samsung.com/mobile/account/check.do?serviceID=v285zxnl3h" +
  "&actionID=StartOAuth2&accessToken=Y&redirect_uri=http://localhost:4794/signin/callback";

fs.mkdirSync(OUT, { recursive: true });

function log(...a) { console.log("[cert]", ...a); }

/* ---------------- step 1: OAuth callback capture ---------------- */

/* Exchange the OAuth authorization code for an access token.
 * The endpoint answers with an HTML page whose <body> holds a query string:
 *   access_token=..&userId=..&inputEmailID=..&access_token_expires_in=..  */
function exchangeCode(code) {
  const url = "https://api.samsungosp.com/v2/license/security/authorizeToken?authToken=" +
              encodeURIComponent(code);
  log("exchanging authorization code for access token...");
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const m = text.match(/<body>([\s\S]*?)<\/body>/i);
        const body = (m ? m[1] : text).trim();
        const pick = (k) => {
          const i = body.indexOf(k + "=");
          if (i < 0) return null;
          const rest = body.slice(i + k.length + 1);
          const amp = rest.indexOf("&");
          return (amp < 0 ? rest : rest.slice(0, amp)).trim();
        };
        const token = pick("access_token");
        const userId = pick("userId");
        const email = (pick("inputEmailID") || "").replace(/%40/g, "@");
        if (!token || !userId) {
          return reject(new Error("token exchange failed (HTTP " + res.statusCode + "): " +
                                  body.slice(0, 300)));
        }
        log("access token obtained");
        resolve({ token, userId, email });
      });
    }).on("error", reject);
  });
}

function awaitLogin() {
  /* Fallback: if Samsung ends the flow on a page whose URL carries the token
   * instead of redirecting to us, paste that URL in as CALLBACK_URL. */
  if (process.env.TOKEN_JSON) {
    const j = JSON.parse(process.env.TOKEN_JSON);
    log("using TOKEN_JSON from a callback already captured");
    return Promise.resolve({ token: j.access_token, userId: j.userId, email: j.inputEmailID || "" });
  }
  if (process.env.CALLBACK_URL) {
    const q = new URL(process.env.CALLBACK_URL.replace(/^.*?\?/, "http://x/?"));
    const token = q.searchParams.get("access_token");
    const userId = q.searchParams.get("userId") || q.searchParams.get("user_id");
    const email = q.searchParams.get("inputEmailID") || q.searchParams.get("email") || "";
    if (token && userId) { log("using pasted CALLBACK_URL"); return Promise.resolve({ token, userId, email }); }
    return Promise.reject(new Error("CALLBACK_URL has no access_token/userId"));
  }
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://localhost:4794");
      log("REQ", req.method, u.pathname, u.search || "(no query)");
      const collect = (params) => {
        if (params.toString()) log("PARAMS", [...params.keys()].join(","));
        /* Samsung runs an authorization-code flow: the callback carries `code`,
         * which is then exchanged for the access token at the OSP endpoint. */
        /* `code` is not an authorization code: Samsung packs the whole token
         * payload into it as JSON, so no exchange round-trip is needed. */
        const code = params.get("code");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        if (code && code.trim().startsWith("{")) {
          const j = JSON.parse(code);
          res.end("<html><body style='font:20px sans-serif;padding:60px'>" +
                  "<h2>&#10003; Samsung login captured</h2>" +
                  "<p>You can close this tab. The terminal takes it from here.</p></body></html>");
          server.close();
          resolve({ token: j.access_token, userId: j.userId, email: j.inputEmailID || "" });
        } else if (code) {
          res.end("<html><body style='font:20px sans-serif;padding:60px'>" +
                  "<h2>&#10003; Samsung login captured</h2>" +
                  "<p>You can close this tab. The terminal takes it from here.</p></body></html>");
          server.close();
          exchangeCode(code).then(resolve, reject);
        } else {
          res.end("<html><body style='font:20px sans-serif;padding:60px'>" +
                  "<h2>No code in callback</h2><pre>" + u.search + "</pre></body></html>");
        }
      };
      if (req.method === "POST") {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => collect(new URLSearchParams(body)));
      } else {
        collect(u.searchParams);
      }
    });
    server.on("error", reject);
    server.listen(4794, "127.0.0.1", () => {
      log("callback server listening on http://localhost:4794");
      console.log("\n==================== ACTION NEEDED ====================");
      console.log("Open this URL in your browser and sign in with your Samsung account:\n");
      console.log(LOGIN_URL);
      console.log("\n(Your password goes straight to Samsung. This script only");
      console.log(" receives the OAuth callback token.)");
      console.log("=======================================================\n");
      execFile("open", [LOGIN_URL], () => {});
    });
    setTimeout(() => { server.close(); reject(new Error("login timed out after 15 min")); }, 15 * 60 * 1000);
  });
}

/* ---------------- step 2: CSR generation ---------------- */

function writeCsr(kind, subject, altNames) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject(subject);
  if (altNames) {
    csr.setAttributes([{ name: "extensionRequest", extensions: [{ name: "subjectAltName", altNames }] }]);
  }
  csr.sign(keys.privateKey);
  fs.writeFileSync(path.join(OUT, kind + ".pri"), forge.pki.privateKeyToPem(keys.privateKey));
  const pem = forge.pki.certificationRequestToPem(csr);
  fs.writeFileSync(path.join(OUT, kind + ".csr"), pem);
  log(kind + ".csr written");
  return pem;
}

/* ---------------- step 3: multipart POST ---------------- */

function postMultipart(url, fields, csrPem, csrName) {
  return new Promise((resolve, reject) => {
    const B = "*****";
    let body = "";
    for (const [k, v] of Object.entries(fields)) {
      body += `--${B}\r\nContent-Disposition: form-data; name=${k}\r\n` +
              `Content-Type: text/plain; charset=utf-8\r\n\r\n${v}\r\n`;
    }
    body += `--${B}\r\nContent-Disposition: form-data; name=csr; filename=${csrName}\r\n` +
            `Content-Type: text/plain; charset=utf-8\r\n\r\n${csrPem}\r\n--${B}--\r\n`;
    const buf = Buffer.from(body, "utf8");
    const u = new URL(url);
    const req = https.request({
      host: u.host, path: u.pathname, method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary="${B}"`,
        "Content-Length": buf.length,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode !== 200) return reject(new Error(`${url} -> HTTP ${res.statusCode}: ${text.slice(0, 400)}`));
        if (text.trim().startsWith("{")) {
          try {
            const j = JSON.parse(text);
            if (j.error || j.status === "FAIL" || j.code) {
              return reject(new Error(`${url} -> ${text.slice(0, 400)}`));
            }
          } catch { /* not json after all */ }
        }
        resolve(text);
      });
    });
    req.on("error", reject);
    req.end(buf);
  });
}

/* ---------------- step 4: PKCS#12 assembly ---------------- */

function firstCertPem(text) {
  const b = text.indexOf("-----BEGIN CERTIFICATE-----");
  const e = text.indexOf("-----END CERTIFICATE-----");
  if (b < 0 || e < 0) throw new Error("no PEM certificate in response: " + text.slice(0, 300));
  return text.slice(b, e + "-----END CERTIFICATE-----".length);
}

function buildP12(kind, crtText, caFile) {
  const leaf = forge.pki.certificateFromPem(firstCertPem(crtText));
  const ca = forge.pki.certificateFromPem(firstCertPem(fs.readFileSync(caFile, "utf8")));
  const key = forge.pki.privateKeyFromPem(fs.readFileSync(path.join(OUT, kind + ".pri"), "utf8"));
  const asn1 = forge.pkcs12.toPkcs12Asn1(key, [leaf, ca], PASSWORD,
    { generateLocalKeyId: true, friendlyName: "UserCertificate" });
  const der = forge.asn1.toDer(asn1).getBytes();
  const p12Path = path.join(OUT, kind + ".p12");
  fs.writeFileSync(p12Path, der, { encoding: "binary" });
  log(kind + ".p12 written ->", p12Path);
  return p12Path;
}

/* ---------------- main ---------------- */

const { token, userId, email } = await awaitLogin();
log("signed in as", email || userId);

const authorCsr = writeCsr("author", [
  { name: "commonName", value: "Tizen Developer" },
  { shortName: "OU", value: "TIT" },
  { name: "organizationName", value: "Independent" },
  { name: "localityName", value: "Unknown" },
  { shortName: "ST", value: "Unknown" },
  { name: "countryName", value: "NL" },
]);

const distCsr = writeCsr("distributor",
  [{ name: "commonName", value: "TizenSDK" }, { name: "emailAddress", value: email || "tizen@example.com" }],
  [{ type: 6, value: "URN:tizen:packageid=" }, { type: 6, value: "URN:tizen:deviceid=" + DUID }]);

log("requesting author certificate...");
const authorCrt = await postMultipart(AUTHOR_URL,
  { access_token: token, user_id: userId, platform: "VD" }, authorCsr, "author.csr");
fs.writeFileSync(path.join(OUT, "author.crt"), authorCrt);
log("author certificate issued");

log("requesting distributor certificate for DUID", DUID, "...");
const distFields = {
  access_token: token, user_id: userId, privilege_level: PRIVILEGE,
  developer_type: "Individual", platform: "VD",
};
const distCrt = await postMultipart(DIST_URL_V3, distFields, distCsr, "distributor.csr");
fs.writeFileSync(path.join(OUT, "distributor.crt"), distCrt);
log("distributor certificate issued");

try {
  const xml = await postMultipart(DIST_URL_V1, distFields, distCsr, "distributor.csr");
  fs.writeFileSync(path.join(OUT, "device-profile.xml"), xml);
  log("device-profile.xml saved");
} catch (e) { log("device-profile.xml skipped:", e.message.slice(0, 120)); }

const authorP12 = buildP12("author", authorCrt, path.join(CA_DIR, "vd_tizen_dev_author_ca.cer"));
const distP12 = buildP12("distributor", distCrt, path.join(CA_DIR, "vd_tizen_dev_public2.crt"));

console.log("\nOK");
console.log("AUTHOR_P12=" + authorP12);
console.log("DIST_P12=" + distP12);
