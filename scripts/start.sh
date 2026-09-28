#!/data/data/com.termux/files/usr/bin/bash
# Levanta el túnel de Cloudflare y el servidor. Muestra la URL para claude.ai.
set -euo pipefail
cd "$(dirname "$0")/.."
RUN=~/.termux-mcp/run
mkdir -p "$RUN"

if [ -f "$RUN/server.pid" ] && kill -0 "$(cat "$RUN/server.pid")" 2>/dev/null; then
  echo "Ya está corriendo. Usá ./scripts/stop.sh para apagarlo."; exit 1
fi

PORT=$(node -e 'try{console.log(require("./config.json").port||8787)}catch{console.log(8787)}')
command -v termux-wake-lock >/dev/null && termux-wake-lock || true

if [ -n "${CF_TUNNEL_TOKEN:-}" ]; then
  # Túnel con nombre (URL fija). PUBLIC_URL debe estar en config.json o en el entorno.
  cloudflared tunnel --no-autoupdate run --token "$CF_TUNNEL_TOKEN" > "$RUN/tunnel.log" 2>&1 &
  echo $! > "$RUN/tunnel.pid"
  URL="${PUBLIC_URL:-$(node -e 'console.log(require("./config.json").publicUrl||"")')}"
  [ -z "$URL" ] && { echo "Falta publicUrl en config.json para el túnel con nombre."; exit 1; }
else
  # Túnel rápido: sin cuenta, la URL cambia cada vez.
  cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" > "$RUN/tunnel.log" 2>&1 &
  echo $! > "$RUN/tunnel.pid"
  echo "Esperando la URL del túnel…"
  URL=""
  for _ in $(seq 1 30); do
    URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$RUN/tunnel.log" | head -1 || true)
    [ -n "$URL" ] && break
    sleep 1
  done
  [ -z "$URL" ] && { echo "No se pudo obtener la URL. Mirá $RUN/tunnel.log"; ./scripts/stop.sh; exit 1; }
fi

PUBLIC_URL="$URL" nohup node src/server.js > "$RUN/server.log" 2>&1 &
echo $! > "$RUN/server.pid"
sleep 2
if ! kill -0 "$(cat "$RUN/server.pid")" 2>/dev/null; then
  echo "El servidor no arrancó:"; cat "$RUN/server.log"; ./scripts/stop.sh; exit 1
fi

echo
echo "================================================"
echo " URL del conector:  $URL/mcp"
echo "================================================"
echo "Pegala en claude.ai > Configuración > Conectores > Agregar conector personalizado."
echo "Log de actividad:   tail -f ~/.termux-mcp/audit.log"
echo "Para apagar:        ./scripts/stop.sh"
