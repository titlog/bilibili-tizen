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

**Setting `COOKIE` to an empty string breaks playback.** A jar-only session has no
readable SESSDATA, so `Auth.cookieHeader()` returns `""` while `isLoggedIn()` is
true. Handing that to `setStreamingProperty("COOKIE", "")` makes AVPlay emit a
malformed `Cookie` header and the CDN refuses everything. It looked exactly like
a broken stream and it only started once the viewer signed in. Set the property
only when there is something to send.

**Playback routes, all measured on device.**

| route | works | notes |
|---|---|---|
| AVPlay, progressive `durl` | yes | native buffering, seeking, constant memory — but see the cap below |
| MSE in the `<video>` element | yes | the only way to play DASH here; `avc1` and `mp4a.40.2` both pass `isTypeSupported` |
| AVPlay, MPD served over HTTP | yes | proves the generated manifest is valid |
| AVPlay, MPD as `data:` URI | no | `PLAYER_ERROR_INVALID_URI` |
| AVPlay, MPD as `file://` | no | `PLAYER_ERROR_NOT_SUPPORTED_FILE` |
| AVPlay, bare `.m4s` | yes | decodes, but video only — no audio track |

AVPlay does DASH correctly, it just insists the manifest arrive over HTTP, and a
widget cannot listen on a socket. So DASH means MSE.

**The single-file form is capped at 720p, and sometimes refused entirely.** This
is the fact that decides the player's architecture:

| form | what it offers |
|---|---|
| `fnval=1` (`durl`) | `accept_quality` tops out at `[64, 16]` |
| `fnval=16` (DASH) | `[116, 112, 80, 64, 32, 16]` on the same video |

Asking progressive first therefore played *everything* at 720P however good the
source, and for videos carrying a high-tier source the API still returns a durl
whose CDN answers **403 on every mirror, at every quality** — which presented as
"some videos just fail". `app.js` now asks both forms and takes the better;
progressive wins ties because AVPlay beats hand-rolled MSE on buffering, seeking
and memory.

**`dash.audio` is unsorted, and some entries the account cannot fetch.** One
video listed bandwidths in the order 105k, 66k, 210k. Taking `audio[0]` is
therefore a coin flip, and drawing a gated track shows up as the picture
buffering to four minutes while the sound never arrives and every audio mirror
answers 403. Sort by bandwidth, and treat exhausted mirrors as a reason to try
the *next representation*, not to cycle the dead mirrors again.

**Size MSE requests from each representation's bitrate.** A flat 4 MB chunk is
three minutes of audio but thirteen seconds of 1080p video, so the audio raced
ahead while the picture — the thing playback actually waits on — trickled in.
Ask for a fixed number of *seconds* instead, with a deliberately short first
request so something is playable quickly. Two requests in flight keeps the link
busy; because a fragmented MP4 is a sequential byte stream, arrivals must go
through an ordered queue rather than being appended as they land.

> Anything that drives AVPlay repeatedly must guard its callbacks. `setListener`
> registers on the avplay singleton and swapping the `<object>` element does not
> detach it, so a stale `onerror` from a previous attempt fires into the current
> one. `player.js` and `spike/main.js` use a generation counter for this; without
> it an experiment that tries several sources in sequence produces results in the
> wrong order and reads as "everything failed". That happened, and inverted a
> conclusion.

## Deploying

```bash
node tools/collect.mjs          # terminal 1, leave running
zsh tools/deploy.sh             # terminal 2: check, sign, install, launch (~15 s)
zsh tools/deploy.sh --selftest  # same, but the build walks the flow and reports
```

`deploy.sh` runs `node --check` over every file and then `tools/lint.mjs`, and
**refuses to install if either fails** — the parse check alone once let a build
ship in which selecting a video did nothing at all.

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
this repo since they include private keys. The signing profile is `SamsungBili`
and its password is read from `~/.bilibili-tizen-cert-password`, also outside the
repo. **The distributor certificate expires around 2027-08.**

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
  js/resume.js   where each video was left off
  js/settings.js preferences that outlive a session
  js/app.js      screens and routing
  js/selftest.js on-device walkthrough, off unless --selftest
spike/        the harness that established the platform facts; not deployed
tools/
  deploy.sh        one-command build + install + launch
  collect.mjs      diagnostics collector on :8099
  lint.mjs         catches calls to things that do not exist; gates deploys
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

## How to debug anything on this television

Everything convenient is closed on a retail set, and finding that out takes
longer than working around it:

| route | state |
|---|---|
| `dlog` / `sdb shell dlogutil` | returns nothing at all |
| Web Inspector via `tizen debug` | hangs; no port ever opens |
| Samsung remote WebSocket (`:8002`) | works, but the first connection needs someone in front of the set to accept a dialog |

So the app reports on itself. `report()` in `app.js` and `window.onerror` POST to
`tools/collect.mjs` on port 8099, which `deploy.sh` wires up automatically. Run
the collector in one terminal before deploying and every error arrives as text.

For anything more than an error message, `zsh tools/deploy.sh --selftest` ships a
build that walks the entire flow by dispatching the same key events the remote
sends — grid, play, panel, scroll, scrub, pause, resume, exit — and reports each
step. That is the only way to exercise a build unattended, and it is also how a
regression gets caught before it reaches the sofa. Add a step whenever a bug
turns out to be reachable by pressing buttons in order.

## Traps this codebase has already fallen into

Read this before diagnosing anything. Every entry below cost at least an hour,
and most of them cost several — always for the same reason.

