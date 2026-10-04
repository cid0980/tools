/**
 * A PDF writer, written from scratch.
 *
 * It exists because "text → PDF" and "Word → PDF" are half of what OmniBox does,
 * and pulling in a 400 KB library to place text on a page is a bad trade. What
 * this is NOT: a typesetting engine. It lays out a simple block model (headings,
 * paragraphs, lists, quotes, code, tables, images) with the standard 14 fonts,
 * estimates widths from the real AFM metrics, wraps, paginates, and emits a
 * spec-valid PDF with a correct xref table.
 *
 * Verified in the test suite by an *independent* reader (Python's pypdf), which
 * checks page count, extracted text and that the object graph resolves.
 */

import { toBytes, concatBytes, utf8, clamp } from './util.js';
import { inflateZlib } from './zip.js';
import { encodePng, decodePngAsync, isJpeg, isPng, readJpegInfo } from './image.js';

export const PAGE_SIZES = {
  a4: [595.28, 841.89],
  letter: [612, 792],
  legal: [612, 1008],
  a5: [419.53, 595.28],
};

/* --------------------------------------------------------------- font metrics */

// Real Helvetica AFM widths for printable ASCII (units of 1/1000 em).
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
const TIMES = [
  250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278,
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564, 564, 444,
  921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722,
  556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500,
  333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500,
  500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541,
];

const FONTS = {
  Helvetica: { base: 'Helvetica', widths: HELVETICA, weight: 'normal', style: 'normal' },
  HelveticaBold: { base: 'Helvetica-Bold', widths: HELVETICA_BOLD, weight: 'bold', style: 'normal' },
  HelveticaOblique: { base: 'Helvetica-Oblique', widths: HELVETICA, weight: 'normal', style: 'italic' },
  Courier: { base: 'Courier', widths: null, weight: 'normal', style: 'normal' },
  CourierBold: { base: 'Courier-Bold', widths: null, weight: 'bold', style: 'normal' },
  TimesRoman: { base: 'Times-Roman', widths: TIMES, weight: 'normal', style: 'normal' },
  TimesBold: { base: 'Times-Bold', widths: TIMES, weight: 'bold', style: 'normal' },
  TimesItalic: { base: 'Times-Italic', widths: TIMES, weight: 'normal', style: 'italic' },
};

export const FONT_NAMES = Object.keys(FONTS);

/** Width of a string in points, using AFM metrics; accents fall back to the base letter. */
export function measureText(text, font = 'Helvetica', size = 11) {
  const spec = FONTS[font] || FONTS.Helvetica;
  if (!spec.widths) return String(text || '').length * 0.6 * size;
  let total = 0;
  for (const ch of String(text == null ? '' : text)) {
    const code = ch.codePointAt(0);
    if (code >= 32 && code <= 126) total += spec.widths[code - 32];
    else if (ch === '\t') total += spec.widths[0] * 4;
    else {
      const base = ch.normalize('NFD')[0];
      const baseCode = base.codePointAt(0);
      total += baseCode >= 32 && baseCode <= 126 ? spec.widths[baseCode - 32] : 500;
    }
  }
  return (total / 1000) * size;
}

export function wrapText(text, font, size, maxWidth) {
  const words = String(text == null ? '' : text).split(/(\s+)/);
  const lines = [];
  let line = '';
  for (const chunk of words) {
    if (chunk === '') continue;
    const candidate = line + chunk;
    if (measureText(candidate, font, size) <= maxWidth || line === '') line = candidate;
    else { lines.push(line.replace(/\s+$/, '')); line = chunk.replace(/^\s+/, ''); }
  }
  lines.push(line.replace(/\s+$/, ''));
  return lines.length ? lines : [''];
}

/* ------------------------------------------------------------- WinAnsi text */

// The 0x80–0x9F block differs between Latin-1 and WinAnsi; PDF standard fonts
// use WinAnsi, so those characters must be mapped or they turn into garbage.
const WINANSI_EXTRA = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86,
  0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c,
  0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
  0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

