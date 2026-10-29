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
# --dmperf: the danmaku frame-time run instead (selftest.js, 2026-10-18) — the
# ways of drawing rotated on one dense video, rAF intervals per window.
[ "$1" = "--dmperf" ] && SELFTEST='"dmperf"'
# --tokenswap: a web-token 403 made to order mid-play (selftest.js, 2026-10-20) —
# checks the strong token is swapped in without a rebuild, and that the next
# video starts on it; then (10-29) a third video's lead host made unreachable and
# the next one's signature spoiled, as on no account: no swap, no rebuild. Two
# spoiled requests to the CDN per run.
[ "$1" = "--tokenswap" ] && SELFTEST='"tokenswap"'
# --diag: the diagnostics upload through 设置 and from an incident (selftest.js,
# 2026-10-21), sent to BILI_DIAG_TO — by default tools/diag-local.mjs on this
# machine, which has to be running: node tools/diag-local.mjs
[ "$1" = "--diag" ] && SELFTEST='"diag"'

export PATH="$HOME/tizen-studio/tools:$HOME/tizen-studio/tools/ide/bin:$PATH"

CERT_DIR="$HOME/tizen-studio-data/SamsungCertificate/${CERT_PROFILE:-BiliSpike}"
CA_DIR="$HOME/tizen-studio-data/samsung-ca"
PROFILES="$HOME/tizen-studio-data/profile/profiles.xml"
# The certificate password lives outside the repo. The p12 files it protects are
# not in version control either, but a password in a git history is a habit worth
# not forming. Read only when the profile has to be built from them (below): a
# profile made in Tizen Studio's Certificate Manager and named in BILI_PROFILE
# needs none of this, and requiring it anyway had people commenting the profile
# step out by hand (issue #4).
PW_FILE="$HOME/.bilibili-tizen-cert-password"
# Everything below describes one particular television on one particular LAN, so
# none of it is hardcoded any more: `tools/setup.sh` writes ~/.bilibili-tizen.conf
# once. Device/network values can still be overridden per invocation from the
# environment; the application ID comes from the package manifest so a renamed
# app cannot be installed successfully and then launch an older package.
CONF="${BILI_TIZEN_CONF:-$HOME/.bilibili-tizen.conf}"
# The file assigns every BILI_* it knows, so sourcing it plainly let the file
# overrule the environment — BILI_PROFILE=… zsh tools/deploy.sh signed and
# installed with the file's profile. Put the environment's values back on top.
ENV_BILI=$(typeset -p -m 'BILI_*' 2>/dev/null)
[ -f "$CONF" ] && source "$CONF"
eval "$ENV_BILI"

PROFILE="${BILI_PROFILE:-SamsungBili}"
TV_IP="${BILI_TV_IP:-}"
TARGET="${BILI_TV_TARGET:-}"
APP_ID=$(sed -n 's/.*<tizen:application id="\([^"]*\)".*/\1/p' "$APP/config.xml" | head -n 1)
[ -n "$APP_ID" ] || { echo "app/config.xml 中找不到应用 ID"; exit 1; }

if [ -z "$TV_IP" ]; then
  echo "没有配置电视地址。先跑一次：zsh tools/setup.sh"
  echo "（或临时指定：BILI_TV_IP=<电视地址> zsh tools/deploy.sh）"
  exit 1
fi
TV="$TV_IP:26101"

# The interface the television reports back over. On a laptop with both Wi-Fi and
# a dock this is not always en0, and a wrong guess sends diagnostics into a void
# with no error anywhere — the failure this project has burned the most hours on.
NET_IF="${BILI_NET_IF:-en0}"

# The flags below go into the package, never into a commit. It escaped once:
# `var SELFTEST = true;` reached master and, worse, the television kept a build
# that walked the whole flow — playing videos and pressing its own buttons —
# every single time it was opened.
#
# REPORT_TO goes back to empty for the same reason (2026-09-07): it holds this
# machine's LAN address, the repository is public and the convention is that no
# address lives in it. Only SELFTEST was reset here, so every deploy left the
# working tree dirty with the address in it, one `git add -A` away from master.
#
# And on every exit, not only the one after packaging (2026-10-17): a failed
# check, a failed package or a Ctrl-C used to leave the script before the reset
# ran, with the address still sitting in config.js.
restore_config() {
  APP="$APP" python3 - <<'PY'
import os, re
p = os.path.join(os.environ["APP"], "js", "config.js")
src = open(p).read()
src = re.sub(r'var SELFTEST = (?:[a-z]+|"[a-z]+");', 'var SELFTEST = false;', src)
src = re.sub(r'var REPORT_TO = "[^"]*";', 'var REPORT_TO = "";', src, count=1)
src = re.sub(r'var DIAG_TO = "[^"]*";', 'var DIAG_TO = "";', src, count=1)
open(p, "w").write(src)
PY
}
trap restore_config EXIT
# A signal would otherwise end the script without running the EXIT trap.
trap 'exit 130' INT TERM

