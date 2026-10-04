/**
 * The conversion matrix.
 *
 * One registry drives the whole UI: every entry says what it accepts, what it
 * produces, how long it might take, and — importantly — what it will *not*
 * preserve. The notes are part of the contract: a converter that silently drops
 * your tables is worse than one that tells you it did.
 */

import { extOf, kindOf, withExtension, baseName, stemOf, safeFileName, str, formatBytes, te } from './util.js';
import { writeZip, readZip } from './zip.js';
import { readPdf, pdfToBlocks, pdfTextToBlocks } from './pdfread.js';
import { blocksToPdf, blocksToText } from './pdf.js';
import { readDocx, writeDocx, docxBlocksToText } from './docx.js';
import { readXlsx, writeXlsx, sheetsToBlocks, sheetToDelimited, parseDelimited, detectDelimiter } from './xlsx.js';
import { parseText, parseInline } from './markdown.js';
import { parseXml, findAll, childNodes, attr, textOf, decodeEntities } from './xml.js';
import { isPng, isJpeg, readJpegInfo, decodePngAsync } from './image.js';

/* --------------------------------------------------------------- markdown out */

function runsToMarkdown(runs) {
  return (runs || []).map((run) => {
    let text = String(run.text == null ? '' : run.text);
    if (run.code) text = `\`${text}\``;
    if (run.bold) text = `**${text}**`;
    if (run.italic) text = `*${text}*`;
    if (run.strike) text = `~~${text}~~`;
    if (run.link) text = `[${text}](${run.link})`;
    return text;
  }).join('');
}

