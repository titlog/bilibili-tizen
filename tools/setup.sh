#!/bin/zsh
# One-time setup: ask for the four things that describe *your* television and
# *your* machine, then write them where deploy.sh will find them.
#
# This exists because the alternative is a README telling strangers to edit
# constants in three files. Everything it asks for is discovered on the device
# itself; nothing here is guessable, and a wrong value fails in a way that looks
# like something else entirely — a wrong host IP makes sdb time out silently,
# and a wrong DUID yields a certificate that signs fine and installs nothing.
#
#   zsh tools/setup.sh
set -e

ROOT="${0:A:h:h}"
CONF="${BILI_TIZEN_CONF:-$HOME/.bilibili-tizen.conf}"
[ -f "$CONF" ] && source "$CONF"

export PATH="$HOME/tizen-studio/tools:$HOME/tizen-studio/tools/ide/bin:$PATH"

echo "== bilibili-tizen 一次性配置 =="
echo

# ---- 1. prerequisites, checked before anything is asked ----
missing=""
command -v node >/dev/null 2>&1 || missing="$missing node"
command -v python3 >/dev/null 2>&1 || missing="$missing python3"
command -v sdb  >/dev/null 2>&1 || missing="$missing sdb(tizen-studio)"
command -v tizen >/dev/null 2>&1 || missing="$missing tizen(tizen-studio)"
if [ -n "$missing" ]; then
  echo "缺少：$missing"
  echo
  echo "sdb 和 tizen 来自 Tizen Studio；只需要它的 CLI，不需要 IDE："
  echo "  https://developer.tizen.org/development/tizen-studio/download"
  echo "装完确认它们在 ~/tizen-studio/tools 和 ~/tizen-studio/tools/ide/bin 下。"
  exit 1
fi

# ---- 2. this machine's address on the LAN ----
# Offered as a menu rather than typed: this is the value the television must be
# told to trust, and a typo here is the silent-timeout failure mode.
echo "1/4  这台电脑在局域网里的地址"
ifs=($(ifconfig -l | tr ' ' '\n' | grep -E '^(en|eth|bridge)' ))
i=1; cands=()
for nif in $ifs; do
  ip=$(ipconfig getifaddr "$nif" 2>/dev/null || true)
  [ -n "$ip" ] || continue
  echo "     $i) $nif  $ip"
  cands+=("$nif:$ip"); i=$((i+1))
done
[ ${#cands[@]} -gt 0 ] || { echo "     没有找到已联网的网卡"; exit 1; }
if [ ${#cands[@]} -eq 1 ]; then
  pick=1
  echo "     （只有一个，直接用它）"
else
  echo -n "     选哪个？[1] "; read pick; pick=${pick:-1}
fi
NET_IF="${cands[$pick]%%:*}"
HOST_IP="${cands[$pick]##*:}"
echo "     -> $NET_IF $HOST_IP"
echo

# ---- 3. the television ----
echo "2/4  电视的局域网地址"
echo "     电视上：设置 > 支持 > 关于本机，或者路由器的客户端列表"
echo -n "     地址 [${BILI_TV_IP:-192.168.1.100}]: "; read ans
TV_IP="${ans:-${BILI_TV_IP:-192.168.1.100}}"

echo
echo "     电视上开启开发者模式（如果还没开）："
echo "       Apps 页面 > 用遥控器按 1 2 3 4 5 > Developer mode 打开"
echo "       Host PC IP 填：$HOST_IP"
echo "       然后【完整断电重启】—— 不重启不生效，这一条吃过亏"
echo -n "     开好了按回车继续…"; read _

echo "     连接中…"
sdb connect "$TV_IP:26101" >/dev/null 2>&1 || true
if sdb devices 2>/dev/null | grep -q "$TV_IP.*device"; then
  TARGET=$(sdb devices | grep "$TV_IP" | awk '{print $3}')
  echo "     -> 已连接，型号 $TARGET"
else
  echo "     !! 连不上 $TV_IP:26101"
  echo "        电视醒着吗？待机时 sdb 会掉。"
  echo "        Host PC IP 确实填的是 $HOST_IP 吗？改完必须完整断电重启。"
  exit 1
fi
echo

# ---- 4. DUID ----
# Read off the device where possible; the Developer Mode panel shows it too, but
# people mistype it, and this is the value a wrong guess ruins a certificate with.
echo "3/4  电视的 DUID（证书要绑定到这台机器）"
DUID_AUTO=$(sdb shell 'echo $(cat /opt/etc/duid-gadget 2>/dev/null)' 2>/dev/null | tr -d '\r\n ' || true)
case "$DUID_AUTO" in (*[!A-Za-z0-9]*|"") DUID_AUTO="";; esac
if [ -n "$DUID_AUTO" ]; then
  echo "     从电视上读到：$DUID_AUTO"
  echo -n "     用这个？[Y/n] "; read ans
  case "$ans" in [Nn]*) DUID_AUTO="";; esac
fi
if [ -z "$DUID_AUTO" ]; then
  echo "     零售机上 sdb shell 通常是关的，读不到就手输："
  echo "     电视 > Apps > 按 12345，面板里显示的那串"
  echo -n "     DUID [${BILI_TV_DUID:-}]: "; read ans
  DUID_AUTO="${ans:-${BILI_TV_DUID:-}}"
fi
[ -n "$DUID_AUTO" ] || { echo "     没有 DUID 就签不出证书"; exit 1; }
TV_DUID="$DUID_AUTO"
echo "     -> $TV_DUID"
echo

# ---- 5. write it down ----
echo "4/4  写入配置"
cat > "$CONF" <<EOF
# bilibili-tizen —— tools/setup.sh 生成，deploy.sh 每次读取。
# 故意放在仓库外：这里描述的是你的电视和你的网络，不是这个项目。
BILI_NET_IF="$NET_IF"
BILI_HOST_IP="$HOST_IP"
BILI_TV_IP="$TV_IP"
BILI_TV_TARGET="$TARGET"
BILI_TV_DUID="$TV_DUID"
BILI_PROFILE="${BILI_PROFILE:-SamsungBili}"
BILI_APP_ID="${BILI_APP_ID:-BiLiSpiKe0.BiliSpike}"
EOF
chmod 600 "$CONF"
echo "     -> $CONF"
echo

# ---- 6. certificate ----
CERT_DIR="$HOME/tizen-studio-data/SamsungCertificate/${CERT_PROFILE:-BiliSpike}"
if [ -f "$CERT_DIR/author.p12" ] && [ -f "$CERT_DIR/distributor.p12" ]; then
  echo "证书已存在，跳过签发。"
else
  echo "接下来要签发三星证书。"
  echo "  这一步会打开浏览器让你登录三星账号（免费注册即可）。"
  echo "  三星自己的分发证书在这一代电视上一律 Invalid certificate chain，"
  echo "  所以必须是三星签发的那套 —— 这也是 Tizen Studio 的 GUI 之外没有别的路的原因。"
  echo -n "  现在签发？[Y/n] "; read ans
  case "$ans" in
    [Nn]*) echo "  跳过。之后手动跑：TV_DUID=$TV_DUID node tools/samsung-cert.mjs" ;;
    *) TV_DUID="$TV_DUID" node "$ROOT/tools/samsung-cert.mjs" ;;
  esac
fi

echo
echo "== 完成 =="
echo "接下来："
echo "  终端 1：node tools/collect.mjs      # 诊断收集器，一直开着"
echo "  终端 2：zsh tools/deploy.sh         # 检查、签名、安装、启动"
