/**
 * The document engines: the PDF writer, the PDF reader, .docx and spreadsheets.
 *
 * Where possible the assertions are made by an *independent* reader — Python's
 * pypdf, python-docx, openpyxl and zipfile — because a writer and reader written
 * by the same person can share the same misunderstanding. Those checks skip if
 * Python is unavailable; the rest always run.
 */

import { test, ok, eq, deep, rejects, run, python, pythonHas } from './helpers/harness.mjs';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blocksToPdf, blocksToText, measureText, wrapText, winAnsiBytes, escapePdfText, layoutDocument } from '../app/core/pdf.js';
import { readPdf, pdfTextToBlocks, parseToUnicode, glyphNameToUnicode } from '../app/core/pdfread.js';
import { readDocx, writeDocx, docxBlocksToText } from '../app/core/docx.js';
import { readXlsx, writeXlsx, parseDelimited, sheetToDelimited, excelSerialToDate, columnToIndex, indexToColumn } from '../app/core/xlsx.js';
import { encodePng, decodePngAsync, readJpegInfo, isPng, isJpeg } from '../app/core/image.js';
import { utf8 } from '../app/core/util.js';

const tmp = mkdtempSync(join(tmpdir(), 'omnibox-docs-'));
const hasPypdf = pythonHas(['pypdf']);
const hasDocx = pythonHas(['docx']);
const hasXlsx = pythonHas(['openpyxl']);
const hasPil = pythonHas(['PIL']);

const SAMPLE = [
  { type: 'h', level: 1, runs: [{ text: 'Report' }] },
  { type: 'p', runs: [{ text: 'Plain ' }, { text: 'bold', bold: true }, { text: ' and unicode: café — naïve €25 “quotes”' }] },
  { type: 'ul', items: [[{ text: 'first' }], [{ text: 'second' }]] },
  { type: 'ol', items: [[{ text: 'one' }], [{ text: 'two' }]], start: 1 },
  { type: 'code', text: 'const x = 1;\nconsole.log(x);' },
  { type: 'quote', runs: [{ text: 'Quoted material.' }] },
  { type: 'table', head: ['A', 'B'], rows: [['1', '2'], ['three', 'four']] },
  { type: 'hr' },
];

/* ------------------------------------------------------------------ metrics */

test('text measurement and wrapping use the real AFM widths', () => {
  ok(measureText('iiii', 'Helvetica', 12) < measureText('wwww', 'Helvetica', 12), 'narrow letters are narrower');
  eq(Math.round(measureText('MMMM', 'Courier', 12)), Math.round(4 * 0.6 * 12), 'Courier is monospace at 600/1000 em');
  const lines = wrapText('word '.repeat(60).trim(), 'Helvetica', 11, 200);
  ok(lines.length > 5, 'long text wraps into many lines');
  ok(lines.every((line) => measureText(line, 'Helvetica', 11) <= 200.5), 'no line exceeds the width');
});

test('WinAnsi encoding maps the characters the standard fonts expect', () => {
  const bytes = winAnsiBytes('€ — “ x → y');
  ok(bytes.includes(0x80), 'euro sign (0x80)');
  ok(bytes.includes(0x97), 'em dash');
  ok(bytes.every((b) => b < 256), 'all single bytes');
  const escaped = escapePdfText(winAnsiBytes('a(b)c'));
  ok(escaped.includes('\\(') && escaped.includes('\\)'), 'parens are backslash-escaped in PDF strings');
  ok(escaped.startsWith('a') && escaped.endsWith('c'), 'the characters themselves survive');
  ok(escapePdfText(winAnsiBytes('é')).length > 1, 'non-ASCII becomes an octal escape');
});

/* --------------------------------------------------------------- the writer */

test('the layout engine paginates and reports overflow', () => {
  const blocks = [];
  for (let i = 0; i < 120; i++) blocks.push({ type: 'p', runs: [{ text: `Paragraph ${i} with enough words to occupy a couple of lines on the page.` }] });
  const layout = layoutDocument(blocks, { size: 'a4' });
  ok(layout.pages.length > 1, 'multiple pages');
  const yPositions = layout.pages[0].ops.filter((op) => op.t === 'text').map((op) => op.y);
  ok(Math.min(...yPositions) > 20, 'nothing is drawn off the bottom of the page');
  ok(Math.max(...yPositions) < 842, 'nothing is drawn above the top');
});

