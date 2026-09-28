#!/data/data/com.termux/files/usr/bin/bash
# Kill switch: apaga el servidor y el túnel.
cd "$(dirname "$0")/.."
RUN=~/.termux-mcp/run
for n in server tunnel; do
  if [ -f "$RUN/$n.pid" ]; then
    kill "$(cat "$RUN/$n.pid")" 2>/dev/null && echo "Apagado: $n"
    rm -f "$RUN/$n.pid"
  fi
done
command -v termux-wake-unlock >/dev/null && termux-wake-unlock || true
echo "Listo. Nadie puede conectarse ahora."
