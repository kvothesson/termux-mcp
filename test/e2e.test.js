// Prueba de punta a punta: registro OAuth, PIN, PKCE, token y llamadas MCP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { DEFAULTS } from '../src/config.js';

let server, base, cfg;
const PIN = 'pin-de-prueba-123';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

before(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmcp-'));
  cfg = { ...DEFAULTS, pin: PIN, workspace: path.join(tmp, 'ws'), stateDir: path.join(tmp, 'state'), audit: () => {} };
  fs.mkdirSync(cfg.workspace);
  fs.mkdirSync(cfg.stateDir);
  fs.writeFileSync(path.join(cfg.workspace, 'hola.txt'), 'hola mundo\n');
  await new Promise((resolve) => {
    // Puerto provisorio para conocer la URL; luego se arma la app real.
    const probe = createApp({ ...cfg, publicUrl: 'http://localhost:1' }).app.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => {
        cfg.publicUrl = `http://localhost:${port}`;
        server = createApp(cfg).app.listen(port, '127.0.0.1', resolve);
        base = cfg.publicUrl;
      });
    });
  });
});

after(() => server?.close());

async function getToken() {
  const reg = await fetch(`${base}/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' })
  }).then((r) => r.json());
  assert.ok(reg.client_id);

  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' });
  const page = await fetch(`${base}/authorize?${q}`).then((r) => r.text());
  const id = page.match(/name="id" value="([^"]+)"/)[1];

  const bad = await fetch(`${base}/approve`, { method: 'POST', body: new URLSearchParams({ id, pin: 'incorrecto' }), redirect: 'manual' });
  assert.equal(bad.status, 401);

  const ok = await fetch(`${base}/approve`, { method: 'POST', body: new URLSearchParams({ id, pin: PIN }), redirect: 'manual' });
  assert.equal(ok.status, 302);
  const loc = new URL(ok.headers.get('location'));
  assert.equal(loc.searchParams.get('state'), 'xyz');
  const code = loc.searchParams.get('code');

  const tok = await fetch(`${base}/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: REDIRECT })
  }).then((r) => r.json());
  assert.ok(tok.access_token, JSON.stringify(tok));

  // El código es de un solo uso.
  const reuse = await fetch(`${base}/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: REDIRECT })
  });
  assert.equal(reuse.status, 400);
  return { ...tok, client_id: reg.client_id };
}

async function rpc(token, method, params = {}) {
  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const body = await r.text();
  const data = body.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(data ? data.slice(6) : body);
}

test('sin token no hay acceso y se anuncian los metadatos OAuth', async () => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /resource_metadata=/);
  const meta = await fetch(`${base}/.well-known/oauth-authorization-server`).then((x) => x.json());
  assert.ok(meta.registration_endpoint);
  const bad = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer falso', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(bad.status, 401);
});

test('flujo completo: PIN, token y herramientas', async () => {
  const { access_token, refresh_token, client_id } = await getToken();

  const init = await rpc(access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'termux-mcp');

  const list = await rpc(access_token, 'tools/list');
  const names = list.result.tools.map((t) => t.name);
  for (const n of ['run_command', 'read_file', 'write_file', 'list_dir', 'battery_status', 'notify']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('delete_file'), 'borrar está apagado por defecto');

  const call = (name, args) => rpc(access_token, 'tools/call', { name, arguments: args }).then((r) => r.result);

  let r = await call('run_command', { command: 'cat hola.txt' });
  assert.match(r.content[0].text, /hola mundo/);
  r = await call('run_command', { command: 'rm hola.txt' });
  assert.ok(r.isError);
  r = await call('run_command', { command: 'cat /etc/passwd' });
  assert.ok(r.isError);

  r = await call('write_file', { path: 'notas/a.txt', content: 'desde claude' });
  assert.ok(!r.isError);
  r = await call('read_file', { path: 'notas/a.txt' });
  assert.equal(r.content[0].text, 'desde claude');
  r = await call('read_file', { path: '../state/oauth-state.json' });
  assert.ok(r.isError);
  r = await call('list_dir', { path: '.' });
  assert.match(r.content[0].text, /notas/);

  // Termux:API no existe acá: debe fallar prolijo, sin tirar el servidor.
  r = await call('battery_status', {});
  assert.ok(r.isError);
  assert.match(r.content[0].text, /No se encontró/);

  // Refresh token con rotación.
  const ref = await fetch(`${base}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token, client_id }) }).then((x) => x.json());
  assert.ok(ref.access_token);
  const again = await fetch(`${base}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token, client_id }) });
  assert.equal(again.status, 400);
});

test('bloqueo tras varios PIN incorrectos', async () => {
  const reg = await fetch(`${base}/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Atacante', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' })
  }).then((r) => r.json());
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' });
  const page = await fetch(`${base}/authorize?${q}`).then((r) => r.text());
  const id = page.match(/name="id" value="([^"]+)"/)[1];
  let last;
  for (let i = 0; i < cfg.maxPinAttempts + 1; i++) {
    last = await fetch(`${base}/approve`, { method: 'POST', body: new URLSearchParams({ id, pin: 'nope' + i }), redirect: 'manual' });
  }
  assert.equal(last.status, 429);
  // Aun con el PIN correcto, sigue bloqueado.
  const ok = await fetch(`${base}/approve`, { method: 'POST', body: new URLSearchParams({ id, pin: PIN }), redirect: 'manual' });
  assert.equal(ok.status, 429);
});
