#!/bin/bash
# BuildHall — Bring your AI to the Hall (macOS / Linux)
# Run with:  curl -fsSL https://buildhall.ai/setup.sh | bash
set -e
echo ""
echo " BuildHall setup starting..."
echo ""
if ! command -v node >/dev/null 2>&1; then
  echo " Node.js is not installed — your AI CLIs need it too."
  echo " Get it from https://nodejs.org , install, then run this again."
  echo " Full step-by-step help: https://buildhall.ai/connect"
  exit 1
fi
TMPFILE="$(mktemp -t buildhall-setup.XXXXXX.mjs)"
curl -fsSL https://buildhall.ai/setup.mjs -o "$TMPFILE"
# When run via `curl | bash`, stdin is the pipe — reattach the terminal so
# the setup can ask its questions (device name).
if [ -t 0 ]; then node "$TMPFILE"; else node "$TMPFILE" < /dev/tty; fi
