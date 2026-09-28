// MCP tools exposed to Claude.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { checkCommand, readableRoots, resolveInWorkspace, resolveReadable, SafetyError } from './safety.js';
import { formatScan, human, recentFiles, scanStorage, systemInfo } from './inspect.js';
import { IMAGE_EXTENSIONS, loadImage } from './images.js';

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (t) => ({ content: [{ type: 'text', text: t }], isError: true });

/**
 * Runs a program without a shell, with a timeout and an output limit.
 * It runs in its own process group: when time runs out the whole group is
 * killed and we answer right away, even if a child (e.g. from Termux:API)
 * still holds the pipes open.
 * With { binary: true }, stdout is returned as a Buffer.
 */
export function runProgram(program, args, cfg, { input, timeoutMs, binary = false, maxBytes } = {}) {
  const limit = timeoutMs ?? cfg.commandTimeoutMs;
  const cap = maxBytes ?? cfg.maxOutputBytes;
  return new Promise((resolve) => {
    let out = Buffer.alloc(0), err = Buffer.alloc(0), done = false, note = '';
    const stdoutValue = () => (binary ? out.subarray(0, cap) : out.subarray(0, cap).toString());
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    let child;
    try {
      child = spawn(program, args, { cwd: cfg.workspace, env: { ...process.env, TERMUX_MCP: '1' }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: 1, stdout: binary ? Buffer.alloc(0) : '', stderr: e.message });
    }
    const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } } };
    const timer = setTimeout(() => {
      killGroup();
      finish({ code: 124, stdout: stdoutValue(), stderr: err.toString() + `\n[stopped: exceeded ${limit} ms]` });
    }, limit);
    const collect = (which) => (chunk) => {
      if (which === 'out') out = Buffer.concat([out, chunk]); else err = Buffer.concat([err, chunk]);
      if (out.length + err.length > cap && !note) {
        note = `\n[output truncated to ${cap} bytes]`;
        killGroup();
      }
    };
    child.stdout.on('data', collect('out'));
    child.stderr.on('data', collect('err'));
    child.on('error', (e) => finish(e.code === 'ENOENT'
      ? { code: 127, stdout: binary ? Buffer.alloc(0) : '', stderr: `"${program}" was not found. Is it installed?` }
      : { code: 1, stdout: binary ? Buffer.alloc(0) : '', stderr: e.message }));
    child.on('exit', (code, signal) => {
      // Give the pipes a moment to drain, without waiting for hung children.
      setTimeout(() => finish({ code: code ?? (signal ? 1 : 0), stdout: stdoutValue(), stderr: err.toString() + note }), 50);
    });
    child.stdin.on('error', () => {});
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

function formatRun({ code, stdout, stderr }) {
  let out = stdout;
  if (stderr.trim()) out += (out ? '\n' : '') + `[stderr]\n${stderr}`;
  return `[exit code: ${code}]\n${out || '(no output)'}`;
}

/** Wraps every tool: logs to the audit log and turns exceptions into tool errors. */
function wrap(name, cfg, fn) {
  return async (args) => {
    const started = Date.now();
    try {
      const result = await fn(args || {});
      cfg.audit?.({ event: 'tool', tool: name, args, ok: !result.isError, ms: Date.now() - started });
      return result;
    } catch (e) {
      const msg = e instanceof SafetyError ? `Blocked: ${e.message}` : `Error: ${e.message}`;
      cfg.audit?.({ event: 'tool', tool: name, args, ok: false, error: e.message, ms: Date.now() - started });
      return fail(msg);
    }
  };
}

// Termux:API tools (need the Termux:API app and the termux-api package).
const API_TIMEOUT_MS = 8000;
const API_HINT = '\nTermux:API did not respond. On the phone: force-stop the Termux:API app, set its battery usage to "Unrestricted" and open it once.';
const apiResult = (r, okText) => r.code === 0 ? text(okText ?? (r.stdout || '(no data)')) : fail(formatRun(r) + (r.code === 124 ? API_HINT : ''));

const TERMUX_API = [
  { name: 'battery_status', program: 'termux-battery-status', desc: 'Battery status (level, charging, temperature).' },
  { name: 'wifi_info', program: 'termux-wifi-connectioninfo', desc: 'Information about the current Wi-Fi connection.' },
  { name: 'clipboard_get', program: 'termux-clipboard-get', desc: 'Reads the text in the clipboard.' }
];

