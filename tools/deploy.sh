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
# The certificate password lives outside the repo. The p12 files it protects are
# not in version control either, but a password in a git history is a habit worth
# not forming.
PW_FILE="$HOME/.bilibili-tizen-cert-password"
[ -f "$PW_FILE" ] || { echo "missing $PW_FILE — see CLAUDE.md"; exit 1; }
PW=$(cat "$PW_FILE")
PROFILE="SamsungBili"
TV_IP="192.168.1.100"
TV="$TV_IP:26101"
TARGET="UE65XXXXXXXXXX"
APP_ID="BiLiSpiKe0.BiliSpike"

# The client fetches its own stream urls at runtime, so nothing needs pinning
# any more; only the dev reporting address is injected.
echo "== pointing reporting at this machine =="
HOST_IP=$(ipconfig getifaddr en0)
APP="$APP" HOST_IP="$HOST_IP" python3 - <<'PY'
import os, re
p = os.path.join(os.environ["APP"], "js", "config.js")
src = open(p).read()
src = re.sub(r'var REPORT_TO = "[^"]*";',
             'var REPORT_TO = "http://%s:8099/report";' % os.environ["HOST_IP"], src, count=1)
open(p, "w").write(src)
print("  report ->", os.environ["HOST_IP"])
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
rm -f ./*.wgt
tizen package -t wgt -s "$PROFILE" -- . 2>&1 | grep -E "Package File Location|error" || true
# tizen names the package after <name> in config.xml, so never hard-code it:
# renaming the app once left the installer pushing a stale wgt while the launch
# step happily started the previously installed build.
WGT=$(ls -1 ./*.wgt 2>/dev/null | head -1)
[ -n "$WGT" ] || { echo "packaging produced no wgt"; exit 1; }
echo "  built $WGT"

echo "== connecting =="
for i in $(seq 1 40); do
  sdb connect "$TV" >/dev/null 2>&1 || true
  if sdb devices 2>/dev/null | grep -q "$TV_IP.*device"; then echo "  connected"; break; fi
  sleep 5
done
sdb devices | grep -q "$TV_IP" || { echo "TV not reachable"; exit 1; }

echo "== installing =="
tizen install -n "$(basename "$WGT")" -t "$TARGET" 2>&1 \
  | grep -E "install completed|successfully|failed|error" \
  || { echo "  install produced no recognisable result"; exit 1; }

echo "== launching =="
tizen run -p "$APP_ID" -t "$TARGET" 2>&1 | grep -E "successfully|failed" || true
echo "== done =="
