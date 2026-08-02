#!/bin/zsh
# Refresh the playurl, sign, install and launch the spike on the living-room TV.
# One command per iteration: zsh tools/deploy.sh
set -e

ROOT="${0:A:h:h}"
APP="$ROOT/app"

# --selftest ships a build that walks the whole flow on the device and reports
# each step, because the set blocks dlog, the inspector, and unattended remote
# control. Never leave it on in a build meant for watching.
SELFTEST=false
[ "$1" = "--selftest" ] && SELFTEST=true

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
APP="$APP" HOST_IP="$HOST_IP" SELFTEST="$SELFTEST" python3 - <<'PY'
import os, re
p = os.path.join(os.environ["APP"], "js", "config.js")
src = open(p).read()
src = re.sub(r'var REPORT_TO = "[^"]*";',
             'var REPORT_TO = "http://%s:8099/report";' % os.environ["HOST_IP"], src, count=1)
src = re.sub(r'var SELFTEST = [a-z]+;',
             'var SELFTEST = %s;' % os.environ.get("SELFTEST", "false"), src)
open(p, "w").write(src)
print("  report -> %s, selftest=%s" % (os.environ["HOST_IP"], os.environ.get("SELFTEST")))
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

# node --check only proves each file parses. It happily ships code that calls a
# function deleted from another file, which is exactly how a build went out where
# pressing OK on the home screen did nothing.
echo "== checking =="
for f in "$APP"/js/*.js; do node --check "$f" >/dev/null || { echo "  syntax error in $f"; exit 1; }; done
node "$ROOT/tools/lint.mjs" || { echo "  refuse to deploy"; exit 1; }
# The account layer fails silently on the device — history filed under the wrong
# person, a cookie riding along from the previous account — so it is verified
# against a fake localStorage here, where a wrong answer is an assertion.
node "$ROOT/tools/md5-verify.mjs" >/dev/null || { echo "  md5 is wrong; TV login would be rejected"; exit 1; }
node "$ROOT/tools/accounts-verify.mjs" || { echo "  refuse to deploy"; exit 1; }
# An invalid manifest does not throw — the player refuses it and the viewer just
# sees a spinner. One unescaped ampersand in a stream url is enough to cause it.
node "$ROOT/tools/mpd-verify.mjs" >/dev/null || { echo "  the DASH manifest is malformed"; exit 1; }

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

# The flag is now inside the package, so put the source back before anything can
# commit it. It escaped once: `var SELFTEST = true;` reached master and, worse,
# the television kept a build that walked the whole flow — playing videos and
# pressing its own buttons — every single time it was opened.
python3 - <<PY
import os, re
p = os.path.join("$APP", "js", "config.js")
src = open(p).read()
open(p, "w").write(re.sub(r'var SELFTEST = [a-z]+;', 'var SELFTEST = false;', src))
PY

# The set only accepts sdb from the address registered in Developer Mode. When
# DHCP moves this machine, the failure is a silent timeout, so say plainly what
# happened rather than leaving it to be rediscovered.
EXPECTED_HOST="192.168.1.10"
if [ "$HOST_IP" != "$EXPECTED_HOST" ]; then
  echo "!! this machine is now $HOST_IP, but the TV is set to allow $EXPECTED_HOST"
  echo "   sdb will time out until they match. Either:"
  echo "     - TV: Apps > press 12345 > set Host PC IP to $HOST_IP, then full power cycle"
  echo "     - or give this machine a DHCP reservation for $EXPECTED_HOST on the router"
  echo "   and update EXPECTED_HOST in this script if you settle on a new address."
fi

echo "== connecting =="
for i in $(seq 1 40); do
  sdb connect "$TV" >/dev/null 2>&1 || true
  if sdb devices 2>/dev/null | grep -q "$TV_IP.*device"; then echo "  connected"; break; fi
  sleep 5
done
sdb devices | grep -q "$TV_IP" || {
  echo "TV not reachable at $TV_IP."
  echo "  - is it awake? the set drops sdb in standby"
  echo "  - does Developer Mode still list $HOST_IP as the host PC?"
  exit 1
}

echo "== installing =="
tizen install -n "$(basename "$WGT")" -t "$TARGET" 2>&1 \
  | grep -E "install completed|successfully|failed|error" \
  || { echo "  install produced no recognisable result"; exit 1; }

echo "== launching =="
tizen run -p "$APP_ID" -t "$TARGET" 2>&1 | grep -E "successfully|failed" || true
echo "== done =="

# Said last, where it cannot be scrolled past. A selftest build is not something
# to leave on a television somebody is about to use: it starts playing by itself
# and works the remote for a minute every time the app opens.
if [ "$SELFTEST" = "true" ]; then
  echo
  echo "!! 电视上现在装的是自测构建：每次打开都会自己跑一遍整套流程。"
  echo "!! 看电视之前先装回正常构建： zsh tools/deploy.sh"
fi
