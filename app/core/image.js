/**
 * Image codecs, hand-written, no dependencies.
 *
 * Needed in both directions:
 *   • reading  — a dropped JPEG/PNG must go INTO a PDF, and a PDF's embedded
 *                images must come back OUT as files;
 *   • writing  — PNG output for extracted images.
 *
 * Scope is deliberate and stated in the UI: PNG (8-bit, non-interlaced, all
 * colour types) and JPEG. WebP/GIF/HEIC are refused with a clear message rather
 * than silently mangled.
 */

import { toBytes, str } from './util.js';
import { inflateRaw, inflateZlib } from './zip.js';

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(bytes) {
  const b = toBytes(bytes);
  return b.length > 8 && PNG_SIG.every((v, i) => b[i] === v);
}

export function isJpeg(bytes) {
  const b = toBytes(bytes);
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

/* ---------------------------------------------------------------------- JPEG */

/** Read the frame header: dimensions and component count, no decoding. */
export function readJpegInfo(bytes) {
  const b = toBytes(bytes);
  if (!isJpeg(b)) throw new Error('Not a JPEG (no SOI marker)');
  let p = 2;
  while (p < b.length - 3) {
    if (b[p] !== 0xff) { p++; continue; }
    const marker = b[p + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
    const len = (b[p + 2] << 8) | b[p + 3];
    // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return {
        width: (b[p + 7] << 8) | b[p + 8],
        height: (b[p + 5] << 8) | b[p + 6],
        components: b[p + 9],
        bits: b[p + 4],
        progressive: marker === 0xc2 || marker === 0xc6 || marker === 0xca || marker === 0xce,
        marker: marker.toString(16),
      };
    }
    if (marker === 0xda) break; // start of scan, no SOF seen
    p += 2 + len;
  }
  throw new Error('JPEG has no frame header (SOF)');
}

/* ----------------------------------------------------------------------- PNG */

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** @returns {{width,height,rgb:Uint8Array,alpha:Uint8Array|null}} */
export function decodePng(input) {
  const b = toBytes(input);
  if (!isPng(b)) throw new Error('Not a PNG (bad signature)');
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);

  let p = 8;
  let ihdr = null;
  const idat = [];
  let palette = null;
  let transparency = null;

  while (p + 8 <= b.length) {
    const len = view.getUint32(p, false);
    const type = str(b.subarray(p + 4, p + 8));
    const data = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: view.getUint32(p + 8, false),
        height: view.getUint32(p + 12, false),
        depth: data[8], colorType: data[9], compression: data[10], filter: data[11], interlace: data[12],
      };
    } else if (type === 'PLTE') {
      palette = data.slice();
    } else if (type === 'tRNS') {
      transparency = data.slice();
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    p += 12 + len; // length + type + data + crc
  }

  if (!ihdr) throw new Error('PNG has no IHDR chunk');
  if (ihdr.interlace) throw new Error('Interlaced (Adam7) PNG is not supported — re-save it as a normal PNG or JPEG');
  if (!idat.length) throw new Error('PNG has no image data');

  const { width, height, depth, colorType } = ihdr;
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`Unsupported PNG colour type ${colorType}`);

  const raw = inflateZlibConcat(idat);
  const bitsPerPixel = channels * depth;
  const bytesPerLine = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));

  const unfiltered = unfilter(raw, height, bytesPerLine, bpp);
  const rgba = toRgba(unfiltered, { width, height, depth, colorType, palette, transparency, bytesPerLine });
  return rgba;
}

function inflateZlibConcat(chunks) {
  // DecompressionStream is async in the browser but the PNG path is hot; keep a
  // synchronous-ish path by concatenating first, then inflating once. Callers
  // that need it async use decodePngAsync().
  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { merged.set(c, at); at += c.length; }
  return merged;
}

