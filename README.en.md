# bilibili on Samsung TV

**[中文](README.md) · English**

A bilibili client for Samsung Tizen televisions, driven entirely by the remote.
The TV talks to bilibili directly: **no backend, no proxy, no server, and your
credentials never leave the set.**

Several people can be signed in at once, each with their own watch history;
what you half-watched on the phone is under the cursor when the TV comes on.

> LG webOS has a good one, [bili-webos](https://github.com/asdf17128/bili-webos).
> The Samsung side was empty. This fills that gap.
>
> **Not affiliated with bilibili or Samsung.** Personal project, MIT.

|  |  |
|---|---|
| ![Home](docs/screenshots/01-home.jpg) | ![Playback](docs/screenshots/03-player-scrub.jpg) |
| Home. The top row is 「continue watching」, and the cursor starts on it | 1080p H.265, scrubbing with thumbnail previews and chapter ticks |
| ![Related](docs/screenshots/04-panel.jpg) | ![Search](docs/screenshots/02-search.jpg) |
| Press down while playing for parts, description and related videos — **the video keeps running** | Search, with the TV's own Chinese IME one button away |

## Will it run on my TV

| | |
|---|---|
| **Verified** | Samsung 2023 65" **CU7090**, firmware Tizen 9.0 (Chromium 120). Every measurement in this project comes from this one set |
| **Very likely** | Same generation or newer (2022 onwards, Tizen 7+). Playback uses standard MSE and AVPlay, nothing model-specific — but **nobody has tried another model yet** |
| **No** | Non-Samsung sets; Samsung models from before 2016 (engine too old) |

Every build reports its engine string and codec support on boot; that line is
the first thing to read. **If it works or fails on another model, please open an
issue with the model and firmware version** — that is how this table grows.

## Install

Samsung's store does not accept third-party clients for other people's services
(it pulled the unofficial Twitch app in 2019 for exactly that), so this is
sideloaded. You need a computer on the same network, **once**; after that the
app opens from the TV like any other.

**Everybody gets stuck on the certificate; `setup.sh` handles it.** Samsung sets
from 2023 on only accept Samsung-issued distributor certificates — the ones that
ship with Tizen Studio all fail with `Invalid certificate chain`. The script opens
the Samsung account login, requests the certificate for you, and needs no Eclipse,
no sudo, no certificate-manager GUI.

You need Node, Python 3, and the
[Tizen Studio](https://developer.tizen.org/development/tizen-studio/download)
command-line tools (**not the IDE**). On the TV, enable Developer Mode, register
this computer's IP, then **power-cycle the set completely** — without that the
registration does not take, and the symptom is `sdb` timing out silently.

```bash
git clone https://github.com/titlog/bilibili-tizen.git && cd bilibili-tizen
zsh tools/setup.sh      # once: finds the TV, reads its DUID, issues the certificate; config lives outside the repo
zsh tools/deploy.sh     # check, sign, install, launch — about 15 seconds
```

**Updating is the same command.** The app does not update itself yet (all five
self-update routes have been proven on the set, but it is not built), so
`git pull` and another `deploy.sh` is the upgrade.

> Only need the certificate, for something unrelated? It is a standalone tool:
> **[samsung-tv-cert](https://github.com/titlog/samsung-tv-cert)**
> [![npm](https://img.shields.io/npm/v/samsung-tv-cert.svg)](https://www.npmjs.com/package/samsung-tv-cert)
> — `npx samsung-tv-cert --duid <your DUID>`. Useful for Jellyfin, community
> Twitch, or anything else you sideload onto a Samsung set.

## Accounts and privacy

- QR sign-in, any number of accounts, switching needs no rescan.
- **Credentials are stored only in the TV's local storage.** No server, no
  analytics, no third party; the app talks to `bilibili.com` and its CDN and
  nothing else. Stream URLs are pre-signed, so media requests carry no account.
- Watch progress is reported back to bilibili (every 30 s), so the phone and the
  web can pick up where the TV left off — and vice versa.
- The default sign-in is the **TV login** route, signed with the official TV
  client's appkey. That is what makes multiple accounts and progress reporting
  possible; it also means your client presents itself to bilibili as the official
  TV client. That is a terms-of-service judgement, not a technical one; the web
  QR route is there if you would rather not, at the cost of one account and no
  progress reporting. The full trade-off is in [`docs/登录路径.md`](docs/登录路径.md) (Chinese).
- An expired token means scanning again (the refresh endpoint has not been
  verified against the server, and guessing on the one path that holds the whole
  household's credentials is not something this project does).
- The deploy script bakes **your computer's LAN address** into the package as the
  destination for diagnostic logs; anything is received only while you run the
  collector on that computer, and only on your LAN.

## What it does, and what it deliberately does not

**Does**: recommendations / popular / rankings / food / dance / dynamic feed /
watch-later / search with the TV's own Chinese IME, multi-part uploads, resume
(remembers which part, picks up from the phone), autoplay next, scrub previews,
parts and related videos over a running video. About **2.5–3.5 s** from OK to a
picture, 1080p H.265.

**Does not**:
- **4K.** The two missing tiers (1080p high bitrate, 4K) are what the paid
  membership sells, very few uploads have them, and whether this set's MSE can
  hardware-decode 4K is unverified.
- **Casting from the phone.** A cast receiver has to listen on a port; a Tizen
  web widget cannot, regardless of how official it is. The substitute is
  watch-later: tap on the phone, open on the TV.
- **Subtitles, uploader pages, a settings screen.** The APIs exist; not built.

## FAQ

**`sdb` cannot reach the TV.** Is the IP registered in Developer Mode this
computer's *current* IP, and did you power-cycle the set after changing it? A DHCP
change means re-registering.

**`Invalid certificate chain`.** You are using a Tizen-bundled certificate. Run
`zsh tools/setup.sh` for a Samsung-issued one.

**A video will not open: 「视频流被拒绝（403）」.** Usually CDN throttling or a
per-file refusal. The app rotates mirrors, escalates the token, switches codec
family and drops tiers on its own; the message means all of that was tried. Wait
a few minutes or pick another video.

**The dynamic feed / watch-later tab is empty.** Both need a signed-in account;
scan from 「我的」 first.

**A code change has no effect.** Check the boot line the TV reports; `deploy.sh`
derives the package name from `config.xml`, so after renaming the app make sure
it is pushing the new package.

## For developers: what this platform actually allows

The client is the result; the time went into finding out what the platform can
do. Each of these cost at least a day and none of them is written down elsewhere:

- **bilibili needs no `Referer`, but rejects by UA.** Probing with bare `curl`
  makes every response read like "Referer required" — a false signal that nearly
  put a proxy into this project that it never needed.
- **This firmware's widget cannot send a `Cookie` header.** Chromium 120 silently
  drops forbidden headers, so signed-in sessions ride in the query as
  `access_key`. The earlier "it can" conclusion was measured with one account on
  the set, where the measurement had no power to distinguish anything.
- **The same upload plays on the phone and not on the TV because of playurl's
  `platform`.** Tokens minted by the web endpoint get 403'd by strict CDN nodes;
  tokens from the app endpoint are accepted.
- **AVPlay plays DASH, but the manifest must arrive over HTTP**, and a widget
  cannot listen on a port — so DASH goes through MSE. The same wall is why
  casting cannot be built.
- **Switching CDN nodes does not work, throttling is per IP, mirrors must be
  ranked and never dropped.** Which mirror is dead is that day's weather: the same
  host 403'd all evening and served all of the next.

The stories behind each are in [`docs/平台坑.md`](docs/平台坑.md) (Chinese); every
measurement, log line and the debugging discipline are in [`CLAUDE.md`](CLAUDE.md),
the project's working notes, including the conclusions that were later overturned.

## Layout

```
app/          the client (ES5, IIFE, no build step)
  vendor/     Shaka Player, precompiled, checked in
spike/        the rigs that established the platform facts
tools/
  setup.sh            once: your TV, your certificate
  deploy.sh           check, sign, install, launch
  samsung-cert.mjs    Samsung certificate issuance without a GUI
  devserver.mjs       run the client in a desktop browser (screenshots, UI work without deploying)
  collect.mjs         diagnostics collector on :8099
  lint.mjs            catches calls to things that do not exist
  *-verify.mjs        manifest / accounts / md5 / QR — any failure refuses to ship
docs/         platform notes, login routes, the full stream-token investigation
CLAUDE.md     everything learned, every trap, and how to debug on a retail set
```

## Debugging

A retail set has every convenience switched off: `dlog` returns nothing, the Web
Inspector port never opens, `sdb shell` is `closed`. So the app reports on
itself — `tools/collect.mjs` listens on 8099 and `deploy.sh` writes the address
into the build.

```bash
node tools/collect.mjs | tee /tmp/bili.log   # terminal 1, first
zsh tools/deploy.sh                          # terminal 2
```

With no collector the reports fail silently; after five failures in a row the
app sleeps five minutes and tries again, so a collector started late receives
lines within five minutes, and a redeploy restores it at once.

```bash
zsh tools/deploy.sh --selftest
```

walks the whole flow on the set unattended — grid, playback, panel, scrolling,
scrubbing, long seeks across the buffer, pause, resume, exit, accounts — reporting
each step. **It is the only way to check a build without someone on the sofa.**
Install a normal build again when it is done.

## Licence

MIT. bilibili is a trademark of its owner; this project is not affiliated.
