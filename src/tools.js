// Herramientas MCP que se exponen a Claude.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { checkCommand, readableRoots, resolveInWorkspace, resolveReadable, SafetyError } from './safety.js';
import { formatScan, scanStorage, systemInfo } from './inspect.js';

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (t) => ({ content: [{ type: 'text', text: t }], isError: true });

/**
 * Ejecuta un programa sin shell, con timeout y límite de salida.
 * Corre en su propio grupo de procesos: al vencer el tiempo se mata el grupo
 * entero y se responde enseguida, aunque algún hijo (p. ej. de Termux:API)
 * siga con las tuberías abiertas.
 */
export function runProgram(program, args, cfg, { input, timeoutMs } = {}) {
  const limit = timeoutMs ?? cfg.commandTimeoutMs;
  return new Promise((resolve) => {
    let out = Buffer.alloc(0), err = Buffer.alloc(0), done = false, note = '';
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    let child;
    try {
      child = spawn(program, args, { cwd: cfg.workspace, env: { ...process.env, TERMUX_MCP: '1' }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: 1, stdout: '', stderr: e.message });
    }
    const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* ya terminó */ } } };
    const timer = setTimeout(() => {
      killGroup();
      finish({ code: 124, stdout: out.toString(), stderr: err.toString() + `\n[cortado: superó ${limit} ms]` });
    }, limit);
    const collect = (which) => (chunk) => {
      if (which === 'out') out = Buffer.concat([out, chunk]); else err = Buffer.concat([err, chunk]);
      if (out.length + err.length > cfg.maxOutputBytes && !note) {
        note = `\n[salida recortada a ${cfg.maxOutputBytes} bytes]`;
        killGroup();
      }
    };
    child.stdout.on('data', collect('out'));
    child.stderr.on('data', collect('err'));
    child.on('error', (e) => finish(e.code === 'ENOENT'
      ? { code: 127, stdout: '', stderr: `No se encontró "${program}". ¿Está instalado?` }
      : { code: 1, stdout: '', stderr: e.message }));
    child.on('exit', (code, signal) => {
      // Dar un instante para vaciar las tuberías y no esperar a hijos colgados.
      setTimeout(() => finish({
        code: code ?? (signal ? 1 : 0),
        stdout: out.subarray(0, cfg.maxOutputBytes).toString(),
        stderr: err.toString() + note
      }), 50);
    });
    child.stdin.on('error', () => {});
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

function formatRun({ code, stdout, stderr }) {
  let out = stdout;
  if (stderr.trim()) out += (out ? '\n' : '') + `[stderr]\n${stderr}`;
  return `[código de salida: ${code}]\n${out || '(sin salida)'}`;
}

/** Envuelve cada herramienta: registra en el log y convierte errores en respuestas. */
function wrap(name, cfg, fn) {
  return async (args) => {
    const started = Date.now();
    try {
      const result = await fn(args || {});
      cfg.audit?.({ event: 'tool', tool: name, args, ok: !result.isError, ms: Date.now() - started });
      return result;
    } catch (e) {
      const msg = e instanceof SafetyError ? `Bloqueado: ${e.message}` : `Error: ${e.message}`;
      cfg.audit?.({ event: 'tool', tool: name, args, ok: false, error: e.message, ms: Date.now() - started });
      return fail(msg);
    }
  };
}

// Herramientas de Termux:API (requieren la app Termux:API y el paquete termux-api).
const API_TIMEOUT_MS = 8000;
const API_HINT = '\nTermux:API no respondió. En el celu: forzar detención de la app Termux:API, ponerla en batería "Sin restricciones" y abrirla una vez.';
const apiResult = (r, okText) => r.code === 0 ? text(okText ?? (r.stdout || '(sin datos)')) : fail(formatRun(r) + (r.code === 124 ? API_HINT : ''));

const TERMUX_API = [
  { name: 'battery_status', program: 'termux-battery-status', desc: 'Estado de la batería (nivel, carga, temperatura).' },
  { name: 'wifi_info', program: 'termux-wifi-connectioninfo', desc: 'Información de la conexión Wi-Fi actual.' },
  { name: 'clipboard_get', program: 'termux-clipboard-get', desc: 'Lee el texto del portapapeles.' }
];

