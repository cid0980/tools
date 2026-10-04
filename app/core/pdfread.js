/**
 * A PDF reader, written from scratch.
 *
 * Scope, stated honestly: this extracts **text** (with ToUnicode CMaps, glyph
 * names and WinAnsi fallback), **page geometry**, **metadata** and the
 * **embedded images**. It does not rasterise pages — a full renderer is a
 * different order of project — so "PDF → image" means "extract the pictures the
 * PDF already contains", and the UI says exactly that.
 *
 * PDF files are wild: cross-reference tables, cross-reference streams, object
 * streams, broken writers. So this reader scans objects directly (no reliance on
 * the xref), then handles the compressed containers it finds. That makes it
 * tolerant of exactly the kind of file people actually have.
 */

import { toBytes, str, concatBytes, utf8 } from './util.js';
import { inflateZlib, inflateRaw } from './zip.js';
import { encodePng } from './image.js';

/* -------------------------------------------------------------- PDF syntax */

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);

function isWhite(ch) { return WS.has(ch.charCodeAt(0)); }
function isDelim(ch) { return '()<>[]{}/%'.includes(ch); }

/** Recursive-descent parser for one PDF object starting at `at`. */
function parseValue(s, at) {
  let i = at;
  const skip = () => {
    while (i < s.length) {
      const c = s[i];
      if (isWhite(c)) { i++; continue; }
      if (c === '%') { while (i < s.length && s[i] !== '\n') i++; continue; }
      break;
    }
  };
  skip();
  if (i >= s.length) return { value: null, next: i };

  const ch = s[i];

  if (ch === '<' && s[i + 1] !== '<') { // hex string
    const end = s.indexOf('>', i + 1);
    const body = s.slice(i + 1, end === -1 ? s.length : end).replace(/[^0-9a-fA-F]/g, '');
    const padded = body.length % 2 ? body + '0' : body;
    const bytes = new Uint8Array(padded.length / 2);
    for (let n = 0; n < bytes.length; n++) bytes[n] = parseInt(padded.substr(n * 2, 2), 16);
    return { value: { k: 'str', v: bytes }, next: end === -1 ? s.length : end + 1 };
  }

  if (ch === '(') { // literal string, with nesting and escapes
    const out = [];
    let depth = 1;
    i++;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\') {
        const n = s[i + 1];
        if (n === 'n') { out.push(10); i += 2; continue; }
        if (n === 'r') { out.push(13); i += 2; continue; }
        if (n === 't') { out.push(9); i += 2; continue; }
        if (n === 'b') { out.push(8); i += 2; continue; }
        if (n === 'f') { out.push(12); i += 2; continue; }
        if (n >= '0' && n <= '7') {
          let oct = '';
          let j = i + 1;
          while (j < s.length && oct.length < 3 && s[j] >= '0' && s[j] <= '7') { oct += s[j]; j++; }
          out.push(parseInt(oct, 8));
          i = j;
          continue;
        }
        if (n === '\n') { i += 2; continue; }
        if (n === '\r') { i += s[i + 2] === '\n' ? 3 : 2; continue; }
        out.push(n.charCodeAt(0) || 0);
        i += 2;
        continue;
      }
      if (c === '(') { depth++; out.push(0x28); i++; continue; }
      if (c === ')') { depth--; if (!depth) { i++; break; } out.push(0x29); i++; continue; }
      out.push(c.charCodeAt(0));
      i++;
    }
    return { value: { k: 'str', v: Uint8Array.from(out) }, next: i };
  }

  if (ch === '<') { // dictionary
    const entries = new Map();
    i += 2;
    for (;;) {
      const skipped = skipFrom(s, i);
      i = skipped;
      if (i >= s.length) break;
      if (s[i] === '>' && s[i + 1] === '>') { i += 2; break; }
      if (s[i] !== '/') { i++; continue; }
      const key = readName(s, i);
      i = key.next;
      const val = parseValue(s, i);
      i = val.next;
      if (key.name) entries.set(key.name, val.value);
    }
    return { value: { k: 'dict', v: entries }, next: i };
  }

  if (ch === '/') {
    const name = readName(s, i);
    return { value: { k: 'name', v: name.name }, next: name.next };
  }

  if (ch === '[') {
    const items = [];
    i++;
    for (;;) {
      i = skipFrom(s, i);
      if (i >= s.length || s[i] === ']') { i++; break; }
      const val = parseValue(s, i);
      i = val.next;
      items.push(val.value);
    }
    return { value: { k: 'arr', v: items }, next: i };
  }

  // number, reference or keyword
  const numMatch = /^[+-]?[\d.]+/.exec(s.slice(i));
  if (numMatch) {
    const first = Number(numMatch[0]);
    let j = i + numMatch[0].length;
    const refMatch = /^\s+(\d+)\s+R\b/.exec(s.slice(j));
    if (refMatch && Number.isInteger(first)) {
      return { value: { k: 'ref', num: first, gen: Number(refMatch[1]) }, next: j + refMatch[0].length };
    }
    return { value: { k: 'num', v: first }, next: j };
  }

  const word = /^[A-Za-z*'"]+/.exec(s.slice(i));
  if (word) return { value: { k: 'word', v: word[0] }, next: i + word[0].length };

  return { value: null, next: i + 1 };
}