function unfilter(raw, height, bytesPerLine, bpp) {
  const out = new Uint8Array(height * bytesPerLine);
  let at = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[at++];
    const line = raw.subarray(at, at + bytesPerLine);
    at += bytesPerLine;
    const target = out.subarray(y * bytesPerLine, (y + 1) * bytesPerLine);
    const prior = y > 0 ? out.subarray((y - 1) * bytesPerLine, y * bytesPerLine) : null;
    for (let x = 0; x < bytesPerLine; x++) {
      const a = x >= bpp ? target[x - bpp] : 0;
      const b = prior ? prior[x] : 0;
      const c = prior && x >= bpp ? prior[x - bpp] : 0;
      const v = line[x];
      let value;
      switch (filterType) {
        case 0: value = v; break;
        case 1: value = v + a; break;
        case 2: value = v + b; break;
        case 3: value = v + ((a + b) >> 1); break;
        case 4: value = v + paeth(a, b, c); break;
        default: throw new Error(`Unknown PNG filter type ${filterType}`);
      }
      target[x] = value & 0xff;
    }
  }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function toRgba(data, { width, height, depth, colorType, palette, transparency, bytesPerLine }) {
  const rgb = new Uint8Array(width * height * 3);
  let alpha = null;
  const hasAlpha = colorType === 4 || colorType === 6 || (colorType === 3 && transparency) || (colorType === 0 && transparency);
  if (hasAlpha) alpha = new Uint8Array(width * height).fill(255);

  const sample = (x, channel) => {
    if (depth === 8) return data[x * 0 + channel];
    if (depth === 16) return data[x * 2 + (channel ? 0 : 0)];
    return 0;
  };

  if (depth === 8 && (colorType === 2 || colorType === 6)) {
    const step = colorType === 6 ? 4 : 3;
    for (let i = 0, px = 0; i < width * height; i++, px++) {
      const o = i * step;
      rgb[px * 3] = data[o]; rgb[px * 3 + 1] = data[o + 1]; rgb[px * 3 + 2] = data[o + 2];
      if (step === 4 && alpha) alpha[px] = data[o + 3];
    }
    return { width, height, rgb, alpha };
  }

  if (depth === 8 && colorType === 0) {
    for (let i = 0; i < width * height; i++) {
      const v = data[i];
      rgb[i * 3] = v; rgb[i * 3 + 1] = v; rgb[i * 3 + 2] = v;
      if (alpha) alpha[i] = 255;
    }
    return { width, height, rgb, alpha };
  }

  if (depth === 8 && colorType === 4) {
    for (let i = 0; i < width * height; i++) {
      const v = data[i * 2];
      rgb[i * 3] = v; rgb[i * 3 + 1] = v; rgb[i * 3 + 2] = v;
      if (alpha) alpha[i] = data[i * 2 + 1];
    }
    return { width, height, rgb, alpha };
  }

  if (colorType === 3) {
    if (!palette) throw new Error('Indexed PNG without a palette chunk');
    const rowBits = width * depth;
    const rowBytes = Math.ceil(rowBits / 8);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bitIndex = x * depth;
        const byte = data[y * rowBytes + (bitIndex >> 3)];
        const shift = 8 - depth - (bitIndex & 7);
        const idx = (byte >> shift) & ((1 << depth) - 1);
        const px = y * width + x;
        rgb[px * 3] = palette[idx * 3] || 0;
        rgb[px * 3 + 1] = palette[idx * 3 + 1] || 0;
        rgb[px * 3 + 2] = palette[idx * 3 + 2] || 0;
        if (alpha) alpha[px] = transparency && idx < transparency.length ? transparency[idx] : 255;
      }
    }
    return { width, height, rgb, alpha };
  }

  if (depth < 8 && (colorType === 0 || colorType === 4)) {
    const max = (1 << depth) - 1;
    const rowBytes = Math.ceil((width * depth) / 8);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bitIndex = x * depth;
        const byte = data[y * rowBytes + (bitIndex >> 3)];
        const shift = 8 - depth - (bitIndex & 7);
        let v = (byte >> shift) & max;
        if (colorType === 4) v = (byte >> shift) & max; // gray sample
        const scaled = Math.round((v / max) * 255);
        const px = y * width + x;
        rgb[px * 3] = scaled; rgb[px * 3 + 1] = scaled; rgb[px * 3 + 2] = scaled;
        if (alpha) alpha[px] = 255;
      }
    }
    return { width, height, rgb, alpha };
  }

  if (depth === 16) {
    // keep the high byte: 16-bit-per-channel art is visually identical at 8-bit
    const step = colorType === 6 ? 8 : colorType === 2 ? 6 : 2;
    for (let i = 0; i < width * height; i++) {
      const o = i * step;
      const r = data[o]; const g = step >= 6 ? data[o + 2] : r; const bl = step >= 6 ? data[o + 4] : r;
      rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = bl;
      if (alpha) alpha[i] = step === 8 ? data[o + 6] : 255;
    }
    return { width, height, rgb, alpha };
  }

  throw new Error(`Unsupported PNG layout: depth ${depth}, colour type ${colorType}`);
}

/** Async version — decodes for real (idat is zlib, which is async here). */
export async function decodePngAsync(input) {
  const b = toBytes(input);
  if (!isPng(b)) throw new Error('Not a PNG (bad signature)');
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 8;
  const idat = [];
  let header = null;
  let palette = null;
  let transparency = null;
  while (p + 8 <= b.length) {
    const len = view.getUint32(p, false);
    const type = str(b.subarray(p + 4, p + 8));
    const data = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      header = {
        width: view.getUint32(p + 8, false), height: view.getUint32(p + 12, false),
        depth: data[8], colorType: data[9], interlace: data[12],
      };
    } else if (type === 'PLTE') palette = data.slice();
    else if (type === 'tRNS') transparency = data.slice();
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!header) throw new Error('PNG has no IHDR chunk');
  if (header.interlace) throw new Error('Interlaced (Adam7) PNG is not supported — re-save it as a normal PNG or JPEG');
  const merged = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of idat) { merged.set(c, at); at += c.length; }
  const raw = await inflateZlib(merged);
  const channels = CHANNELS[header.colorType];
  const bytesPerLine = Math.ceil((header.width * channels * header.depth) / 8);
  const bpp = Math.max(1, Math.ceil((channels * header.depth) / 8));
  const unfiltered = unfilter(raw, header.height, bytesPerLine, bpp);
  return toRgba(unfiltered, { ...header, palette, transparency, bytesPerLine });
}

/* -------------------------------------------------------------------- writing */

/** RGB pixels → PNG file bytes (colour type 2, filter 0, zlib). */
export async function encodePng({ width, height, rgb }) {
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0;
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (1 + width * 3) + 1);
  }
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'));
  const zlibData = new Uint8Array(await new Response(stream).arrayBuffer());

  const chunks = [new Uint8Array(PNG_SIG)];
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width, false); iv.setUint32(4, height, false);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunks.push(pngChunk('IHDR', ihdr), pngChunk('IDAT', zlibData), pngChunk('IEND', new Uint8Array(0)));
  return concatAll(chunks);
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  const crc = crc32Bytes(out.subarray(4, 8 + data.length));
  view.setUint32(8 + data.length, crc, false);
  return out;
}

function crc32Bytes(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function concatAll(list) {
  const total = list.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of list) { out.set(c, at); at += c.length; }
  return out;
}
