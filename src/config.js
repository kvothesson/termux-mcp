// Loads and validates the configuration (config.json at the project root,
// or the path given in TERMUX_MCP_CONFIG).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULTS = {
  port: 8787,
  host: '127.0.0.1',
  // The only folder with write access, and the working directory for commands.
  workspace: '~/claude-workspace',
  // Extra folders that can be READ (never written). ~/storage/shared appears
  // after running termux-setup-storage and is the phone's internal storage.
  readRoots: ['~/storage/shared'],
  // State folder (OAuth clients, tokens, audit log).
  stateDir: '~/.termux-mcp',
  // Only these programs can be run with run_command.
  allowedCommands: [
    'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'find', 'du', 'df', 'pwd',
    'date', 'uptime', 'whoami', 'uname', 'echo', 'stat', 'file', 'sort', 'uniq',
    'getprop', 'free', 'nproc',
    'termux-battery-status', 'termux-wifi-connectioninfo', 'termux-telephony-deviceinfo'
  ],
  allowWrite: true,
  allowDelete: false,
  commandTimeoutMs: 15000,
  maxOutputBytes: 64 * 1024,
  maxFileBytes: 1024 * 1024,
  // Access token lifetime, in minutes.
  accessTokenTtlMin: 60,
  // Refresh token lifetime, in days.
  refreshTokenTtlDays: 30,
  // Failed PIN attempts before approval is locked for 15 minutes.
  maxPinAttempts: 5
};

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function loadConfig(overrides = {}) {
  const file = process.env.TERMUX_MCP_CONFIG || path.join(ROOT, 'config.json');
  let fromFile = {};
  if (fs.existsSync(file)) {
    fromFile = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const cfg = { ...DEFAULTS, ...fromFile, ...overrides };

  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (process.env.PUBLIC_URL) cfg.publicUrl = process.env.PUBLIC_URL;
  if (process.env.TERMUX_MCP_PIN) cfg.pin = process.env.TERMUX_MCP_PIN;

  cfg.workspace = path.resolve(expandHome(cfg.workspace));
  cfg.stateDir = path.resolve(expandHome(cfg.stateDir));

  if (!cfg.pin || String(cfg.pin).length < 8) {
    throw new Error('Missing "pin" in config.json (at least 8 characters). It is the code you type to authorize Claude.');
  }
  if (!cfg.publicUrl) {
    throw new Error('Missing the public URL (PUBLIC_URL). Use scripts/start.sh, which gets it from the tunnel.');
  }
  const u = new URL(cfg.publicUrl);
  if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) {
    throw new Error('PUBLIC_URL must be https.');
  }
  cfg.publicUrl = u.origin;

  fs.mkdirSync(cfg.workspace, { recursive: true });
  fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  return cfg;
}