function skipFrom(s, i) {
  while (i < s.length && isWhite(s[i])) i++;
  return i;
}

function readName(s, at) {
  let i = at + 1;
  let name = '';
  while (i < s.length && !isWhite(s[i]) && !isDelim(s[i])) { name += s[i]; i++; }
  // #xx escapes in names
  name = name.replace(/#([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return { name, next: i };
}

function dictGet(dict, key) {
  if (!dict || dict.k !== 'dict') return null;
  return dict.v.get(key) ?? null;
}

function asName(value) { return value && value.k === 'name' ? value.v : null; }
function asNumber(value) { return value && value.k === 'num' ? value.v : null; }

/* ------------------------------------------------------------- object store */

/**
 * Scan every "N G obj … endobj" in the file. Scanning instead of trusting the
 * xref is deliberate: it survives broken offsets, incremental updates and files
 * whose xref was never written.
 */
function scanObjects(bytes) {
  const s = str(bytes, 'latin1');
  const objects = new Map();
  const re = /(\d+)[\s]+(\d+)[\s]+obj\b/g;
  let match;
  let covered = 0; // bytes already consumed by a stream, so we don't rescan them

  while ((match = re.exec(s))) {
    const num = Number(match[1]);
    if (match.index < covered) continue;

    const bodyStart = match.index + match[0].length;
    const endObj = s.indexOf('endobj', bodyStart);
    let dictEnd = bodyStart;
    let dict = null;

    try {
      const parsed = parseValue(s, bodyStart);
      dict = parsed.value;
      dictEnd = parsed.next;
    } catch { dict = null; }

    let streamData = null;
    const streamKeyword = /stream\r?\n/.exec(s.slice(dictEnd, dictEnd + 20));
    if (streamKeyword) {
      const dataStart = dictEnd + streamKeyword.index + streamKeyword[0].length;
      let length = asNumber(dictGet(dict, 'Length'));
      const lengthRef = dictGet(dict, 'Length');
      if (lengthRef && lengthRef.k === 'ref') length = null; // resolve later; search instead
      let dataEnd;
      if (length && dataStart + length <= bytes.length) {
        dataEnd = dataStart + length;
        // tolerate writers that have the CRLF before endstream inside the length
        const after = s.slice(dataEnd, dataEnd + 12);
        if (!/^\s*endstream/.test(after)) {
          const found = s.indexOf('endstream', dataStart);
          if (found !== -1 && found - dataStart < 100000) dataEnd = found;
        }
      } else {
        const found = s.indexOf('endstream', dataStart);
        dataEnd = found === -1 ? Math.min(bytes.length, dataStart) : found;
      }
      streamData = bytes.subarray(dataStart, Math.max(dataStart, dataEnd));
      covered = dataEnd;
      re.lastIndex = dataEnd;
    } else if (endObj !== -1) {
      covered = Math.max(covered, 0);
    }

    if (!objects.has(num)) {
      objects.set(num, { num, body: s.slice(bodyStart, dictEnd), dict, stream: streamData, streamDict: streamData ? dict : null });
    }

    if (endObj !== -1 && re.lastIndex < endObj) re.lastIndex = endObj;
  }

  return objects;
}

/** Objects can be packed into /ObjStm streams; unpack those before anything else. */
async function expandObjectStreams(objects) {
  const pending = [...objects.values()].filter((o) => asName(dictGet(o.dict, 'Type')) === 'ObjStm' && o.stream);
  for (const container of pending) {
    const n = asNumber(dictGet(container.dict, 'N')) || 0;
    const first = asNumber(dictGet(container.dict, 'First')) || 0;
    let decoded;
    try { decoded = await decodeStream(container); } catch { continue; }
    const s = str(decoded, 'latin1');
    const pairs = s.slice(0, first).trim().split(/\s+/).map(Number).filter((v) => Number.isFinite(v));
    for (let i = 0; i < n; i++) {
      const num = pairs[i * 2];
      const offset = pairs[i * 2 + 1];
      if (num === undefined || offset === undefined) break;
      if (objects.has(num)) continue;
      const parsed = parseValue(s, first + offset);
      if (parsed && parsed.value) {
        objects.set(num, { num, body: s.slice(first + offset, parsed.next), dict: parsed.value, stream: null, streamDict: null });
      }
    }
  }
}

/* --------------------------------------------------------------- filters */

function resolve(objects, value, depth = 0) {
  if (!value || depth > 12) return null;
  if (value.k === 'ref') {
    const target = objects.get(value.num);
    if (!target) return null;
    return target.dict;
  }
  if (value.k === 'dict') return value;
  return null;
}

function resolveStream(objects, value) {
  if (!value || value.k !== 'ref') return null;
  return objects.get(value.num) || null;
}

/** Apply the stream's filters. Flate is the one that matters; the others are here for completeness. */
async function decodeStream(obj) {
  if (!obj || !obj.stream) return new Uint8Array(0);
  const filterValue = dictGet(obj.dict, 'Filter');
  const names = [];
  if (filterValue && filterValue.k === 'name') names.push(filterValue.v);
  else if (filterValue && filterValue.k === 'arr') for (const f of filterValue.v) { const n = asName(f); if (n) names.push(n); }
  if (!names.length) return obj.stream.slice();

  let data = obj.stream.slice();
  for (const name of names) {
    if (name === 'FlateDecode' || name === 'Fl') {
      try { data = await inflateZlib(data); }
      catch {
        try { data = await inflateRaw(data); }
        catch (err) { throw new Error(`Could not inflate a stream (${err.message})`); }
      }
      data = applyPredictor(data, obj.dict);
    } else if (name === 'ASCIIHexDecode' || name === 'AHx') {
      const text = str(data).replace(/[^0-9a-fA-F]/g, '');
      const out = new Uint8Array(Math.floor(text.length / 2));
      for (let i = 0; i < out.length; i++) out[i] = parseInt(text.substr(i * 2, 2), 16);
      data = out;
    } else if (name === 'ASCII85Decode' || name === 'A85') {
      data = ascii85Decode(data);
    } else if (name === 'RunLengthDecode' || name === 'RL') {
      data = runLengthDecode(data);
    }
    // DCTDecode / JPXDecode / CCITTFaxDecode stay as they are: they are already
    // the final image bytes, and text extraction never needs them.
  }
  return data;
}

function applyPredictor(data, dict) {
  const parms = dictGet(dict, 'DecodeParms') || dictGet(dict, 'DP');
  if (!parms || parms.k !== 'dict') return data;
  const predictor = asNumber(dictGet(parms, 'Predictor')) || 1;
  if (predictor <= 1) return data;
  const colors = asNumber(dictGet(parms, 'Colors')) || 1;
  const bpc = asNumber(dictGet(parms, 'BitsPerComponent')) || 8;
  const columns = asNumber(dictGet(parms, 'Columns')) || 1;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLength = Math.ceil((colors * bpc * columns) / 8);

  if (predictor === 2) { // TIFF predictor: horizontal differencing
    const out = data.slice();
    for (let r = 0; r + rowLength <= out.length; r += rowLength) {
      for (let i = bpp; i < rowLength; i++) out[r + i] = (out[r + i] + out[r + i - bpp]) & 0xff;
    }
    return out;
  }

  // PNG predictors: each row is prefixed with a filter byte
  const rows = Math.floor(data.length / (rowLength + 1));
  const out = new Uint8Array(rows * rowLength);
  for (let r = 0; r < rows; r++) {
    const filter = data[r * (rowLength + 1)];
    const line = data.subarray(r * (rowLength + 1) + 1, r * (rowLength + 1) + 1 + rowLength);
    const target = out.subarray(r * rowLength, (r + 1) * rowLength);
    const prior = r > 0 ? out.subarray((r - 1) * rowLength, r * rowLength) : null;
    for (let x = 0; x < rowLength; x++) {
      const a = x >= bpp ? target[x - bpp] : 0;
      const b = prior ? prior[x] : 0;
      const c = prior && x >= bpp ? prior[x - bpp] : 0;
      const v = line[x];
      let value;
      switch (filter) {
        case 0: value = v; break;
        case 1: value = v + a; break;
        case 2: value = v + b; break;
        case 3: value = v + ((a + b) >> 1); break;
        case 4: value = v + paeth(a, b, c); break;
        default: value = v;
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

function ascii85Decode(bytes) {
  const s = str(bytes).replace(/\s/g, '').replace(/^<~/, '').replace(/~>$/, '');
  const out = [];
  let tuple = 0;
  let count = 0;
  for (const ch of s) {
    if (ch === 'z' && count === 0) { out.push(0, 0, 0, 0); continue; }
    const code = ch.charCodeAt(0) - 33;
    if (code < 0 || code > 84) continue;
    tuple = tuple * 85 + code;
    if (++count === 5) {
      out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
      tuple = 0; count = 0;
    }
  }
  if (count > 0) {
    for (let i = count; i < 5; i++) tuple = tuple * 85 + 84;
    const bytesOut = [(tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff];
    out.push(...bytesOut.slice(0, count - 1));
  }
  return Uint8Array.from(out);
}

function runLengthDecode(bytes) {
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    const length = bytes[i++];
    if (length === 128) break;
    if (length < 128) {
      for (let n = 0; n <= length; n++) out.push(bytes[i + n]);
      i += length + 1;
    } else {
      const value = bytes[i++];
      for (let n = 0; n < 257 - length; n++) out.push(value);
    }
  }
  return Uint8Array.from(out);
}

/* -------------------------------------------------------------- encodings */

const WINANSI_REVERSE = new Map([
  [0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e], [0x85, 0x2026], [0x86, 0x2020],
  [0x87, 0x2021], [0x88, 0x02c6], [0x89, 0x2030], [0x8a, 0x0160], [0x8b, 0x2039], [0x8c, 0x0152],
  [0x8e, 0x017d], [0x91, 0x2018], [0x92, 0x2019], [0x93, 0x201c], [0x94, 0x201d], [0x95, 0x2022],
  [0x96, 0x2013], [0x97, 0x2014], [0x98, 0x02dc], [0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a],
  [0x9c, 0x0153], [0x9e, 0x017e], [0x9f, 0x0178],
]);

function winAnsiChar(byte) {
  if (WINANSI_REVERSE.has(byte)) return String.fromCodePoint(WINANSI_REVERSE.get(byte));
  return String.fromCharCode(byte);
}

const GLYPH_TO_UNICODE = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&',
  quotesingle: "'", parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-',
  period: '.', slash: '/', zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
  seven: '7', eight: '8', nine: '9', colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>',
  question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']', asciicircum: '^',
  underscore: '_', grave: '`', braceleft: '{', bar: '|', braceright: '}', asciitilde: '~',
  quoteright: '\u2019', quoteleft: '\u2018', quotedblleft: '\u201c', quotedblright: '\u201d',
  quotedblbase: '\u201e', endash: '\u2013', emdash: '\u2014', bullet: '\u2022', ellipsis: '\u2026',
  dagger: '\u2020', daggerdbl: '\u2021', perthousand: '\u2030', Euro: '\u20ac', euro: '\u20ac',
  trademark: '\u2122', degree: '\u00b0', plusminus: '\u00b1', multiply: '\u00d7', divide: '\u00f7',
  fraction: '\u2044', florin: '\u0192', section: '\u00a7', paragraph: '\u00b6', periodcentered: '\u00b7',
  guillemotleft: '\u00ab', guillemotright: '\u00bb', guilsinglleft: '\u2039', guilsinglright: '\u203a',
  ae: '\u00e6', oe: '\u0153', oslash: '\u00f8', aring: '\u00e5', germandbls: '\u00df', eth: '\u00f0',
  thorn: '\u00fe', AE: '\u00c6', OE: '\u0152', Oslash: '\u00d8', Aring: '\u00c5', questiondown: '\u00bf',
  exclamdown: '\u00a1', sterling: '\u00a3', yen: '\u00a5', cent: '\u00a2', currency: '\u00a4',
  brokenbar: '\u00a6', copyright: '\u00a9', registered: '\u00ae', ordmasculine: '\u00ba',
  ordfeminine: '\u00aa', onesuperior: '\u00b9', twosuperior: '\u00b2', threesuperior: '\u00b3',
  onequarter: '\u00bc', onehalf: '\u00bd', threequarters: '\u00be', notequal: '\u2260',
  lessequal: '\u2264', greaterequal: '\u2265', infinity: '\u221e', approxequal: '\u2248',
  lozenge: '\u25ca', dotlessi: '\u0131', nbspace: '\u00a0',
};

const DIACRITICS = { acute: '\u0301', grave: '\u0300', circumflex: '\u0302', tilde: '\u0303', dieresis: '\u0308', ring: '\u030a', cedilla: '\u0327', caron: '\u030c', breve: '\u0306', macron: '\u0304', ogonek: '\u0328', dotaccent: '\u0307' };

export function glyphNameToUnicode(name) {
  if (!name) return '';
  if (GLYPH_TO_UNICODE[name]) return GLYPH_TO_UNICODE[name];
  const uni = /^uni([0-9A-Fa-f]{4,6})$/.exec(name);
  if (uni) { try { return String.fromCodePoint(parseInt(uni[1], 16)); } catch { return ''; } }
  const u = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (u) { try { return String.fromCodePoint(parseInt(u[1], 16)); } catch { return ''; } }
  // "eacute" → e + combining acute
  for (const [mark, combining] of Object.entries(DIACRITICS)) {
    if (name.endsWith(mark) && name.length > mark.length) {
      const base = name.slice(0, -mark.length);
      const baseChar = base.length === 1 ? base : (GLYPH_TO_UNICODE[base] || '');
      if (baseChar) return (baseChar + combining).normalize('NFC');
    }
  }
  return '';
}

/** Parse a /ToUnicode CMap into a code → string map. */
export function parseToUnicode(text) {
  const map = new Map();
  const src = String(text || '');
  let maxCode = 0;

  const readHex = (hex) => {
    const clean = hex.replace(/[^0-9a-fA-F]/g, '');
    let out = '';
    for (let i = 0; i + 3 < clean.length + 1; i += 4) {
      const code = parseInt(clean.substr(i, 4), 16);
      if (!Number.isFinite(code)) break;
      if (code === 0) continue;
      out += String.fromCharCode(code);
    }
    return out;
  };

  const bfchar = /beginbfchar([\s\S]*?)endbfchar/g;
  let m;
  while ((m = bfchar.exec(src))) {
    const pairs = m[1].match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g) || [];
    for (const pair of pairs) {
      const [src2, dst] = pair.match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/).slice(1);
      const code = parseInt(src2, 16);
      maxCode = Math.max(maxCode, code);
      map.set(code, readHex(dst));
    }
  }

  const bfrange = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = bfrange.exec(src))) {
    const body = m[1];
    const simple = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g;
    let r;
    while ((r = simple.exec(body))) {
      const lo = parseInt(r[1], 16);
      const hi = parseInt(r[2], 16);
      const dst = readHex(r[3]);
      const base = dst.length ? dst.codePointAt(0) : 0;
      for (let code = lo; code <= hi && code - lo < 512; code++) {
        map.set(code, dst.length === 1 ? String.fromCodePoint(base + (code - lo)) : dst);
        maxCode = Math.max(maxCode, code);
      }
    }
    const arrayForm = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([^\]]*)\]/g;
    while ((r = arrayForm.exec(body))) {
      const lo = parseInt(r[1], 16);
      const items = r[3].match(/<([0-9a-fA-F]*)>/g) || [];
      items.forEach((item, index) => {
        const dst = readHex(item.slice(1, -1));
        map.set(lo + index, dst);
        maxCode = Math.max(maxCode, lo + index);
      });
    }
  }
  return { map, twoByte: maxCode > 255 };
}

