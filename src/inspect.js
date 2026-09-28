// Herramientas de diagnóstico: almacenamiento y datos del sistema (solo lectura).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
export function human(bytes) {
  let n = bytes, i = 0;
  while (n >= 1024 && i < UNITS.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${UNITS[i]}`;
}

const CATEGORIES = {
  'Fotos': ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif', 'bmp', 'dng', 'raw'],
  'Videos': ['mp4', 'mkv', 'mov', '3gp', 'webm', 'avi', 'm4v'],
  'Audio': ['mp3', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'flac', 'amr'],
  'Documentos': ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'odt', 'epub'],
  'Instaladores (APK)': ['apk', 'apks', 'xapk'],
  'Comprimidos': ['zip', 'rar', '7z', 'tar', 'gz', 'tgz'],
  'Bases de datos / backups': ['db', 'crypt14', 'crypt15', 'bak', 'backup']
};
const EXT_TO_CAT = Object.fromEntries(Object.entries(CATEGORIES).flatMap(([c, exts]) => exts.map((e) => [e, c])));

/**
 * Recorre `root` sin seguir symlinks, con límites de cantidad y tiempo.
 * Devuelve totales, tamaño por subcarpeta directa, por tipo, archivos más grandes y posibles duplicados.
 */
export function scanStorage(root, { top = 15, maxEntries = 300000, maxMs = 25000 } = {}) {
  const started = Date.now();
  const res = {
    root, files: 0, dirs: 0, bytes: 0, truncated: false, unreadable: 0,
    byChild: new Map(), byCat: new Map(), largest: [], oldBig: [], dupes: new Map()
  };
  const yearAgo = Date.now() - 365 * 86400 * 1000;
  const stack = [[root, null]];

  const pushLargest = (item) => {
    res.largest.push(item);
    if (res.largest.length > top * 3) { res.largest.sort((a, b) => b.size - a.size); res.largest.length = top; }
  };

  while (stack.length) {
    if (res.files + res.dirs >= maxEntries || Date.now() - started > maxMs) { res.truncated = true; break; }
    const [dir, child] = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { res.unreadable++; continue; }
    res.dirs++;
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const top1 = child ?? e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { stack.push([full, top1]); continue; }
      if (!e.isFile()) continue;
      let st;
      try { st = fs.statSync(full); } catch { res.unreadable++; continue; }
      res.files++;
      res.bytes += st.size;
      const childKey = child === null ? '(archivos sueltos en la raíz)' : top1;
      const c = res.byChild.get(childKey) || { bytes: 0, files: 0 };
      c.bytes += st.size; c.files++; res.byChild.set(childKey, c);
      const ext = path.extname(e.name).slice(1).toLowerCase();
      const cat = EXT_TO_CAT[ext] || 'Otros';
      const k = res.byCat.get(cat) || { bytes: 0, files: 0 };
      k.bytes += st.size; k.files++; res.byCat.set(cat, k);
      const rel = path.relative(root, full);
      pushLargest({ path: rel, size: st.size, mtime: st.mtimeMs });
      if (st.size >= 50 * 1024 * 1024 && st.mtimeMs < yearAgo) res.oldBig.push({ path: rel, size: st.size, mtime: st.mtimeMs });
      if (st.size >= 1024 * 1024) {
        const key = `${e.name.toLowerCase()}|${st.size}`;
        const d = res.dupes.get(key);
        if (d) d.push(rel); else res.dupes.set(key, [rel]);
      }
    }
  }
  res.largest.sort((a, b) => b.size - a.size);
  res.largest.length = Math.min(top, res.largest.length);
  res.oldBig.sort((a, b) => b.size - a.size);
  res.ms = Date.now() - started;
  return res;
}

export function formatScan(r, top = 15) {
  const date = (ms) => new Date(ms).toISOString().slice(0, 10);
  const lines = [];
  lines.push(`Carpeta: ${r.root}`);
  lines.push(`Total: ${human(r.bytes)} en ${r.files} archivos y ${r.dirs} carpetas (${(r.ms / 1000).toFixed(1)} s)`);
  if (r.truncated) lines.push('AVISO: el recorrido se cortó por límite de tiempo o cantidad; los números son parciales.');
  if (r.unreadable) lines.push(`${r.unreadable} carpetas o archivos sin permiso de lectura (normal en Android/data y Android/obb).`);

  lines.push('', '## Por carpeta (primer nivel)');
  [...r.byChild.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 25)
    .forEach(([n, v]) => lines.push(`${human(v.bytes).padStart(9)}  ${n}  (${v.files} archivos)`));

  lines.push('', '## Por tipo');
  [...r.byCat.entries()].sort((a, b) => b[1].bytes - a[1].bytes)
    .forEach(([n, v]) => lines.push(`${human(v.bytes).padStart(9)}  ${n}  (${v.files})`));

  lines.push('', `## ${top} archivos más grandes`);
  r.largest.forEach((f) => lines.push(`${human(f.size).padStart(9)}  ${f.path}  (${date(f.mtime)})`));

  if (r.oldBig.length) {
    lines.push('', '## Grandes (>50 MB) sin tocar hace más de un año');
    r.oldBig.slice(0, top).forEach((f) => lines.push(`${human(f.size).padStart(9)}  ${f.path}  (${date(f.mtime)})`));
  }

  const sizeOf = (k) => Number(k.split('|').pop());
  const withSize = [...r.dupes.entries()].filter(([, v]) => v.length > 1)
    .map(([k, v]) => ({ size: sizeOf(k), paths: v, waste: sizeOf(k) * (v.length - 1) }))
    .sort((a, b) => b.waste - a.waste);
  if (withSize.length) {
    const waste = withSize.reduce((s, d) => s + d.waste, 0);
    lines.push('', `## Posibles duplicados (mismo nombre y tamaño): ${withSize.length} grupos, ~${human(waste)} recuperables`);
    withSize.slice(0, 10).forEach((d) => lines.push(`${human(d.size).padStart(9)} x${d.paths.length}  ${d.paths.slice(0, 3).join('  |  ')}`));
  }
  return lines.join('\n');
}

function readProc(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function diskLine(label, p) {
  try {
    const s = fs.statfsSync(p);
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    return `${label}: ${human(total - free)} usados de ${human(total)} (${Math.round((1 - free / total) * 100)}%), libres ${human(free)}`;
  } catch { return null; }
}

const PROPS = [
  ['ro.product.manufacturer', 'Fabricante'], ['ro.product.brand', 'Marca'], ['ro.product.model', 'Modelo'],
  ['ro.product.device', 'Dispositivo'], ['ro.build.version.release', 'Android'], ['ro.build.version.sdk', 'SDK'],
  ['ro.build.version.security_patch', 'Parche de seguridad'], ['ro.build.display.id', 'Build'],
  ['ro.soc.manufacturer', 'Fabricante del chip'], ['ro.soc.model', 'Chip'], ['ro.hardware', 'Hardware'],
  ['ro.product.cpu.abi', 'Arquitectura'], ['ro.sf.lcd_density', 'Densidad de pantalla (dpi)'],
  ['persist.sys.locale', 'Idioma'], ['persist.sys.timezone', 'Zona horaria']
];

export async function systemInfo(run) {
  const lines = ['## Equipo'];
  const props = await run('getprop', []);
  if (props.code === 0) {
    const map = Object.fromEntries([...props.stdout.matchAll(/^\[([^\]]+)\]: \[([^\]]*)\]$/gm)].map((m) => [m[1], m[2]]));
    for (const [k, label] of PROPS) if (map[k]) lines.push(`${label}: ${map[k]}`);
  } else {
    lines.push('(getprop no disponible)');
  }
  lines.push(`Kernel: ${os.release()}`);
  lines.push(`Núcleos de CPU: ${os.cpus().length || 'desconocido'}`);
  const up = os.uptime();
  lines.push(`Encendido hace: ${Math.floor(up / 86400)} d ${Math.floor((up % 86400) / 3600)} h ${Math.floor((up % 3600) / 60)} min`);

  lines.push('', '## Memoria');
  const mem = Object.fromEntries([...readProc('/proc/meminfo').matchAll(/^(\w+):\s+(\d+) kB/gm)].map((m) => [m[1], Number(m[2]) * 1024]));
  if (mem.MemTotal) {
    lines.push(`RAM: ${human(mem.MemTotal - (mem.MemAvailable ?? 0))} en uso de ${human(mem.MemTotal)} (disponible ${human(mem.MemAvailable ?? 0)})`);
    if (mem.SwapTotal) lines.push(`Swap/zram: ${human(mem.SwapTotal - (mem.SwapFree ?? 0))} en uso de ${human(mem.SwapTotal)}`);
  } else {
    lines.push(`RAM total: ${human(os.totalmem())}, libre: ${human(os.freemem())}`);
  }

  lines.push('', '## Almacenamiento');
  const disks = [diskLine('Interno (/data)', '/data'), diskLine('Compartido (/storage/emulated)', '/storage/emulated/0'), diskLine('Termux (home)', os.homedir())].filter(Boolean);
  const seen = new Set();
  for (const d of disks) { const key = d.split(': ')[1]; if (!seen.has(key)) { seen.add(key); lines.push(d); } }

  lines.push('', '## Batería');
  const bat = await run('termux-battery-status', []);
  if (bat.code === 0) {
    try {
      const b = JSON.parse(bat.stdout);
      lines.push(`Nivel: ${b.percentage}%  |  Estado: ${b.status}  |  Salud: ${b.health}  |  Temperatura: ${b.temperature?.toFixed?.(1) ?? b.temperature} °C  |  Enchufado: ${b.plugged}`);
    } catch { lines.push(bat.stdout.trim()); }
  } else {
    lines.push('(Termux:API no disponible)');
  }
  return lines.join('\n');
}