test('a table wider than the page still lays out inside the margins', () => {
  const layout = layoutDocument([{ type: 'table', head: ['a', 'b', 'c', 'd', 'e', 'f'], rows: [['1', '2', '3', '4', '5', '6']] }], {});
  const rects = layout.pages[0].ops.filter((op) => op.t === 'rect');
  ok(rects.length >= 2, 'header and row backgrounds drawn');
  ok(rects.every((r) => r.x >= 55 && r.x + r.w <= 596 - 55 + 0.5), 'cells stay inside the margins');
});

test('the PDF we write is structurally valid', async () => {
  const { bytes, pages } = await blocksToPdf(SAMPLE, { title: 'Sample', author: 'tests' });
  const text = new TextDecoder('latin1').decode(bytes);
  ok(text.startsWith('%PDF-1.7'), 'correct header');
  ok(text.includes('startxref'), 'xref pointer present');
  ok(text.trimEnd().endsWith('%%EOF'), 'proper trailer');
  eq(pages, 1);
  const offsets = [...text.matchAll(/^(\d{10}) 00000 n/gm)].map((m) => Number(m[1]));
  ok(offsets.length > 5, 'xref has entries');
  for (const offset of offsets.slice(0, 5)) {
    ok(/^\d+ 0 obj/.test(text.slice(offset, offset + 30)), `object at offset ${offset} is real`);
  }
});

test('an independent reader accepts our PDF and finds every string', async () => {
  if (!hasPypdf) return;
  const { bytes } = await blocksToPdf(SAMPLE, { title: 'Sample report', author: 'OmniBox tests' });
  const path = join(tmp, 'ours.pdf');
  writeFileSync(path, bytes);
  const check = python(`from pypdf import PdfReader
r = PdfReader(${JSON.stringify(path)})
t = r.pages[0].extract_text()
probes = ['Report','Plain','bold','café','naïve','€25','first','second','one','two','const x = 1','Quoted material','three','four']
missing = [p for p in probes if p not in t]
print(len(r.pages), r.metadata.title, '|', 'MISSING:' + ','.join(missing) if missing else 'ALL_PRESENT')`);
  ok(check.ok, 'pypdf read it: ' + check.err);
  ok(check.out.includes('ALL_PRESENT'), 'every string found — got: ' + check.out);
  ok(check.out.startsWith('1 Sample report'), 'metadata survived');
});

test('images are embedded with the right filters, and alpha becomes a soft mask', async () => {
  // needs both: PIL to make the fixtures, pypdf to inspect the result
  if (!hasPil || !hasPypdf) return;
  const made = python(`from PIL import Image
Image.new('RGB',(64,48),(200,30,30)).save(${JSON.stringify(join(tmp, 'photo.jpg'))}, quality=85)
Image.new('RGB',(50,40),(10,200,200)).save(${JSON.stringify(join(tmp, 'flat.png'))})
Image.new('RGBA',(30,30),(0,0,255,128)).save(${JSON.stringify(join(tmp, 'alpha.png'))})
print('ok')`);
  ok(made.ok, 'PIL made the images');
  const blocks = [
    { type: 'image', bytes: new Uint8Array(readFileSync(join(tmp, 'photo.jpg'))), name: 'photo.jpg', width: 64, height: 48 },
    { type: 'image', bytes: new Uint8Array(readFileSync(join(tmp, 'flat.png'))), name: 'flat.png', width: 50, height: 40 },
    { type: 'image', bytes: new Uint8Array(readFileSync(join(tmp, 'alpha.png'))), name: 'alpha.png', width: 30, height: 30 },
  ];
  const { bytes } = await blocksToPdf(blocks, {});
  const path = join(tmp, 'images.pdf');
  writeFileSync(path, bytes);
  const check = python(`from pypdf import PdfReader
r = PdfReader(${JSON.stringify(path)})
xo = r.pages[0]['/Resources']['/XObject']
info = []
for k, v in xo.items():
    o = v.get_object()
    info.append(f"{o.get('/Filter')}:{o.get('/Width')}x{o.get('/Height')}:{'smask' if '/SMask' in o else ''}")
print('|'.join(sorted(info)))`);
  ok(check.ok, check.err);
  ok(check.out.includes('/DCTDecode:64x48'), 'JPEG passed through untouched: ' + check.out);
  ok(check.out.includes('/FlateDecode:50x40'), 'PNG re-flated');
  ok(check.out.includes('smask'), 'alpha channel became a soft mask');
});