// Characters the standard 14 fonts cannot draw at all. Rather than emitting
// "?" (which looks like corruption, not a limit), substitute the nearest thing
// a reader will actually understand.
const SUBSTITUTIONS = {
  0x2192: '->', 0x21d2: '=>', 0x2190: '<-', 0x21d0: '<=', 0x2194: '<->',
  0x2713: 'v', 0x2714: 'v', 0x2717: 'x', 0x2718: 'x', 0x2705: '[ok]',
  0x25cf: '\u2022', 0x25cb: 'o', 0x25aa: '\u2022', 0x25a0: '\u2022',
  0x2264: '<=', 0x2265: '>=', 0x2260: '!=', 0x2248: '~',
  0x2018: '\u2018', 0x2019: '\u2019', 0x201c: '\u201c', 0x201d: '\u201d',
  0x1f4c4: '[doc]', 0x1f4c1: '[dir]', 0x1f512: '[lock]', 0x1f513: '[unlock]',
  0x2b50: '*', 0x1f680: '[rocket]', 0x1f517: '[link]', 0x23f3: '[time]',
};
const SUBSTITUTION_OUT = new Map();
for (const [code, replacement] of Object.entries(SUBSTITUTIONS)) {
  SUBSTITUTION_OUT.set(Number(code), [...replacement].map((c) => c.codePointAt(0)));
}

export function winAnsiBytes(text) {
  const out = [];
  for (const ch of String(text == null ? '' : text)) {
    const code = ch.codePointAt(0);
    if (code === 0x0a || code === 0x0d) { out.push(0x20); continue; }
    if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) { out.push(code); continue; }
    const mapped = WINANSI_EXTRA[code];
    if (mapped !== undefined) { out.push(mapped); continue; }
    const substitute = SUBSTITUTION_OUT.get(code);
    if (substitute) { out.push(...substitute); continue; }
    if (code > 0xffff) { out.push(0x3f, 0x3f); continue; } // emoji: two '?'
    out.push(0x3f); // '?' beats a broken glyph
  }
  return Uint8Array.from(out);
}

/** Escape for a PDF literal string: only ASCII survives here. */
export function escapePdfText(bytes) {
  let out = '';
  for (const byte of bytes) {
    if (byte === 0x28) out += '\\(';
    else if (byte === 0x29) out += '\\)';
    else if (byte === 0x5c) out += '\\\\';
    else if (byte >= 32 && byte <= 126) out += String.fromCharCode(byte);
    else out += `\\${byte.toString(8).padStart(3, '0')}`;
  }
  return out;
}

/* ------------------------------------------------------------------- layout */

const DEFAULTS = {
  size: 'a4',
  margin: 56,
  fontSize: 11,
  lineHeight: 1.45,
  font: 'Helvetica',
  title: null,
  author: null,
  subject: null,
  pageNumbers: true,
  createdAt: null,
};

function fontFor(kind, weight, italic) {
  if (kind === 'code') return weight === 'bold' ? 'CourierBold' : 'Courier';
  if (kind === 'serif') {
    if (weight === 'bold') return 'TimesBold';
    return italic ? 'TimesItalic' : 'TimesRoman';
  }
  if (weight === 'bold' && italic) return 'HelveticaBold'; // no bold-oblique slot registered
  if (weight === 'bold') return 'HelveticaBold';
  if (italic) return 'HelveticaOblique';
  return 'Helvetica';
}

const HEADING_SIZE = { 1: 22, 2: 17, 3: 14, 4: 12.5, 5: 11.5, 6: 11 };

/**
 * Lay out a document model into pages of drawing operations.
 * @returns {{pages: Array<{size:number[], ops: Array}>, warnings: string[], images: Array}}
 */
