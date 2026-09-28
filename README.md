# termux-mcp

An MCP server that runs on your Android phone (inside Termux) so Claude, from claude.ai or the Claude app, can act on the phone: run allowlisted commands, work with files in a workspace folder, read the phone's storage, and use a few phone features (battery, notifications, clipboard, vibration).

```
Claude (claude.ai) ──HTTPS──> Cloudflare ──tunnel──> cloudflared (phone) ──> termux-mcp (127.0.0.1:8787)
```

The server only listens on the phone itself (127.0.0.1). The only way in from the internet is the Cloudflare tunnel, which is opened *from* the phone: no ports to open, and it works on mobile data.

## What Claude can do

| Tool | What it does |
|---|---|
| `run_command` | Runs **allowlisted** commands, without a shell (no pipes, `;`, `>`, `$`) |
| `list_dir`, `read_file` | Reads the workspace (`~/claude-workspace`) and, **read-only**, the phone's storage (`~/storage/shared`) |
| `recent_files` | Newest files in a folder, optionally filtered by type (e.g. the latest downloads or WhatsApp documents) |
| `storage_overview` | Where the space goes: per folder and per file type, largest files, large old files, likely duplicates |
| `system_info` | Model, Android version, security patch, chip, RAM, storage, uptime, battery |
| `write_file` | Creates or edits files in the workspace (can be disabled) |
| `delete_file` | Deletes workspace files. **Off by default** (`allowDelete`) |
| `battery_status`, `wifi_info`, `clipboard_get` | Phone data through Termux:API |
| `notify`, `clipboard_set`, `vibrate` | Show a notification, copy text, vibrate |

What it **cannot** do: look at images (only list them), tap the screen, control other apps, read other apps' private data (e.g. WhatsApp chats, which are encrypted), or see which apps use battery or RAM. Android does not allow that without root (ADB from a computer can do some of it).

> **Reading a WhatsApp chat:** in WhatsApp open the chat → ⋮ → More → **Export chat** → *Without media* → save it to Downloads. Then ask Claude to read it.

## Security

- **OAuth with a PIN**: when connecting, claude.ai opens a page where you type your PIN. No PIN, no access.
- The PIN page shows where access will be sent (for claude.ai: `claude.ai`) and cannot be embedded in another site.
- 5 wrong PINs → approvals are locked for 15 minutes.
- Tokens are stored only as hashes; 60-minute access tokens, 30-day refresh tokens with rotation.
- Command allowlist, and options that could write or execute are blocked in every form — spaced, `--long=…` or glued to the flag (`find -exec`/`-delete`, `sort -o`/`--compress-program`, `file -f`, and a write output operand for `uniq`).
- Writes only inside the workspace. The phone storage (`readRoots`) is **read-only**; every other path is blocked, including in command arguments (symlinks are checked too).
- Every tool call is logged to `~/.termux-mcp/audit.log`.
- Hung commands (e.g. an unresponsive Termux:API) are killed on a timeout instead of blocking the server.
- **Kill switch**: `./scripts/stop.sh` shuts everything down instantly.

## Install (everything from the phone)

1. Install **F-Droid** (f-droid.org) and, from it, **Termux** and **Termux:API**. Don't use the Play Store versions: they are outdated, and both apps must come from the same source.
2. Open Termux:API once.
3. In Termux:

   ```bash
   pkg install -y git
   git clone https://github.com/kvothesson/termux-mcp
   cd termux-mcp
   ./scripts/setup.sh
   ```

   `setup.sh` installs Node, cloudflared and termux-api, asks you to choose the **PIN** (at least 8 characters; a phrase is better) and runs `termux-setup-storage` to grant read access to storage (Android asks for permission: tap *Allow*).

## Usage

```bash
./scripts/start.sh
```

It prints something like:

```
Connector URL:  https://random-words.trycloudflare.com/mcp
```

1. In claude.ai → **Settings → Connectors → Add custom connector**, paste that URL. Leave *Client ID* and *Client Secret* empty.
2. When connecting, the authorization page opens: type your PIN.
3. In a conversation, enable the connector and ask Claude things: "how much battery do I have?", "analyze my storage", "what did I download last?", "create notes/shopping.txt with…".

Stop: `./scripts/stop.sh`. Watch activity live: `tail -f ~/.termux-mcp/audit.log`.

### Updating

```bash
./scripts/stop.sh
git pull
npm install --omit=dev
./scripts/start.sh
```

### The URL changes on every start

Cloudflare's quick tunnel needs no account but gives a new URL each time, so the connector has to be removed and added again with the new URL (Settings → Connectors). For a fixed URL, create a named tunnel in Cloudflare (free account + a domain), set `"publicUrl": "https://your-domain"` in `config.json` and start with:

```bash
CF_TUNNEL_TOKEN=your-token ./scripts/start.sh
```

### Keeping Android from killing it

- `start.sh` enables `termux-wake-lock`.
- In Settings → Apps → **Termux** and **Termux:API** → Battery, choose **Unrestricted**.
- Only run it while you use it: it costs battery.

## Configuration (`config.json`)

| Key | Default | |
|---|---|---|
| `pin` | — | Required, at least 8 characters |
| `workspace` | `~/claude-workspace` | The only folder with write access |
| `readRoots` | `["~/storage/shared"]` | Read-only folders. `[]` removes access to the phone storage |
| `allowedCommands` | `ls`, `cat`, `grep`, … | Command allowlist |
| `allowWrite` | `true` | Enables `write_file` |
| `allowDelete` | `false` | Enables `delete_file` |
| `allowPathsOutsideWorkspace` | `false` | Allows any path in command arguments (not recommended) |
| `commandTimeoutMs` | `15000` | Maximum time per command |
| `maxOutputBytes` | `65536` | Maximum command output returned to Claude |
| `maxFileBytes` | `1048576` | Largest file `read_file`/`write_file` will handle |
| `accessTokenTtlMin` / `refreshTokenTtlDays` | `60` / `30` | Token lifetimes |
| `maxPinAttempts` | `5` | Wrong PINs before approvals lock for 15 minutes |

After changing the configuration: `./scripts/stop.sh && ./scripts/start.sh`.

## Troubleshooting

- **"Could not sign in" / no PIN page**: check `tail -30 ~/.termux-mcp/run/server.log`; every request is logged. Make sure the connector uses the *current* URL.
- **502 Bad Gateway**: the tunnel dropped (common with patchy mobile signal). Restart with `stop.sh` + `start.sh` and update the connector URL.
- **Termux:API commands hang** (`termux-battery-status` never returns): force-stop Termux:API, set its battery usage to *Unrestricted*, open it once. Cancel a hung command in Termux with **Volume Down + C**.
- **Revoke Claude's access** (it will have to ask for the PIN again): `npm run revoke`, then restart.
- **Change the PIN**: edit `config.json` and restart.
- Logs: `~/.termux-mcp/run/server.log` and `~/.termux-mcp/run/tunnel.log`.

## Risks

- You are exposing part of your phone to the internet. The PIN is what protects it: use a long one and don't share it.
- With `readRoots` enabled, Claude can **read** everything in shared storage: downloads, documents, WhatsApp media (file names and text files). That includes files other people sent you. If you don't want that, set `"readRoots": []`.
- Adding commands to the allowlist widens what can be done. Never add `sh`, `bash`, `node`, `python`, `rm`, `curl` or similar: that amounts to handing over a full terminal.
- If the log shows something you didn't ask for, stop the server and revoke the tokens.

## Development

```bash
npm install
npm test
```

The tests cover path confinement, the command allowlist, hung-process handling, the full OAuth + PIN flow, and the read-only storage.
