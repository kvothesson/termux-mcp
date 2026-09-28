// Entry point: HTTP server with OAuth + MCP endpoint (Streamable HTTP, stateless).
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createOAuthMetadata, mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from './config.js';
import { PinOAuthProvider } from './oauth.js';
import { buildServer } from './tools.js';

function makeAudit(stateDir) {
  const file = path.join(stateDir, 'audit.log');
  return (entry) => {
    const e = { time: new Date().toISOString(), ...entry };
    // Never store full contents in the log.
    if (e.args?.content) e.args = { ...e.args, content: `<${e.args.content.length} characters>` };
    if (e.args?.text) e.args = { ...e.args, text: `<${e.args.text.length} characters>` };
    fs.appendFileSync(file, JSON.stringify(e) + '\n', { mode: 0o600 });
    if (e.event !== 'tool' || process.env.VERBOSE) console.log(`[${e.time}] ${e.event}${e.tool ? ' ' + e.tool : ''}${e.ok === false ? ' (failed)' : ''}`);
  };
}

export function createApp(cfg) {
  cfg.audit ??= makeAudit(cfg.stateDir);
  const provider = new PinOAuthProvider(cfg);
  const mcpUrl = new URL('/mcp', cfg.publicUrl);

  const app = express();
  app.disable('x-powered-by');
  // cloudflared connects from localhost; trust only that proxy.
  app.set('trust proxy', 'loopback');

  // Log every request (no bodies or tokens) to help diagnose connection problems.
  app.use((req, res, next) => {
    const t = Date.now();
    const json = res.json.bind(res);
    res.json = (body) => { if (body?.error) res.locals.err = `${body.error}${body.error_description ? ': ' + body.error_description : ''}`; return json(body); };
    res.on('finish', () => {
      const p = req.originalUrl.split('?')[0];
      const q = p === '/authorize' ? ` scope=${req.query.scope ?? '-'} resource=${req.query.resource ?? '-'}` : '';
      console.log(`[${new Date().toISOString()}] ${req.method} ${p} -> ${res.statusCode} (${Date.now() - t} ms)${q}${res.locals.err ? ' ERROR ' + (typeof res.locals.err === 'string' ? res.locals.err : JSON.stringify(res.locals.err)) : ''}`);
    });
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Our own OAuth metadata: issuer WITHOUT a trailing slash, served on every
  // discovery path different clients use (RFC 8414, RFC 9728 and OIDC).
  const origin = cfg.publicUrl;
  const asMeta = {
    ...createOAuthMetadata({ provider, issuerUrl: new URL(origin), scopesSupported: ['mcp'] }),
    issuer: origin
  };
  const prMeta = { resource: mcpUrl.href, authorization_servers: [origin], scopes_supported: ['mcp'], bearer_methods_supported: ['header'], resource_name: 'Phone (Termux)' };
  const sendJson = (body) => (_req, res) => res.set('Cache-Control', 'no-store').set('Access-Control-Allow-Origin', '*').json(body);
  for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp', '/.well-known/openid-configuration', '/.well-known/openid-configuration/mcp', '/mcp/.well-known/openid-configuration']) {
    app.get(p, sendJson(asMeta));
  }
  for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    app.get(p, sendJson(prMeta));
  }

  app.use(mcpAuthRouter({
    provider,
    issuerUrl: new URL(origin),
    resourceServerUrl: mcpUrl,
    resourceName: 'Phone (Termux)',
    scopesSupported: ['mcp']
  }));

  app.post('/approve', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => provider.approve(req, res));

  const auth = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl)
  });

  app.post('/mcp', auth, express.json({ limit: '2mb' }), async (req, res) => {
    const server = buildServer(cfg);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('MCP error:', e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });

  const notAllowed = (_req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  app.get('/mcp', auth, notAllowed);
  app.delete('/mcp', auth, notAllowed);

  return { app, provider };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const { app } = createApp(cfg);
  const httpServer = app.listen(cfg.port, cfg.host, () => {
    console.log(`termux-mcp listening on http://${cfg.host}:${cfg.port}`);
    console.log(`Connector URL for claude.ai: ${cfg.publicUrl}/mcp`);
    console.log(`Workspace: ${cfg.workspace}`);
  });
  const stop = () => { console.log('Shutting down…'); httpServer.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
