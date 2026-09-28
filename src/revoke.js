// Revokes every token: Claude will have to authorize again with the PIN.
// Usage: node src/revoke.js   (or: npm run revoke)
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, expandHome } from './config.js';

let stateDir = DEFAULTS.stateDir;
try {
  const cfgFile = process.env.TERMUX_MCP_CONFIG || new URL('../config.json', import.meta.url).pathname;
  const c = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  if (c.stateDir) stateDir = c.stateDir;
} catch { /* no config: use the default */ }

const file = path.join(path.resolve(expandHome(stateDir)), 'oauth-state.json');
if (!fs.existsSync(file)) {
  console.log('No stored tokens.');
  process.exit(0);
}
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const n = Object.keys(data.access || {}).length + Object.keys(data.refresh || {}).length;
data.access = {};
data.refresh = {};
fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
console.log(`Revoked ${n} tokens. If the server is running, restart it so the change takes effect.`);
