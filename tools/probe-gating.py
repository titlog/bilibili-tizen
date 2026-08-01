"""Ask the playurl API in several client guises and report, for each returned
CDN url, whether the CDN serves it without a Referer header."""
import json, subprocess, sys

B = "bvid=BV1xx411c7XD&cid=3660440"
HDR = ["-H", "Referer: https://www.bilibili.com", "-H", "User-Agent: Mozilla/5.0"]

VARIANTS = [
    ("web baseline",   f"https://api.bilibili.com/x/player/playurl?{B}&qn=32&fnval=1"),
    ("platform=android", f"https://api.bilibili.com/x/player/playurl?{B}&qn=32&fnval=1&platform=android"),
    ("platform=ios",    f"https://api.bilibili.com/x/player/playurl?{B}&qn=32&fnval=1&platform=ios"),
    ("platform=tv",     f"https://api.bilibili.com/x/player/playurl?{B}&qn=32&fnval=1&platform=tv"),
    ("tv ugc endpoint", f"https://api.bilibili.com/x/tv/ugc/playurl?{B}&qn=32&fnval=1"),
    ("pgc-style fnval=0", f"https://api.bilibili.com/x/player/playurl?{B}&qn=32&fnval=0"),
]

def curl(args, timeout=25):
    try:
        return subprocess.run(["curl", "-s", "-m", str(timeout)] + args,
                              capture_output=True, text=True, timeout=timeout + 10).stdout
    except subprocess.TimeoutExpired:
        return ""

for name, url in VARIANTS:
    raw = curl(HDR + [url])
    try:
        d = json.loads(raw)
    except Exception:
        print(f"  {name:20s} -> non-JSON response")
        continue
    code = d.get("code")
    data = d.get("data") or d.get("result") or {}
    durl = data.get("durl") if isinstance(data, dict) else None
    if code != 0 or not durl:
        msg = (d.get("message") or "")[:40]
        print(f"  {name:20s} -> api code={code} {msg}")
        continue
    u = durl[0]["url"]
    host = u.split("/")[2]
    noref = curl(["-o", "/dev/null", "-w", "%{http_code}", "-r", "0-1023", u])
    print(f"  {name:20s} -> {host:38s} no-Referer={noref}")
