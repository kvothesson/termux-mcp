// End-to-end test: OAuth registration, PIN, PKCE, tokens and MCP tool calls.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { DEFAULTS } from '../src/config.js';

let server, base, cfg;
const PIN = 'test-pin-123';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const hasMagick = (() => { try { execFileSync('convert', ['-version']); return true; } catch { return false; } })();

before(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmcp-'));
  const shared = path.join(tmp, 'shared');
  cfg = { ...DEFAULTS, pin: PIN, workspace: path.join(tmp, 'ws'), stateDir: path.join(tmp, 'state'), readRoots: [shared], audit: () => {} };
  cfg.shared = shared;
  const wa = path.join(shared, 'Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images');
  fs.mkdirSync(path.join(shared, 'DCIM/Camera'), { recursive: true });
  fs.mkdirSync(path.join(shared, 'Download'), { recursive: true });
  fs.mkdirSync(wa, { recursive: true });
  fs.writeFileSync(path.join(shared, 'DCIM/Camera/photo.jpg'), Buffer.alloc(3 * 1024 * 1024));
  fs.writeFileSync(path.join(shared, 'Download/photo.jpg'), Buffer.alloc(3 * 1024 * 1024));
  fs.writeFileSync(path.join(shared, 'Download/app.apk'), Buffer.alloc(5 * 1024 * 1024));
  fs.writeFileSync(path.join(shared, 'Download/readme.txt'), 'shared text');
  if (hasMagick) {
    execFileSync('convert', ['-size', '3000x2000', 'xc:red', path.join(wa, 'IMG-old.jpg')]);
    execFileSync('convert', ['-size', '400x300', 'xc:blue', path.join(wa, 'IMG-new.png')]);
    const old = new Date(Date.now() - 86400 * 1000);
    fs.utimesSync(path.join(wa, 'IMG-old.jpg'), old, old);
  }
  fs.mkdirSync(cfg.workspace);
  fs.mkdirSync(cfg.stateDir);
  fs.writeFileSync(path.join(cfg.workspace, 'hello.txt'), 'hello world\n');
  await new Promise((resolve) => {
    // Temporary port to learn the URL; then build the real app on it.
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

  const bad = await fetch(`${base}/approve`, { method: 'POST', body: new URLSearchParams({ id, pin: 'wrong' }), redirect: 'manual' });
  assert.equal(bad.status, 401);

  const ok = await fetch(`${base}/approve`, { method: 'POST', body: new URLSearchParams({ id, pin: PIN }), redirect: 'manual' });
  assert.equal(ok.status, 302);
  const loc = new URL(ok.headers.get('location'));
  assert.equal(loc.searchParams.get('state'), 'xyz');
  const code = loc.searchParams.get('code');

  const exchange = () => fetch(`${base}/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: REDIRECT })
  });
  const tok = await exchange().then((r) => r.json());
  assert.ok(tok.access_token, JSON.stringify(tok));
  assert.equal((await exchange()).status, 400, 'codes are single use');
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

test('no access without a token; OAuth metadata is advertised', async () => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /resource_metadata=/);
  for (const p of ['oauth-authorization-server', 'openid-configuration']) {
    const meta = await fetch(`${base}/.well-known/${p}`).then((x) => x.json());
    assert.ok(meta.registration_endpoint);
    assert.equal(meta.issuer, base, 'issuer without trailing slash');
  }
  for (const p of ['oauth-protected-resource', 'oauth-protected-resource/mcp']) {
    const pr = await fetch(`${base}/.well-known/${p}`).then((x) => x.json());
    assert.deepEqual(pr.authorization_servers, [base]);
  }
  const bad = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer fake', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(bad.status, 401);
});

test('full flow: PIN, token and tools', async () => {
  const { access_token, refresh_token, client_id } = await getToken();

  const init = await rpc(access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'termux-mcp');

  const list = await rpc(access_token, 'tools/list');
  const names = list.result.tools.map((t) => t.name);
  for (const n of ['run_command', 'read_file', 'write_file', 'list_dir', 'recent_files', 'view_image', 'battery_status', 'notify', 'storage_overview', 'system_info']) {
    assert.ok(names.includes(n), n);
  }
  assert.ok(!names.includes('delete_file'), 'delete is off by default');

  const call = (name, args) => rpc(access_token, 'tools/call', { name, arguments: args }).then((r) => r.result);

  let r = await call('run_command', { command: 'cat hello.txt' });
  assert.match(r.content[0].text, /hello world/);
  r = await call('run_command', { command: 'rm hello.txt' });
  assert.ok(r.isError);
  r = await call('run_command', { command: 'cat /etc/passwd' });
  assert.ok(r.isError);

  r = await call('write_file', { path: 'notes/a.txt', content: 'from claude' });
  assert.ok(!r.isError);
  r = await call('read_file', { path: 'notes/a.txt' });
  assert.equal(r.content[0].text, 'from claude');
  r = await call('read_file', { path: '../state/oauth-state.json' });
  assert.ok(r.isError);
  r = await call('list_dir', { path: '.' });
  assert.match(r.content[0].text, /notes/);

  // Shared storage: readable, never writable.
  r = await call('read_file', { path: path.join(cfg.shared, 'Download/readme.txt') });
  assert.equal(r.content[0].text, 'shared text');
  r = await call('list_dir', { path: path.join(cfg.shared, 'Download') });
  assert.match(r.content[0].text, /app\.apk/);
  r = await call('write_file', { path: path.join(cfg.shared, 'Download/x.txt'), content: 'no' });
  assert.ok(r.isError);
  assert.ok(!fs.existsSync(path.join(cfg.shared, 'Download/x.txt')));
  r = await call('run_command', { command: `ls ${path.join(cfg.shared, 'DCIM')}` });
  assert.match(r.content[0].text, /Camera/);

  r = await call('storage_overview', {});
  assert.ok(!r.isError, r.content[0].text);
  assert.match(r.content[0].text, /Download/);
  assert.match(r.content[0].text, /Installers \(APK\)/);
  assert.match(r.content[0].text, /Likely duplicates.*1 groups/);

  r = await call('system_info', {});
  assert.ok(!r.isError);
  assert.match(r.content[0].text, /## Memory/);
  assert.match(r.content[0].text, /CPU cores: \d+/);

  // No Termux:API here: must fail cleanly without taking the server down.
  r = await call('battery_status', {});
  assert.ok(r.isError);
  assert.match(r.content[0].text, /was not found/);

  // Refresh token with rotation.
  const refresh = () => fetch(`${base}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token, client_id }) });
  assert.ok((await refresh().then((x) => x.json())).access_token);
  assert.equal((await refresh()).status, 400);
});

