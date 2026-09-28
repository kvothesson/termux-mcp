// Carga y valida la configuración (config.json en la raíz del proyecto
// o la ruta indicada en TERMUX_MCP_CONFIG).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULTS = {
  port: 8787,
  host: '127.0.0.1',
  // Carpeta a la que se limitan las herramientas de archivos y el cwd de los comandos.
  workspace: '~/claude-workspace',
  // Carpeta de estado (clientes OAuth, tokens, log de auditoría).
  stateDir: '~/.termux-mcp',
  // Solo estos programas se pueden ejecutar con run_command.
  allowedCommands: [
    'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'find', 'du', 'df', 'pwd',
    'date', 'uptime', 'whoami', 'uname', 'echo', 'stat', 'file', 'sort', 'uniq',
    'termux-battery-status', 'termux-wifi-connectioninfo', 'termux-telephony-deviceinfo'
  ],
  allowWrite: true,
  allowDelete: false,
  commandTimeoutMs: 15000,
  maxOutputBytes: 64 * 1024,
  maxFileBytes: 1024 * 1024,
  // Minutos de vida del access token.
  accessTokenTtlMin: 60,
  // Días de vida del refresh token.
  refreshTokenTtlDays: 30,
  // Intentos fallidos de PIN antes de bloquear la aprobación por 15 minutos.
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
    throw new Error('Falta "pin" en config.json (mínimo 8 caracteres). Es la clave que vas a escribir para autorizar a Claude.');
  }
  if (!cfg.publicUrl) {
    throw new Error('Falta la URL pública (PUBLIC_URL). Usá scripts/start.sh, que la obtiene del túnel.');
  }
  const u = new URL(cfg.publicUrl);
  if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) {
    throw new Error('PUBLIC_URL tiene que ser https.');
  }
  cfg.publicUrl = u.origin;

  fs.mkdirSync(cfg.workspace, { recursive: true });
  fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  return cfg;
}
