# BiliSpike

A throwaway diagnostic app for one question:

> Can a Tizen app play a bilibili CDN stream when it cannot set a Referer header?

If the answer is yes, a Samsung TV bilibili client is a weekend project. If it is
no, you need a LAN proxy and the economics change. Nothing else about the project
is worth designing until this is settled.

---

## 1. Get a stream URL

Two calls, both from your PC browser or curl. Use a video you know is public.

**Get the cid** (the `bvid` is in the video page URL):

```
https://api.bilibili.com/x/player/pagelist?bvid=BV1xx411c7XD
```

Take `data[0].cid` from the response.

**Get the playurl:**

```
https://api.bilibili.com/x/player/playurl?bvid=BV1xx411c7XD&cid=<cid>&qn=32&fnval=1
```

- `fnval=1` returns a plain MP4 in `data.durl[0].url` — one file, no DASH
  manifest, no separate audio track. Much easier to reason about for a spike.
- `qn=32` is 480p, which needs no login. **Use this for the first run.** Adding
  a SESSDATA cookie for 1080p introduces a second variable, and the whole point
  of this exercise is to isolate one.

Copy `data.durl[0].url` — it will be a long `*.bilivideo.com` URL.

**It expires.** Typically within a couple of hours. If tests suddenly start
failing after they were passing, fetch a fresh one before debugging anything else.

Paste it into `js/config.js`:

```js
var VIDEO_URL = "https://cn-...bilivideo.com/upgcxcode/...";
```

---

## 2. Put the TV in developer mode

1. Open **Apps** on the TV.
2. Press `1 2 3 4 5` on the remote. A developer mode dialog appears.
3. Set **Developer mode: On**, enter your computer's LAN IP, save.
4. Restart the TV.

Your computer and the TV must be on the same network.

---

## 3. Toolchain

Install **Tizen Studio** with, via Package Manager:

- **TV Extension** (matching your TV — a 2024 CU-series runs Tizen 8.0, but
  building against 6.0 keeps it portable)
- **Samsung Certificate Extension** — this one is easy to miss and nothing
  installs without it

Then in **Tools → Certificate Manager**, create a profile:

- Author certificate: **Samsung** (not Tizen), signed in with your Samsung account
- Distributor certificate: **Samsung**, and enter your TV's **DUID**

The DUID is the important part — a Samsung distributor certificate is bound to
specific devices. You find it in Device Manager once the TV is connected, or on
the TV under Support → About This TV.

> A Tizen distributor certificate will not work here. It has to be Samsung.
> This is the single most common reason installs fail with a signature error.

---

## 4. Build and install

Connect the TV in **Tools → Device Manager** (Remote Device → add your TV's IP →
toggle on). Right-click the device → **Permit to install applications**.

Then either import this folder as a Tizen Web project in the IDE and hit Run, or
use the CLI:

```bash
tizen build-web -- .
tizen package -t wgt -s <your-profile-name> -- .buildResult
tizen install -n BiliSpike.wgt -t <device-name-from-sdb-devices>
```

`sdb devices` lists connected targets.

---

## 5. Read the result

Blue button runs all three probes. Individual tests are on red, green, yellow.

| 01 range | 02 AVPlay | 03 video tag | What it means |
|---|---|---|---|
| pass | pass | fail | **The good outcome.** AVPlay sends no Referer and the CDN is fine with that; WebKit sends one and gets rejected. Build the app. |
| pass | pass | pass | Even better — the CDN is not checking Referer on this URL at all. |
| pass | fail | fail | The URL is reachable but AVPlay will not decode it. Look at codec and container, not headers. Try a different `qn`. |
| fail | fail | fail | The CDN wants a Referer. You need a LAN proxy. See below. |
| fail | pass | — | Odd. Probably an expired URL that got refreshed between probes. Rerun. |

Test 02 hides the UI and shows video for 12 seconds, then comes back to the
report. Press RETURN during playback to abort early.

---

## 6. If it fails

The fallback is a small proxy on your LAN that adds the header the TV cannot:

```js
// ~20 lines with node:http — point VIDEO_URL at
// http://192.168.x.x:8080/?url=<encoded original>
// and have the proxy pipe the response through with
// Referer: https://www.bilibili.com attached.
```

Run it on anything always-on — a Pi, a NAS, an old laptop. Keep it on the LAN:
video bytes through a cloud host would be expensive and pointless, since the
only thing being added is a header.

The cost of this fallback is not the code, it is that your TV app now depends on
a second machine being up. Worth knowing before you commit.

---

## Notes

- `<access origin="*" subdomains="true"/>` in config.xml is what lets test 01
  see real HTTP status codes. On Tizen the widget access policy stands in for
  CORS. If test 01 reports status 0, that rule did not take effect.
- Web Inspector works while the app runs: `sdb shell` and the debug port that
  Tizen Studio prints on launch. The on-screen log exists so you can debug from
  the couch without it.
- Once this passes, the next unknown is QR login plus WBI signing from inside
  the app. That is spike 2, and it is a different kind of problem — no platform
  mystery, just following the API docs.