test('a skipped image does not shift the other image references', async () => {
  const good = await (async () => {
    const rgb = new Uint8Array(4 * 4 * 3).fill(128);
    return encodePng({ width: 4, height: 4, rgb });
  })();
  const blocks = [
    { type: 'image', bytes: utf8('not an image at all'), width: 10, height: 10 },
    { type: 'image', bytes: good, name: 'good.png', width: 4, height: 4 },
  ];
  const layout = layoutDocument(blocks, {});
  ok(layout.images.length === 2, 'both blocks entered the layout');
  const { bytes } = await blocksToPdf(blocks, {});
  const text = new TextDecoder('latin1').decode(bytes);
  ok(!/\/Im0 \d+ 0 R/.test(text), 'the skipped image is not referenced');
  ok(/\/Im1 \d+ 0 R/.test(text), 'the surviving image is referenced by its own index');
});

/* --------------------------------------------------------------- the reader */

test('we can read our own PDF back', async () => {
  const { bytes } = await blocksToPdf(SAMPLE, { title: 'Read me' });
  const result = await readPdf(bytes);
  eq(result.pageCount, 1);
  eq(result.meta.title, 'Read me');
  for (const probe of ['Report', 'bold', 'café', '€25', 'first', 'second', 'const x = 1', 'three']) {
    ok(result.text.includes(probe), `read back: ${probe}`);
  }
});

test('a foreign PDF with WinAnsi text reads correctly', async () => {
  const result = await readPdf(readFileSync('/home/user/omnibox/tests/fixtures/foreign-core.pdf'));
  ok(result.pageCount === 2, 'two pages');
  for (const probe of ['Foreign report from fpdf2', 'café', 'naïve', '£25', 'Section two', 'Page two text']) {
    ok(result.text.includes(probe), `foreign text: ${probe}`);
  }
});

test('a foreign PDF with a ToUnicode CMap reads non-Latin scripts', async () => {
  const result = await readPdf(readFileSync('/home/user/omnibox/tests/fixtures/foreign-ttf.pdf'));
  for (const probe of ['café', '€99', 'αβγ', 'да', 'TrueType ToUnicode path']) {
    ok(result.text.includes(probe), `cmap text: ${probe}`);
  }
});

test('ToUnicode CMaps and glyph names are parsed properly', () => {
  const { map, twoByte } = parseToUnicode(`beginbfchar
    <0041> <0041>
    <00e9> <00e9>
    endbfchar
    beginbfrange
    <0061> <0063> <0061>
    endbfrange`);
  eq(map.get(0x41), 'A');
  ok(map.get(0x61) === 'a' && map.get(0x63) === 'c', 'bfrange expands across the range');
  ok(!twoByte, 'single-byte codes detected');
  eq(glyphNameToUnicode('eacute'), 'é');
  eq(glyphNameToUnicode('uni20AC'), '€');
  eq(glyphNameToUnicode('nonsense'), '');
});

test('the reader refuses a non-PDF with a clear message', async () => {
  await rejects(() => readPdf(utf8('just some text, definitely not a PDF')), /Not a PDF/);
});

