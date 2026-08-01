#!/bin/zsh
# Refresh the playurl, sign, install and launch the spike on the living-room TV.
# One command per iteration: zsh tools/deploy.sh
set -e

ROOT="${0:A:h:h}"
APP="$ROOT/app"

export PATH="$HOME/tizen-studio/tools:$HOME/tizen-studio/tools/ide/bin:$PATH"

CERT_DIR="$HOME/tizen-studio-data/SamsungCertificate/BiliSpike"
CA_DIR="$HOME/tizen-studio-data/samsung-ca"
PROFILES="$HOME/tizen-studio-data/profile/profiles.xml"
PW="CHANGEME"
PROFILE="SamsungBili"
TV_IP="192.168.1.100"
TV="$TV_IP:26101"
TARGET="UE65XXXXXXXXXX"
APP_ID="BiLiSpiKe0.BiliSpike"

# Progressive-download link for tests 01..03. These die after an hour or two,
# so it is refreshed on every deploy rather than pinned in config.js.
echo "== refreshing playurl =="
curl -s -m 20 -A "Mozilla/5.0" \
  "https://api.bilibili.com/x/player/playurl?bvid=BV1xx411c7XD&cid=3660440&qn=32&fnval=1" \
  -o /tmp/playurl.json
HOST_IP=$(ipconfig getifaddr en0)
APP="$APP" HOST_IP="$HOST_IP" python3 - <<'PY'
import json, os, re
app = os.environ["APP"]
d = json.load(open("/tmp/playurl.json"))
assert d["code"] == 0, d
url = d["data"]["durl"][0]["url"]
p = os.path.join(app, "js", "config.js")
src = open(p).read()
src = re.sub(r'var VIDEO_URL = "[^"]*";', 'var VIDEO_URL = ' + json.dumps(url) + ';', src, count=1)
# The results collector runs on this machine; the app posts its verdict there so
# a run does not have to be read off the TV screen.
src = re.sub(r'var REPORT_TO = "[^"]*";',
             'var REPORT_TO = "http://%s:8099/report";' % os.environ["HOST_IP"], src, count=1)
open(p, "w").write(src)
print("  playurl refreshed (%d chars), report -> %s" % (len(url), os.environ["HOST_IP"]))
PY

echo "== signing profile =="
if ! grep -q "profile name=\"$PROFILE\"" "$PROFILES" 2>/dev/null; then
  tizen security-profiles add -n "$PROFILE" -A \
    -a "$CERT_DIR/author.p12" -p "$PW" \
    -d "$CERT_DIR/distributor.p12" -dp "$PW" \
    -dc "$CA_DIR/vd_tizen_dev_public2.crt" \
    -c "$CA_DIR/vd_tizen_dev_author_ca.cer" >/dev/null
  # The CLI records password-file paths; tizen package wants them inline.
  PW="$PW" PROFILES="$PROFILES" python3 - <<'PY'
import os, re
p = os.environ["PROFILES"]
s = open(p).read()
s = re.sub(r'password="[^"]*\.pwd"', 'password="%s"' % os.environ["PW"], s)
open(p, "w").write(s)
PY
  echo "  profile $PROFILE created"
else
  echo "  profile $PROFILE already present"
fi
tizen cli-config "profiles.path=$PROFILES" >/dev/null

echo "== packaging =="
cd "$APP"
rm -f BiliSpike.wgt
tizen package -t wgt -s "$PROFILE" -- . 2>&1 | grep -E "Package File Location|error" || true

echo "== connecting =="
for i in $(seq 1 40); do
  sdb connect "$TV" >/dev/null 2>&1 || true
  if sdb devices 2>/dev/null | grep -q "$TV_IP.*device"; then echo "  connected"; break; fi
  sleep 5
done
sdb devices | grep -q "$TV_IP" || { echo "TV not reachable"; exit 1; }

echo "== installing =="
tizen install -n BiliSpike.wgt -t "$TARGET" 2>&1 | grep -E "install completed|successfully|failed|error" || true

echo "== launching =="
tizen run -p "$APP_ID" -t "$TARGET" 2>&1 | grep -E "successfully|failed" || true
echo "== done =="
