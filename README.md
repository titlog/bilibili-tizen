# bilibili on Samsung TV

A bilibili client for Samsung Tizen televisions, driven entirely by the remote.
Plain ES5, no build step, no backend, no proxy — the TV talks to bilibili
directly. Several people can be signed in at once, each with their own watch
history.

There is no bilibili app on Tizen. There is a good one for LG webOS
([bili-webos](https://github.com/asdf17128/bili-webos)); this is the Samsung
side of that gap.

**Not affiliated with bilibili or Samsung.** Personal project.

## What works

Recommendations, popular, rankings, four category tabs, dynamic feed, search
with the TV's own IME, QR sign-in for any number of accounts, multi-part videos,
resume across parts and devices, autoplay next, scrub with thumbnail previews
and chapter ticks, and playback over two routes — progressive via AVPlay, DASH
via [Shaka Player](https://github.com/shaka-project/shaka-player).

About **2.5–3.5 seconds** from pressing OK to a picture, 1080p H.265.

## Install

Samsung's store does not accept third-party clients for other people's services
— it pulled the unofficial Twitch app in 2019 for exactly that — so this is
sideloaded. You need a computer on the same network, once.

```bash
git clone <this repo> && cd bilibili-tizen
zsh tools/setup.sh      # asks for your TV, issues the certificate
zsh tools/deploy.sh     # check, sign, install, launch
```

`setup.sh` walks through enabling Developer Mode, finds your TV, reads its DUID
and issues a Samsung distribution certificate. Requirements: Node, Python 3, and
the [Tizen Studio](https://developer.tizen.org/development/tizen-studio/download)
CLI (the IDE is not needed).

> **The certificate is the part everyone gets stuck on.** Tizen's own
> distribution certificates all fail with `Invalid certificate chain` on 2023+
> sets — both the expired 2022 pair and the `-new` pair valid to 2032, so it is
> a trust-chain problem, not an expiry one. You need a Samsung-issued one.
> `tools/samsung-cert.mjs` does that headlessly: no Eclipse, no sudo, no
> certificate GUI. It is useful on its own for any Tizen project.

## What this repository is really for

The client works, but the expensive part was finding out what the platform does.
[`CLAUDE.md`](CLAUDE.md) records every measurement, including the ones that
overturned earlier conclusions. Some findings that cost days:

- **bilibili needs no `Referer`.** It rejects a `Referer` it does not recognise
  but accepts requests with none, and 403s `curl/*` user agents. Testing with
  bare `curl` therefore makes every response read like "Referer required", which
  nearly justified building a LAN proxy the project does not need.
- **AVPlay exposes only `COOKIE` and `USER_AGENT`** as streaming properties.
  Any design needing a third request header has to change shape.
- **Setting `COOKIE` to an empty string breaks playback outright** — AVPlay
  emits a malformed header and the CDN refuses everything. It looks exactly like
  a broken stream, and only appears after a viewer signs in.
- **AVPlay plays DASH, but only from a manifest delivered over HTTP.** `data:`
  and `file://` URIs are both refused, and a widget cannot listen on a socket —
  which is why DASH goes through MSE.
- **The single-file (`durl`) form caps at 720p** and is refused outright for
  videos with a high-tier source, 403 on every mirror and every quality.
- **Rotating CDN hostnames does not work here.** Signatures are host-bound; 7 of
  8 alternates 403, and the one that answers runs 30× slower.
- **Every AVPlay callback needs a generation guard.** `setListener` registers on
  a singleton and `close()` does not detach it, so a torn-down session's
  `onerror` lands in whatever is playing now. This inverted a conclusion once.

It also records the debugging discipline that got there: a plausible mechanism
is not a diagnosis, and five separate failures were each explained by the first
self-consistent story before measurement said otherwise.

## Layout

```
app/          the client (ES5, IIFE modules, no build step)
  vendor/     Shaka Player, prebuilt
spike/        the harness that established the platform facts
tools/
  setup.sh            one-time: your TV, your certificate
  deploy.sh           check, sign, install, launch
  samsung-cert.mjs    headless Samsung certificate issuance
  collect.mjs         diagnostics collector on :8099
  lint.mjs            catches calls to things that do not exist
  *-verify.mjs        manifest, accounts, md5, QR — all gate the deploy
CLAUDE.md     findings, traps, and how to debug on a retail set
```

## Debugging

Retail sets close everything convenient: `dlog` returns nothing, the Web
Inspector never opens its port, and `sdb shell` is closed. So the app reports to
itself — `tools/collect.mjs` listens on :8099 and `deploy.sh` wires the address
in. Start the collector **before** deploying; the app gives up reporting after
five failed attempts and does not retry until it is restarted.

`zsh tools/deploy.sh --selftest` walks the entire flow on the device
unattended — grid, playback, panel, scrubbing, long seeks, pause, resume,
accounts — and reports each step. It is the only way to check a build without
sitting in front of the television.

## Licence

MIT. bilibili is a trademark of its owner; this project is unaffiliated.
