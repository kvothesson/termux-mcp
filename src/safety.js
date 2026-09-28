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

// Options that turn a "harmless" command into one that executes, writes or reads
// an arbitrary path. Coreutils are surprisingly capable: sort can write with -o
// and run any program with --compress-program; file can read a list of targets
// with -f. These are blocked whatever their form (--flag, --flag=x, -ox, -o x).
const DANGEROUS_FLAGS = {
  find: ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls', '-files0-from'],
  sort: ['-o', '--output', '--compress-program', '--files0-from'],
  uniq: [], // its output-file operand is handled below (WRITE_POSITIONAL).
  file: ['-C', '--compile', '-m', '--magic-file', '-f', '--files-from']
};

// Commands whose SECOND (and later) file operand is an OUTPUT file they write.
// A read-only tool must never be handed such a path, so we forbid the operand
// outright: the single-input form (the useful one) still works.
const WRITE_POSITIONAL = new Set(['uniq']);

function looksLikePath(a) {
  return a.startsWith('/') || a.startsWith('~') || a.startsWith('.') || a.includes('/');
}

/**
 * Every flag token a single argument stands for, so the denylist catches
 * grouped and glued forms: "--output=x" -> ["--output"], "-ox" -> ["-o", …],
 * "-ru" -> ["-r", "-u"]. Over-approximating (treating later glued letters as
 * flags too) only ever blocks more, which is the safe direction here.
 */
function flagTokens(a) {
  const bare = a.split('=')[0];
  if (a.startsWith('--')) return [bare];
  // Single dash covers both find-style long options ("-exec", "-delete") and
  // short clusters/glued values ("-ru", "-ox"). Test the whole token and every
  // "-<letter>" it contains, so any of those forms hits the denylist.
  return [bare, ...[...a.slice(1)].map((ch) => '-' + ch)];
}

/** The path a flag argument points at, if any: "--out=x" -> "x", "-ox" -> "x". */
function embeddedValue(a) {
  if (a.startsWith('--')) return a.includes('=') ? a.slice(a.indexOf('=') + 1) : null;
  const rest = a.slice(2); // everything after "-X"
  return rest.length ? rest : null;
}

/**
 * Checks a command against the allowlist and returns { program, args } ready to spawn.
 * Arguments that look like paths must fall inside the allowed folders, and options
 * that could write or execute (in any form) are rejected.
 */
export function checkCommand(line, cfg) {
  const [program, ...args] = splitArgs(line);
  if (program.includes('/')) throw new SafetyError('Use the program name, not a path.');
  if (!cfg.allowedCommands.includes(program)) {
    throw new SafetyError(`"${program}" is not on the allowlist. Allowed: ${cfg.allowedCommands.join(', ')}`);
  }
  const banned = DANGEROUS_FLAGS[program] || [];
  let operands = 0;
  for (const a of args) {
    if (a.startsWith('-') && a !== '-') {
      for (const flag of flagTokens(a)) {
        if (banned.includes(flag)) throw new SafetyError(`Option "${flag}" is not allowed with ${program}.`);
      }
      if (!cfg.allowPathsOutsideWorkspace) {
        const value = embeddedValue(a);
        if (value && looksLikePath(value)) resolveReadable(cfg, value);
      }
      continue;
    }
    // Positional operand ("-" means stdin and is not a path).
    operands++;
    if (WRITE_POSITIONAL.has(program) && operands >= 2) {
      throw new SafetyError(`"${program}" is only allowed with a single input file; its output-file operand can write outside the workspace.`);
    }
    if (!cfg.allowPathsOutsideWorkspace && a !== '-' && looksLikePath(a)) resolveReadable(cfg, a);
  }
  return { program, args };
}
