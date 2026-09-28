// Punto de entrada: servidor HTTP con OAuth + endpoint MCP (Streamable HTTP, sin estado).
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from './config.js';
import { PinOAuthProvider } from './oauth.js';
import { buildServer } from './tools.js';

function makeAudit(stateDir) {
  const file = path.join(stateDir, 'audit.log');
  return (entry) => {
    const e = { time: new Date().toISOString(), ...entry };
    // No guardar contenidos completos en el log.
    if (e.args?.content) e.args = { ...e.args, content: `<${e.args.content.length} caracteres>` };
    if (e.args?.text) e.args = { ...e.args, text: `<${e.args.text.length} caracteres>` };
    fs.appendFileSync(file, JSON.stringify(e) + '\n', { mode: 0o600 });
    if (e.event !== 'tool' || process.env.VERBOSE) console.log(`[${e.time}] ${e.event}${e.tool ? ' ' + e.tool : ''}${e.ok === false ? ' (falló)' : ''}`);
  };
}

export function createApp(cfg) {
  cfg.audit ??= makeAudit(cfg.stateDir);
  const provider = new PinOAuthProvider(cfg);
  const mcpUrl = new URL('/mcp', cfg.publicUrl);

  const app = express();
  app.disable('x-powered-by');
  // cloudflared se conecta desde localhost; confiar solo en ese proxy.
  app.set('trust proxy', 'loopback');

  // Registro de cada pedido (sin cuerpos ni tokens) para diagnosticar la conexión.
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

  app.use(mcpAuthRouter({
    provider,
    issuerUrl: new URL(cfg.publicUrl),
    resourceServerUrl: mcpUrl,
    resourceName: 'Celular (Termux)',
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
      console.error('Error MCP:', e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Error interno' }, id: null });
    }
  });

  const notAllowed = (_req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Método no permitido.' }, id: null });
  app.get('/mcp', auth, notAllowed);
  app.delete('/mcp', auth, notAllowed);

  return { app, provider };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const { app } = createApp(cfg);
  const httpServer = app.listen(cfg.port, cfg.host, () => {
    console.log(`termux-mcp escuchando en http://${cfg.host}:${cfg.port}`);
    console.log(`URL del conector para claude.ai: ${cfg.publicUrl}/mcp`);
    console.log(`Carpeta de trabajo: ${cfg.workspace}`);
  });
  const stop = () => { console.log('Apagando…'); httpServer.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
