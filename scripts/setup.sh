#!/data/data/com.termux/files/usr/bin/bash
# Instala dependencias y crea config.json. Correr una sola vez dentro de Termux.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Instalando paquetes de Termux (nodejs, cloudflared, termux-api)…"
pkg update -y
pkg install -y nodejs-lts cloudflared termux-api

echo "==> Instalando dependencias de Node…"
npm install --omit=dev

if [ ! -f config.json ]; then
  echo
  echo "==> Elegí un PIN (mínimo 8 caracteres). Lo vas a escribir para autorizar a Claude."
  while true; do
    read -rsp "PIN: " PIN1; echo
    read -rsp "Repetilo: " PIN2; echo
    if [ "$PIN1" != "$PIN2" ]; then echo "No coinciden."; continue; fi
    if [ ${#PIN1} -lt 8 ]; then echo "Muy corto."; continue; fi
    break
  done
  PIN="$PIN1" node -e '
    const fs = require("fs");
    const c = JSON.parse(fs.readFileSync("config.example.json", "utf8"));
    c.pin = process.env.PIN;
    fs.writeFileSync("config.json", JSON.stringify(c, null, 2), { mode: 0o600 });
  '
  echo "config.json creado."
else
  echo "config.json ya existe, no lo toco."
fi

mkdir -p ~/claude-workspace

if [ ! -d ~/storage/shared ]; then
  echo
  echo "==> Acceso de LECTURA al almacenamiento del celu (para analizar espacio y carpetas)."
  echo "    Android te va a pedir permiso: tocá Permitir."
  termux-setup-storage || true
fi
echo
echo "Listo. Para arrancar:  ./scripts/start.sh"
echo "Importante: abrí una vez la app Termux:API y dale los permisos que pida."
