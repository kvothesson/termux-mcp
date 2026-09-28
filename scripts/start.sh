#!/data/data/com.termux/files/usr/bin/bash
# Starts the Cloudflare tunnel and the server, then prints the URL for claude.ai.
set -euo pipefail
cd "$(dirname "$0")/.."
RUN=~/.termux-mcp/run
mkdir -p "$RUN"

if [ -f "$RUN/server.pid" ] && kill -0 "$(cat "$RUN/server.pid")" 2>/dev/null; then
  echo "Already running. Use ./scripts/stop.sh to stop it."; exit 1
fi

PORT=$(node -e 'try{console.log(require("./config.json").port||8787)}catch{console.log(8787)}')
command -v termux-wake-lock >/dev/null && termux-wake-lock || true

if [ -n "${CF_TUNNEL_TOKEN:-}" ]; then
  # Named tunnel (fixed URL). PUBLIC_URL must be in config.json or the environment.
  cloudflared tunnel --no-autoupdate run --token "$CF_TUNNEL_TOKEN" > "$RUN/tunnel.log" 2>&1 &
  echo $! > "$RUN/tunnel.pid"
  URL="${PUBLIC_URL:-$(node -e 'console.log(require("./config.json").publicUrl||"")')}"
  [ -z "$URL" ] && { echo "Missing publicUrl in config.json for the named tunnel."; exit 1; }
else
  # Quick tunnel: no account needed, but the URL changes every time.
  cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" > "$RUN/tunnel.log" 2>&1 &
  echo $! > "$RUN/tunnel.pid"
  echo "Waiting for the tunnel URL…"
  URL=""
  for _ in $(seq 1 30); do
    URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$RUN/tunnel.log" | head -1 || true)
    [ -n "$URL" ] && break
    sleep 1
  done
  [ -z "$URL" ] && { echo "Could not get the URL. Check $RUN/tunnel.log"; ./scripts/stop.sh; exit 1; }
fi

PUBLIC_URL="$URL" nohup node src/server.js > "$RUN/server.log" 2>&1 &
echo $! > "$RUN/server.pid"
sleep 2
if ! kill -0 "$(cat "$RUN/server.pid")" 2>/dev/null; then
  echo "The server did not start:"; cat "$RUN/server.log"; ./scripts/stop.sh; exit 1
fi

echo
echo "================================================"
echo " Connector URL:  $URL/mcp"
echo "================================================"
echo "Paste it in claude.ai > Settings > Connectors > Add custom connector."
echo "Activity log:    tail -f ~/.termux-mcp/audit.log"
echo "To stop:         ./scripts/stop.sh"