/* ------------------------------------------------------------------ fonts */

async function buildFontDecoder(objects, fontDict) {
  const builtin = { map: null, twoByte: false, differences: null };
  if (!fontDict || fontDict.k !== 'dict') return (bytes) => [...bytes].map(winAnsiChar).join('');

  // /ToUnicode is the authoritative mapping when present
  const toUnicodeRef = dictGet(fontDict, 'ToUnicode');
  const toUnicodeObj = toUnicodeRef && toUnicodeRef.k === 'ref' ? objects.get(toUnicodeRef.num) : null;
  if (toUnicodeObj && toUnicodeObj.stream) {
    try {
      const decoded = await decodeStream(toUnicodeObj);
      const parsed = parseToUnicode(str(decoded, 'latin1'));
      if (parsed.map.size) {
        builtin.map = parsed.map;
        builtin.twoByte = parsed.twoByte;
      }
    } catch { /* fall through to encoding */ }
  }

  // /Encoding /Differences [ 65 /Aacute /Bcedilla … ]
  const encoding = dictGet(fontDict, 'Encoding');
  if (encoding && encoding.k === 'dict') {
    const diffs = dictGet(encoding, 'Differences');
    if (diffs && diffs.k === 'arr') {
      const map = new Map();
      let code = 0;
      for (const item of diffs.v) {
        if (item.k === 'num') code = item.v;
        else if (item.k === 'name') { map.set(code, glyphNameToUnicode(item.v)); code++; }
      }
      builtin.differences = map;
    }
  }

  return (bytes) => {
    if (builtin.map) {
      let out = '';
      if (builtin.twoByte) {
        for (let i = 0; i < bytes.length; i += 2) {
          const code = (bytes[i] << 8) | (bytes[i + 1] || 0);
          const mapped = builtin.map.get(code);
          out += mapped !== undefined ? mapped : (bytes[i] ? winAnsiChar(bytes[i]) : '');
        }
      } else {
        for (const byte of bytes) {
          const mapped = builtin.map.get(byte);
          out += mapped !== undefined ? mapped : winAnsiChar(byte);
        }
      }
      return out;
    }
    let out = '';
    for (const byte of bytes) {
      const mapped = builtin.differences ? builtin.differences.get(byte) : null;
      out += mapped !== undefined && mapped !== null ? mapped : winAnsiChar(byte);
    }
    return out;
  };
}

