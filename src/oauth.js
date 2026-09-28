// Minimal OAuth 2.1 server (PKCE + dynamic client registration) so claude.ai
// can connect. Access is approved by typing a PIN on a web page.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

const now = () => Math.floor(Date.now() / 1000);
const token = () => crypto.randomBytes(32).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function safeEqual(a, b) {
  const x = Buffer.from(sha(String(a)));
  const y = Buffer.from(sha(String(b)));
  return crypto.timingSafeEqual(x, y);
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Persistent on-disk state: registered clients and tokens (stored only as hashes). */
class Store {
  constructor(dir) {
    this.file = path.join(dir, 'oauth-state.json');
    this.data = { clients: {}, access: {}, refresh: {} };
    if (fs.existsSync(this.file)) {
      try { this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch { /* corrupt state: start fresh */ }
    }
    this.prune();
  }
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  prune() {
    const t = now();
    for (const kind of ['access', 'refresh']) {
      for (const [k, v] of Object.entries(this.data[kind])) if (v.expiresAt < t) delete this.data[kind][k];
    }
  }
  revokeAll() {
    this.data.access = {};
    this.data.refresh = {};
    this.save();
  }
}

export class PinOAuthProvider {
  constructor(cfg) {
    this.cfg = cfg;
    this.store = new Store(cfg.stateDir);
    this.codes = new Map(); // code -> { clientId, challenge, redirectUri, scopes, resource, expiresAt }
    this.pending = new Map(); // request id -> { client, params, expiresAt }
    this.failures = [];

    const store = this.store;
    this.clientsStore = {
      getClient: (id) => store.data.clients[id],
      registerClient: (client) => {
        const full = { ...client, client_id: crypto.randomUUID(), client_id_issued_at: now() };
        store.data.clients[full.client_id] = full;
        store.save();
        return full;
      }
    };
  }

  // Shows the page where the PIN is typed.
  async authorize(client, params, res) {
    this.prunePending();
    const id = token();
    const p = { client, params, expiresAt: now() + 600 };
    this.pending.set(id, p);
    this.sendPage(res, 200, this.page({ id, p }));
  }

  // Drops expired PIN requests and caps how many can be open at once, so
  // repeated /authorize calls cannot grow memory without bound.
  prunePending() {
    const t = now();
    for (const [k, v] of this.pending) if (v.expiresAt < t) this.pending.delete(k);
    while (this.pending.size >= 100) this.pending.delete(this.pending.keys().next().value);
  }

  // The PIN page must never be framed (clickjacking) or cached. No form-action:
  // browsers apply it to the redirect after /approve, which would block claude.ai.
  sendPage(res, status, html) {
    res.status(status)
      .set('X-Frame-Options', 'DENY')
      .set('Content-Security-Policy', "frame-ancestors 'none'; default-src 'none'; style-src 'unsafe-inline'")
      .set('Cache-Control', 'no-store')
      .set('Referrer-Policy', 'no-referrer')
      .type('html').send(html);
  }

  page({ id, p, error }) {
    const clientName = p.client.client_name || p.client.client_id;
    let dest = '';
    try { dest = new URL(p.params.redirectUri).host; } catch { /* shown as unknown */ }
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize access</title>
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:40px auto;padding:0 16px;color:#222}
h1{font-size:1.3rem}input,button{font-size:1.1rem;width:100%;padding:12px;box-sizing:border-box;margin-top:8px}
button{background:#1a73e8;color:#fff;border:0;border-radius:8px}.err{color:#b00020}.warn{background:#fff4e5;padding:10px;border-radius:8px}</style></head>
<body><h1>Authorize access to your phone</h1>
<p><b>${escapeHtml(clientName)}</b> wants to run tools on your phone (allowlisted commands, the workspace folder and read-only access to storage).</p>
<p>Access will be sent to: <b>${escapeHtml(dest || 'unknown')}</b></p>
<p class="warn">Only enter the PIN if you added this connector yourself and the address above is the one you expect (for claude.ai: <b>claude.ai</b>).</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/approve"><input type="hidden" name="id" value="${escapeHtml(id)}">
<input type="password" name="pin" placeholder="PIN" autocomplete="off" autofocus required>
<button type="submit">Authorize</button></form></body></html>`;
  }

  locked() {
    const cutoff = Date.now() - 15 * 60 * 1000;
    this.failures = this.failures.filter((t) => t > cutoff);
    return this.failures.length >= this.cfg.maxPinAttempts;
  }

  // Handles the PIN form submission.
  approve(req, res) {
    const { id, pin } = req.body || {};
    const p = this.pending.get(id);
    if (!p || p.expiresAt < now()) {
      this.pending.delete(id);
      return res.status(400).type('text').send('Request expired. Connect again from Claude.');
    }
    if (this.locked()) {
      return this.sendPage(res, 429, this.page({ id, p, error: 'Too many attempts. Wait 15 minutes.' }));
    }
    if (!pin || !safeEqual(pin, this.cfg.pin)) {
      this.failures.push(Date.now());
      this.cfg.audit?.({ event: 'pin_failed' });
      return this.sendPage(res, 401, this.page({ id, p, error: 'Wrong PIN.' }));
    }
    this.pending.delete(id);
    const code = token();
    this.codes.set(code, {
      clientId: p.client.client_id,
      challenge: p.params.codeChallenge,
      redirectUri: p.params.redirectUri,
      scopes: p.params.scopes || [],
      resource: p.params.resource?.href,
      expiresAt: now() + 300
    });
    this.cfg.audit?.({ event: 'authorized', client: p.client.client_name || p.client.client_id });
    const url = new URL(p.params.redirectUri);
    url.searchParams.set('code', code);
    if (p.params.state) url.searchParams.set('state', p.params.state);
    res.redirect(302, url.href);
  }

  async challengeForAuthorizationCode(client, code) {
    const c = this.codes.get(code);
    if (!c || c.clientId !== client.client_id || c.expiresAt < now()) throw new InvalidGrantError('Invalid or expired code.');
    return c.challenge;
  }

  issue(clientId, scopes, resource) {
    const access = token();
    const refresh = token();
    const t = now();
    const accessTtl = this.cfg.accessTokenTtlMin * 60;
    this.store.data.access[sha(access)] = { clientId, scopes, resource, expiresAt: t + accessTtl };
    this.store.data.refresh[sha(refresh)] = { clientId, scopes, resource, expiresAt: t + this.cfg.refreshTokenTtlDays * 86400 };
    this.store.prune();
    this.store.save();
    return { access_token: access, token_type: 'bearer', expires_in: accessTtl, refresh_token: refresh, scope: scopes.join(' ') };
  }

  async exchangeAuthorizationCode(client, code, _verifier, redirectUri) {
    const c = this.codes.get(code);
    this.codes.delete(code); // single use
    if (!c || c.clientId !== client.client_id || c.expiresAt < now()) throw new InvalidGrantError('Invalid or expired code.');
    if (redirectUri && redirectUri !== c.redirectUri) throw new InvalidGrantError('redirect_uri does not match.');
    return this.issue(client.client_id, c.scopes, c.resource);
  }

  async exchangeRefreshToken(client, refreshToken, scopes) {
    const key = sha(refreshToken);
    const r = this.store.data.refresh[key];
    if (!r || r.clientId !== client.client_id || r.expiresAt < now()) throw new InvalidGrantError('Invalid refresh token.');
    delete this.store.data.refresh[key]; // rotation
    return this.issue(client.client_id, scopes?.length ? scopes : r.scopes, r.resource);
  }

  async verifyAccessToken(accessToken) {
    const a = this.store.data.access[sha(accessToken)];
    if (!a || a.expiresAt < now()) throw new InvalidTokenError('Invalid or expired token.');
    return { token: accessToken, clientId: a.clientId, scopes: a.scopes, expiresAt: a.expiresAt, resource: a.resource ? new URL(a.resource) : undefined };
  }

  async revokeToken(_client, { token: t }) {
    const key = sha(t);
    delete this.store.data.access[key];
    delete this.store.data.refresh[key];
    this.store.save();
  }

  revokeAll() {
    this.store.revokeAll();
  }
}