export function buildServer(cfg) {
  const server = new McpServer({ name: 'termux-mcp', version: '0.2.0' });
  const ro = { readOnlyHint: true, openWorldHint: false };
  const roots = readableRoots(cfg);
  const rootsNote = roots.length
    ? ` También se puede LEER (no escribir) usando rutas absolutas dentro de: ${roots.join(', ')} (almacenamiento del celu).`
    : ' No hay carpetas extra de lectura (falta correr termux-setup-storage).';

  server.registerTool('run_command', {
    title: 'Ejecutar comando',
    description: `Ejecuta un comando de la lista blanca en el celular (sin shell: no hay pipes, redirecciones ni variables). ` +
      `El directorio actual es la carpeta de trabajo (${cfg.workspace}).${rootsNote} ` +
      `Permitidos: ${cfg.allowedCommands.join(', ')}.`,
    inputSchema: { command: z.string().describe('Ej.: "ls -la notas"') },
    annotations: { destructiveHint: false, openWorldHint: false }
  }, wrap('run_command', cfg, async ({ command }) => {
    const { program, args } = checkCommand(command, cfg);
    const r = await runProgram(program, args, cfg, { timeoutMs: program.startsWith('termux-') ? API_TIMEOUT_MS : undefined });
    return r.code === 0 ? text(formatRun(r)) : fail(formatRun(r));
  }));

  server.registerTool('list_dir', {
    title: 'Listar carpeta',
    description: `Lista una carpeta. Rutas relativas = carpeta de trabajo.${rootsNote}`,
    inputSchema: { path: z.string().default('.').describe('Relativa a la carpeta de trabajo, o absoluta dentro de una carpeta de lectura') },
    annotations: ro
  }, wrap('list_dir', cfg, async ({ path: p }) => {
    const dir = resolveReadable(cfg, p);
    const entries = fs.readdirSync(dir, { withFileTypes: true }).map((d) => {
      const full = path.join(dir, d.name);
      let size = '';
      try { if (d.isFile()) size = ` (${fs.statSync(full).size} B)`; } catch { /* ignorar */ }
      return `${d.isDirectory() ? '[carpeta] ' : ''}${d.name}${size}`;
    });
    return text(entries.length ? entries.join('\n') : '(vacía)');
  }));

  server.registerTool('read_file', {
    title: 'Leer archivo',
    description: `Lee un archivo de texto. Rutas relativas = carpeta de trabajo.${rootsNote}`,
    inputSchema: { path: z.string() },
    annotations: ro
  }, wrap('read_file', cfg, async ({ path: p }) => {
    const file = resolveReadable(cfg, p);
    const st = fs.statSync(file);
    if (!st.isFile()) return fail('No es un archivo.');
    if (st.size > cfg.maxFileBytes) return fail(`El archivo pesa ${st.size} B; el máximo es ${cfg.maxFileBytes} B.`);
    return text(fs.readFileSync(file, 'utf8'));
  }));

  if (cfg.allowWrite) {
    server.registerTool('write_file', {
      title: 'Escribir archivo',
      description: 'Crea o reemplaza un archivo de texto dentro de la carpeta de trabajo (crea las carpetas que falten).',
      inputSchema: { path: z.string(), content: z.string(), append: z.boolean().default(false) },
      annotations: { destructiveHint: true, openWorldHint: false }
    }, wrap('write_file', cfg, async ({ path: p, content, append }) => {
      if (Buffer.byteLength(content) > cfg.maxFileBytes) return fail(`Contenido demasiado grande (máx. ${cfg.maxFileBytes} B).`);
      const file = resolveInWorkspace(cfg.workspace, p);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (append) fs.appendFileSync(file, content); else fs.writeFileSync(file, content);
      return text(`${append ? 'Agregado a' : 'Escrito'}: ${path.relative(cfg.workspace, file)}`);
    }));
  }

  if (cfg.allowDelete) {
    server.registerTool('delete_file', {
      title: 'Borrar archivo',
      description: 'Borra un archivo (no carpetas) dentro de la carpeta de trabajo.',
      inputSchema: { path: z.string() },
      annotations: { destructiveHint: true, openWorldHint: false }
    }, wrap('delete_file', cfg, async ({ path: p }) => {
      const file = resolveInWorkspace(cfg.workspace, p);
      if (file === fs.realpathSync(cfg.workspace)) return fail('No se puede borrar la carpeta de trabajo.');
      if (!fs.statSync(file).isFile()) return fail('Solo se pueden borrar archivos.');
      fs.unlinkSync(file);
      return text(`Borrado: ${path.relative(cfg.workspace, file)}`);
    }));
  }

  server.registerTool('storage_overview', {
    title: 'Resumen del almacenamiento',
    description: 'Recorre una carpeta y resume en qué se usa el espacio: tamaño por subcarpeta, por tipo de archivo, ' +
      'los archivos más grandes, archivos grandes viejos y posibles duplicados. Sin "path" analiza el almacenamiento compartido del celu. ' +
      'Puede tardar hasta ~25 s en almacenamientos grandes.',
    inputSchema: {
      path: z.string().optional().describe('Carpeta a analizar (por defecto, la primera carpeta de lectura)'),
      top: z.number().int().min(5).max(50).default(15)
    },
    annotations: ro
  }, wrap('storage_overview', cfg, async ({ path: p, top }) => {
    const target = p ? resolveReadable(cfg, p) : (roots[0] || resolveReadable(cfg, '.'));
    if (!fs.statSync(target).isDirectory()) return fail('No es una carpeta.');
    return text(formatScan(scanStorage(target, { top }), top));
  }));

  server.registerTool('system_info', {
    title: 'Datos del sistema',
    description: 'Modelo, versión de Android, parche de seguridad, chip, RAM, almacenamiento, tiempo encendido y batería.',
    annotations: ro
  }, wrap('system_info', cfg, async () => text(await systemInfo((prog, args) => runProgram(prog, args, cfg, { timeoutMs: prog.startsWith('termux-') ? API_TIMEOUT_MS : undefined })))));

  for (const t of TERMUX_API) {
    server.registerTool(t.name, { title: t.name, description: t.desc, annotations: ro },
      wrap(t.name, cfg, async () => {
        const r = await runProgram(t.program, [], cfg, { timeoutMs: API_TIMEOUT_MS });
        return apiResult(r);
      }));
  }

  server.registerTool('notify', {
    title: 'Notificación',
    description: 'Muestra una notificación en el celular.',
    inputSchema: { title: z.string().max(100), content: z.string().max(1000) },
    annotations: { openWorldHint: false }
  }, wrap('notify', cfg, async ({ title, content }) => {
    const r = await runProgram('termux-notification', ['--title', title, '--content', content], cfg, { timeoutMs: API_TIMEOUT_MS });
    return apiResult(r, 'Notificación enviada.');
  }));

  server.registerTool('clipboard_set', {
    title: 'Copiar al portapapeles',
    description: 'Copia un texto al portapapeles del celular.',
    inputSchema: { text: z.string().max(10000) },
    annotations: { openWorldHint: false }
  }, wrap('clipboard_set', cfg, async ({ text: value }) => {
    const r = await runProgram('termux-clipboard-set', [], cfg, { input: value, timeoutMs: API_TIMEOUT_MS });
    return apiResult(r, 'Copiado.');
  }));

  server.registerTool('vibrate', {
    title: 'Vibrar',
    description: 'Hace vibrar el celular.',
    inputSchema: { duration_ms: z.number().int().min(50).max(3000).default(500) },
    annotations: { openWorldHint: false }
  }, wrap('vibrate', cfg, async ({ duration_ms }) => {
    const r = await runProgram('termux-vibrate', ['-d', String(duration_ms), '-f'], cfg, { timeoutMs: API_TIMEOUT_MS });
    return apiResult(r, 'Listo.');
  }));

  return server;
}