test('recent files and images', { skip: !hasMagick && 'ImageMagick not installed' }, async () => {
  const { access_token } = await getToken();
  const call = (name, args) => rpc(access_token, 'tools/call', { name, arguments: args }).then((r) => r.result);

  let r = await call('recent_files', { extensions: ['images'], limit: 5 });
  assert.ok(!r.isError, r.content[0].text);
  const lines = r.content[0].text.split('\n');
  assert.match(lines[0], /IMG-new\.png/, 'newest first');
  assert.ok(lines.some((l) => /IMG-old\.jpg/.test(l)));
  assert.ok(!lines.some((l) => /app\.apk/.test(l)), 'filtered by extension');

  const wa = path.join(cfg.shared, 'Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images');
  r = await call('view_image', { path: path.join(wa, 'IMG-old.jpg') });
  assert.ok(!r.isError, JSON.stringify(r).slice(0, 300));
  assert.equal(r.content[0].type, 'image');
  assert.equal(r.content[0].mimeType, 'image/jpeg');
  const tmp = path.join(os.tmpdir(), `out-${process.pid}.jpg`);
  fs.writeFileSync(tmp, Buffer.from(r.content[0].data, 'base64'));
  const [w, h] = execFileSync('identify', ['-format', '%w %h', tmp]).toString().split(' ').map(Number);
  assert.ok(w <= 1280 && h <= 1280 && w === 1280, `resized to ${w}x${h}`);

  r = await call('view_image', { path: path.join(cfg.shared, 'Download/readme.txt') });
  assert.ok(r.isError, 'text file is not an image');
  r = await call('view_image', { path: '/etc/hostname.png' });
  assert.ok(r.isError, 'outside allowed folders');
});

test('lockout after several wrong PINs', async () => {
  const reg = await fetch(`${base}/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Attacker', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' })
  }).then((r) => r.json());
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' });
  const page = await fetch(`${base}/authorize?${q}`).then((r) => r.text());
  const id = page.match(/name="id" value="([^"]+)"/)[1];
  let last;
  for (let i = 0; i < cfg.maxPinAttempts + 1; i++) {
    last = await fetch(`${base}/approve`, { method: 'POST', body: new URLSearchParams({ id, pin: 'nope' + i }), redirect: 'manual' });
  }
  assert.equal(last.status, 429);
  // Still locked, even with the right PIN.
  const ok = await fetch(`${base}/approve`, { method: 'POST', body: new URLSearchParams({ id, pin: PIN }), redirect: 'manual' });
  assert.equal(ok.status, 429);
});
