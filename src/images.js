// Prepares phone images so Claude can see them: auto-rotates, shrinks and
// re-encodes with ImageMagick when available, otherwise sends small files as-is.
import fs from 'node:fs';
import path from 'node:path';

export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'bmp'];
const RAW_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const RAW_LIMIT = 3.5 * 1024 * 1024; // Largest file sent unconverted.

let converter; // undefined = not probed yet, null = none found

async function findConverter(run) {
  if (converter !== undefined) return converter;
  converter = null;
  for (const prog of ['magick', 'convert']) {
    const r = await run(prog, ['-version'], { timeoutMs: 5000 });
    if (r.code === 0 && /ImageMagick/i.test(String(r.stdout))) { converter = prog; break; }
  }
  return converter;
}

/** For tests: forget which converter was found. */
export function resetConverter() { converter = undefined; }

/**
 * Returns { data (base64), mimeType, note } for `file`, or throws with a clear message.
 * `run(program, args, opts)` must support { binary: true, maxBytes } and return stdout as a Buffer.
 */
export async function loadImage(file, cfg, run) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!IMAGE_EXTENSIONS.includes(ext)) throw new Error(`Not a supported image (${IMAGE_EXTENSIONS.join(', ')}).`);
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error('Not a file.');
  if (st.size > cfg.maxImageBytes) throw new Error(`Image is ${st.size} B; the limit is ${cfg.maxImageBytes} B.`);

  const prog = await findConverter(run);
  if (prog) {
    const dim = cfg.imageMaxDimension;
    // [0] = first frame only (GIFs); ">" = only shrink, never enlarge.
    const r = await run(prog, [`${file}[0]`, '-auto-orient', '-resize', `${dim}x${dim}>`, '-strip', '-quality', '80', 'jpg:-'],
      { binary: true, maxBytes: 8 * 1024 * 1024, timeoutMs: 30000 });
    if (r.code === 0 && r.stdout.length > 0) {
      return { data: r.stdout.toString('base64'), mimeType: 'image/jpeg', note: `Resized to fit ${dim}px (original ${st.size} B).` };
    }
    if (!RAW_MIME[ext] || st.size > RAW_LIMIT) {
      throw new Error(`Could not convert the image: ${String(r.stderr).trim().slice(0, 300) || 'unknown error'}`);
    }
  }
  if (RAW_MIME[ext] && st.size <= RAW_LIMIT) {
    return { data: fs.readFileSync(file).toString('base64'), mimeType: RAW_MIME[ext], note: prog ? 'Sent as-is.' : 'Sent as-is (ImageMagick not installed).' };
  }
  throw new Error('This image is too large or in a format that needs conversion. Install ImageMagick in Termux: pkg install imagemagick');
}
