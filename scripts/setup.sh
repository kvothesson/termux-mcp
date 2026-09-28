#!/data/data/com.termux/files/usr/bin/bash
# Installs dependencies and creates config.json. Run once inside Termux.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Installing Termux packages (nodejs, cloudflared, termux-api, imagemagick)…"
pkg update -y
pkg install -y nodejs-lts cloudflared termux-api imagemagick

echo "==> Installing Node dependencies…"
npm install --omit=dev

if [ ! -f config.json ]; then
  echo
  echo "==> Choose a PIN (at least 8 characters). You will type it to authorize Claude."
  while true; do
    read -rsp "PIN: " PIN1; echo
    read -rsp "Repeat it: " PIN2; echo
    if [ "$PIN1" != "$PIN2" ]; then echo "They don't match."; continue; fi
    if [ ${#PIN1} -lt 8 ]; then echo "Too short."; continue; fi
    break
  done
  PIN="$PIN1" node -e '
    const fs = require("fs");
    const c = JSON.parse(fs.readFileSync("config.example.json", "utf8"));
    c.pin = process.env.PIN;
    fs.writeFileSync("config.json", JSON.stringify(c, null, 2), { mode: 0o600 });
  '
  echo "config.json created."
else
  echo "config.json already exists, leaving it as is."
fi

mkdir -p ~/claude-workspace

if [ ! -d ~/storage/shared ]; then
  echo
  echo "==> READ access to the phone's storage (to analyze space, folders and images)."
  echo "    Android will ask for permission: tap Allow."
  termux-setup-storage || true
fi

echo
echo "Done. To start:  ./scripts/start.sh"
echo "Important: open the Termux:API app once and grant any permissions it asks for."
