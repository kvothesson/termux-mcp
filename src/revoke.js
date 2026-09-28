// Revoca todos los tokens: Claude tendrá que volver a autorizarse con el PIN.
// Uso: node src/revoke.js   (o: npm run revoke)
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, expandHome } from './config.js';

let stateDir = DEFAULTS.stateDir;
try {
  const cfgFile = process.env.TERMUX_MCP_CONFIG || new URL('../config.json', import.meta.url).pathname;
  const c = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  if (c.stateDir) stateDir = c.stateDir;
} catch { /* sin config: usar el valor por defecto */ }

const file = path.join(path.resolve(expandHome(stateDir)), 'oauth-state.json');
if (!fs.existsSync(file)) {
  console.log('No hay tokens guardados.');
  process.exit(0);
}
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const n = Object.keys(data.access || {}).length + Object.keys(data.refresh || {}).length;
data.access = {};
data.refresh = {};
fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
console.log(`Revocados ${n} tokens. Si el servidor está corriendo, reinicialo para que tome el cambio.`);
