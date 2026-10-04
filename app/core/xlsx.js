/**
 * Spreadsheets: .xlsx reading/writing and CSV/TSV.
 *
 * Sheets are plain grids, which is what makes "spreadsheet → PDF", "→ CSV" and
 * "CSV → Excel" all the same few lines of glue. Dates are the classic trap here:
 * Excel stores them as day serials, so a number only becomes a date if the cell's
 * style says so — that lookup is done properly via styles.xml.
 */

import { parseXml, findAll, childNodes, child, attr, textOf, xmlDeclaration, escapeXml } from './xml.js';
import { writeZip, readZip } from './zip.js';
import { str } from './util.js';

/* -------------------------------------------------------------- cell refs */

export function columnToIndex(letters) {
  let n = 0;
  for (const ch of String(letters || '').toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

export function indexToColumn(index) {
  let n = Number(index) + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function splitRef(ref) {
  const match = /^([A-Za-z]*)(\d*)$/.exec(String(ref || ''));
  if (!match) return { col: 0, row: 0 };
  return { col: columnToIndex(match[1]), row: Math.max(0, Number(match[2]) - 1) };
}

/* ---------------------------------------------------------------- dates */

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function isDateFormat(numFmtId, formatCode) {
  if (BUILTIN_DATE_FORMATS.has(Number(numFmtId))) return true;
  if (!formatCode) return false;
  const code = String(formatCode).replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, '');
  return /(^|[^\\])(y{2,}|d{1,2}|m{1,5}|h{1,2}|s{1,2})/.test(code) && !/^[#0.,%\s]*$/.test(code);
}

/** Excel's 1900 date system (with the deliberate 1900 leap-year bug). */
export function excelSerialToDate(serial) {
  const value = Number(serial);
  if (!Number.isFinite(value)) return null;
  const days = Math.floor(value);
  const fraction = value - days;
  const epoch = Date.UTC(1899, 11, 30); // day 1 = 1900-01-01
  const ms = epoch + days * 86400000 + Math.round(fraction * 86400000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function formatDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  const time = d.getUTCHours() || d.getUTCMinutes() || d.getUTCSeconds();
  const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return time ? `${date} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : date;
}

/* ---------------------------------------------------------------- reading */

/**
 * @returns {Promise<{sheets: Array<{name, rows: Array<Array<string|number>>, truncated?: boolean}>, meta, warnings}>}
 */
export async function readXlsx(input, { maxRows = 20000 } = {}) {
  const { entries } = await readZip(input);
  const warnings = [];
  const read = (name) => (entries.has(name) ? str(entries.get(name).bytes) : null);

  const workbookXml = read('xl/workbook.xml');
  if (!workbookXml) throw new Error('Not a spreadsheet: xl/workbook.xml is missing');

  const relsXml = read('xl/_rels/workbook.xml.rels') || '';
  const relTargets = {};
  for (const rel of findAll(parseXml(relsXml), 'Relationship')) {
    relTargets[attr(rel, 'Id', '')] = attr(rel, 'Target', '');
  }

  const sharedStrings = [];
  const sstXml = read('xl/sharedStrings.xml');
  if (sstXml) {
    const sst = parseXml(sstXml);
    for (const si of findAll(sst, 'si')) sharedStrings.push(textOf(si));
  }

  // style index → number format, so dates can be recognised
  const styleFormats = [0];
  const customFormats = {};
  const stylesXml = read('xl/styles.xml');
  if (stylesXml) {
    const styles = parseXml(stylesXml);
    for (const fmt of findAll(styles, 'numFmt')) customFormats[attr(fmt, 'numFmtId', '')] = attr(fmt, 'formatCode', '');
    const cellXfs = findAll(styles, 'cellXfs')[0];
    if (cellXfs) {
      const xfs = childNodes(cellXfs, 'xf');
      styleFormats.length = 0;
      for (const xf of xfs) styleFormats.push(Number(attr(xf, 'numFmtId', '0')) || 0);
    }
  }

  const workbook = parseXml(workbookXml);
  const sheetNodes = findAll(workbook, 'sheet');
  const sheets = [];

  for (let i = 0; i < sheetNodes.length; i++) {
    const node = sheetNodes[i];
    const name = attr(node, 'name', `Sheet${i + 1}`);
    const rid = attr(node, 'r:id', null);
    let target = rid && relTargets[rid] ? relTargets[rid] : `worksheets/sheet${i + 1}.xml`;
    target = target.replace(/^\//, '').replace(/^xl\//, '');
    const sheetXml = read(`xl/${target}`) || read(target);
    if (!sheetXml) { warnings.push(`Sheet "${name}" is missing from the file`); continue; }

    const sheetDoc = parseXml(sheetXml);
    const rows = [];
    let truncated = false;
    const rowNodes = findAll(sheetDoc, 'row');
    for (const rowNode of rowNodes) {
      if (rows.length >= maxRows) { truncated = true; break; }
      const cells = [];
      for (const c of childNodes(rowNode, 'c')) {
        const ref = attr(c, 'r', null);
        const at = ref ? splitRef(ref).col : cells.length;
        const type = attr(c, 't', 'n');
        const styleIndex = Number(attr(c, 's', '0')) || 0;
        const numFmtId = styleFormats[styleIndex] || 0;
        let value = '';

        if (type === 'inlineStr') {
          const is = child(c, 'is');
          value = is ? textOf(is) : '';
        } else {
          const v = child(c, 'v');
          const raw = v ? textOf(v) : '';
          if (type === 's') value = sharedStrings[Number(raw)] ?? '';
          else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
          else if (type === 'e') value = raw;
          else if (type === 'str') value = raw;
          else if (raw === '') value = '';
          else if (isDateFormat(numFmtId, customFormats[numFmtId])) {
            const date = excelSerialToDate(raw);
            value = date ? formatDate(date) : raw;
          } else {
            const n = Number(raw);
            value = Number.isFinite(n) ? n : raw;
          }
        }
        while (cells.length < at) cells.push('');
        cells[at] = value;
      }
      rows.push(cells);
    }
    // trim trailing empty rows/columns so a stray cell doesn't create 1000 columns
    while (rows.length && rows[rows.length - 1].every((c) => c === '' || c == null)) rows.pop();
    const width = rows.reduce((n, r) => Math.max(n, r.length), 0);
    for (const r of rows) while (r.length < width) r.push('');

    sheets.push({ name, rows, truncated, rowCount: rows.length, columnCount: width });
    if (truncated) warnings.push(`Sheet "${name}" has more than ${maxRows} rows — only the first ${maxRows} were converted`);
  }

  const meta = {};
  const core = read('docProps/core.xml');
  if (core) {
    const doc = parseXml(core);
    const pick = (tag) => { const node = findAll(doc, tag)[0]; return node ? textOf(node).trim() : ''; };
    meta.title = pick('dc:title') || pick('title');
    meta.author = pick('dc:creator') || pick('creator');
  }

  if (!sheets.length) throw new Error('Spreadsheet has no readable sheets');
  return { sheets, meta, warnings };
}

/* ------------------------------------------------------------ delimited text */

export function detectDelimiter(text) {
  const sample = String(text || '').split(/\r?\n/).slice(0, 8).join('\n');
  const counts = { ',': 0, '\t': 0, ';': 0, '|': 0 };
  let inQuotes = false;
  for (const ch of sample) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ',';
}

/** RFC 4180-ish: quoted fields, embedded newlines, doubled quotes. */
export function parseDelimited(text, { delimiter = null } = {}) {
  const src = String(text == null ? '' : text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const sep = delimiter || detectDelimiter(src);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === sep) { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  row.push(field);
  rows.push(row);

  while (rows.length && rows[rows.length - 1].every((c) => c === '')) rows.pop();
  const width = rows.reduce((n, r) => Math.max(n, r.length), 0);
  for (const r of rows) while (r.length < width) r.push('');
  return { rows, delimiter: sep };
}

export function sheetToDelimited(rows, { delimiter = ',' } = {}) {
  const escapeCell = (value) => {
    const text = value == null ? '' : String(value);
    const needs = text.includes(delimiter) || text.includes('"') || /[\n\r]/.test(text);
    return needs ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return (rows || []).map((row) => (row || []).map(escapeCell).join(delimiter)).join('\r\n') + '\r\n';
}

/* ----------------------------------------------------------------- grids → blocks */

/** One heading + one table per sheet — good enough for PDF and Word output. */
export function sheetsToBlocks(sheets, { maxRows = 500 } = {}) {
  const blocks = [];
  const multiple = sheets.length > 1;
  sheets.forEach((sheet, index) => {
    if (multiple || sheet.name) blocks.push({ type: 'h', level: 2, runs: [{ text: sheet.name }] });
    const rows = (sheet.rows || []).slice(0, maxRows);
    if (!rows.length) { blocks.push({ type: 'p', runs: [{ text: '(empty sheet)' }] }); return; }
    const head = rows[0].map((c) => [{ text: String(c == null ? '' : c) }]);
    const body = rows.slice(1).map((r) => r.map((c) => [{ text: String(c == null ? '' : c) }]));
    if (body.length) blocks.push({ type: 'table', head, rows: body });
    else blocks.push({ type: 'table', rows: [head] });
    if (sheet.rows.length > rows.length) {
      blocks.push({ type: 'p', runs: [{ text: `… ${sheet.rows.length - rows.length} more rows were not included in this conversion.`, italic: true }] });
    }
    if (index < sheets.length - 1) blocks.push({ type: 'pagebreak' });
  });
  return blocks;
}

/* ------------------------------------------------------------------ writing */

function inlineCellXml(value, ref) {
  if (value == null || value === '') return '';
  const isNumber = typeof value === 'number' && Number.isFinite(value);
  if (isNumber) return `<c r="${ref}"><v>${value}</v></c>`;
  const text = escapeXml(String(value));
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
}

/**
 * @param sheets Array<{name, rows}>  rows are arrays of strings/numbers
 */
export async function writeXlsx(sheets, meta = {}) {
  const clean = (sheets || []).map((sheet, i) => ({
    name: String(sheet.name || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, '_').slice(0, 31) || `Sheet${i + 1}`,
    rows: sheet.rows || [],
  }));
  if (!clean.length) throw new Error('writeXlsx: at least one sheet is required');

  const sheetFiles = clean.map((sheet, index) => {
    const rows = sheet.rows.map((row, r) => {
      const cells = row.map((value, c) => inlineCellXml(value, `${indexToColumn(c)}${r + 1}`)).join('');
      return `<row r="${r + 1}">${cells}</row>`;
    }).join('');
    return {
      name: `xl/worksheets/sheet${index + 1}.xml`,
      text: xmlDeclaration()
        + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + `<dimension ref="A1:${indexToColumn(Math.max(0, (clean[index].rows[0] || []).length - 1))}${Math.max(1, sheet.rows.length)}"/>`
        + `<sheetData>${rows}</sheetData></worksheet>`,
    };
  });

  const workbookSheets = clean.map((sheet, index) =>
    `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('');

  const files = [
    {
      name: '[Content_Types].xml',
      text: xmlDeclaration()
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + clean.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
        + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        + '</Types>',
    },
    {
      name: '_rels/.rels',
      text: xmlDeclaration()
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        + '</Relationships>',
    },
    {
      name: 'docProps/core.xml',
      text: xmlDeclaration()
        + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        + 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
        + 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        + `<dc:title>${escapeXml(meta.title || 'OmniBox sheet')}</dc:title>`
        + `<dc:creator>${escapeXml(meta.author || 'OmniBox')}</dc:creator>`
        + `<dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created>`
        + '</cp:coreProperties>',
    },
    {
      name: 'xl/workbook.xml',
      text: xmlDeclaration()
        + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + `<sheets>${workbookSheets}</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      text: xmlDeclaration()
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + clean.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
        + '</Relationships>',
    },
    ...sheetFiles,
  ];

  return writeZip(files, { compress: true });
}

/** Convenience: delimited text → .xlsx (the "CSV → Excel" path). */
export async function csvToXlsx(text, { sheetName = 'Sheet1', delimiter = null } = {}) {
  const { rows } = parseDelimited(text, { delimiter });
  return writeXlsx([{ name: sheetName, rows }]);
}