/* ------------------------------------------------------------- text layout */

/** Width of a run of text, used only to decide where spaces belong. */
function approximateWidth(text, fontSize) { return text.length * fontSize * 0.5; }

function chunksToText(chunks) {
  if (!chunks.length) return '';
  const sorted = [...chunks].sort((a, b) => (Math.abs(a.y - b.y) > 1 ? b.y - a.y : a.x - b.x));
  const lines = [];
  let line = null;

  for (const chunk of sorted) {
    const size = chunk.size || 10;
    if (!line || Math.abs(chunk.y - line.y) > Math.max(2, size * 0.4)) {
      line = { y: chunk.y, size, chunks: [chunk] };
      lines.push(line);
    } else {
      line.chunks.push(chunk);
      line.size = Math.max(line.size, size);
    }
  }

  let out = '';
  let previous = null;
  for (const current of lines) {
    const pieces = [];
    let lastEnd = null;
    for (const chunk of current.chunks.sort((a, b) => a.x - b.x)) {
      if (lastEnd !== null) {
        const gap = chunk.x - lastEnd;
        if (gap > Math.max(1.2, current.size * 0.22) && !/\s$/.test(pieces.join(''))) pieces.push(' ');
      }
      pieces.push(chunk.text);
      lastEnd = chunk.x + approximateWidth(chunk.text, current.size);
    }
    const text = pieces.join('').replace(/\s+$/, '');
    if (!text) continue;
    if (previous) {
      const gap = previous.y - current.y;
      if (gap > Math.max(previous.size, current.size) * 1.75) out += '\n';
      else out += '\n';
    }
    out += text;
    previous = current;
  }
  return out;
}