export function blocksToMarkdown(blocks) {
  const out = [];
  for (const block of blocks || []) {
    const type = block.type || 'p';
    if (type === 'h') out.push(`${'#'.repeat(Math.min(6, Math.max(1, block.level || 1)))} ${runsToMarkdown(block.runs || block.text)}`, '');
    else if (type === 'p') out.push(runsToMarkdown(block.runs || block.text), '');
    else if (type === 'quote') out.push(runsToMarkdown(block.runs).split('\n').map((l) => `> ${l}`).join('\n'), '');
    else if (type === 'code') out.push('```' + (block.lang || ''), String(block.text || ''), '```', '');
    else if (type === 'ul') out.push(...(block.items || []).map((i) => `- ${runsToMarkdown(Array.isArray(i) ? i : [{ text: String(i) }])}`), '');
    else if (type === 'ol') out.push(...(block.items || []).map((i, n) => `${(block.start || 1) + n}. ${runsToMarkdown(Array.isArray(i) ? i : [{ text: String(i) }])}`), '');
    else if (type === 'hr') out.push('---', '');
    else if (type === 'image') out.push(`![${block.name || 'image'}](${block.name || 'image'})`, '');
    else if (type === 'table') {
      const cellText = (c) => runsToMarkdown(Array.isArray(c) ? c : [{ text: String(c == null ? '' : c) }]).replace(/\|/g, '\\|');
      if (block.head && block.head.length) {
        out.push(`| ${block.head.map(cellText).join(' | ')} |`);
        out.push(`| ${block.head.map(() => '---').join(' | ')} |`);
      }
      for (const row of block.rows || []) out.push(`| ${row.map(cellText).join(' | ')} |`);
      out.push('');
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/* ------------------------------------------------------------------ html in */

/** Minimal HTML → blocks. No CSS, no scripts — structure only, stated in the UI. */
export function htmlToBlocks(html) {
  const doc = parseXml(String(html || ''));
  const blocks = [];
  const INLINE = new Set(['a', 'b', 'strong', 'i', 'em', 'code', 'span', 'u', 's', 'strike', 'del', 'sub', 'sup', 'small', 'mark', 'br']);

  const runsOf = (node, inherited = {}) => {
    const runs = [];
    const walk = (current, style) => {
      if (current.text) runs.push({ text: decodeEntities(current.text), ...style });
      for (const kid of childNodes(current)) {
        const local = kid.local;
        if (local === 'br') { runs.push({ text: '\n' }); continue; }
        if (local === 'script' || local === 'style' || local === 'head') continue;
        const next = { ...style };
        if (local === 'b' || local === 'strong') next.bold = true;
        if (local === 'i' || local === 'em') next.italic = true;
        if (local === 'u') next.underline = true;
        if (local === 's' || local === 'strike' || local === 'del') next.strike = true;
        if (local === 'code') next.code = true;
        if (local === 'a') next.link = attr(kid, 'href', null) || undefined;
        if (INLINE.has(local) || local === 'a') walk(kid, next);
        else runs.push({ text: textOf(kid), ...style });
      }
    };
    walk(node, inherited);
    return runs.length ? runs : [{ text: '' }];
  };

  const visit = (node) => {
    for (const kid of childNodes(node)) {
      const local = kid.local;
      if (/^h([1-6])$/.test(local)) blocks.push({ type: 'h', level: Number(local[1]), runs: runsOf(kid) });
      else if (local === 'p') blocks.push({ type: 'p', runs: runsOf(kid) });
      else if (local === 'blockquote') blocks.push({ type: 'quote', runs: runsOf(kid) });
      else if (local === 'pre') blocks.push({ type: 'code', text: textOf(kid).replace(/^\n+|\s+$/g, '') });
      else if (local === 'ul' || local === 'ol') {
        const items = childNodes(kid, 'li').map((li) => runsOf(li));
        if (items.length) blocks.push({ type: local === 'ul' ? 'ul' : 'ol', items });
      } else if (local === 'table') {
        const rows = findAll(kid, 'tr').map((tr) => childNodes(tr).filter((c) => c.local === 'td' || c.local === 'th')
          .map((cell) => runsOf(cell)));
        if (rows.length) {
          const hasHeader = childNodes(findAll(kid, 'tr')[0] || { children: [] }, 'th').length > 0;
          blocks.push(hasHeader ? { type: 'table', head: rows[0], rows: rows.slice(1) } : { type: 'table', rows });
        }
      } else if (local === 'hr') blocks.push({ type: 'hr' });
      else if (local === 'body' || local === 'html' || local === 'head' || local === 'div' || local === 'section' || local === 'article' || local === 'main' || local === 'header' || local === 'footer' || local === 'nav' || local === 'li') visit(kid);
      else if (local === 'img') {
        blocks.push({ type: 'p', runs: [{ text: `[image: ${attr(kid, 'alt', '') || attr(kid, 'src', '')}]`, italic: true }] });
      } else if (local === 'title' && !blocks.some((b) => b.fromTitle)) {
        const titleText = textOf(kid).trim();
        if (titleText) blocks.push({ type: 'h', level: 1, runs: [{ text: titleText }], fromTitle: true });
      }
    }
  };

  visit(doc);
  // A page's <title> is its name, not automatically a heading. Keep it only when the
  // body does not bring an <h1> of its own — otherwise it is just noise on top.
  if (blocks.some((b) => b.type === 'h' && b.level === 1 && !b.fromTitle)) {
    const at = blocks.findIndex((b) => b.fromTitle);
    if (at >= 0) blocks.splice(at, 1);
  }
  if (!blocks.length) {
    const text = String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text) blocks.push({ type: 'p', runs: [{ text }] });
  }
  return blocks;
}

/* --------------------------------------------------------------- json / csv */

function rowsFromJson(value) {
  const data = typeof value === 'string' ? JSON.parse(value) : value;
  const list = Array.isArray(data) ? data : (Array.isArray(data?.rows) ? data.rows : [data]);
  if (!list.length) return { rows: [['']] };
  if (list.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
    const keys = [];
    for (const item of list) for (const key of Object.keys(item)) if (!keys.includes(key)) keys.push(key);
    const rows = [keys];
    for (const item of list) rows.push(keys.map((key) => {
      const value2 = item[key];
      if (value2 == null) return '';
      if (typeof value2 === 'object') return JSON.stringify(value2);
      return value2;
    }));
    return { rows, objects: true };
  }
  if (list.every((item) => Array.isArray(item))) return { rows: list };
  return { rows: list.map((v) => [v]) };
}

/** Any JSON shape → one or more sheets of rows. */
function jsonToSheets(value, fallbackName = 'Sheet1') {
  const isSheetMap = value && !Array.isArray(value) && typeof value === 'object'
    && !Array.isArray(value.rows)
    && Object.values(value).every((v) => v && typeof v === 'object');
  if (isSheetMap) {
    const sheets = Object.entries(value).map(([name, v]) => ({ name, rows: rowsFromJson(v).rows }));
    if (sheets.length) return sheets;
  }
  return [{ name: fallbackName, rows: rowsFromJson(value).rows }];
}

function csvToJsonObject(rows) {
  if (!rows.length) return [];
  const head = rows[0].map((h, i) => (String(h || '').trim() || `column${i + 1}`));
  const unique = new Set(head).size === head.length;
  if (!unique) return rows;
  return rows.slice(1).map((row) => {
    const obj = {};
    head.forEach((key, i) => {
      const raw = row[i];
      if (raw === '' || raw == null) obj[key] = null;
      else if (raw === 'true' || raw === 'false') obj[key] = raw === 'true';
      else if (/^-?\d+(\.\d+)?$/.test(String(raw))) obj[key] = Number(raw);
      else obj[key] = raw;
    });
    return obj;
  });
}

/* ----------------------------------------------------------------- helpers */

async function imageSizeOf(bytes) {
  if (isJpeg(bytes)) { const info = readJpegInfo(bytes); return { width: info.width, height: info.height }; }
  if (isPng(bytes)) { const info = await decodePngAsync(bytes); return { width: info.width, height: info.height }; }
  return null;
}

function zipNameFor(base) { return `${base}.zip`; }

/* ============================================================== the registry */

/**
 * Each entry:
 *   id, label, group, accepts: kinds/exts, multiple: bool, to: output extension,
 *   note: what changes, limits: honesty, run(ctx): → {files, warnings}
 * ctx = { name, bytes, files?, options, onProgress }
 */
export const CONVERSIONS = [
  /* ------------------------------------------------------------- PDF → ... */
  {
    id: 'pdf-text', label: 'Text (.txt)', group: 'PDF', accepts: ['pdf'], to: 'txt',
    note: 'The text layer, in reading order. Scanned PDFs have no text layer and will come out empty — the app says so rather than pretending.',
    async run({ name, bytes, onProgress }) {
      onProgress?.({ phase: 'Reading the PDF', fraction: 0.2 });
      const result = await readPdf(bytes, { extractImages: false });
      const text = result.pages.map((p) => p.text).join('\n\n');
      return {
        files: [{ name: withExtension(name, 'txt'), mime: 'text/plain', bytes: te.encode(text) }],
        warnings: result.warnings,
        stats: { pages: result.pageCount, characters: text.length },
      };
    },
  },
  {
    id: 'pdf-docx', label: 'Word (.docx)', group: 'PDF', accepts: ['pdf'], to: 'docx',
    note: 'Editable paragraphs and headings. PDFs have no notion of "heading", so structure is inferred from line shape — nothing is dropped, but complex layouts move.',
    async run({ name, bytes, onProgress }) {
      onProgress?.({ phase: 'Reading the PDF', fraction: 0.15 });
      const { blocks, result, warnings } = await pdfToBlocks(bytes);
      onProgress?.({ phase: 'Attaching images', fraction: 0.6 });
      for (const image of result.images.slice(0, 60)) {
        const size = await imageSizeOf(image.bytes);
        blocks.push({ type: 'image', bytes: image.bytes, name: image.name, width: size?.width || image.width, height: size?.height || image.height, caption: `Extracted from page ${image.page}` });
      }
      onProgress?.({ phase: 'Writing the document', fraction: 0.85 });
      const out = await writeDocx(blocks, { title: result.meta.title || stemOf(name), author: result.meta.author });
      return {
        files: [{ name: withExtension(name, 'docx'), mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: out }],
        warnings: [...warnings, ...(result.images.length ? [] : [])],
        stats: { pages: result.pageCount, images: result.images.length },
      };
    },
  },
  {
    id: 'pdf-md', label: 'Markdown (.md)', group: 'PDF', accepts: ['pdf'], to: 'md',
    note: 'Same structure recovery as the Word output, written as Markdown.',
    async run({ name, bytes, onProgress }) {
      onProgress?.({ phase: 'Reading the PDF', fraction: 0.3 });
      const { blocks, result, warnings } = await pdfToBlocks(bytes);
      const md = blocksToMarkdown(blocks);
      return { files: [{ name: withExtension(name, 'md'), mime: 'text/markdown', bytes: te.encode(md) }], warnings, stats: { pages: result.pageCount } };
    },
  },
  {
    id: 'pdf-images', label: 'Images (extract)', group: 'PDF', accepts: ['pdf'], to: 'zip',
    note: 'Extracts the pictures the PDF already contains as JPEG/PNG files. It does not render pages — a PDF page rendered to an image needs a rasteriser, which this app does not have.',
    async run({ name, bytes, onProgress }) {
      onProgress?.({ phase: 'Scanning for images', fraction: 0.3 });
      const result = await readPdf(bytes, { extractImages: true });
      if (!result.images.length) {
        const err = new Error('This PDF contains no extractable images (it may be text-only, or use an image format OmniBox cannot re-encode)');
        err.code = 'no-images';
        throw err;
      }
      const files = result.images.map((img) => ({ name: img.name, mime: img.mime, bytes: img.bytes }));
      if (files.length === 1) return { files, warnings: result.warnings, stats: { images: 1 } };
      const zip = await writeZip(files.map((f) => ({ name: f.name, bytes: f.bytes })));
      return {
        files: [{ name: zipNameFor(stemOf(name) + '-images'), mime: 'application/zip', bytes: zip }],
        warnings: result.warnings,
        stats: { images: files.length },
      };
    },
  },

  /* ------------------------------------------------------------ Word → ... */
  {
    id: 'docx-pdf', label: 'PDF (.pdf)', group: 'Word', accepts: ['docx', 'doc'], to: 'pdf',
    note: 'Re-rendered, not a clone: text, headings, bold/italic, lists, tables and images are laid out again with standard PDF fonts. Column layouts and precise spacing will differ from Word.',
    async run({ name, bytes, onProgress }) {
      onProgress?.({ phase: 'Reading the document', fraction: 0.2 });
      const { blocks, meta, warnings } = await readDocx(bytes);
      onProgress?.({ phase: 'Laying out pages', fraction: 0.6 });
      const { bytes: pdf, pages } = await blocksToPdf(blocks, { title: meta.title || stemOf(name), author: meta.author, size: 'a4' });
      return {
        files: [{ name: withExtension(name, 'pdf'), mime: 'application/pdf', bytes: pdf }],
        warnings, stats: { pages },
      };
    },
  },
  {
    id: 'docx-txt', label: 'Text (.txt)', group: 'Word', accepts: ['docx'], to: 'txt',
    note: 'All the text, in order, formatted as plain text. Formatting is dropped by definition.',
    async run({ name, bytes }) {
      const { blocks, warnings } = await readDocx(bytes);
      return { files: [{ name: withExtension(name, 'txt'), mime: 'text/plain', bytes: te.encode(docxBlocksToText(blocks)) }], warnings };
    },
  },
  {
    id: 'docx-md', label: 'Markdown (.md)', group: 'Word', accepts: ['docx'], to: 'md',
    note: 'Headings, bold/italic, lists, quotes and tables become Markdown. Images become placeholders, since a .md file cannot carry them.',
    async run({ name, bytes }) {
      const { blocks, warnings } = await readDocx(bytes);
      const md = blocksToMarkdown(blocks.filter((b) => b.type !== 'image').map((b) => b));
      return { files: [{ name: withExtension(name, 'md'), mime: 'text/markdown', bytes: te.encode(md) }], warnings };
    },
  },

  /* ------------------------------------------------------- text/md/html → ... */
  {
    id: 'md-pdf', label: 'PDF (.pdf)', group: 'Text & Markdown', accepts: ['md', 'markdown', 'txt'], to: 'pdf',
    note: 'Markdown becomes a typeset PDF: headings, lists, tables, quotes, code blocks with grey backgrounds, images, page numbers.',
    async run({ name, bytes, options = {}, onProgress }) {
      const text = str(bytes);
      const markdown = extOf(name) !== 'txt';
      onProgress?.({ phase: 'Parsing', fraction: 0.25 });
      let blocks = parseText(text, { markdown });
      if (options.pagePerHeading) blocks = withPageBreaks(blocks);
      onProgress?.({ phase: 'Typesetting', fraction: 0.6 });
      const { bytes: pdf, pages, warnings } = await blocksToPdf(blocks, {
        title: options.title || stemOf(name), author: options.author || null,
        size: options.pageSize || 'a4', fontSize: options.fontSize || 11,
      });
      return { files: [{ name: withExtension(name, 'pdf'), mime: 'application/pdf', bytes: pdf }], warnings, stats: { pages } };
    },
  },
  {
    id: 'md-docx', label: 'Word (.docx)', group: 'Text & Markdown', accepts: ['md', 'markdown', 'txt'], to: 'docx',
    note: 'Markdown becomes a real Word file with heading styles, real bullet/numbered lists and tables — editable in Word, Google Docs or LibreOffice.',
    async run({ name, bytes, onProgress }) {
      const text = str(bytes);
      const markdown = extOf(name) !== 'txt';
      onProgress?.({ phase: 'Parsing', fraction: 0.4 });
      const blocks = parseText(text, { markdown });
      const out = await writeDocx(blocks, { title: stemOf(name) });
      return { files: [{ name: withExtension(name, 'docx'), mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: out }] };
    },
  },
  {
    id: 'html-md', label: 'Markdown (.md)', group: 'Web page', accepts: ['html', 'htm'], to: 'md',
    note: 'Structure only: headings, paragraphs, lists, quotes, code, links and tables. CSS, scripts and layout are ignored — a page is not a document.',
    async run({ name, bytes, onProgress }) {
      onProgress?.({ phase: 'Reading the page', fraction: 0.4 });
      const blocks = htmlToBlocks(str(bytes));
      return { files: [{ name: withExtension(name, 'md'), mime: 'text/markdown', bytes: te.encode(blocksToMarkdown(blocks)) }] };
    },
  },
  {
    id: 'html-txt', label: 'Text (.txt)', group: 'Web page', accepts: ['html', 'htm'], to: 'txt',
    note: 'Visible text with whitespace tidied. Useful for grabbing the words out of a saved page.',
    async run({ name, bytes }) {
      const blocks = htmlToBlocks(str(bytes));
      return { files: [{ name: withExtension(name, 'txt'), mime: 'text/plain', bytes: te.encode(blocksToText(blocks)) }] };
    },
  },
  {
    id: 'html-docx', label: 'Word (.docx)', group: 'Web page', accepts: ['html', 'htm'], to: 'docx',
    note: 'Headings, paragraphs, lists, links and tables become an editable Word document. Layout is not reproduced.',
    async run({ name, bytes }) {
      const blocks = htmlToBlocks(str(bytes));
      const out = await writeDocx(blocks, { title: stemOf(name) });
      return { files: [{ name: withExtension(name, 'docx'), mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: out }] };
    },
  },

  /* ---------------------------------------------------------- spreadsheets */
  {
    id: 'sheet-csv', label: 'CSV (.csv)', group: 'Spreadsheet', accepts: ['xlsx', 'xls'], to: 'csv',
    note: 'One CSV per sheet, zipped when there is more than one. Formulas are converted to their last stored values.',
    async run({ name, bytes, onProgress }) {
      onProgress?.({ phase: 'Reading the workbook', fraction: 0.35 });
      const { sheets, warnings } = await readXlsx(bytes);
      const files = sheets.map((sheet) => ({
        name: sheets.length > 1 ? `${stemOf(name)}-${safeFileName(sheet.name)}.csv` : withExtension(name, 'csv'),
        mime: 'text/csv',
        bytes: te.encode(sheetToDelimited(sheet.rows)),
      }));
      if (files.length === 1) return { files, warnings, stats: { rows: sheets[0].rowCount } };
      const zip = await writeZip(files.map((f) => ({ name: f.name, bytes: f.bytes })));
      return { files: [{ name: zipNameFor(stemOf(name) + '-csv'), mime: 'application/zip', bytes: zip }], warnings, stats: { sheets: sheets.length } };
    },
  },
  {
    id: 'sheet-pdf', label: 'PDF (.pdf)', group: 'Spreadsheet', accepts: ['xlsx', 'csv', 'tsv'], to: 'pdf',
    note: 'Each sheet becomes a heading plus a table, capped at 500 rows per sheet so a 200k-row export does not produce a 4000-page PDF. The cap is stated when it applies.',
    async run({ name, bytes, options = {}, onProgress }) {
      onProgress?.({ phase: 'Reading the data', fraction: 0.3 });
      let sheets;
      let warnings = [];
      if (extOf(name) === 'csv' || extOf(name) === 'tsv') {
        const { rows } = parseDelimited(str(bytes), { delimiter: extOf(name) === 'tsv' ? '\t' : null });
        sheets = [{ name: stemOf(name), rows }];
      } else {
        const result = await readXlsx(bytes);
        sheets = result.sheets; warnings = result.warnings;
      }
      onProgress?.({ phase: 'Typesetting', fraction: 0.65 });
      const blocks = sheetsToBlocks(sheets, { maxRows: options.maxRows || 500 });
      const { bytes: pdf, pages } = await blocksToPdf(blocks, { title: stemOf(name), size: options.pageSize || 'a4' });
      return { files: [{ name: withExtension(name, 'pdf'), mime: 'application/pdf', bytes: pdf }], warnings, stats: { pages, sheets: sheets.length } };
    },
  },
  {
    id: 'sheet-json', label: 'JSON (.json)', group: 'Spreadsheet', accepts: ['xlsx', 'csv', 'tsv'], to: 'json',
    note: 'The first row becomes the keys. Falls back to arrays-of-arrays if the header has duplicates.',
    async run({ name, bytes }) {
      let rows;
      if (extOf(name) === 'csv' || extOf(name) === 'tsv') {
        rows = parseDelimited(str(bytes), { delimiter: extOf(name) === 'tsv' ? '\t' : null }).rows;
      } else {
        const { sheets, warnings } = await readXlsx(bytes);
        const payload = sheets.length === 1
          ? csvToJsonObject(sheets[0].rows)
          : Object.fromEntries(sheets.map((s) => [s.name, csvToJsonObject(s.rows)]));
        return { files: [{ name: withExtension(name, 'json'), mime: 'application/json', bytes: te.encode(JSON.stringify(payload, null, 2)) }], warnings };
      }
      return { files: [{ name: withExtension(name, 'json'), mime: 'application/json', bytes: te.encode(JSON.stringify(csvToJsonObject(rows), null, 2)) }] };
    },
  },
  {
    id: 'json-csv', label: 'CSV (.csv)', group: 'JSON', accepts: ['json'], to: 'csv',
    note: 'An array of objects becomes a table — keys are the header, missing keys become blank cells, and nested objects stay as JSON text in the cell. An object of arrays becomes one CSV per key, zipped.',
    async run({ name, bytes, onProgress }) {
      onProgress?.({ phase: 'Reading the JSON', fraction: 0.35 });
      const sheets = jsonToSheets(JSON.parse(str(bytes)), stemOf(name));
      onProgress?.({ phase: 'Writing rows', fraction: 0.7 });
      if (sheets.length === 1) {
        return {
          files: [{ name: withExtension(name, 'csv'), mime: 'text/csv', bytes: te.encode(sheetToDelimited(sheets[0].rows)) }],
          stats: { rows: Math.max(0, sheets[0].rows.length - 1), columns: (sheets[0].rows[0] || []).length },
        };
      }
      const files = sheets.map((sheet) => ({
        name: `${stemOf(name)}-${safeFileName(sheet.name) || 'sheet'}.csv`,
        bytes: te.encode(sheetToDelimited(sheet.rows)),
      }));
      const zip = await writeZip(files.map((f) => ({ name: f.name, bytes: f.bytes })));
      return {
        files: [{ name: `${stemOf(name)}-csv.zip`, mime: 'application/zip', bytes: zip }],
        stats: { sheets: sheets.length },
      };
    },
  },
  {
    id: 'json-xlsx', label: 'Excel (.xlsx)', group: 'JSON', accepts: ['json'], to: 'xlsx',
    note: 'One worksheet per top-level key (a plain array gets a single worksheet). Numbers and booleans stay typed; nested objects land in the cell as JSON text.',
    async run({ name, bytes }) {
      const sheets = jsonToSheets(JSON.parse(str(bytes)), stemOf(name));
      const out = await writeXlsx(sheets, { title: stemOf(name) });
      return {
        files: [{ name: withExtension(name, 'xlsx'), mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: out }],
        stats: { sheets: sheets.length, rows: sheets.reduce((n, s2) => n + s2.rows.length, 0) },
      };
    },
  },
  {
    id: 'csv-xlsx', label: 'Excel (.xlsx)', group: 'Spreadsheet', accepts: ['csv', 'tsv'], to: 'xlsx',
    note: 'A real .xlsx with inline strings — opens in Excel, Numbers, Google Sheets and LibreOffice. Numbers stay numbers.',
    async run({ name, bytes, onProgress }) {
      onProgress?.({ phase: 'Parsing rows', fraction: 0.4 });
      const { rows } = parseDelimited(str(bytes), { delimiter: extOf(name) === 'tsv' ? '\t' : null });
      const numeric = rows.map((row) => row.map((cell) => {
        const text = String(cell);
        if (text.trim() === '') return '';
        if (/^-?\d+(\.\d+)?$/.test(text.trim()) && text.trim().length < 15) return Number(text);
        return text;
      }));
      const out = await writeXlsx([{ name: safeFileName(stemOf(name)) || 'Sheet1', rows: numeric }]);
      return { files: [{ name: withExtension(name, 'xlsx'), mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: out }], stats: { rows: rows.length } };
    },
  },

  /* ------------------------------------------------------------- images */
  {
    id: 'image-pdf', label: 'PDF (.pdf)', group: 'Image', accepts: ['png', 'jpg', 'jpeg'], to: 'pdf',
    note: 'One image per page, scaled to fit A4 with its aspect ratio intact. JPEG data is embedded as-is, so nothing is re-compressed.',
    async run({ name, bytes, files, options = {}, onProgress }) {
      const inputs = files && files.length ? files : [{ name, bytes }];
      const blocks = [];
      for (let i = 0; i < inputs.length; i++) {
        const file = inputs[i];
        onProgress?.({ phase: `Placing ${file.name}`, fraction: (i + 1) / (inputs.length + 1) });
        const size = await imageSizeOf(file.bytes);
        if (!size) {
          const err = new Error(`${file.name} is not a JPEG or PNG OmniBox can read (WebP, GIF and HEIC are not supported)`);
          err.code = 'unsupported-image';
          throw err;
        }
        if (i > 0) blocks.push({ type: 'pagebreak' });
        blocks.push({ type: 'image', bytes: file.bytes, name: file.name, width: size.width, height: size.height, caption: options.captions ? file.name : null });
      }
      const { bytes: pdf, pages } = await blocksToPdf(blocks, { title: stemOf(inputs[0].name), margin: options.margin ?? 40 });
      const outName = inputs.length > 1 ? `${stemOf(inputs[0].name)}-and-${inputs.length - 1}-more.pdf` : withExtension(inputs[0].name, 'pdf');
      return { files: [{ name: outName, mime: 'application/pdf', bytes: pdf }], stats: { pages, images: inputs.length } };
    },
  },

  /* --------------------------------------------------------------- archive */
  {
    id: 'zip-extract', label: 'Extract files', group: 'Archive', accepts: ['zip'], to: 'zip',
    note: 'Unpacks the archive. Nested folders are flattened to "folder-name.file" so nothing is lost in a download.',
    async run({ name, bytes, onProgress }) {
      onProgress?.({ phase: 'Reading the archive', fraction: 0.3 });
      const { entries } = await readZip(bytes);
      const files = [];
      const warnings = [];
      for (const entry of entries.values()) {
        if (entry.dir) continue;
        if (!entry.bytes) continue;
        files.push({ name: safeFileName(entry.name.replace(/\//g, '-')), mime: 'application/octet-stream', bytes: entry.bytes });
      }
      if (files.length > 2000) warnings.push(`That is a lot of files (${files.length}) — most browsers will struggle to save them all`);
      return { files, warnings, stats: { files: files.length } };
    },
  },
];

/** Registry lookup by id. */
export function conversionById(id) {
  return CONVERSIONS.find((c) => c.id === id) || null;
}

/** Which conversions make sense for this file? */
export function conversionsFor(fileName, { multiple = false } = {}) {
  const ext = extOf(fileName);
  const kind = kindOf(fileName);
  const list = CONVERSIONS.filter((c) => c.accepts.includes(ext));
  if (multiple) {
    // a group of files can only become an archive or a combined PDF
    return [
      ...list.filter((c) => c.id === 'image-pdf'),
      {
        id: 'files-zip', label: `ZIP archive (${multiple} files)`, group: 'Archive', accepts: [ext], to: 'zip', virtual: true,
        note: 'Everything you dropped, packed into one archive.',
      },
    ];
  }
  if (kind === 'image' && !list.length) {
    return [{ id: 'unsupported-image', label: 'Not supported', virtual: true, blocked: true, note: 'WebP, GIF, HEIC and SVG cannot be embedded in a PDF by this app — re-save as JPEG or PNG first.' }];
  }
  return list;
}

function withPageBreaks(blocks) {
  const out = [];
  for (const block of blocks) {
    if (block.type === 'h' && block.level === 1 && out.length) out.push({ type: 'pagebreak' });
    out.push(block);
  }
  return out;
}

/**
 * Run one conversion.
 * @returns {Promise<{files: Array<{name,bytes,mime}>, warnings: string[], notes: string[], stats: object, ms: number}>}
 */
export async function convert(input, conversionId, { onProgress = null, options = {} } = {}) {
  const started = Date.now();
  const files = input.files && input.files.length ? input.files : [{ name: input.name, bytes: input.bytes }];

  if (conversionId === 'files-zip') {
    const zip = await writeZip(files.map((f) => ({ name: safeFileName(f.name), bytes: f.bytes })));
    return {
      files: [{ name: zipNameFor(stemOf(files[0].name) + (files.length > 1 ? `-and-${files.length - 1}-more` : '')), mime: 'application/zip', bytes: zip }],
      warnings: [], notes: [], stats: { files: files.length }, ms: Date.now() - started,
    };
  }

  const conversion = conversionById(conversionId);
  if (!conversion) throw new Error(`Unknown conversion: ${conversionId}`);

  const ext = extOf(files[0].name);
  if (!conversion.accepts.includes(ext)) {
    throw new Error(`${conversion.label} does not accept .${ext} files — it works from: ${conversion.accepts.map((a) => '.' + a).join(', ')}`);
  }

  onProgress?.({ phase: 'Starting', fraction: 0.05 });
  const result = await conversion.run({
    name: files[0].name,
    bytes: files[0].bytes,
    files,
    options,
    onProgress: (p) => onProgress?.({ phase: p.phase || 'Working', fraction: Math.min(0.98, p.fraction ?? 0.5) }),
  });

  onProgress?.({ phase: 'Finishing', fraction: 1 });
  return {
    files: result.files || [],
    warnings: result.warnings || [],
    notes: conversion.note ? [conversion.note] : [],
    stats: result.stats || {},
    ms: Date.now() - started,
  };
}

export { detectDelimiter, parseDelimited, sheetToDelimited };