**A plausible cause is not a diagnosis.** Four separate times an error was
explained by the first mechanism that fit, designed around, and shipped:

- *"The CDN needs a Referer, so we need a LAN proxy."* It was `curl`'s default
  User-Agent being blocklisted. Nearly abandoned the project as too expensive.
- *"AVPlay cannot see the cookie jar, so a signed-in session must play through
  MSE."* Stream urls are pre-signed; AVPlay needs no session at all. Only the
  playurl call does, and that already goes over XHR. Hand-rolling MSE gave up
  native buffering, seeking and hardware decode for nothing.
- *"Every manifest delivery route fails, so AVPlay cannot do DASH."* Stale
  listeners were knocking over each attempt before it ran. With a generation
  guard, HTTP delivery worked on the first try — the opposite conclusion.
- *"`PLAYER_ERROR_CONNECTION_FAILED` means the CDN refused us."* Twice: first
  blamed on restricted PCDN nodes, then on an empty `COOKIE` property. It was
  neither.

**The move that actually works is a discriminating test** — one experiment whose
two outcomes point at different causes. For that last one: hand the very url
AVPlay rejects to a plain `XMLHttpRequest`.

That test is now permanent. `probeUrl()` in `app.js` runs on every playback
failure and reports one line:

```
probe: https upos-hz-mirrorakam.akamaized.net avplay=PLAYER_ERROR_CONNECTION_FAILED xhr=403
probe: https upos-hz-mirrorakam.akamaized.net avplay=PLAYER_ERROR_CONNECTION_FAILED xhr=206
```

`xhr=403` means bilibili is refusing the stream and no amount of retrying will
help — switch form. `xhr=206` means the url and the network are fine and the
fault is in how AVPlay is asking — switch mirror or scheme. Reading the AVPlay
code alone cannot tell these apart, and guessing between them cost several
deploys before the probe existed.

The `206` case turned out to be that selecting a video fired the playurl call,
`view()`, `related()` and AVPlay's own stream connection in the same instant, and
AVPlay intermittently lost that race. Metadata is queued until the picture is up.

**One error code can mean several things.** `CONNECTION_FAILED` covers "refused",
"no route" and "could not get a socket"; `InvalidAccessError` accompanies all of
them. Never reason from the code alone — find something that separates the cases.

**Never edit by replacing text you remember.** Twice in one session an edit was
applied against an anchor that had already drifted:

- A block delete keyed on two surrounding markers took `playVideo` with it,
  because that function had been written *between* them. Pressing OK on the home
  screen then did nothing, and every file still parsed.
- A rewrite of the playback routing silently matched nothing. The build shipped,
  the behaviour was unchanged, and the logs showed the old code path — costing a
  full round of "why didn't that fix it".

Read the region first, then edit. When a change is supposed to alter behaviour,
confirm it did by looking for its evidence in the collector, not by assuming the
edit landed.

**`node --check` proves nothing about whether the app works.** A block delete
removed `playVideo` along with the dead detail screen beside it. Every file
parsed, the build shipped, and the only symptom was that pressing OK on the home
screen did nothing whatsoever. `tools/lint.mjs` now catches calls to things that
do not exist and `deploy.sh` refuses to ship when it fails. Run it after any
deletion that spans more than a few lines.

**Silent no-ops are the expensive failures.** Nothing in this app throws when
focus lands on a detached node, when a scroll container loses the class `nav.js`
identifies it by, or when a callback repaints a screen the viewer already left.
The user sees a remote that stopped working and there is nothing in any log.
When a symptom is "it does nothing", suspect state rather than errors.

**Guard every AVPlay callback with a generation counter.** `setListener`
registers on a singleton and `close()` does not detach it, so a torn-down
session's `onerror` or `onstreamcompleted` fires into whatever is playing now.
This has bitten twice. `player.js` and `spike/main.js` both guard; new code must.

**Guard every async callback that paints with a view token.** A response that
lands after the viewer has moved on will repaint a dead screen and hand focus to
a node that is no longer in the document. `app.js` uses `newView()` and
`stillViewing()`; `loadFeed` additionally has its own request counter.

**Clear per-video player state in `play()`, not on teardown.** The scrub head was
seeded from `lastKnownPosition`, which nothing reset, so the first press of
fast-forward on a new video jumped it to the previous video's timestamp — usually
straight to its own ending. Anything that describes "the video playing now"
belongs in the reset at the top of `play()`.

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
2. **The client** — done: recommendations, 热门, 排行, 动态, search with the
   television's own IME, detail with parts and related videos, resume, autoplay
   of the next video, and a player built on AVPlay with progressive `durl`. MSE
   is the fallback for videos with no single-file stream.

**Watch history is local.** Reporting playback to bilibili needs the CSRF token
`bili_jct`, which this login path never exposes, so nothing this app plays
reaches the server-side history. `resume.js` keeps its own list and 我的 renders
that — the only version that reflects what was actually watched here.

**Not possible on this login path.** Like, coin, favourite and watch-later all
need the CSRF token `bili_jct`. The session lives in the engine's cookie jar
where this code cannot read it, so those actions cannot be signed. The way out
would be bilibili's TV login endpoint, which returns credentials as JSON for
exactly this reason — but it requires signing with the official TV client's
appkey, which is a decision about impersonating their client, not a technical
one. Left alone deliberately.

**Still missing**, roughly in order of how much the absence is felt: a UP主 page
(the space API answers -352 without WBI signing), categories beyond 全站, search
history and hot searches, subtitles (the endpoint works; many videos carry
them), and a settings screen for quality, autoplay and clearing history.
