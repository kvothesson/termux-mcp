# termux-mcp

Servidor MCP que corre en tu celular Android (dentro de Termux) para que Claude, desde claude.ai o la app, pueda ejecutar acciones en el celu: comandos de una lista blanca, archivos de una carpeta de trabajo y algunas funciones del teléfono (batería, notificaciones, portapapeles, vibrar).

```
Claude (claude.ai) ──HTTPS──> Cloudflare ──túnel──> cloudflared (celu) ──> termux-mcp (127.0.0.1:8787)
```

El servidor solo escucha en el propio celu (127.0.0.1). La única entrada desde internet es el túnel de Cloudflare, que sale desde el celu: no hace falta abrir puertos y funciona con datos móviles.

## Qué puede hacer Claude

| Herramienta | Qué hace |
|---|---|
| `run_command` | Ejecuta comandos de la **lista blanca**, sin shell (sin pipes, `;`, `>`, `$`) |
| `list_dir`, `read_file` | Lee la carpeta de trabajo (`~/claude-workspace`) y, en **solo lectura**, el almacenamiento del celu (`~/storage/shared`) |
| `storage_overview` | Resume el almacenamiento: espacio por carpeta y por tipo, archivos más grandes, grandes y viejos, posibles duplicados |
| `system_info` | Modelo, Android, parche de seguridad, chip, RAM, disco, tiempo encendido, batería |
| `write_file` | Crea o modifica archivos en la carpeta de trabajo (se puede apagar) |
| `delete_file` | Borra archivos. **Apagado por defecto** (`allowDelete`) |
| `battery_status`, `wifi_info`, `clipboard_get` | Datos del celu vía Termux:API |
| `notify`, `clipboard_set`, `vibrate` | Notificación, copiar texto, vibrar |

No puede tocar la pantalla, manejar otras apps, ver datos internos de otras apps ni qué apps gastan batería o RAM: Android no lo permite sin root (con ADB desde una PC sí).

## Seguridad

- **OAuth con PIN**: al conectar, claude.ai te abre una página donde escribís tu PIN. Sin eso no hay acceso.
- 5 PIN incorrectos → bloqueo de 15 minutos.
- Tokens guardados solo como hash; access token de 60 min, refresh token de 30 días con rotación.
- Lista blanca de comandos y bloqueo de opciones peligrosas (`find -exec`, `-delete`, etc.).
- Escritura solo en la carpeta de trabajo. El almacenamiento del celu (`readRoots`) es de **solo lectura**; cualquier otra ruta está bloqueada, incluso en argumentos de comandos (también se controlan los symlinks).
- Log de todo lo que se ejecuta en `~/.termux-mcp/audit.log`.
- **Kill switch**: `./scripts/stop.sh` apaga todo al instante.

## Instalación (todo desde el celu)

1. Instalá **F-Droid** (f-droid.org) y desde ahí **Termux** y **Termux:API**. No uses las versiones de Play Store: están desactualizadas.
2. Abrí Termux:API una vez y aceptá los permisos que pida.
3. En Termux:

   ```bash
   pkg install -y git
   git clone https://github.com/kvothesson/termux-mcp
   cd termux-mcp
   ./scripts/setup.sh
   ```

   El repo es privado: `git clone` te pide usuario y contraseña. La contraseña **no** es la de tu cuenta: es un token que creás en github.com → Settings → Developer settings → Personal access tokens → *Fine-grained*, con acceso de solo lectura a este repo.

   `setup.sh` instala Node, cloudflared y termux-api, te pide que elijas el **PIN** (mínimo 8 caracteres; mejor una frase) y corre `termux-setup-storage` para dar acceso de lectura al almacenamiento (Android pide permiso: tocá *Permitir*).

## Uso

```bash
./scripts/start.sh
```

Te muestra algo como:

```
URL del conector:  https://palabras-al-azar.trycloudflare.com/mcp
```

1. En claude.ai → **Configuración → Conectores → Agregar conector personalizado**, pegá esa URL.
2. Al conectar se abre la página de autorización: escribí tu PIN.
3. En una conversación, activá el conector y pedile cosas a Claude: "¿cuánta batería tengo?", "creá notas/compras.txt con…".

Apagar: `./scripts/stop.sh`. Ver actividad en vivo: `tail -f ~/.termux-mcp/audit.log`.

### La URL cambia en cada inicio

El túnel rápido de Cloudflare no requiere cuenta pero da una URL nueva cada vez: hay que editar el conector con la URL nueva. Para una URL fija, creá un túnel con nombre en Cloudflare (cuenta gratis + un dominio), poné `"publicUrl": "https://tu-dominio"` en `config.json` y arrancá con:

```bash
CF_TUNNEL_TOKEN=tu-token ./scripts/start.sh
```

### Que Android no lo mate

- `start.sh` activa `termux-wake-lock`.
- En Ajustes → Apps → Termux → Batería, elegí **Sin restricciones**.
- Encendelo solo cuando lo uses: gasta batería.

## Configuración (`config.json`)

| Clave | Por defecto | |
|---|---|---|
| `pin` | — | Obligatorio, mínimo 8 caracteres |
| `workspace` | `~/claude-workspace` | Única carpeta con escritura |
| `readRoots` | `["~/storage/shared"]` | Carpetas de solo lectura. `[]` para quitar el acceso al almacenamiento |
| `allowedCommands` | `ls`, `cat`, `grep`, … | Lista blanca |
| `allowWrite` | `true` | Habilita `write_file` |
| `allowDelete` | `false` | Habilita `delete_file` |
| `allowPathsOutsideWorkspace` | `false` | Permite rutas fuera de la carpeta en los comandos (no recomendado) |
| `commandTimeoutMs` | `15000` | Tiempo máximo por comando |

Después de cambiar la configuración: `./scripts/stop.sh && ./scripts/start.sh`.

## Si algo sale mal

- **Cortar todo**: `./scripts/stop.sh`.
- **Revocar el acceso de Claude** (tendrá que volver a pedir el PIN): `npm run revoke` y reiniciar.
- **Cambiar el PIN**: editá `config.json` y reiniciá.
- Logs: `~/.termux-mcp/run/server.log` y `~/.termux-mcp/run/tunnel.log`.

## Riesgos

- Estás exponiendo parte de tu celu a internet. El PIN es lo que lo protege: usá uno largo y no lo compartas.
- Con `readRoots` activo, Claude puede **leer** todo el almacenamiento compartido: fotos, descargas, documentos, backups de WhatsApp. Si no querés eso, poné `"readRoots": []`.
- Agregar comandos a la lista blanca amplía lo que se puede hacer. Nunca agregues `sh`, `bash`, `node`, `python`, `rm`, `curl` ni similares: equivalen a darle una terminal completa.
- Si ves en el log algo que no pediste, apagalo y revocá los tokens.

## Desarrollo

```bash
npm install
npm test
```