export function layoutDocument(blocks, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const [pw, ph] = PAGE_SIZES[opts.size] || PAGE_SIZES.a4;
  const margin = opts.margin;
  const contentWidth = pw - margin * 2;
  const bottom = margin + (opts.pageNumbers ? 24 : 0);

  const pages = [];
  const warnings = [];
  const images = [];
  let ops = [];
  let page = 1;
  let y = ph - margin;

  const newPage = () => { pages.push({ size: [pw, ph], ops }); ops = []; y = ph - margin; page++; };
  const ensure = (height) => { if (y - height < bottom) newPage(); };

  const text = (x, yy, str2, font, size, color = 0x000000) => ops.push({ t: 'text', x, y: yy, text: str2, font, size, color });
  const rect = (x, yy, w, h, color) => ops.push({ t: 'rect', x, y: yy, w, h, color });
  const line = (x1, y1, x2, y2, color = 0x999999, width = 0.6) => ops.push({ t: 'line', x1, y1, x2, y2, color, width });

  /** Render a list of inline runs as wrapped lines. */
  const flowRuns = (runs, indent = 0, { size = opts.fontSize, kind = 'body' } = {}) => {
    const maxWidth = contentWidth - indent;
    const words = [];
    for (const run of runs) {
      const font = fontFor(kind, run.bold ? 'bold' : 'normal', run.italic);
      const parts = String(run.text == null ? '' : run.text).split(/(\s+)/).filter((p) => p !== '');
      for (const part of parts) words.push({ part, font, underline: !!run.underline, code: !!run.code, size });
    }
    const lines = [];
    let current = { width: 0, parts: [] };
    const pushLine = () => { lines.push(current); current = { width: 0, parts: [] }; };
    for (const w of words) {
      const width = measureText(w.part, w.code ? 'Courier' : w.font, w.size);
      const isBreak = /^\s+$/.test(w.part);
      if (current.width + width > maxWidth && current.parts.length && !isBreak) pushLine();
      if (isBreak && current.parts.length === 0) continue; // no leading spaces on a new line
      current.parts.push({ ...w, font: w.code ? 'Courier' : w.font, width });
      current.width += width;
    }
    pushLine();
    return lines;
  };

  const drawRuns = (lines, x, startY, { size = opts.fontSize, lh = opts.lineHeight } = {}) => {
    let yy = startY;
    for (const ln of lines) {
      let xx = x;
      for (const part of ln.parts) {
        text(xx, yy, part.part, part.font, size);
        if (part.underline) line(xx, yy - 2, xx + part.width, yy - 2, 0x333333, 0.5);
        xx += part.width;
      }
      yy -= size * lh;
    }
    return yy;
  };

  const blocksToRuns = (block) => {
    if (Array.isArray(block.runs)) return block.runs;
    if (typeof block.text === 'string') return [{ text: block.text }];
    return [];
  };

  for (const block of blocks || []) {
    const type = block.type || 'p';

    if (type === 'pagebreak') { newPage(); continue; }

    if (type === 'h') {
      const size = HEADING_SIZE[clamp(block.level || 1, 1, 6)] || 12;
      const runs = blocksToRuns(block).map((r) => ({ ...r, bold: true }));
      const lines = flowRuns(runs, 0, { size, kind: block.serif ? 'serif' : 'body' });
      const needed = lines.length * size * 1.3 + 14;
      ensure(needed);
      if (y < ph - margin) y -= 10; // space before, except at the top of a page
      y = drawRuns(lines, margin, y, { size, lh: 1.3 });
      y -= 6;
      continue;
    }

    if (type === 'p' || type === 'quote') {
      const isQuote = type === 'quote';
      const indent = isQuote ? 16 : 0;
      const runs = isQuote ? blocksToRuns(block).map((r) => ({ ...r, italic: true })) : blocksToRuns(block);
      const lines = flowRuns(runs, indent, {});
      const height = lines.length * opts.fontSize * opts.lineHeight;
      ensure(height);
      const startY = y;
      if (isQuote) rect(margin, startY - height + 4, 3, height, 0xdddddd);
      y = drawRuns(lines, margin + indent, y);
      y -= opts.fontSize * 0.55;
      continue;
    }

    if (type === 'ul' || type === 'ol') {
      const items = block.items || [];
      for (let i = 0; i < items.length; i++) {
        const marker = type === 'ol' ? `${(block.start || 1) + i}.` : '•';
        const runs = Array.isArray(items[i]) ? items[i] : [{ text: String(items[i]) }];
        const markerWidth = measureText(marker, 'Helvetica', opts.fontSize) + 6;
        const lines = flowRuns(runs, markerWidth + 12, {});
        ensure(lines.length * opts.fontSize * opts.lineHeight);
        text(margin + 10, y, marker, 'Helvetica', opts.fontSize);
        y = drawRuns(lines, margin + 12 + markerWidth, y);
        y -= 2;
      }
      y -= opts.fontSize * 0.35;
      continue;
    }

    if (type === 'code') {
      const size = 9.5;
      const codeFont = 'Courier';
      const raw = String(block.text == null ? '' : block.text).replace(/\t/g, '    ');
      const maxChars = Math.max(20, Math.floor((contentWidth - 20) / measureText('M', codeFont, size)));
      const lines = [];
      for (const logical of raw.split('\n')) {
        if (logical.length <= maxChars) { lines.push(logical); continue; }
        for (let i = 0; i < logical.length; i += maxChars) lines.push(logical.slice(i, i + maxChars));
      }
      const lh = size * 1.35;
      let i = 0;
      while (i < lines.length) {
        const room = Math.floor((y - bottom - 10) / lh);
        if (room < 3) { newPage(); continue; }
        const take = Math.min(room, lines.length - i);
        const height = take * lh + 10;
        rect(margin, y - height + 4, contentWidth, height, 0xf4f4f5);
        let yy = y - 6;
        for (let n = 0; n < take; n++) { text(margin + 8, yy, lines[i + n], codeFont, size, 0x27272a); yy -= lh; }
        y -= height + 6;
        i += take;
      }
      continue;
    }

    if (type === 'hr') {
      ensure(14);
      y -= 6;
      line(margin, y, pw - margin, y, 0xcccccc, 0.8);
      y -= 10;
      continue;
    }

    if (type === 'table') {
      const head = block.head || [];
      const rows = block.rows || [];
      const columns = Math.max(head.length, ...rows.map((r) => r.length), 1);
      const size = Math.min(opts.fontSize, 10);
      const cellPad = 5;

      // Column widths: start even, then nudge toward the content's natural width.
      const weights = new Array(columns).fill(1);
      const sample = [...head, ...rows].slice(0, 40);
      for (const row of sample) {
        for (let c = 0; c < columns; c++) {
          const value = Array.isArray(row[c]) ? row[c].map((r) => r.text).join('') : String(row[c] == null ? '' : row[c]);
          weights[c] = Math.max(weights[c], Math.min(3.2, value.length / 12 + 0.4));
        }
      }
      const total = weights.reduce((a, b) => a + b, 0);
      const widths = weights.map((w) => (w / total) * contentWidth);

      const cellLines = (value, width, bold) => {
        const runs = Array.isArray(value) ? value : [{ text: String(value == null ? '' : value) }];
        return flowRuns(runs.map((r) => ({ ...r, bold: bold || r.bold })), 0, { size: size - 0.5 })
          .length;
      };

      const drawRow = (cells, isHead) => {
        const heights = [];
        for (let c = 0; c < columns; c++) heights.push(cellLines(cells[c], widths[c] - cellPad * 2, isHead));
        const rowHeight = Math.max(...heights) * size * 1.35 + cellPad * 2;
        ensure(rowHeight + 4);
        const top = y;
        rect(margin, top - rowHeight, contentWidth, rowHeight, isHead ? 0xeef2ff : 0xffffff);
        let x = margin;
        for (let c = 0; c < columns; c++) {
          const value = cells[c];
          const runs = (Array.isArray(value) ? value : [{ text: String(value == null ? '' : value) }])
            .map((r) => ({ ...r, bold: isHead || r.bold }));
          const lines = flowRuns(runs, 0, { size: size - 0.5 });
          let yy = top - cellPad - size;
          for (const ln of lines) {
            let xx = x + cellPad;
            for (const part of ln.parts) { text(xx, yy, part.part, part.font, size - 0.5); xx += part.width; }
            yy -= size * 1.35;
          }
          if (c > 0) line(x, top, x, top - rowHeight, 0xd4d4d8, 0.5);
          x += widths[c];
        }
        line(margin, top, pw - margin, top, 0xd4d4d8, 0.5);
        line(margin, top - rowHeight, pw - margin, top - rowHeight, 0xd4d4d8, 0.5);
        y = top - rowHeight;
      };

      ensure(30);
      if (head.length) drawRow(head, true);
      for (const row of rows) drawRow(row, false);
      y -= 12;
      continue;
    }

    if (type === 'image') {
      const entry = block;
      const [pw2, ph2] = PAGE_SIZES[opts.size] || PAGE_SIZES.a4;
      const available = ph2 - margin - bottom;
      let w = entry.width || 0;
      let h = entry.height || 0;
      if (!w || !h) { warnings.push('Image without dimensions was skipped'); continue; }
      const scale = Math.min(1, contentWidth / w, available / h);
      const dw = w * scale; const dh = h * scale;
      ensure(dh + 8);
      const ref = images.length;
      images.push(entry);
      ops.push({ t: 'image', x: margin, y: y - dh, w: dw, h: dh, ref });
      y -= dh + (block.caption ? 18 : 10);
      if (block.caption) { y = drawRuns(flowRuns([{ text: block.caption, italic: true }], 0, { size: 9 }), margin, y, { size: 9 }); y -= 6; }
      continue;
    }

    // anything unknown degrades to a paragraph rather than vanishing
    const runs = blocksToRuns(block);
    if (runs.length) {
      const lines = flowRuns(runs);
      ensure(lines.length * opts.fontSize * opts.lineHeight);
      y = drawRuns(lines, margin, y);
      y -= opts.fontSize * 0.55;
    }
  }

  pages.push({ size: [pw, ph], ops });

  if (opts.pageNumbers && pages.length > 1) {
    pages.forEach((pg, i) => {
      const label = `${i + 1} / ${pages.length}`;
      const width = measureText(label, 'Helvetica', 9);
      pg.ops.push({ t: 'text', x: (pg.size[0] - width) / 2, y: 28, text: label, font: 'Helvetica', size: 9, color: 0x888888 });
    });
  }

  return { pages, warnings, images, options: opts };
}