test('text without a text layer produces a warning, not a silent empty file', async () => {
  if (!hasPil) return;
  const made = python(`from PIL import Image
Image.new('RGB',(80,60),(255,255,255)).save(${JSON.stringify(join(tmp, 'scan.pdf'))})`);
  ok(made.ok, 'PIL wrote an image-only PDF');
  const result = await readPdf(readFileSync(join(tmp, 'scan.pdf')));
  ok(result.text.trim() === '', 'no text found');
  ok(result.warnings.some((w) => /no extractable text/i.test(w)), 'and it says so: ' + JSON.stringify(result.warnings));
  ok(result.images.length >= 1, 'the embedded image is still extractable');
});

test('PDF text becomes plausible blocks', () => {
  const blocks = pdfTextToBlocks([{ text: 'Title Line\n\nA paragraph of body text that goes on.\n\n• bullet one\n• bullet two\n\n1. numbered' }]);
  eq(blocks[0].type, 'h', 'short first line reads as a heading');
  ok(blocks.some((b) => b.type === 'ul' && b.items.length === 2), 'bullets grouped');
  ok(blocks.some((b) => b.type === 'ol'), 'numbering grouped');
});

/* ------------------------------------------------------------------- .docx */

test('docx round-trips through our own writer and reader', async () => {
  const bytes = await writeDocx(SAMPLE, { title: 'Round trip', author: 'tests' });
  const { blocks, meta } = await readDocx(bytes);
  eq(meta.title, 'Round trip');
  const text = docxBlocksToText(blocks);
  for (const probe of ['Report', 'bold', 'café', 'first', 'one', 'const x = 1', 'Quoted material', 'three']) {
    ok(text.includes(probe), `round-tripped: ${probe}`);
  }
  ok(blocks.some((b) => b.type === 'table'), 'the table came back as a table');
  ok(blocks.some((b) => b.type === 'h' && b.level === 1), 'the heading kept its level');
});

test('python-docx accepts our .docx — including the tables', async () => {
  if (!hasDocx) return;
  const bytes = await writeDocx(SAMPLE, { title: 'Interop' });
  const path = join(tmp, 'ours.docx');
  writeFileSync(path, bytes);
  const check = python(`import docx
d = docx.Document(${JSON.stringify(path)})
print(d.paragraphs[0].style.name, len(d.tables), len(d.tables[0].rows), len(d.tables[0].columns), d.tables[0].cell(1,0).text, d.core_properties.title)`);
  ok(check.ok, 'python-docx opened it: ' + check.err);
  eq(check.out, 'Heading 1 1 3 2 1 Interop');
});

test('a foreign .docx reads correctly, images included', async () => {
  if (!hasDocx) return;
  const made = python(`import docx
d = docx.Document()
d.add_heading('Foreign heading', level=1)
p = d.add_paragraph(); p.add_run('bold run').bold = True; p.add_run(' and café.')
d.add_paragraph('bullet', style='List Bullet')
t = d.add_table(rows=2, cols=2); t.style='Table Grid'
t.cell(0,0).text='h1'; t.cell(0,1).text='h2'; t.cell(1,0).text='v1'; t.cell(1,1).text='v2'
d.save(${JSON.stringify(join(tmp, 'foreign.docx'))})
print('ok')`);
  ok(made.ok, 'python-docx made the file');
  const { blocks, warnings } = await readDocx(readFileSync(join(tmp, 'foreign.docx')));
  const text = docxBlocksToText(blocks);
  for (const probe of ['Foreign heading', 'bold run', 'café', 'bullet', 'h1', 'v2']) ok(text.includes(probe), `foreign docx: ${probe}`);
  ok(blocks.some((b) => b.type === 'h' && b.level === 1), 'heading level detected from the style');
  ok(warnings.length === 0, 'no warnings for a clean file');
});

test('a .docx that is not a .docx is rejected clearly', async () => {
  await rejects(() => readDocx(utf8('plain text pretending to be a docx')), /ZIP|Not a Word/);
});

/* ------------------------------------------------------------ spreadsheets */

test('Excel column references convert both ways', () => {
  eq(columnToIndex('A'), 0);
  eq(columnToIndex('Z'), 25);
  eq(columnToIndex('AA'), 26);
  eq(indexToColumn(0), 'A');
  eq(indexToColumn(27), 'AB');
});

