# bilibili on Samsung TV (Tizen)

Building a bilibili client for a living-room Samsung TV. `app/` is the client:
browse, search, QR login, and playback. `spike/` keeps the diagnostic harness that
established the platform facts below — it is not deployed, but it is the fastest
way to re-answer a media question without disturbing the app.

## The target

| | |
|---|---|
| Model | UE65XXXXXXXXXX, Tizen 7, 2023 |
| LAN address | `192.168.1.100` (sdb on `:26101`) |
| DUID | `YOURDUIDHERE` |
| Dev machine | `192.168.1.10` on `en0` |

Developer Mode is already on and the host PC address is registered. If sdb
refuses to connect, that registration is the first thing to check — the TV
accepts connections from that one address only, and the setting needs a full
power cycle to take effect.

## What has been measured

These were established by experiment on 2026-08-01 and several contradict the
assumptions the project started from. Do not re-derive them casually.

**bilibili does not require a Referer.** Both `api.bilibili.com` and the CDN
reject a Referer they do not recognise, and accept a request carrying none at
all. They also 403 a `curl/*` User-Agent. So the rule is: send *no* Referer,
send *any* browser-shaped UA. In the widget that is
`<meta name="referrer" content="no-referrer">` in `index.html` plus
`avplay.setStreamingProperty("USER_AGENT", …)`. The consequence is large — the
TV talks to bilibili directly, so **no LAN proxy and no backend of our own**.

> Never probe bilibili with bare `curl`. Its default UA is blocklisted, so every
> response reads as "Referer required" and you will conclude the project needs a
> proxy. That false signal already cost most of an evening. Always pass `-A`.

**Samsung TVs of this generation demand a Samsung distributor certificate.**
Tizen's bundled distributor certs fail with `Invalid certificate chain` — both
the ones that expired in 2022 and the valid-to-2032 `-new` ones, so this is a
trust-chain issue, not an expiry issue. The VS Code `tizentv` extension cannot
issue Samsung certs; neither can any CLI that ships with Tizen Studio.

**AVPlay exposes only `COOKIE` and `USER_AGENT`.** There is no general custom
HTTP header for progressive playback — arbitrary headers exist only on the DRM
license path via `setDrm()`. Any design that needs a request header other than
those two has to change shape.

**Playback routes, all measured on device.** In descending order of usefulness:

| route | works | notes |
|---|---|---|
| MSE in the `<video>` element | yes | **the one to build on** — muxed audio+video, no server |
| AVPlay, progressive `durl` | yes | simplest; `qn=64` gives 720p with no login |
| AVPlay, MPD served over HTTP | yes | proves the generated manifest is valid |
| AVPlay, MPD as `data:` URI | no | `PLAYER_ERROR_INVALID_URI` |
| AVPlay, MPD as `file://` | no | `PLAYER_ERROR_NOT_SUPPORTED_FILE` |
| AVPlay, bare `.m4s` | yes | decodes, but video only — no audio track |

So AVPlay does DASH correctly, it just insists the manifest arrive over HTTP, and
a widget cannot listen on a socket. MSE closes that gap: fetch the DASH
representations with XHR and append them to two `SourceBuffer`s. `avc1` and
`mp4a.40.2` both pass `MediaSource.isTypeSupported` here.

> Anything that drives AVPlay repeatedly must guard its callbacks. `setListener`
> registers on the avplay singleton and swapping the `<object>` element does not
> detach it, so a stale `onerror` from a previous attempt fires into the current
> one. `main.js` uses a generation counter for this; without it an experiment
> that tries several sources in sequence produces results in the wrong order and
> reads as "everything failed". That happened, and inverted a conclusion.

## Deploying

```bash
zsh tools/deploy.sh          # refresh playurl, sign, install, launch (~15 s)
node tools/collect.mjs       # in another terminal, before pressing play
```

`deploy.sh` rewrites `REPORT_TO` in `app/js/config.js` so the TV knows where to
send diagnostics. It also derives the package filename from the build rather than
assuming it: `tizen` names the wgt after `<name>` in `config.xml`, and renaming
the app once left the installer pushing a stale package while the launch step
cheerfully started the previously installed build — which reads exactly like new
code having no effect.

