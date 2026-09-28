// Reglas de seguridad: rutas dentro de la carpeta de trabajo y lista blanca de comandos.
import fs from 'node:fs';
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

  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new SafetyError(`La ruta "${p}" queda fuera de la carpeta de trabajo.`);
  }
  return real;
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
        if (looksLikePath(value)) resolveInWorkspace(cfg.workspace, value);
      }
    }
  }
  return { program, args };
}
