// Reglas de seguridad: rutas dentro de la carpeta de trabajo y lista blanca de comandos.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class SafetyError extends Error {}

/**
 * Resuelve `p` relativo a la carpeta de trabajo y garantiza que el resultado
 * (siguiendo symlinks) quede dentro de ella.
 */
export function resolveInWorkspace(workspace, p = '.') {
  if (typeof p !== 'string' || p.includes('\0')) throw new SafetyError('Ruta inválida.');
  const root = fs.realpathSync(workspace);
  const target = path.resolve(root, p.startsWith('~') ? '.' + p.slice(1) : p);

  // Resolver symlinks del tramo que ya existe (el archivo puede no existir todavía).
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
    throw new SafetyError(`La ruta "${p}" queda fuera de la carpeta de trabajo.`);
  }
  return real;
}

const isInside = (root, p) => p === root || p.startsWith(root + path.sep);

/** Carpetas de solo lectura que existen, ya resueltas (siguiendo symlinks). */
export function readableRoots(cfg) {
  const roots = [];
  for (const r of cfg.readRoots || []) {
    const abs = r === '~' ? os.homedir() : r.startsWith('~/') ? path.join(os.homedir(), r.slice(2)) : r;
    try { roots.push(fs.realpathSync(abs)); } catch { /* no existe (p. ej. falta termux-setup-storage) */ }
  }
  return roots;
}

/**
 * Resuelve una ruta para LEER. Relativa = carpeta de trabajo. Absoluta o con "~/"
 * = tiene que caer dentro de la carpeta de trabajo o de una carpeta de solo lectura.
 */
export function resolveReadable(cfg, p = '.') {
  if (typeof p !== 'string' || p.includes('\0')) throw new SafetyError('Ruta inválida.');
  const ws = fs.realpathSync(cfg.workspace);
  let target;
  if (p === '~' || p.startsWith('~/')) target = path.join(os.homedir(), p.slice(1));
  else target = path.resolve(ws, p);

  let real;
  try { real = fs.realpathSync(target); } catch { real = path.resolve(target); }
  if (isInside(ws, real) || readableRoots(cfg).some((r) => isInside(r, real))) return real;
  throw new SafetyError(`La ruta "${p}" está fuera de las carpetas permitidas (carpeta de trabajo y ${(cfg.readRoots || []).join(', ') || 'ninguna de lectura'}).`);
}

/** Divide una línea de comando en argumentos (comillas simples/dobles, sin shell). */
export function splitArgs(line) {
  if (typeof line !== 'string') throw new SafetyError('Comando inválido.');
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
      throw new SafetyError(`Carácter no permitido: "${c}". No hay shell: sin pipes, redirecciones ni variables.`);
    } else {
      cur += c; has = true;
    }
  }
  if (quote) throw new SafetyError('Comillas sin cerrar.');
  if (has) args.push(cur);
  if (args.length === 0) throw new SafetyError('Comando vacío.');
  return args;
}

// Opciones que convierten un comando "inofensivo" en uno que ejecuta, borra o escribe.
const DANGEROUS_FLAGS = {
  find: ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'],
  sort: ['-o', '--output'],
  file: ['-C', '--compile', '-m', '--magic-file']
};

function looksLikePath(a) {
  return a.startsWith('/') || a.startsWith('~') || a.startsWith('.') || a.includes('/');
}

/**
 * Valida un comando contra la lista blanca y devuelve { program, args } listo para execFile.
 * Los argumentos que parecen rutas se fuerzan a quedar dentro de la carpeta de trabajo.
 */
export function checkCommand(line, cfg) {
  const [program, ...args] = splitArgs(line);
  if (program.includes('/')) throw new SafetyError('Usá el nombre del programa, no una ruta.');
  if (!cfg.allowedCommands.includes(program)) {
    throw new SafetyError(`"${program}" no está en la lista blanca. Permitidos: ${cfg.allowedCommands.join(', ')}`);
  }
  const banned = DANGEROUS_FLAGS[program] || [];
  for (const a of args) {
    const flag = a.split('=')[0];
    if (banned.includes(flag)) throw new SafetyError(`La opción "${flag}" no está permitida con ${program}.`);
    if (!cfg.allowPathsOutsideWorkspace) {
      const value = a.startsWith('-') && a.includes('=') ? a.slice(a.indexOf('=') + 1) : a;
      if (!a.startsWith('-') || a.includes('=')) {
        if (looksLikePath(value)) resolveReadable(cfg, value);
      }
    }
  }
  return { program, args };
}