/* ------------------------------------------------------------ page walking */

function collectPages(objects) {
  const pages = [];
  let catalog = null;
  for (const obj of objects.values()) {
    if (asName(dictGet(obj.dict, 'Type')) === 'Catalog') { catalog = obj; break; }
  }
  const root = catalog ? resolve(objects, dictGet(catalog.dict, 'Pages')) : null;
  const roots = root ? [root] : [...objects.values()].map((o) => o.dict).filter((d) => asName(dictGet(d, 'Type')) === 'Pages');

  const visit = (nodeDict, inherited) => {
    if (!nodeDict || nodeDict.k !== 'dict') return;
    const type = asName(dictGet(nodeDict, 'Type'));
    const merged = {
      Resources: dictGet(nodeDict, 'Resources') || inherited.Resources,
      MediaBox: dictGet(nodeDict, 'MediaBox') || inherited.MediaBox,
      Rotate: dictGet(nodeDict, 'Rotate') || inherited.Rotate,
    };
    if (type === 'Page') {
      pages.push({ dict: nodeDict, inherited: merged });
      return;
    }
    const kids = dictGet(nodeDict, 'Kids');
    if (kids && kids.k === 'arr') {
      for (const kid of kids.v) {
        const childDict = kid.k === 'ref' ? resolve(objects, kid) : kid;
        visit(childDict, merged);
      }
    }
  };
  for (const r of roots) visit(r, {});
  return pages;
}