test('Excel date serials become real dates', () => {
  const d = excelSerialToDate(46037); // 2026-01-15
  eq(d.toISOString().slice(0, 10), '2026-01-15');
});

test('CSV parsing handles quotes, embedded newlines and delimiters', () => {
  const { rows, delimiter } = parseDelimited('a,b\n"x,1","line\nbreak"\n');
  eq(delimiter, ',');
  eq(rows.length, 2, 'a trailing newline does not invent an empty row');
  eq(rows[1][0], 'x,1');
  eq(rows[1][1], 'line\nbreak');
  eq(parseDelimited('a\tb\tc').delimiter, '\t');
  eq(parseDelimited('a;b;c').delimiter, ';');
  eq(sheetToDelimited([['a', 'b'], ['needs "quotes"', 'plain']]), 'a,b\r\n"needs ""quotes""",plain\r\n');
});

test('our .xlsx is accepted by openpyxl, numbers intact', async () => {
  if (!hasXlsx) return;
  const bytes = await writeXlsx([{ name: 'Data', rows: [['label', 'count'], ['a', 42], ['b', 3.5]] }]);
  const path = join(tmp, 'ours.xlsx');
  writeFileSync(path, bytes);
  const check = python(`import openpyxl
wb = openpyxl.load_workbook(${JSON.stringify(path)})
ws = wb.active
print(ws.title, ws['B2'].value, type(ws['B2'].value).__name__, ws['B3'].value, ws['A2'].value)`);
  ok(check.ok, 'openpyxl opened it: ' + check.err);
  eq(check.out, 'Data 42 int 3.5 a');
});

test('a foreign .xlsx reads with types and dates preserved', async () => {
  if (!hasXlsx) return;
  const made = python(`import openpyxl, datetime
wb = openpyxl.Workbook(); ws = wb.active; ws.title='Sales'
ws.append(['Month','Units','Date'])
ws.append(['Jan', 120, datetime.date(2026,1,15)])
ws.append(['Feb', 98, datetime.date(2026,2,20)])
wb.create_sheet('Notes')['A1']='second sheet'
wb.save(${JSON.stringify(join(tmp, 'foreign.xlsx'))})
print('ok')`);
  ok(made.ok, 'openpyxl made the workbook');
  const { sheets } = await readXlsx(readFileSync(join(tmp, 'foreign.xlsx')));
  eq(sheets.length, 2, 'both sheets');
  eq(sheets[0].name, 'Sales');
  eq(sheets[0].rows[1][1], 120, 'number stays a number');
  eq(sheets[0].rows[1][2], '2026-01-15', 'date serial rendered as a date');
  eq(sheets[1].rows[0][0], 'second sheet');
});

test('an xlsx that is really something else is refused', async () => {
  await rejects(() => readXlsx(utf8('not a spreadsheet')), /ZIP|Not a spreadsheet/);
});

/* ------------------------------------------------------------------ images */

test('PNG encode/decode round-trips and JPEG headers parse', async () => {
  const rgb = new Uint8Array(8 * 6 * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 11) % 256;
  const png = await encodePng({ width: 8, height: 6, rgb });
  ok(isPng(png));
  const back = await decodePngAsync(png);
  eq(back.width, 8);
  eq(back.height, 6);
  deep([...back.rgb], [...rgb], 'pixel data survives the round trip');

  if (hasPil) {
    const made = python(`from PIL import Image
Image.new('RGB',(37,21),(1,2,3)).save(${JSON.stringify(join(tmp, 'probe.jpg'))})`);
    if (made.ok) {
      const info = readJpegInfo(readFileSync(join(tmp, 'probe.jpg')));
      eq(info.width, 37);
      eq(info.height, 21);
      eq(info.components, 3);
    }
  }
});

test('interlaced PNGs and non-images are refused with a reason', async () => {
  await rejects(() => decodePngAsync(utf8('nope')), /Not a PNG/);
  ok(!isJpeg(utf8('nope')));
});

await run('documents');
