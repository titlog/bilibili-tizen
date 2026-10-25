#!/bin/zsh
# The gate every package goes through, whether it is headed for the living-room
# TV (deploy.sh) or for strangers (release.sh). One copy, so the two can never
# drift: a check added to only one of them is a check the other ships without.
# Exits non-zero on the first failure; callers refuse to package.
set -e

ROOT="${0:A:h:h}"
APP="$ROOT/app"

# node --check only proves each file parses. It happily ships code that calls a
# function deleted from another file, which is exactly how a build went out where
# pressing OK on the home screen did nothing.
echo "== checking =="
# Two things a fresh clone does not bring, asked for up front: otherwise they
# surface as a stack trace from whichever check happens to need them (#4 — Node
# 18 died in diag-verify, a clone without the packages died in mpd-verify).
# diag-verify runs the worker on node:sqlite, unflagged from Node 22.13.
node --no-warnings -e 'require("node:sqlite")' >/dev/null 2>&1 || {
  echo "  需要 Node 22.13 或更新（现在是 $(node --version 2>/dev/null || echo '没装')）"; exit 1; }
(cd "$ROOT/tools" && node --input-type=module -e 'await import("fast-xml-parser")') >/dev/null 2>&1 || {
  echo "  tools 的依赖没装：npm install --prefix tools"; exit 1; }
for f in "$APP"/js/*.js; do node --check "$f" >/dev/null || { echo "  syntax error in $f"; exit 1; }; done
node "$ROOT/tools/lint.mjs" || exit 1
# The account layer fails silently on the device — history filed under the wrong
# person, a cookie riding along from the previous account — so it is verified
# against a fake localStorage here, where a wrong answer is an assertion.
node "$ROOT/tools/md5-verify.mjs" >/dev/null || { echo "  md5 is wrong; TV login would be rejected"; exit 1; }
node "$ROOT/tools/accounts-verify.mjs" || exit 1
# An invalid manifest does not throw — the player refuses it and the viewer just
# sees a spinner. One unescaped ampersand in a stream url is enough to cause it.
node "$ROOT/tools/mpd-verify.mjs" >/dev/null || { echo "  the DASH manifest is malformed"; exit 1; }
# Mirrors are ordered, never dropped. Dropping one played fine for a day and
# then walled every 1080p video the evening the primary CDN went sour.
node "$ROOT/tools/mirrors-verify.mjs" >/dev/null || { echo "  mirror ordering is wrong"; exit 1; }
# The interactive features (PR #2): a write must never leave without a
# credential, and a hold on OK opens the menu without starting the video.
node "$ROOT/tools/compat-api-verify.mjs" || { echo "  video actions or library API regressed"; exit 1; }
node "$ROOT/tools/gated-verify.mjs" || { echo "  the ways round bilibili's gates regressed (ranking -352, writes refused for their Origin)"; exit 1; }
node "$ROOT/tools/nav-verify.mjs" || { echo "  remote navigation regressed"; exit 1; }
node "$ROOT/tools/episode-nav-verify.mjs" || { echo "  episode shortcuts regressed"; exit 1; }
# Tizen 5.5 has no flex gap. A new gap without its fallback looks fine on any
# set made since, and cramped on the ones this check exists for.
node "$ROOT/tools/legacy-css-verify.mjs" || exit 1
# Self-update can ship code to every installed set, so its trust root is checked
# here: the public key is real, boot.js agrees with config.xml about the version,
# and every way of tampering with an update is refused for its own reason.
node "$ROOT/tools/update-verify.mjs" >/dev/null || { echo "  self-update verification failed (node tools/update-verify.mjs)"; exit 1; }
# Diagnostics leave the television: a title or a name in what is sent looks
# exactly like a working upload, and an upload that never happens looks like a
# set with no problems. Both ends are run here, the worker on node:sqlite.
node "$ROOT/tools/diag-verify.mjs" >/dev/null || { echo "  diagnostics upload regressed (node tools/diag-verify.mjs)"; exit 1; }
# 弹幕: parsing, dedupe and lane allocation. A lane bug does not throw — it draws
# comments on top of each other, or none at all.
node "$ROOT/tools/danmaku-verify.mjs" >/dev/null || { echo "  danmaku parsing or lanes regressed"; exit 1; }