/* ------------------------------------------------------------------ writing */

function pdfDate(date) {
  const d = date instanceof Date ? date : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}Z`;
}

function contentStreamFor(page) {
  const parts = [];
  for (const op of page.ops) {
    if (op.t === 'text') {
      const bytes = escapePdfText(winAnsiBytes(op.text));
      const color = hexToRgb(op.color || 0);
      parts.push(`BT ${color} rg /${op.font} ${round(op.size)} Tf 1 0 0 1 ${round(op.x)} ${round(op.y)} Tm (${bytes}) Tj ET`);
    } else if (op.t === 'rect') {
      parts.push(`q ${hexToRgb(op.color || 0xffffff)} rg ${round(op.x)} ${round(op.y)} ${round(op.w)} ${round(op.h)} re f Q`);
    } else if (op.t === 'line') {
      parts.push(`q ${hexToRgb(op.color || 0x888888)} RG ${round(op.width || 0.6)} w ${round(op.x1)} ${round(op.y1)} m ${round(op.x2)} ${round(op.y2)} l S Q`);
    } else if (op.t === 'image') {
      parts.push(`q ${round(op.w)} 0 0 ${round(op.h)} ${round(op.x)} ${round(op.y)} cm /Im${op.ref} Do Q`);
    }
  }
  return parts.join('\n');
}

function round(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function hexToRgb(value) {
  const n = typeof value === 'number' ? value : 0;
  const r = ((n >> 16) & 0xff) / 255; const g = ((n >> 8) & 0xff) / 255; const b = (n & 0xff) / 255;
  return `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)}`;
}

/**
 * A non-interlaced 8-bit grey/truecolour PNG is *already* deflate-compressed
 * scanlines with PNG predictors — which is exactly what PDF's /FlateDecode with
 * /Predictor 15 wants. Re-using the original IDAT skips a full decode+encode
 * cycle and keeps the file smaller.
 */
function pngPassthrough(bytes) {
  if (!isPng(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 8;
  let header = null;
  const idat = [];
  while (p + 8 <= bytes.length) {
    const len = view.getUint32(p, false);
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    const data = bytes.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') header = { width: view.getUint32(p + 8, false), height: view.getUint32(p + 12, false), depth: data[8], colorType: data[9], interlace: data[12] };
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!header || header.depth !== 8 || header.interlace) return null;
  if (header.colorType !== 0 && header.colorType !== 2) return null; // palette/alpha need real work
  const colors = header.colorType === 2 ? 3 : 1;
  const merged = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of idat) { merged.set(c, at); at += c.length; }
  return {
    dict: `/Type /XObject /Subtype /Image /Width ${header.width} /Height ${header.height} `
      + `/ColorSpace ${colors === 3 ? '/DeviceRGB' : '/DeviceGray'} /BitsPerComponent 8 /Filter /FlateDecode `
      + `/DecodeParms << /Predictor 15 /Colors ${colors} /BitsPerComponent 8 /Columns ${header.width} >>`,
    data: merged,
  };
}

async function embedImage(entry) {
  const bytes = toBytes(entry.bytes);
  if (isJpeg(bytes)) {
    const info = readJpegInfo(bytes);
    const cs = info.components === 1 ? '/DeviceGray' : info.components === 4 ? '/DeviceCMYK' : '/DeviceRGB';
    const decode = info.components === 4 ? ' /Decode [1 0 1 0 1 0 1 0]' : '';
    return {
      dict: `/Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} `
        + `/ColorSpace ${cs} /BitsPerComponent 8${decode} /Filter /DCTDecode`,
      data: bytes,
    };
  }
  if (isPng(bytes)) {
    const fast = pngPassthrough(bytes);
    if (fast) return fast;
    const { width, height, rgb, alpha } = await decodePngAsync(bytes);
    return {
      dict: `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,
      data: await deflateZlib(rgb),
      alpha,
      softMask: alpha ? await softMaskFor(alpha, width, height) : null,
    };
  }
  return null;
}