# The client fetches its own stream urls at runtime, so nothing needs pinning
# any more; only the dev reporting address is injected.
echo "== pointing reporting at this machine =="
HOST_IP=$(ipconfig getifaddr "$NET_IF")
[ -n "$HOST_IP" ] || { echo "拿不到 $NET_IF 的地址 — 用 BILI_NET_IF 指定网卡"; exit 1; }
# --diag with no address of its own (the conf's off is not one) goes to the local stand-in.
[ "$SELFTEST" = '"diag"' ] && [ "${BILI_DIAG_TO:-off}" = off ] && BILI_DIAG_TO="http://$HOST_IP:8097/v1/upload"
# BILI_DIAG_TO points this build's diagnostics uploads (diag.js) somewhere
# else — a local stand-in, to test that path on the television — or turns
# them off (BILI_DIAG_TO=off in the conf: this project's own machine, whose
# collector already has every line). Unset, a build from source uploads like a
# release package (from 10-23, issue #7: a stranger's source build failed and
# nothing reached anybody). Selftest builds never upload (diag.js).
APP="$APP" HOST_IP="$HOST_IP" SELFTEST="$SELFTEST" DIAG_TO="${BILI_DIAG_TO:-}" python3 - <<'PY'
import os, re
p = os.path.join(os.environ["APP"], "js", "config.js")
src = open(p).read()
src = re.sub(r'var REPORT_TO = "[^"]*";',
             'var REPORT_TO = "http://%s:8099/report";' % os.environ["HOST_IP"], src, count=1)
src = re.sub(r'var SELFTEST = (?:[a-z]+|"[a-z]+");',
             'var SELFTEST = %s;' % os.environ.get("SELFTEST", "false"), src)
src = re.sub(r'var DIAG_TO = "[^"]*";', 'var DIAG_TO = "%s";' % os.environ["DIAG_TO"], src, count=1)
open(p, "w").write(src)
print("  report -> %s, selftest=%s%s" % (os.environ["HOST_IP"], os.environ.get("SELFTEST"),
      ", diag -> " + os.environ["DIAG_TO"] if os.environ["DIAG_TO"] else ""))
PY

echo "== signing profile =="
if ! grep -q "profile name=\"$PROFILE\"" "$PROFILES" 2>/dev/null; then
  # Say which input is missing and what to do, instead of letting
  # `security-profiles add` fail inside a >/dev/null under set -e.
  need=("$PW_FILE" "$CERT_DIR/author.p12" "$CERT_DIR/distributor.p12"
        "$CA_DIR/vd_tizen_dev_public2.crt" "$CA_DIR/vd_tizen_dev_author_ca.cer")
  lack=()
  for f in "${need[@]}"; do [ -f "$f" ] || lack+=("$f"); done
  if [ ${#lack[@]} -gt 0 ]; then
    echo "  没有签名档 $PROFILE，也建不出来，缺："
    for f in "${lack[@]}"; do echo "    $f"; done
    echo "  二选一："
    echo "    · zsh tools/setup.sh —— 替这台电视签一套三星证书"
    echo "    · 已经在 Tizen Studio 证书管理器里建好了签名档：在 $CONF"
    echo "      里写 BILI_PROFILE=\"<签名档名字>\"（$PROFILES 里 profile name 那个）"
    case "${lack[*]}" in (*"$CA_DIR"*)
      echo "  CA 证书在 Tizen Studio 证书管理器的 org.tizen.common.cert_*.jar 里，res/ca/ 下面：" ;
      echo "    mkdir -p $CA_DIR && unzip -j -o \"\$(find ~/tizen-studio -name 'org.tizen.common.cert_*.jar' | head -n 1)\" 'res/ca/*' -d $CA_DIR" ;;
    esac
    exit 1
  fi
  PW=$(cat "$PW_FILE")
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

# Shared with release.sh, so the two can never disagree about what may ship.
zsh "$ROOT/tools/check.sh" || { echo "  refuse to deploy"; exit 1; }

echo "== packaging =="
cd "$APP"
# (N): zsh aborts on a glob with no matches, and after a failed packaging run
# there is no wgt left to match — the next deploy then died on this very line.
rm -f ./*.wgt(N)
tizen package -t wgt -s "$PROFILE" -- . 2>&1 | grep -E "Package File Location|error" || true
# tizen names the package after <name> in config.xml, so never hard-code it:
# renaming the app once left the installer pushing a stale wgt while the launch
# step happily started the previously installed build.
WGTS=(./*.wgt(N))
WGT=${WGTS[1]}
[ -n "$WGT" ] || { echo "packaging produced no wgt"; exit 1; }
echo "  built $WGT"

# The flags are inside the package now, so put the source back straight away
# rather than at exit: connecting can wait minutes for a sleeping TV, and the
# working tree should not carry the address through all of it.
restore_config

# The set only accepts sdb from the address registered in Developer Mode. When
# DHCP moves this machine, the failure is a silent timeout, so say plainly what
# happened rather than leaving it to be rediscovered.
# Recorded by setup.sh as the address that was registered on the TV. Empty on a
# machine that has not run setup, in which case there is nothing to compare and
# the warning simply does not fire.
EXPECTED_HOST="${BILI_HOST_IP:-}"
if [ -n "$EXPECTED_HOST" ] && [ "$HOST_IP" != "$EXPECTED_HOST" ]; then
  echo "!! this machine is now $HOST_IP, but the TV is set to allow $EXPECTED_HOST"
  echo "   sdb will time out until they match. Either:"
  echo "     - TV: Apps > press 12345 > set Host PC IP to $HOST_IP, then full power cycle"
  echo "     - or give this machine a DHCP reservation for $EXPECTED_HOST on the router"
  echo "   and re-run tools/setup.sh if you settle on a new address."
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
if [ "$SELFTEST" != "false" ]; then
  echo
  echo "!! 电视上现在装的是自测构建：每次打开都会自己跑一遍整套流程。"
  echo "!! 看电视之前先装回正常构建： zsh tools/deploy.sh"
fi