Results come back over HTTP because `dlog` is closed on retail sets: the app
POSTs errors to `collect.mjs` on port 8099. Without the collector running,
reporting silently no-ops. Web Inspector via `tizen debug` is the fallback when a
run dies before anything reports, such as a syntax error at load.

## Certificates

Live in `~/tizen-studio-data/SamsungCertificate/BiliSpike/`, deliberately outside
this repo since they include private keys. The signing profile is `SamsungBili`;
password `CHANGEME`. **The distributor certificate expires around 2027-08.**

To reissue, `node tools/samsung-cert.mjs` opens a Samsung account login, captures
the OAuth callback and posts CSRs to `svdca.samsungqbe.com`. It needs no Eclipse,
no sudo and no Tizen certificate GUI.

One trap is baked into that script's comments and worth repeating: the OAuth
callback's `code` parameter is **not** an authorization code. Samsung packs the
entire token payload into it as JSON. Trying to exchange it at
`api.samsungosp.com/v2/license/security/authorizeToken` returns
`403 ACF_0403 [AllowList]` from any ordinary network, which reads like a
permissions problem but is really a wrong turn — just parse the JSON.

## Layout

```
app/          the client
  js/config.js   user agent, preferred quality, reporting address
  js/api.js      bilibili endpoints and response normalisation
  js/auth.js     QR login and session storage
  js/qr.js       QR encoder, verified by tools/qr-verify.mjs
  js/nav.js      geometric D-pad focus
  js/player.js   AVPlay and MSE playback
  js/app.js      screens and routing
spike/        the harness that established the platform facts; not deployed
tools/
  deploy.sh        one-command build + install + launch
  collect.mjs      diagnostics collector on :8099
  samsung-cert.mjs headless Samsung certificate issuance
  qr-verify.mjs    round-trips qr.js through a real decoder
  probe-gating.py  re-check the CDN/API gating rules from the dev machine
docs/
  操作手册-原始.md   the original plan, kept for reference; its step 3
                    (certificates via the VS Code extension) does not work
```

## Conventions

`app/js/` is plain ES5 in an IIFE — Tizen 7's WebKit is old and there is no build
step. No frameworks, no bundler, no `let`/`const`/arrow functions in app code.
`tools/` is Node ESM and modern JS is fine there.

Everything is driven by the D-pad: direction moves focus, centre selects, return
goes back. Focus is geometric — `nav.js` picks whichever `.focusable` lies in the
pressed direction and is nearest — so ragged grids work without anyone declaring
a column count. Anything added has to be reachable that way; there is no pointer.

## Where this is going

Spikes 01 and 02 are **done and all five tests pass**. The CDN, the API and both
playback paths work from the device with no infrastructure of any kind. There is
no known platform blocker left.

1. **Login** — done, by QR. Two findings worth keeping:

   *No WBI signing is needed.* `search/all/v2`, `popular`, `ranking`, `view` and
   `playurl` all answer unsigned. Only `search/type` demands a signature, and
   `search/all/v2` covers the same ground.

   *The poll response does not carry the credentials.* It returns a cross-domain
   url whose query holds `ticket, gourl, first_domain` — the session arrives as
   `Set-Cookie` on that hop, which XHR cannot read. `auth.js` therefore fetches
   the url with `withCredentials` and lets the engine's own jar keep it. That
   works, but it means **this code never sees SESSDATA**, so AVPlay's `COOKIE`
   streaming property cannot be filled in and a logged-in session has to play
   through MSE, which goes over XHR and picks up the jar.

   The QR is encoded on device by `qr.js` rather than fetched from an image
   service: the payload is a single-use login token and anything that can read it
   can complete the login as the user. `tools/qr-verify.mjs` round-trips the
   encoder through a real decoder — run it after any change there.
2. **The client proper** — browse, search, history, playback. Build the player on
   MSE, with progressive `durl` as the fallback for anything that has no DASH.
   This is ordinary API work now, against a foundation that is known-good.
3. **Wits hot reload** — optional. A deploy cycle is about 15 s, which has been
   fast enough so far.