function pageMediaBox(page, objects) {
  const box = page.inherited.MediaBox || dictGet(page.dict, 'MediaBox');
  if (!box || box.k !== 'arr' || box.v.length < 4) return { width: 595.28, height: 841.89, box: [0, 0, 595.28, 841.89] };
  const nums = box.v.map((v) => asNumber(v) || 0);
  return { width: Math.abs(nums[2] - nums[0]), height: Math.abs(nums[3] - nums[1]), box: nums };
}

async function pageContent(objects, page) {
  const contents = dictGet(page.dict, 'Contents') || page.inherited.Contents;
  const parts = [];
  const refs = contents && contents.k === 'arr' ? contents.v : contents ? [contents] : [];
  for (const ref of refs) {
    const obj = ref.k === 'ref' ? objects.get(ref.num) : null;
    if (!obj || !obj.stream) continue;
    try { parts.push(await decodeStream(obj)); } catch { /* a broken stream should not kill the page */ }
  }
  if (!parts.length) return null;
  return concatBytes(parts);
}

/* --------------------------------------------------------------- extraction */

/**
 * @returns {Promise<{pageCount, pages, text, meta, warnings, images}>}
 */
export async function readPdf(input, { maxPages = 500, extractImages = true } = {}) {
  const bytes = toBytes(input);
  const header = str(bytes.subarray(0, 8)).trim();
  if (!header.startsWith('%PDF-')) throw new Error('Not a PDF (missing %PDF header)');

  const objects = scanObjects(bytes);
  await expandObjectStreams(objects);
  const warnings = [];

  const pageNodes = collectPages(objects);
  if (!pageNodes.length) warnings.push('No pages found — the file may be encrypted or use a structure this reader does not recognise');

  const pages = [];
  const images = [];
  let decoderCache = new Map();

  for (let index = 0; index < Math.min(pageNodes.length, maxPages); index++) {
    const node = pageNodes[index];
    const media = pageMediaBox(node, objects);
    const content = await pageContent(objects, node);
    const pageImages = [];

    // fonts for this page
    const resources = resolve(objects, node.inherited.Resources) || (node.inherited.Resources && node.inherited.Resources.k === 'dict' ? node.inherited.Resources : null);
    const fontDict = resources ? resolve(objects, dictGet(resources, 'Font')) || (dictGet(resources, 'Font') && dictGet(resources, 'Font').k === 'dict' ? dictGet(resources, 'Font') : null) : null;
    const decoders = new Map();
    if (fontDict && fontDict.k === 'dict') {
      for (const [name, value] of fontDict.v) {
        const fontObj = resolve(objects, value);
        const key = `${index}:${name}`;
        if (!decoderCache.has(key)) decoderCache.set(key, await buildFontDecoder(objects, fontObj));
        decoders.set(name, decoderCache.get(key));
      }
    }

    let text = '';
    if (content) text = extractTextFromContent(str(content, 'latin1'), decoders);
    if (!text.trim()) {
      // No text layer at all: say so rather than producing an empty document
      if (content) warnings.push(`Page ${index + 1} has no extractable text (it is probably a scan or an image-only page)`);
    }

    if (extractImages) {
      const xobjects = resources ? dictGet(resources, 'XObject') : null;
      const xdict = resolve(objects, xobjects);
      if (xdict && xdict.k === 'dict') {
        let n = 0;
        for (const [name, value] of xdict.v) {
          const obj = resolveStream(objects, value);
          if (!obj || !obj.stream) continue;
          if (asName(dictGet(obj.dict, 'Subtype')) !== 'Image') continue;
          n++;
          try {
            const extracted = await extractImage(objects, obj, index + 1, n);
            if (extracted) { pageImages.push(extracted); images.push(extracted); }
            else warnings.push(`Page ${index + 1} image ${n} uses a format OmniBox cannot re-encode (likely CMYK/JPX) — skipped`);
          } catch (err) {
            warnings.push(`Page ${index + 1} image ${n} could not be extracted: ${err.message}`);
          }
        }
      }
    }

    pages.push({
      index: index + 1,
      width: media.width,
      height: media.height,
      rotation: asNumber(node.inherited.Rotate) || 0,
      text,
      images: pageImages,
    });
  }

  if (pageNodes.length > maxPages) warnings.push(`Only the first ${maxPages} pages were read`);

  const meta = readInfo(objects);

  return {
    pageCount: pageNodes.length,
    pages,
    text: pages.map((p) => p.text).join('\n\n').trim(),
    meta,
    warnings,
    images,
    objects: objects.size,
  };
}

