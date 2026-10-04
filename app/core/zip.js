/**
 * ZIP, both directions, with no dependencies.
 *
 * Reading: central-directory driven (correct even when the writer used data
 * descriptors), stored + deflate. Writing: stored or deflate-raw, UTF-8 names.
 *
 * This is the backbone of the Office formats — .docx and .xlsx are ZIP files
 * full of XML, so every converter in OmniBox leans on these two functions.
 * (A previous project needed a ZIP writer too; this one is stricter: it keeps
 * the CRC honest, reads sizes from the central directory, and round-trips.)
 */

import { concatBytes, toBytes, te, str } from './util.js';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/* ---------------------------------------------------------------- CRC-32 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes, seed = 0) {
  const b = toBytes(bytes);
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------- compressors */

export async function inflateRaw(bytes) {
  const stream = new Blob([toBytes(bytes)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function deflateRaw(bytes) {
  const stream = new Blob([toBytes(bytes)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** zlib wrapper (RFC 1950) — what most PDF streams use. */
export async function inflateZlib(bytes) {
  const stream = new Blob([toBytes(bytes)]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ------------------------------------------------------------------ reading */

function findEocd(view, bytes) {
  // the comment can be up to 64 KB, so scan backwards for the signature
  const min = Math.max(0, bytes.length - 0x10000 - 22);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * @returns {Promise<{entries: Map<string, {name, bytes, dir, method, size, compressed}>, comment: string}>}
 */
export async function readZip(input) {
  const bytes = toBytes(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view, bytes);
  if (eocd === -1) throw new Error('Not a ZIP file (no end-of-central-directory record)');

  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);

  // ZIP64 (rare, but a 4 GB+ office file is a real thing): the EOCD points at
  // a ZIP64 record where the real values live.
  if (cdOffset === 0xffffffff || count === 0xffff) {
    const z64 = findZip64(bytes, view, eocd);
    if (!z64) throw new Error('ZIP64 archive but no ZIP64 end record — refusing to guess');
    return readCentral(bytes, view, z64.cdOffset, z64.count);
  }
  return readCentral(bytes, view, cdOffset, count);
}

function findZip64(bytes, view, eocd) {
  for (let i = eocd - 20; i >= 0 && i > eocd - 0x1000; i--) {
    if (view.getUint32(i, true) === 0x06064b50) {
      const count = Number(view.getBigUint64(i + 32, true));
      const cdOffset = Number(view.getBigUint64(i + 48, true));
      return { count, cdOffset };
    }
  }
  return null;
}

async function readCentral(bytes, view, cdOffset, count) {
  const entries = new Map();
  let p = cdOffset;
  const comment = '';

  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== SIG_CENTRAL) {
      // tolerate a trailing junk record rather than failing the whole file
      break;
    }
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const compSize = view.getUint32(p + 20, true);
    const rawSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = str(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    const dir = name.endsWith('/');
    const entry = { name: dir ? name.slice(0, -1) : name, dir, method, size: rawSize, compressed: compSize, crc, localOffset, bytes: null };
    if (!dir) entry.bytes = await readEntry(bytes, view, entry);
    entries.set(entry.name, entry);
  }

  return { entries, comment };
}

async function readEntry(bytes, view, entry) {
  const at = entry.localOffset;
  if (view.getUint32(at, true) !== SIG_LOCAL) throw new Error(`Bad local header for ${entry.name}`);
  const nameLen = view.getUint16(at + 26, true);
  const extraLen = view.getUint16(at + 28, true);
  const start = at + 30 + nameLen + extraLen;
  const raw = bytes.subarray(start, start + entry.compressed);

  if (entry.method === 0) return raw.slice();
  if (entry.method === 8) {
    const out = await inflateRaw(raw);
    return out;
  }
  throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name} (stored and deflate only)`);
}

/* ------------------------------------------------------------------ writing */

function dosDateTime(date) {
  const d = date instanceof Date ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * @param files Array<{name, bytes|text, dir?}> — text entries are UTF-8 encoded
 * @param options {date?, compress?}  compress=false keeps it stored (fast, larger)
 */
export async function writeZip(files, { date = new Date(), compress = true } = {}) {
  const { time, date: dosDate } = dosDateTime(date);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = String(file.name || '').replace(/^\/+/, '');
    if (!name) throw new Error('writeZip: every entry needs a name');
    const dir = !!file.dir || name.endsWith('/');
    const data = dir ? new Uint8Array(0)
      : (file.bytes !== undefined ? toBytes(file.bytes) : te.encode(String(file.text == null ? '' : file.text)));
    const crc = dir ? 0 : crc32(data);
    let method = 0;
    let payload = data;
    if (!dir && compress && data.length > 64) {
      const packed = await deflateRaw(data);
      if (packed.length < data.length) { method = 8; payload = packed; }
    }

    const nameBytes = te.encode(name);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, SIG_LOCAL, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, payload.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    chunks.push(local, payload);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, SIG_CENTRAL, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, payload.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, dir ? 0x10 : 0, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + payload.length;
  }

  const centralBytes = concatBytes(central);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralBytes.length, true);
  ev.setUint32(16, offset, true);
  return concatBytes([...chunks, centralBytes, eocd]);
}

/* ------------------------------------------------------------------ helpers */

/** Sniff by leading bytes — used on dropped files where the name may lie. */
export function looksLikeZip(bytes) {
  const b = toBytes(bytes);
  return b.length > 3 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7);
}

export async function readZipText(input, name) {
  const { entries } = await readZip(input);
  const entry = entries.get(name);
  if (!entry) return null;
  return str(entry.bytes);
}
