// Diagnostic tools: storage and system information (read-only).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
export function human(bytes) {
  let n = bytes, i = 0;
  while (n >= 1024 && i < UNITS.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${UNITS[i]}`;
}

export const CATEGORIES = {
  'Photos': ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif', 'bmp', 'dng', 'raw'],
  'Videos': ['mp4', 'mkv', 'mov', '3gp', 'webm', 'avi', 'm4v'],
  'Audio': ['mp3', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'flac', 'amr'],
  'Documents': ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'odt', 'epub'],
  'Installers (APK)': ['apk', 'apks', 'xapk'],
  'Archives': ['zip', 'rar', '7z', 'tar', 'gz', 'tgz'],
  'Databases / backups': ['db', 'crypt14', 'crypt15', 'bak', 'backup']
};
const EXT_TO_CAT = Object.fromEntries(Object.entries(CATEGORIES).flatMap(([c, exts]) => exts.map((e) => [e, c])));

/**
 * Walks `root` without following symlinks, with count and time limits.
 * Returns totals, size per top-level subfolder, per type, largest files and likely duplicates.
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
      const childKey = child === null ? '(loose files at the root)' : top1;
      const c = res.byChild.get(childKey) || { bytes: 0, files: 0 };
      c.bytes += st.size; c.files++; res.byChild.set(childKey, c);
      const ext = path.extname(e.name).slice(1).toLowerCase();
      const cat = EXT_TO_CAT[ext] || 'Other';
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
  lines.push(`Folder: ${r.root}`);
  lines.push(`Total: ${human(r.bytes)} in ${r.files} files and ${r.dirs} folders (${(r.ms / 1000).toFixed(1)} s)`);
  if (r.truncated) lines.push('NOTE: the scan stopped at the time or count limit; numbers are partial.');
  if (r.unreadable) lines.push(`${r.unreadable} folders or files could not be read (normal for Android/data and Android/obb).`);

  lines.push('', '## By folder (top level)');
  [...r.byChild.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 25)
    .forEach(([n, v]) => lines.push(`${human(v.bytes).padStart(9)}  ${n}  (${v.files} files)`));

  lines.push('', '## By type');
  [...r.byCat.entries()].sort((a, b) => b[1].bytes - a[1].bytes)
    .forEach(([n, v]) => lines.push(`${human(v.bytes).padStart(9)}  ${n}  (${v.files})`));

  lines.push('', `## ${top} largest files`);
  r.largest.forEach((f) => lines.push(`${human(f.size).padStart(9)}  ${f.path}  (${date(f.mtime)})`));

  if (r.oldBig.length) {
    lines.push('', '## Large (>50 MB) and untouched for over a year');
    r.oldBig.slice(0, top).forEach((f) => lines.push(`${human(f.size).padStart(9)}  ${f.path}  (${date(f.mtime)})`));
  }

  const sizeOf = (k) => Number(k.split('|').pop());
  const groups = [...r.dupes.entries()].filter(([, v]) => v.length > 1)
    .map(([k, v]) => ({ size: sizeOf(k), paths: v, waste: sizeOf(k) * (v.length - 1) }))
    .sort((a, b) => b.waste - a.waste);
  if (groups.length) {
    const waste = groups.reduce((s, d) => s + d.waste, 0);
    lines.push('', `## Likely duplicates (same name and size): ${groups.length} groups, ~${human(waste)} recoverable`);
    groups.slice(0, 10).forEach((d) => lines.push(`${human(d.size).padStart(9)} x${d.paths.length}  ${d.paths.slice(0, 3).join('  |  ')}`));
  }
  return lines.join('\n');
}

/**
 * Most recently modified files under `root` (recursive, no symlinks), optionally
 * filtered by extension. Stops at the same kind of count/time limits as scanStorage.
 */
export function recentFiles(root, { limit = 20, extensions, maxEntries = 200000, maxMs = 15000 } = {}) {
  const started = Date.now();
  const exts = extensions?.length ? new Set(extensions.map((e) => e.replace(/^\./, '').toLowerCase())) : null;
  const found = [];
  const stack = [root];
  let seen = 0, truncated = false;
  while (stack.length) {
    if (seen >= maxEntries || Date.now() - started > maxMs) { truncated = true; break; }
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      seen++;
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!e.isFile()) continue;
      if (exts && !exts.has(path.extname(e.name).slice(1).toLowerCase())) continue;
      try {
        const st = fs.statSync(full);
        found.push({ path: full, size: st.size, mtime: st.mtimeMs });
      } catch { /* vanished or unreadable */ }
      if (found.length > limit * 4) { found.sort((a, b) => b.mtime - a.mtime); found.length = limit; }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  found.length = Math.min(limit, found.length);
  return { files: found, truncated };
}

function readProc(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function diskLine(label, p) {
  try {
    const s = fs.statfsSync(p);
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    return `${label}: ${human(total - free)} used of ${human(total)} (${Math.round((1 - free / total) * 100)}%), ${human(free)} free`;
  } catch { return null; }
}

const PROPS = [
  ['ro.product.manufacturer', 'Manufacturer'], ['ro.product.brand', 'Brand'], ['ro.product.model', 'Model'],
  ['ro.product.device', 'Device'], ['ro.build.version.release', 'Android'], ['ro.build.version.sdk', 'SDK'],
  ['ro.build.version.security_patch', 'Security patch'], ['ro.build.display.id', 'Build'],
  ['ro.soc.manufacturer', 'Chip maker'], ['ro.soc.model', 'Chip'], ['ro.hardware', 'Hardware'],
  ['ro.product.cpu.abi', 'Architecture'], ['ro.sf.lcd_density', 'Screen density (dpi)'],
  ['persist.sys.locale', 'Locale'], ['persist.sys.timezone', 'Time zone']
];

export async function systemInfo(run) {
  const lines = ['## Device'];
  const props = await run('getprop', []);
  if (props.code === 0) {
    const map = Object.fromEntries([...props.stdout.matchAll(/^\[([^\]]+)\]: \[([^\]]*)\]$/gm)].map((m) => [m[1], m[2]]));
    for (const [k, label] of PROPS) if (map[k]) lines.push(`${label}: ${map[k]}`);
  } else {
    lines.push('(getprop not available)');
  }
  lines.push(`Kernel: ${os.release()}`);
  let cores = os.cpus().length;
  if (!cores) {
    // Android often hides /proc/cpuinfo from apps; nproc still works.
    const n = await run('nproc', []);
    cores = n.code === 0 ? Number(n.stdout.trim()) || 0 : 0;
  }
  lines.push(`CPU cores: ${cores || 'unknown'}`);
  const up = os.uptime();
  lines.push(`Uptime: ${Math.floor(up / 86400)} d ${Math.floor((up % 86400) / 3600)} h ${Math.floor((up % 3600) / 60)} min`);

  lines.push('', '## Memory');
  const mem = Object.fromEntries([...readProc('/proc/meminfo').matchAll(/^(\w+):\s+(\d+) kB/gm)].map((m) => [m[1], Number(m[2]) * 1024]));
  if (mem.MemTotal) {
    lines.push(`RAM: ${human(mem.MemTotal - (mem.MemAvailable ?? 0))} in use of ${human(mem.MemTotal)} (${human(mem.MemAvailable ?? 0)} available)`);
    if (mem.SwapTotal) lines.push(`Swap/zram: ${human(mem.SwapTotal - (mem.SwapFree ?? 0))} in use of ${human(mem.SwapTotal)}`);
  } else {
    lines.push(`Total RAM: ${human(os.totalmem())}, free: ${human(os.freemem())}`);
  }

  lines.push('', '## Storage');
  const disks = [diskLine('Internal (/data)', '/data'), diskLine('Shared (/storage/emulated)', '/storage/emulated/0'), diskLine('Termux (home)', os.homedir())].filter(Boolean);
  const seen = new Set();
  for (const d of disks) { const key = d.split(': ')[1]; if (!seen.has(key)) { seen.add(key); lines.push(d); } }

  lines.push('', '## Battery');
  const bat = await run('termux-battery-status', []);
  if (bat.code === 0) {
    try {
      const b = JSON.parse(bat.stdout);
      lines.push(`Level: ${b.percentage}%  |  Status: ${b.status}  |  Health: ${b.health}  |  Temperature: ${b.temperature?.toFixed?.(1) ?? b.temperature} °C  |  Plugged: ${b.plugged}`);
    } catch { lines.push(bat.stdout.trim()); }
  } else {
    lines.push('(Termux:API not available)');
  }
  return lines.join('\n');
}
