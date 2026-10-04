/**
 * OmniBox — shared helpers.
 *
 * No dependencies, no DOM assumptions: every function here works in the browser
 * and in Node, which is what lets the whole toolbox be unit-tested.
 */

export const te = new TextEncoder();
export const td = new TextDecoder();
export const tdLatin1 = new TextDecoder('latin1');

/* ------------------------------------------------------------------- bytes */

export function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (typeof input === 'string') return te.encode(input);
  throw new TypeError('toBytes: expected Uint8Array, ArrayBuffer, view or string');
}

export function concatBytes(chunks) {
  const list = chunks.map(toBytes);
  const total = list.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of list) { out.set(c, at); at += c.length; }
  return out;
}

export function u8(...values) { return new Uint8Array(values); }

export function utf8(text) { return te.encode(text); }

/** Bytes → text. `latin1` handles PDF string literals and WinAnsi text. */
export function str(bytes, enc = 'utf8') {
  return (enc === 'latin1' ? tdLatin1 : td).decode(toBytes(bytes));
}

export function equalsBytes(a, b) {
  const x = toBytes(a); const y = toBytes(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const t = new Uint8Array(256).fill(255);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  t['='.charCodeAt(0)] = 0;
  return t;
})();

/** Chunked so a 60 MB file does not blow the argument limit. */
export function bytesToBase64(bytes) {
  const b = toBytes(bytes);
  let out = '';
  for (let i = 0; i < b.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  }
  return btoa(out);
}

export function base64ToBytes(text) {
  const clean = String(text).replace(/[^A-Za-z0-9+/=]/g, '');
  // '=' padding means the final group carries fewer than 3 bytes — count them or
  // the decoder invents spare bytes at the end.
  const padded = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const meaningful = clean.length - padded;
  const out = new Uint8Array(Math.floor((meaningful * 6) / 8));
  let at = 0; let acc = 0; let bits = 0;
  for (let i = 0; i < meaningful; i++) {
    const v = B64_LOOKUP[clean.charCodeAt(i)];
    if (v === 255) continue;
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; if (at < out.length) out[at++] = (acc >> bits) & 0xff; }
  }
  return out.subarray(0, at);
}

/* ------------------------------------------------------------------ strings */

const CONTROL = /[\u0000-\u001f\u007f]/g;
const UNSAFE = /[\\/:*?"<>|]/g;

/** Strip paths and anything a filesystem will hate, keeping the extension. */
export function safeFileName(name, fallback = 'file') {
  let base = String(name == null ? '' : name).split(/[\\/]/).pop() || '';
  base = base.replace(CONTROL, '').replace(UNSAFE, '_').replace(/\s+/g, ' ').trim();
  base = base.replace(/^\.+/, (m) => (m.length > 1 ? '' : '.'));
  if (!base || base === '.' || base === '..') base = fallback;
  return base.slice(0, 180);
}

export function baseName(name) {
  return String(name == null ? '' : name).split(/[\\/]/).pop() || '';
}

export function extOf(name) {
  const base = baseName(name);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

export function stemOf(name) {
  const base = baseName(name);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? base : base.slice(0, dot);
}

export function uniqueName(name, taken) {
  const set = taken instanceof Set ? taken : new Set(taken || []);
  if (!set.has(name)) return name;
  const ext = extOf(name);
  const stem = stemOf(name) || 'file';
  for (let i = 2; i < 10000; i++) {
    const candidate = ext ? `${stem} (${i}).${ext}` : `${stem} (${i})`;
    if (!set.has(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}`;
}

export function titleCase(text) {
  return String(text || '').replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1));
}

/** "report.PDF" + "docx" → "report.docx" — used for every converter output. */
export function withExtension(name, ext) {
  const stem = stemOf(safeFileName(name)) || 'document';
  return `${stem}.${String(ext).replace(/^\./, '')}`;
}

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = v / 1024; let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value >= 100 ? Math.round(value) : value.toFixed(value >= 10 ? 1 : 2)} ${units[i]}`;
}

export function formatDuration(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function dateStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

export function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

/* ---------------------------------------------------------------- file kinds */

export const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  zip: 'application/zip',
};

export function mimeOf(name) { return MIME[extOf(name)] || 'application/octet-stream'; }

const KIND_BY_EXT = {
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'avif', 'heic'],
  video: ['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v'],
  audio: ['mp3', 'm4a', 'wav', 'ogg', 'opus', 'flac', 'aac'],
  pdf: ['pdf'],
  doc: ['docx', 'doc', 'odt', 'rtf', 'pages'],
  sheet: ['xlsx', 'xls', 'csv', 'tsv', 'ods'],
  slides: ['pptx', 'ppt', 'odp', 'key'],
  text: ['txt', 'md', 'markdown', 'json', 'html', 'htm', 'xml', 'yml', 'yaml', 'log', 'srt', 'vtt', 'js', 'ts', 'css', 'py', 'sh'],
  archive: ['zip', 'tar', 'gz', '7z', 'rar'],
};

export function kindOf(name) {
  const ext = extOf(name);
  for (const [kind, list] of Object.entries(KIND_BY_EXT)) if (list.includes(ext)) return kind;
  return 'other';
}

export const KIND_ICON = {
  image: '🖼️', video: '🎬', audio: '🎵', pdf: '📕', doc: '📄', sheet: '📊',
  slides: '📽️', text: '📝', archive: '🗜️', other: '📦',
};

/* --------------------------------------------------------------- browser bits */

export function isBrowser() {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

/** Ask the browser to save bytes. No-ops outside the browser (tests). */
export function saveBytes(bytes, name, mime) {
  if (!isBrowser()) return null;
  const blob = bytes instanceof Blob ? bytes : new Blob([toBytes(bytes)], { type: mime || mimeOf(name) });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = safeFileName(name);
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return blob;
}

export async function readBlobBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

/** Hard ceiling for anything held in memory at once. */
export const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;

export function tooBigForMemory(bytes, limit = MEMORY_LIMIT_BYTES) {
  const n = typeof bytes === 'number' ? bytes : toBytes(bytes).length;
  return n > limit;
}