function readInfo(objects) {
  const meta = {};
  for (const obj of objects.values()) {
    const dict = obj.dict;
    if (!dict || dict.k !== 'dict') continue;
    if (dict.v.has('Title') || dict.v.has('Producer')) {
      const pick = (key) => {
        const value = dictGet(dict, key);
        if (!value) return '';
        if (value.k === 'str') return str(value.v, 'latin1');
        if (value.k === 'name') return value.v;
        return '';
      };
      meta.title = meta.title || pick('Title');
      meta.author = meta.author || pick('Author');
      meta.subject = meta.subject || pick('Subject');
      meta.producer = meta.producer || pick('Producer');
      meta.created = meta.created || pick('CreationDate');
      break;
    }
  }
  return meta;
}

/** Tokenise a content stream and pull out the shown text with coordinates. */
export function extractTextFromContent(content, decoders = new Map()) {
  const chunks = [];
  let i = 0;
  const stack = [];
  let fontName = null;
  let fontSize = 12;
  let leading = 0;
  let charSpacing = 0;
  let wordSpacing = 0;
  let x = 0;
  let y = 0;
  let pendingString = null;

  const show = (bytes) => {
    const decode = decoders.get(fontName) || ((b) => [...b].map(winAnsiChar).join(''));
    const text = decode(bytes);
    if (text) chunks.push({ x, y, size: fontSize, text });
    x += approximateWidth(text, fontSize) + charSpacing;
  };

  while (i < content.length) {
    i = skipFrom(content, i);
    if (i >= content.length) break;
    const ch = content[i];

    if (ch === '(' || ch === '<' && content[i + 1] !== '<') {
      const parsed = parseValue(content, i);
      i = parsed.next;
      pendingString = parsed.value && parsed.value.k === 'str' ? parsed.value.v : null;
      stack.push(parsed.value);
      continue;
    }
    if (ch === '<' && content[i + 1] === '<') {
      const parsed = parseValue(content, i);
      i = parsed.next;
      stack.push(parsed.value);
      continue;
    }
    if (ch === '[') {
      const items = [];
      i++;
      let current = [];
      for (;;) {
        i = skipFrom(content, i);
        if (i >= content.length || content[i] === ']') { i++; break; }
        if (content[i] === '(' || (content[i] === '<' && content[i + 1] !== '<')) {
          const parsed = parseValue(content, i);
          i = parsed.next;
          current.push({ type: 'str', bytes: parsed.value.v });
          continue;
        }
        const num = /^[+-]?[\d.]+/.exec(content.slice(i));
        if (num) { current.push({ type: 'num', value: Number(num[0]) }); i += num[0].length; continue; }
        i++;
      }
      items.push(...current);
      stack.push({ k: 'arr', v: items });
      continue;
    }
    if (ch === '/') {
      const name = readName(content, i);
      i = name.next;
      stack.push({ k: 'name', v: name.name });
      continue;
    }

    const num = /^[+-]?[\d.]+/.exec(content.slice(i));
    if (num) { stack.push({ k: 'num', v: Number(num[0]) }); i += num[0].length; continue; }

    const op = /^[A-Za-z*'"]+/.exec(content.slice(i));
    if (!op) { i++; continue; }
    const operator = op[0];
    i += operator.length;

    const nums = stack.filter((v) => v && v.k === 'num').map((v) => v.v);
    const names = stack.filter((v) => v && v.k === 'name');
    const strings = stack.filter((v) => v && v.k === 'str');
    const arrays = stack.filter((v) => v && v.k === 'arr');

    switch (operator) {
      case 'BT': x = 0; y = 0; break;
      case 'Tf':
        if (names.length) fontName = names[names.length - 1].v;
        if (nums.length) fontSize = nums[nums.length - 1];
        break;
      case 'TL': if (nums.length) leading = nums[nums.length - 1]; break;
      case 'Tc': if (nums.length) charSpacing = nums[nums.length - 1]; break;
      case 'Tw': if (nums.length) wordSpacing = nums[nums.length - 1]; break;
      case 'Td': if (nums.length >= 2) { x += nums[nums.length - 2]; y += nums[nums.length - 1]; } break;
      case 'TD': if (nums.length >= 2) { x += nums[nums.length - 2]; y += nums[nums.length - 1]; leading = -nums[nums.length - 1]; } break;
      case 'Tm': if (nums.length >= 6) { x = nums[nums.length - 2]; y = nums[nums.length - 1]; } break;
      case 'T*': y -= leading; x = 0; break;
      case 'Tj': if (strings.length) show(strings[strings.length - 1].v); break;
      case "'": y -= leading; x = 0; if (strings.length) show(strings[strings.length - 1].v); break;
      case '"': y -= leading; x = 0; if (strings.length) show(strings[strings.length - 1].v); break;
      case 'TJ': {
        const array = arrays[arrays.length - 1];
        if (array) {
          for (const item of array.v) {
            if (item.type === 'str') show(item.bytes);
            else if (item.type === 'num' && item.value <= -180) x += fontSize * 0.28; // wide kern = a space
          }
        }
        break;
      }
      default: break;
    }
    stack.length = 0;
    pendingString = null;
  }

  return chunksToText(chunks);
}

/* ------------------------------------------------------------ images out */

async function extractImage(objects, obj, pageNumber, index) {
  const dict = obj.dict;
  const width = asNumber(dictGet(dict, 'Width')) || 0;
  const height = asNumber(dictGet(dict, 'Height')) || 0;
  const filters = [];
  const filterValue = dictGet(dict, 'Filter');
  if (filterValue && filterValue.k === 'name') filters.push(filterValue.v);
  else if (filterValue && filterValue.k === 'arr') for (const f of filterValue.v) { const n = asName(f); if (n) filters.push(n); }

  if (filters.includes('DCTDecode')) {
    return {
      name: `page${pageNumber}-image${index}.jpg`,
      mime: 'image/jpeg', bytes: obj.stream.slice(), width, height, page: pageNumber,
    };
  }

  if (!filters.length || filters.every((f) => f === 'FlateDecode' || f === 'Fl')) {
    const colorspace = dictGet(dict, 'ColorSpace');
    const csName = asName(colorspace) || asName(colorspace && colorspace.k === 'arr' ? colorspace.v[0] : null);
    const bpc = asNumber(dictGet(dict, 'BitsPerComponent')) || 8;
    if (bpc !== 8 || (csName !== 'DeviceRGB' && csName !== 'DeviceGray')) return null;
    const data = await decodeStream(obj);
    const channels = csName === 'DeviceRGB' ? 3 : 1;
    if (data.length < width * height * channels) return null;
    const rgb = new Uint8Array(width * height * 3);
    for (let p = 0; p < width * height; p++) {
      if (channels === 3) { rgb[p * 3] = data[p * 3]; rgb[p * 3 + 1] = data[p * 3 + 1]; rgb[p * 3 + 2] = data[p * 3 + 2]; }
      else { const v = data[p]; rgb[p * 3] = v; rgb[p * 3 + 1] = v; rgb[p * 3 + 2] = v; }
    }
    return {
      name: `page${pageNumber}-image${index}.png`,
      mime: 'image/png', bytes: await encodePng({ width, height, rgb }), width, height, page: pageNumber,
    };
  }
  return null;
}

/* ----------------------------------------------------------- text → blocks */

/**
 * Heuristic structure recovery: PDF has no idea what a "heading" is, so this
 * reads the shapes people actually write — short lines, bullets, numbers — and
 * labels them. It is honest about being a guess: nothing is dropped.
 */
export function pdfTextToBlocks(pages) {
  const blocks = [];
  const list = Array.isArray(pages) ? pages : [{ text: String(pages || '') }];

  list.forEach((page, pageIndex) => {
    if (pageIndex > 0) blocks.push({ type: 'pagebreak' });
    const text = String(page.text || '').replace(/\r\n?/g, '\n');
    let paragraph = [];

    const flush = () => {
      if (!paragraph.length) return;
      const joined = paragraph.join(' ');
      blocks.push({ type: 'p', runs: [{ text: joined }] });
      paragraph = [];
    };

    for (const rawLine of text.split('\n')) {
      const line = rawLine.replace(/\s+$/, '');
      if (!line.trim()) { flush(); continue; }

      const bullet = /^\s*[•▪◦‣·*+-]\s+(.*)$/.exec(line);
      const numbered = /^\s*(\d{1,3})[.)]\s+(.*)$/.exec(line);

      if (bullet) {
        flush();
        const last = blocks[blocks.length - 1];
        if (last && last.type === 'ul') last.items.push([{ text: bullet[1] }]);
        else blocks.push({ type: 'ul', items: [[{ text: bullet[1] }]] });
        continue;
      }
      if (numbered) {
        flush();
        const last = blocks[blocks.length - 1];
        if (last && last.type === 'ol') last.items.push([{ text: numbered[2] }]);
        else blocks.push({ type: 'ol', items: [[{ text: numbered[2] }]], start: Number(numbered[1]) });
        continue;
      }

      // A short, title-ish line standing alone reads as a heading.
      const words = line.trim().split(/\s+/);
      const previousBlank = paragraph.length === 0;
      if (previousBlank && words.length <= 9 && !/[.;:,]$/.test(line.trim()) && line.trim().length <= 70) {
        flush();
        blocks.push({ type: 'h', level: 2, runs: [{ text: line.trim() }] });
        continue;
      }

      paragraph.push(line.trim());
    }
    flush();
  });

  return blocks;
}

/** Everything a caller needs for "PDF → text" in one call. */
export async function pdfToText(input) {
  const result = await readPdf(input, { extractImages: false });
  return { text: result.text, pages: result.pageCount, warnings: result.warnings, meta: result.meta };
}

/** PDF → block model (for Word / PDF / Markdown output). */
export async function pdfToBlocks(input, options = {}) {
  const result = await readPdf(input, options);
  const blocks = [];
  if (result.meta.title) blocks.push({ type: 'h', level: 1, runs: [{ text: result.meta.title }] });
  blocks.push(...pdfTextToBlocks(result.pages));
  return { blocks, result, warnings: result.warnings };
}
