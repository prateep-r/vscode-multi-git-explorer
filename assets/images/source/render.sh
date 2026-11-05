#!/usr/bin/env bash
# Redraws the README images in assets/images:
#
#   assets/images/source/render.sh
#
# Needs python3 and Google Chrome (set CHROME to use another Chromium build).
# The pages load the codicon font from cdn.jsdelivr.net.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
out=$(dirname "$here")
chrome=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cd "$work"
python3 "$here/draw.py"
python3 "$here/light.py" overview.html overview-light.html
python3 "$here/light.py" diff.html diff-light.html

shoot() { # name width,height
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --virtual-time-budget=6000 --window-size="$2" --screenshot="$out/$1.png" "file://$work/$1.html" >/dev/null 2>&1
  echo "  $1.png"
}

shoot overview 1280,780
shoot overview-light 1280,780
shoot explorer 1000,560
shoot filter 1280,640
shoot diff 1280,460
shoot diff-light 1280,460
shoot chat 1280,520
shoot menu 1000,700
shoot switch-branch 1280,420
