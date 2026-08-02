#!/bin/bash
# BuildHall AI Bridge setup for macOS.
# If double-clicking says it can't be opened: right-click > Open, or run
#   bash ~/Downloads/BuildHall-Bridge-Setup.command
set -e
BASE="${1:-https://buildhall.ai}"
DIR="$HOME/Library/Application Support/BuildHall"
echo ""
echo "  BuildHall AI Bridge setup"
echo "  -------------------------"
if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js is required. Opening nodejs.org - install it, then run this again."
  open "https://nodejs.org"
  exit 1
fi
echo "  Node found: $(node --version)"
mkdir -p "$DIR/public"
echo "  Downloading the bridge from $BASE ..."
for f in $(curl -fsSL "$BASE/download/manifest.json" | python3 -c "import sys,json;[print(x) for x in json.load(sys.stdin)['files']]"); do
  curl -fsSL "$BASE/bridge-src/$f" -o "$DIR/$f"
done
cat > "$HOME/Desktop/BuildHall Bridge.command" <<EOF
#!/bin/bash
cd "$DIR"
mkdir -p "\$HOME/.buildhall"
nohup node server.mjs >> "\$HOME/.buildhall/bridge.log" 2>&1 &
sleep 1
open "http://127.0.0.1:7391"
EOF
chmod +x "$HOME/Desktop/BuildHall Bridge.command"
echo ""
echo "  Installed. 'BuildHall Bridge' is on your Desktop."
echo "  Starting it now."
bash "$HOME/Desktop/BuildHall Bridge.command"
