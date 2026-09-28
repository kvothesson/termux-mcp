// Safety rules: paths confined to allowed folders, and a command allowlist.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class SafetyError extends Error {}

const isInside = (root, p) => p === root || p.startsWith(root + path.sep);

/**
 * Resolves `p` relative to the workspace and guarantees that the result
 * (following symlinks) stays inside it. Used for anything that WRITES.
 */
export function resolveInWorkspace(workspace, p = '.') {
  if (typeof p !== 'string' || p.includes('\0')) throw new SafetyError('Invalid path.');
  const root = fs.realpathSync(workspace);
  const target = path.resolve(root, p.startsWith('~') ? '.' + p.slice(1) : p);

  // Resolve symlinks in the part that already exists (the file may not exist yet).
  let existing = target;
  const tail = [];
  while (!fs.existsSync(existing)) {
    tail.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const real = path.join(fs.realpathSync(existing), ...tail);

  if (!isInside(root, real)) {
    throw new SafetyError(`Path "${p}" is outside the workspace.`);
  }
  return real;
}

/** Read-only folders that exist, already resolved (following symlinks). */
export function readableRoots(cfg) {
  const roots = [];
  for (const r of cfg.readRoots || []) {
    const abs = r === '~' ? os.homedir() : r.startsWith('~/') ? path.join(os.homedir(), r.slice(2)) : r;
    try { roots.push(fs.realpathSync(abs)); } catch { /* does not exist (e.g. termux-setup-storage not run yet) */ }
  }
  return roots;
}

/**
 * Resolves a path for READING. Relative = workspace. Absolute or "~/" = must fall
 * inside the workspace or one of the read-only folders.
 */
export function resolveReadable(cfg, p = '.') {
  if (typeof p !== 'string' || p.includes('\0')) throw new SafetyError('Invalid path.');
  const ws = fs.realpathSync(cfg.workspace);
  let target;
  if (p === '~' || p.startsWith('~/')) target = path.join(os.homedir(), p.slice(1));
  else target = path.resolve(ws, p);

  let real;
  try { real = fs.realpathSync(target); } catch { real = path.resolve(target); }
  if (isInside(ws, real) || readableRoots(cfg).some((r) => isInside(r, real))) return real;
  throw new SafetyError(`Path "${p}" is outside the allowed folders (workspace and ${(cfg.readRoots || []).join(', ') || 'no read-only folders'}).`);
}

/** Splits a command line into arguments (single/double quotes, no shell). */
export function splitArgs(line) {
  if (typeof line !== 'string') throw new SafetyError('Invalid command.');
  const args = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c; has = true;
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[++i]; has = true;
    } else if (/\s/.test(c)) {
      if (has) { args.push(cur); cur = ''; has = false; }
    } else if ('|&;<>`$()'.includes(c)) {
      throw new SafetyError(`Character not allowed: "${c}". There is no shell: no pipes, redirections or variables.`);
    } else {
      cur += c; has = true;
    }
  }
  if (quote) throw new SafetyError('Unclosed quotes.');
  if (has) args.push(cur);
  if (args.length === 0) throw new SafetyError('Empty command.');
  return args;
}

// Options that turn a "harmless" command into one that executes, deletes or writes.
const DANGEROUS_FLAGS = {
  find: ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'],
  sort: ['-o', '--output'],
  file: ['-C', '--compile', '-m', '--magic-file']
};

function looksLikePath(a) {
  return a.startsWith('/') || a.startsWith('~') || a.startsWith('.') || a.includes('/');
}

/**
 * Checks a command against the allowlist and returns { program, args } ready to spawn.
 * Arguments that look like paths must fall inside the allowed folders.
 */
export function checkCommand(line, cfg) {
  const [program, ...args] = splitArgs(line);
  if (program.includes('/')) throw new SafetyError('Use the program name, not a path.');
  if (!cfg.allowedCommands.includes(program)) {
    throw new SafetyError(`"${program}" is not on the allowlist. Allowed: ${cfg.allowedCommands.join(', ')}`);
  }
  const banned = DANGEROUS_FLAGS[program] || [];
  for (const a of args) {
    const flag = a.split('=')[0];
    if (banned.includes(flag)) throw new SafetyError(`Option "${flag}" is not allowed with ${program}.`);
    if (!cfg.allowPathsOutsideWorkspace) {
      const value = a.startsWith('-') && a.includes('=') ? a.slice(a.indexOf('=') + 1) : a;
      if (!a.startsWith('-') || a.includes('=')) {
        if (looksLikePath(value)) resolveReadable(cfg, value);
      }
    }
  }
  return { program, args };
}