export function buildServer(cfg) {
  const server = new McpServer({ name: 'termux-mcp', version: '0.3.0' });
  const ro = { readOnlyHint: true, openWorldHint: false };
  const roots = readableRoots(cfg);
  const rootsNote = roots.length
    ? ` Absolute paths inside ${roots.join(', ')} (the phone's storage) can also be READ, never written.`
    : ' There are no extra read-only folders (termux-setup-storage has not been run).';
  const run = (prog, args, opts = {}) => runProgram(prog, args, cfg, { timeoutMs: prog.startsWith('termux-') ? API_TIMEOUT_MS : undefined, ...opts });

  server.registerTool('run_command', {
    title: 'Run command',
    description: 'Runs an allowlisted command on the phone (no shell: no pipes, redirections or variables). ' +
      `The working directory is the workspace (${cfg.workspace}).${rootsNote} ` +
      `Allowed: ${cfg.allowedCommands.join(', ')}.`,
    inputSchema: { command: z.string().describe('E.g. "ls -la notes"') },
    annotations: { destructiveHint: false, openWorldHint: false }
  }, wrap('run_command', cfg, async ({ command }) => {
    const { program, args } = checkCommand(command, cfg);
    const r = await run(program, args);
    return r.code === 0 ? text(formatRun(r)) : fail(formatRun(r));
  }));

  server.registerTool('list_dir', {
    title: 'List folder',
    description: `Lists a folder. Relative paths = workspace.${rootsNote}`,
    inputSchema: { path: z.string().default('.').describe('Relative to the workspace, or absolute inside a read-only folder') },
    annotations: ro
  }, wrap('list_dir', cfg, async ({ path: p }) => {
    const dir = resolveReadable(cfg, p);
    const entries = fs.readdirSync(dir, { withFileTypes: true }).map((d) => {
      const full = path.join(dir, d.name);
      let size = '';
      try { if (d.isFile()) size = ` (${fs.statSync(full).size} B)`; } catch { /* ignore */ }
      return `${d.isDirectory() ? '[dir] ' : ''}${d.name}${size}`;
    });
    return text(entries.length ? entries.join('\n') : '(empty)');
  }));

  server.registerTool('read_file', {
    title: 'Read file',
    description: `Reads a text file. Relative paths = workspace.${rootsNote} For images use view_image.`,
    inputSchema: { path: z.string() },
    annotations: ro
  }, wrap('read_file', cfg, async ({ path: p }) => {
    const file = resolveReadable(cfg, p);
    const st = fs.statSync(file);
    if (!st.isFile()) return fail('Not a file.');
    if (st.size > cfg.maxFileBytes) return fail(`The file is ${st.size} B; the limit is ${cfg.maxFileBytes} B.`);
    return text(fs.readFileSync(file, 'utf8'));
  }));

  server.registerTool('recent_files', {
    title: 'Recent files',
    description: 'Lists the most recently modified files in a folder (recursive), newest first, optionally filtered by extension. ' +
      'Useful folders inside the phone storage: DCIM/Camera (camera), Pictures/Screenshots or DCIM/Screenshots (screenshots), ' +
      'Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images (WhatsApp photos), Download.',
    inputSchema: {
      path: z.string().optional().describe('Folder to search (default: the phone storage)'),
      limit: z.number().int().min(1).max(100).default(20),
      extensions: z.array(z.string()).optional().describe('E.g. ["jpg","png"]. Use ["images"] for all image types.')
    },
    annotations: ro
  }, wrap('recent_files', cfg, async ({ path: p, limit, extensions }) => {
    const dir = p ? resolveReadable(cfg, p) : (roots[0] || resolveReadable(cfg, '.'));
    if (!fs.statSync(dir).isDirectory()) return fail('Not a folder.');
    const exts = extensions?.flatMap((e) => (e.toLowerCase() === 'images' ? IMAGE_EXTENSIONS : [e]));
    const { files, truncated } = recentFiles(dir, { limit, extensions: exts });
    if (!files.length) return text('(no matching files)');
    const lines = files.map((f) => `${new Date(f.mtime).toISOString().replace('T', ' ').slice(0, 16)}  ${human(f.size).padStart(8)}  ${f.path}`);
    if (truncated) lines.push('NOTE: the search stopped early; older folders may not have been checked.');
    return text(lines.join('\n'));
  }));

  server.registerTool('view_image', {
    title: 'View image',
    description: `Shows an image from the phone so Claude can see it (${IMAGE_EXTENSIONS.join(', ')}). ` +
      `Large photos are rotated and resized to at most ${cfg.imageMaxDimension}px. Use recent_files to find paths.${rootsNote}`,
    inputSchema: { path: z.string().describe('Path of the image') },
    annotations: ro
  }, wrap('view_image', cfg, async ({ path: p }) => {
    const file = resolveReadable(cfg, p);
    const img = await loadImage(file, cfg, run);
    return { content: [{ type: 'image', data: img.data, mimeType: img.mimeType }, { type: 'text', text: `${file}\n${img.note}` }] };
  }));

  if (cfg.allowWrite) {
    server.registerTool('write_file', {
      title: 'Write file',
      description: 'Creates or replaces a text file inside the workspace (creates missing folders).',
      inputSchema: { path: z.string(), content: z.string(), append: z.boolean().default(false) },
      annotations: { destructiveHint: true, openWorldHint: false }
    }, wrap('write_file', cfg, async ({ path: p, content, append }) => {
      if (Buffer.byteLength(content) > cfg.maxFileBytes) return fail(`Content too large (max ${cfg.maxFileBytes} B).`);
      const file = resolveInWorkspace(cfg.workspace, p);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (append) fs.appendFileSync(file, content); else fs.writeFileSync(file, content);
      return text(`${append ? 'Appended to' : 'Wrote'}: ${path.relative(cfg.workspace, file)}`);
    }));
  }

  if (cfg.allowDelete) {
    server.registerTool('delete_file', {
      title: 'Delete file',
      description: 'Deletes a file (not a folder) inside the workspace.',
      inputSchema: { path: z.string() },
      annotations: { destructiveHint: true, openWorldHint: false }
    }, wrap('delete_file', cfg, async ({ path: p }) => {
      const file = resolveInWorkspace(cfg.workspace, p);
      if (file === fs.realpathSync(cfg.workspace)) return fail('The workspace itself cannot be deleted.');
      if (!fs.statSync(file).isFile()) return fail('Only files can be deleted.');
      fs.unlinkSync(file);
      return text(`Deleted: ${path.relative(cfg.workspace, file)}`);
    }));
  }

  server.registerTool('storage_overview', {
    title: 'Storage overview',
    description: 'Walks a folder and summarizes where the space goes: size per subfolder and per file type, ' +
      'largest files, large old files and likely duplicates. Without "path" it analyzes the phone storage. ' +
      'May take up to ~25 s on large storage.',
    inputSchema: {
      path: z.string().optional().describe('Folder to analyze (default: the first read-only folder)'),
      top: z.number().int().min(5).max(50).default(15)
    },
    annotations: ro
  }, wrap('storage_overview', cfg, async ({ path: p, top }) => {
    const target = p ? resolveReadable(cfg, p) : (roots[0] || resolveReadable(cfg, '.'));
    if (!fs.statSync(target).isDirectory()) return fail('Not a folder.');
    return text(formatScan(scanStorage(target, { top }), top));
  }));

  server.registerTool('system_info', {
    title: 'System info',
    description: 'Model, Android version, security patch, chip, RAM, storage, uptime and battery.',
    annotations: ro
  }, wrap('system_info', cfg, async () => text(await systemInfo(run))));

  for (const t of TERMUX_API) {
    server.registerTool(t.name, { title: t.name, description: t.desc, annotations: ro },
      wrap(t.name, cfg, async () => apiResult(await run(t.program, []))));
  }

  server.registerTool('notify', {
    title: 'Notification',
    description: 'Shows a notification on the phone.',
    inputSchema: { title: z.string().max(100), content: z.string().max(1000) },
    annotations: { openWorldHint: false }
  }, wrap('notify', cfg, async ({ title, content }) =>
    apiResult(await run('termux-notification', ['--title', title, '--content', content]), 'Notification sent.')));

  server.registerTool('clipboard_set', {
    title: 'Copy to clipboard',
    description: "Copies text to the phone's clipboard.",
    inputSchema: { text: z.string().max(10000) },
    annotations: { openWorldHint: false }
  }, wrap('clipboard_set', cfg, async ({ text: value }) =>
    apiResult(await run('termux-clipboard-set', [], { input: value }), 'Copied.')));

  server.registerTool('vibrate', {
    title: 'Vibrate',
    description: 'Makes the phone vibrate.',
    inputSchema: { duration_ms: z.number().int().min(50).max(3000).default(500) },
    annotations: { openWorldHint: false }
  }, wrap('vibrate', cfg, async ({ duration_ms }) =>
    apiResult(await run('termux-vibrate', ['-d', String(duration_ms), '-f']), 'Done.')));

  return server;
}