async function deflateZlib(bytes) {
  const stream = new Blob([toBytes(bytes)]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Turn an alpha channel into a grayscale soft mask (PDF /SMask). */
async function softMaskFor(alpha, width, height) {
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) gray[i] = alpha[i];
  return { width, height, data: await deflateZlib(gray) };
}

/**
 * Assemble a PDF file from a layout.
 * @returns {Promise<Uint8Array>}
 */
export async function pdfFromLayout(layout, meta = {}) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };

  // font objects on demand
  const fontRefs = {};
  const fontNames = new Set();
  for (const page of layout.pages) for (const op of page.ops) if (op.t === 'text') fontNames.add(op.font);
  if (!fontNames.size) fontNames.add('Helvetica');
  for (const name of fontNames) {
    const spec = FONTS[name] || FONTS.Helvetica;
    fontRefs[name] = add(`<< /Type /Font /Subtype /Type1 /BaseFont /${spec.base} /Encoding /WinAnsiEncoding >>`);
  }

  // images
  const imageRefs = [];
  const imageRefByIndex = new Map();
  for (let index = 0; index < (layout.images || []).length; index++) {
    const entry = layout.images[index];
    const embedded = await embedImage(entry);
    if (!embedded) continue; // skipped: index stays unmapped so pagination can't lie
    let maskRef = null;
    if (embedded.softMask) {
      maskRef = add({ streamDict: `/Type /XObject /Subtype /Image /Width ${embedded.softMask.width} /Height ${embedded.softMask.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, data: embedded.softMask.data });
    }
    const dict = embedded.dict + (maskRef ? ` /SMask ${maskRef} 0 R` : '');
    const ref = add({ streamDict: dict, data: embedded.data });
    imageRefs.push(ref);
    imageRefByIndex.set(index, ref);
  }

  const pagesRefPlaceholder = { value: 0 };
  const pageRefs = [];
  const xobjectsFor = (page) => {
    const used = new Set(page.ops.filter((o) => o.t === 'image').map((o) => o.ref));
    return [...used]
      .filter((i) => imageRefByIndex.has(i))
      .map((i) => ` /Im${i} ${imageRefByIndex.get(i)} 0 R`).join('');
  };

  for (const page of layout.pages) {
    const content = contentStreamFor(page);
    const contentRef = add({ streamDict: '', data: utf8(content) });
    const fonts = [...fontNames].map((n) => ` /${n} ${fontRefs[n]} 0 R`).join('');
    const xobjects = xobjectsFor(page);
    const resources = `<< /Font <<${fonts} >>${xobjects ? ` /XObject <<${xobjects} >>` : ''} >>`;
    pageRefs.push(add(`<< /Type /Page /Parent ${pagesRefPlaceholder.value} 0 R /MediaBox [0 0 ${round(page.size[0])} ${round(page.size[1])}] /Resources ${resources} /Contents ${contentRef} 0 R >>`));
  }

  const pagesRef = add(`<< /Type /Pages /Kids [${pageRefs.map((r) => `${r} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`);
  pagesRefPlaceholder.value = pagesRef;

  // Content streams were written before we knew the /Pages ref; patch them in.
  for (const ref of pageRefs) {
    const body = objects[ref - 1];
    objects[ref - 1] = typeof body === 'string'
      ? body.replace(`/Parent ${0} 0 R`, `/Parent ${pagesRef} 0 R`)
      : body;
  }

  const catalogRef = add(`<< /Type /Catalog /Pages ${pagesRef} 0 R >>`);
  const infoRef = add(`<< /Title (${escapePdfText(winAnsiBytes(meta.title || 'OmniBox document'))}) `
    + `/Author (${escapePdfText(winAnsiBytes(meta.author || ''))}) `
    + `/Subject (${escapePdfText(winAnsiBytes(meta.subject || ''))}) `
    + `/Producer (OmniBox) /Creator (OmniBox) /CreationDate (${pdfDate(meta.createdAt)}) >>`);

  // serialise, tracking byte offsets for the xref table
  const chunks = [utf8('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n')];
  let offset = chunks[0].length;
  const offsets = [0];
  objects.forEach((body, i) => {
    const header = utf8(`${i + 1} 0 obj\n`);
    let payload;
    let trailer = utf8('\nendobj\n');
    if (typeof body === 'string') {
      payload = utf8(body);
    } else {
      const dict = body.streamDict ? body.streamDict : '';
      const head = utf8(`<< /Length ${body.data.length}${dict ? ' ' + dict : ''} >>\nstream\n`);
      payload = concatBytes([head, body.data, utf8('\nendstream')]);
      trailer = utf8('\nendobj\n');
    }
    offsets.push(offset);
    const piece = concatBytes([header, payload, trailer]);
    chunks.push(piece);
    offset += piece.length;
  });

  const xrefStart = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  const id = randomId();
  const trailerStr = `trailer\n<< /Size ${objects.length + 1} /Root ${catalogRef} 0 R /Info ${infoRef} 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(utf8(xref), utf8(trailerStr));

  return concatBytes(chunks);
}

function randomId() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = (Date.now() * (i + 7)) & 0xff;
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------------------------------------------------------- public API */

/** Whole pipeline: document model → PDF bytes. */
export async function blocksToPdf(blocks, options = {}) {
  const layout = layoutDocument(blocks, options);
  const bytes = await pdfFromLayout(layout, {
    title: options.title, author: options.author, subject: options.subject, createdAt: options.createdAt,
  });
  return { bytes, pages: layout.pages.length, warnings: layout.warnings };
}

/** Plain text of a document model — the .txt output path. */
export function blocksToText(blocks) {
  const out = [];
  for (const block of blocks || []) {
    const type = block.type || 'p';
    const runsText = (runs) => (Array.isArray(runs) ? runs : [{ text: String(runs == null ? '' : runs) }])
      .map((r) => (typeof r === 'string' ? r : r.text || '')).join('');
    if (type === 'h') out.push(`${'#'.repeat(clamp(block.level || 1, 1, 6))} ${runsText(block.runs || block.text)}`, '');
    else if (type === 'p' || type === 'quote') out.push((type === 'quote' ? '> ' : '') + runsText(block.runs || block.text), '');
    else if (type === 'ul') out.push(...(block.items || []).map((i) => `- ${runsText(i)}`), '');
    else if (type === 'ol') out.push(...(block.items || []).map((i, n) => `${(block.start || 1) + n}. ${runsText(i)}`), '');
    else if (type === 'code') out.push('```', String(block.text || ''), '```', '');
    else if (type === 'hr') out.push('---', '');
    else if (type === 'table') {
      const row = (cells) => (cells || []).map((c) => runsText(c)).join(' | ');
      if (block.head) out.push(row(block.head));
      for (const r of block.rows || []) out.push(row(r));
      out.push('');
    } else if (type === 'image') out.push(`[image: ${block.caption || block.name || 'image'}]`, '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** Rasterise nothing — but expose a page-count/metadata reader hook for tests. */
export async function inflatePdfStream(data) {
  return inflateZlib(data);
}

export { encodePng };
