/**
 * The conversion matrix end-to-end.
 *
 * Inputs are files this project did NOT write where possible (python-docx,
 * openpyxl, PIL, fpdf2), and outputs are checked by independent readers. That is
 * the only way to catch the class of bug where a writer and reader agree with
 * each other and with nobody else.
 */

import { test, ok, eq, deep, rejects, run, python, pythonHas } from './helpers/harness.mjs';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convert, conversionsFor, conversionById, blocksToMarkdown, htmlToBlocks } from '../app/core/convert.js';
import { readZip } from '../app/core/zip.js';
import { str } from '../app/core/util.js';

const tmp = mkdtempSync(join(tmpdir(), 'omnibox-conv-'));
const hasDocx = pythonHas(['docx']);
const hasXlsx = pythonHas(['openpyxl']);
const hasPypdf = pythonHas(['pypdf']);
const hasPil = pythonHas(['PIL']);

const bytesOf = (path) => new Uint8Array(readFileSync(path));
const run1 = (file, id, options = {}) => convert({ name: file, bytes: bytesOf(file) }, id, { options });

let foreignDocx = null;
let foreignXlsx = null;

function makeFixtures() {
  if (hasDocx && !foreignDocx) {
    const path = join(tmp, 'report.docx');
    const made = python(`import docx
d = docx.Document()
d.add_heading('Quarterly report', level=1)
p = d.add_paragraph(); p.add_run('Made by python-docx. Contains '); p.add_run('bold text').bold = True; p.add_run(' and café, naïve, £25.')
d.add_heading('Findings', level=2)
d.add_paragraph('Bullet one', style='List Bullet')
d.add_paragraph('Number one', style='List Number')
t = d.add_table(rows=2, cols=2); t.style='Table Grid'
t.cell(0,0).text='Region'; t.cell(0,1).text='Revenue'; t.cell(1,0).text='North'; t.cell(1,1).text='+4%'
d.save(${JSON.stringify(path)})
print('ok')`);
    if (made.ok) foreignDocx = path;
  }
  if (hasXlsx && !foreignXlsx) {
    const path = join(tmp, 'sales.xlsx');
    const made = python(`import openpyxl
wb = openpyxl.Workbook(); ws = wb.active; ws.title='Sales'
ws.append(['Month','Units']); ws.append(['Jan',120]); ws.append(['Feb',98])
wb.create_sheet('Notes')['A1']='second sheet'
wb.save(${JSON.stringify(path)})
print('ok')`);
    if (made.ok) foreignXlsx = path;
  }
}

/* ------------------------------------------------------------------ registry */

test('the registry offers sensible targets per file type', () => {
  const pdf = conversionsFor('report.pdf').map((c) => c.id);
  ok(pdf.includes('pdf-docx') && pdf.includes('pdf-text') && pdf.includes('pdf-images'), 'pdf targets');
  const docx = conversionsFor('cv.docx').map((c) => c.id);
  ok(docx.includes('docx-pdf') && docx.includes('docx-md'), 'docx targets');
  const csv = conversionsFor('data.csv').map((c) => c.id);
  ok(csv.includes('csv-xlsx') && csv.includes('sheet-pdf') && csv.includes('sheet-json'), 'csv targets');
  const md = conversionsFor('notes.md').map((c) => c.id);
  ok(md.includes('md-pdf') && md.includes('md-docx'), 'markdown targets');
  ok(conversionsFor('photo.png').some((c) => c.id === 'image-pdf'), 'image → pdf');
  ok(conversionsFor('archive.zip').some((c) => c.id === 'zip-extract'), 'zip extract');
});

test('unsupported formats are refused with the reason, not a dead end', () => {
  const list = conversionsFor('picture.heic');
  eq(list.length, 1);
  ok(list[0].blocked, 'marked as blocked');
  ok(/JPEG or PNG/.test(list[0].note), 'and says what to do instead');
});

test('every conversion in the registry can explain itself', () => {
  for (const conversion of conversionsFor('report.pdf').concat(conversionsFor('cv.docx'), conversionsFor('data.csv'))) {
    const spec = conversionById(conversion.id) || conversion;
    if (spec.blocked || spec.virtual) continue;
    ok(typeof spec.note === 'string' && spec.note.length > 30, `${spec.id} documents its trade-offs`);
    ok(typeof spec.run === 'function', `${spec.id} is runnable`);
  }
});

test('converting to an unsupported target is refused', async () => {
  await rejects(() => convert({ name: 'a.csv', bytes: new Uint8Array([1]) }, 'docx-pdf'), /does not accept/);
  await rejects(() => convert({ name: 'a.pdf', bytes: new Uint8Array([1]) }, 'nonsense'), /Unknown conversion/);
});

/* ------------------------------------------------------------ docx → things */

test('a foreign .docx becomes a PDF an independent reader can parse', async () => {
  makeFixtures();
  if (!foreignDocx || !hasPypdf) return;
  const result = await run1(foreignDocx, 'docx-pdf');
  const path = join(tmp, 'from-docx.pdf');
  writeFileSync(path, result.files[0].bytes);
  const check = python(`from pypdf import PdfReader
r = PdfReader(${JSON.stringify(path)})
t = '\\n'.join(p.extract_text() for p in r.pages)
probes = ['Quarterly report','bold text','café','naïve','£25','Findings','Bullet one','Number one','Region','+4%']
missing = [p for p in probes if p not in t]
print(len(r.pages), 'MISSING:'+','.join(missing) if missing else 'ALL_PRESENT')`);
  ok(check.ok, check.err);
  ok(check.out.endsWith('ALL_PRESENT'), 'all text survived: ' + check.out);
  ok(result.stats.pages >= 1, 'page count reported');
});

test('a foreign .docx becomes Markdown with its structure intact', async () => {
  makeFixtures();
  if (!foreignDocx) return;
  const result = await run1(foreignDocx, 'docx-md');
  const md = str(result.files[0].bytes);
  ok(md.startsWith('# Quarterly report'), 'heading became a markdown heading');
  ok(md.includes('## Findings'), 'second-level heading');
  ok(md.includes('- Bullet one'), 'bullet list');
  ok(md.includes('**bold text**'), 'bold kept');
  ok(md.includes('| Region |'), 'table became a markdown table');
});

test('a foreign .docx becomes plain text', async () => {
  makeFixtures();
  if (!foreignDocx) return;
  const result = await run1(foreignDocx, 'docx-txt');
  const text = str(result.files[0].bytes);
  ok(text.includes('Quarterly report') && text.includes('+4%'), 'content present');
  ok(!text.includes('**'), 'plain text has no markdown marks');
});

/* ------------------------------------------------------------- markdown in */

test('Markdown becomes a PDF and a Word file', async () => {
  const md = '# Title\n\nText with **bold** and `code`.\n\n- one\n- two\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n';
  const pdf = await convert({ name: 'notes.md', bytes: new TextEncoder().encode(md) }, 'md-pdf');
  ok(pdf.files[0].name.endsWith('.pdf'));
  ok(pdf.files[0].bytes.length > 1000, 'a real file, not a stub');
  ok(str(pdf.files[0].bytes).startsWith('%PDF'), 'PDF header');

  const docx = await convert({ name: 'notes.md', bytes: new TextEncoder().encode(md) }, 'md-docx');
  ok(docx.files[0].name.endsWith('.docx'));
  if (hasDocx) {
    const path = join(tmp, 'from-md.docx');
    writeFileSync(path, docx.files[0].bytes);
    const check = python(`import docx
d = docx.Document(${JSON.stringify(path)})
print(d.paragraphs[0].style.name, len(d.tables), d.tables[0].cell(0,0).text)`);
    ok(check.ok, check.err);
    eq(check.out, 'Heading 1 1 A');
  }
});

test('Markdown tables with awkward content still convert', async () => {
  const md = '| A | B |\n| --- | --- |\n| has \\| pipe | `code` |\n| long '.concat('x'.repeat(200), ' | y |\n');
  const result = await convert({ name: 'tricky.md', bytes: new TextEncoder().encode(md) }, 'md-pdf');
  ok(result.files[0].bytes.length > 500, 'produced a PDF');
});

test('HTML becomes Markdown and Word without scripts or styles leaking in', async () => {
  const html = `<html><head><title>Page title</title><style>body{color:red}</style></head><body>
    <h1>Real heading</h1><p>Some <b>bold</b> and <a href="https://x.dev">a link</a>.</p>
    <ul><li>alpha</li><li>beta</li></ul><script>alert('nope')</script></body></html>`;
  const result = await convert({ name: 'page.html', bytes: new TextEncoder().encode(html) }, 'html-md');
  const md = str(result.files[0].bytes);
  ok(md.includes('# Real heading'), 'h1 kept');
  ok(!md.includes('Page title'), 'the <title> is not duplicated on top of a body <h1>');
  const noHeading = await convert(
    { name: 'plain.html', bytes: new TextEncoder().encode('<html><head><title>Only title</title></head><body><p>Body.</p></body></html>') },
    'html-md',
  );
  ok(str(noHeading.files[0].bytes).startsWith('# Only title'), 'without a body h1, the title becomes the heading');
  ok(md.includes('**bold**'), 'inline formatting kept');
  ok(md.includes('- alpha'), 'list kept');
  ok(!md.includes('alert(') && !md.includes('color:red'), 'scripts and styles dropped');
  const blocks = htmlToBlocks(html);
  ok(blocks.some((b) => b.type === 'ul'), 'blocks model has the list');
});

/* ------------------------------------------------------------ spreadsheets */

test('a foreign .xlsx becomes CSV per sheet, zipped', async () => {
  makeFixtures();
  if (!foreignXlsx) return;
  const result = await run1(foreignXlsx, 'sheet-csv');
  const { entries } = await readZip(result.files[0].bytes);
  eq(entries.size, 2, 'two sheets');
  ok(str(entries.get('sales-Sales.csv').bytes).startsWith('Month,Units'), 'header row');
  ok(str(entries.get('sales-Sales.csv').bytes).includes('Jan,120'), 'data row');
});

test('a foreign .xlsx becomes a PDF with a table per sheet', async () => {
  makeFixtures();
  if (!foreignXlsx || !hasPypdf) return;
  const result = await run1(foreignXlsx, 'sheet-pdf');
  const path = join(tmp, 'from-xlsx.pdf');
  writeFileSync(path, result.files[0].bytes);
  const check = python(`from pypdf import PdfReader
r = PdfReader(${JSON.stringify(path)})
t = '\\n'.join(p.extract_text() for p in r.pages)
print(len(r.pages), all(x in t for x in ['Sales','Month','Units','Jan','120','Notes']))`);
  ok(check.ok, check.err);
  ok(check.out.endsWith('True'), 'sheet names and cells are in the PDF: ' + check.out);
});

test('CSV becomes Excel, JSON and PDF', async () => {
  const csv = 'name,score,active\nAda,98,true\nGrace,91,false\n';
  const input = { name: 'scores.csv', bytes: new TextEncoder().encode(csv) };
  const xlsx = await convert(input, 'csv-xlsx');
  ok(xlsx.files[0].name.endsWith('.xlsx'));
  if (hasXlsx) {
    const path = join(tmp, 'from-csv.xlsx');
    writeFileSync(path, xlsx.files[0].bytes);
    const check = python(`import openpyxl
ws = openpyxl.load_workbook(${JSON.stringify(path)}).active
print(ws['A2'].value, ws['B2'].value, type(ws['B2'].value).__name__, ws['C2'].value)`);
    ok(check.ok, check.err);
    eq(check.out, 'Ada 98 int true', 'numbers became numbers, text stayed text');
  }
  const json = await convert(input, 'sheet-json');
  const parsed = JSON.parse(str(json.files[0].bytes));
  eq(parsed.length, 2);
  eq(parsed[0].score, 98, 'numeric inference');
  eq(parsed[1].active, false, 'boolean inference');
  const pdf = await convert(input, 'sheet-pdf');
  ok(str(pdf.files[0].bytes).startsWith('%PDF'));
});

test('JSON becomes CSV: keys are the header, missing keys go blank', async () => {
  const payload = JSON.stringify([{ a: 1, b: 'x' }, { a: 2, b: 'y', c: true }]);
  const result = await convert({ name: 'data.json', bytes: new TextEncoder().encode(payload) }, 'json-csv');
  const text = str(result.files[0].bytes);
  ok(text.startsWith('a,b,c'), 'union of keys as the header: ' + JSON.stringify(text));
  ok(text.includes('1,x,'), 'first row');
  eq(result.stats.rows, 2, 'row count reported');
});

test('an object of arrays becomes one CSV per key, zipped', async () => {
  const payload = JSON.stringify({ sales: [{ m: 'Jan', n: 1 }], notes: [{ k: 'v' }] });
  const result = await convert({ name: 'book.json', bytes: new TextEncoder().encode(payload) }, 'json-csv');
  ok(result.files[0].name.endsWith('.zip'), 'zipped when there is more than one table');
  const { entries } = await readZip(result.files[0].bytes);
  deep([...entries.keys()].sort(), ['book-notes.csv', 'book-sales.csv']);
});

test('JSON becomes a real .xlsx with typed numbers', async () => {
  const payload = JSON.stringify({ sales: [{ m: 'Jan', n: 1 }, { m: 'Feb', n: 2 }] });
  const result = await convert({ name: 'book.json', bytes: new TextEncoder().encode(payload) }, 'json-xlsx');
  ok(result.files[0].name.endsWith('.xlsx'));
  if (!hasXlsx) return;
  const path = join(tmp, 'from-json.xlsx');
  writeFileSync(path, result.files[0].bytes);
  const check = python(`import openpyxl
ws = openpyxl.load_workbook(${JSON.stringify(path)}).active
print(ws.title, ws['A2'].value, ws['B2'].value, type(ws['B2'].value).__name__)`);
  ok(check.ok, check.err);
  eq(check.out, 'sales Jan 1 int');
});

test('malformed JSON fails with a readable message', async () => {
  await rejects(
    () => convert({ name: 'broken.json', bytes: new TextEncoder().encode('{not json,') }, 'json-csv'),
    /JSON/i,
  );
});

/* ---------------------------------------------------------------- PDF paths */

test('PDF → text, Word, Markdown and images from one input', async () => {
  makeFixtures();
  if (!foreignDocx) return;
  // build a PDF with text and an image, then take it apart four ways
  const pdf = await run1(foreignDocx, 'docx-pdf');
  const input = { name: 'source.pdf', bytes: pdf.files[0].bytes };

  const text = await convert(input, 'pdf-text');
  ok(str(text.files[0].bytes).includes('Quarterly report'), 'text extracted');

  const docx = await convert(input, 'pdf-docx');
  ok(docx.files[0].name.endsWith('.docx'));
  if (hasDocx) {
    const path = join(tmp, 'roundtrip.docx');
    writeFileSync(path, docx.files[0].bytes);
    const check = python(`import docx
d = docx.Document(${JSON.stringify(path)})
print('Quarterly report' in '\\n'.join(p.text for p in d.paragraphs))`);
    ok(check.ok, check.err);
    eq(check.out, 'True', 'the round trip kept the words');
  }

  const md = await convert(input, 'pdf-md');
  ok(str(md.files[0].bytes).includes('Quarterly report'), 'markdown keeps the text');
});

test('PDF → images extracts what is embedded', async () => {
  if (!hasPil) return;
  const made = python(`from PIL import Image
Image.new('RGB',(120,90),(20,120,200)).save(${JSON.stringify(join(tmp, 'image-only.pdf'))})`);
  if (!made.ok) return;
  const result = await convert({ name: 'image-only.pdf', bytes: bytesOf(join(tmp, 'image-only.pdf')) }, 'pdf-images');
  ok(result.files.length >= 1, 'at least one image came out');
  ok(/\.(jpg|png)$/.test(result.files[0].name), `named for its real format: ${result.files[0].name}`);
  ok(result.stats.images >= 1, 'counted in the stats');
});

test('asking for images from a text-only PDF fails with an explanation', async () => {
  const pdf = await convert({ name: 'x.md', bytes: new TextEncoder().encode('# Heading\n\nBody text.\n') }, 'md-pdf');
  await rejects(
    () => convert({ name: 'x.pdf', bytes: pdf.files[0].bytes }, 'pdf-images'),
    /no extractable images/i,
  );
});

/* ------------------------------------------------------------------ images */

test('JPEG and PNG combine into one PDF, one image per page', async () => {
  if (!hasPil || !hasPypdf) return;
  const made = python(`from PIL import Image
Image.new('RGB',(300,200),(255,60,0)).save(${JSON.stringify(join(tmp, 'a.jpg'))}, quality=80)
Image.new('RGB',(200,300),(0,180,255)).save(${JSON.stringify(join(tmp, 'b.png'))})
print('ok')`);
  ok(made.ok, 'fixtures made');
  const files = [
    { name: 'a.jpg', bytes: bytesOf(join(tmp, 'a.jpg')) },
    { name: 'b.png', bytes: bytesOf(join(tmp, 'b.png')) },
  ];
  const result = await convert({ name: 'a.jpg', files }, 'image-pdf', { options: { captions: true } });
  const path = join(tmp, 'combined.pdf');
  writeFileSync(path, result.files[0].bytes);
  eq(result.stats.images, 2);
  const check = python(`from pypdf import PdfReader
r = PdfReader(${JSON.stringify(path)})
filters = []
for page in r.pages:
    for k, v in page['/Resources']['/XObject'].items():
        filters.append(str(v.get_object().get('/Filter')))
print(len(r.pages), '|'.join(sorted(filters)))`);
  ok(check.ok, check.err);
  ok(check.out.startsWith('2 '), 'two pages: ' + check.out);
  ok(check.out.includes('/DCTDecode') && check.out.includes('/FlateDecode'), 'each image kept its own encoding');
});

test('an image format we cannot embed is refused, and the message says what works', async () => {
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  await rejects(() => convert({ name: 'anim.webp', bytes: webp }, 'image-pdf'), /does not accept \.webp.*\.png, \.jpg, \.jpeg/);
  const offered = conversionsFor('anim.webp');
  ok(offered.some((c) => c.blocked && /re-save as JPEG or PNG/.test(c.note)), 'a blocked entry with advice is offered instead');
});

/* ----------------------------------------------------------------- archive */

test('a ZIP can be unpacked and repacked', async () => {
  const zipBytes = await (async () => {
    const { writeZip } = await import('../app/core/zip.js');
    return writeZip([{ name: 'folder/one.txt', text: 'first' }, { name: 'two.txt', text: 'second' }]);
  })();
  const extracted = await convert({ name: 'bundle.zip', bytes: zipBytes }, 'zip-extract');
  eq(extracted.files.length, 2);
  const names = extracted.files.map((f) => f.name).sort();
  ok(names.includes('folder-one.txt'), 'nested paths flattened readably: ' + names.join(','));

  const repacked = await convert({ name: 'bundle.zip', files: extracted.files }, 'files-zip');
  ok(repacked.files[0].name.endsWith('.zip'));
  const { entries } = await readZip(repacked.files[0].bytes);
  eq(entries.size, 2);
});

/* -------------------------------------------------------------- progress */

test('progress is reported and never goes backwards', async () => {
  const seen = [];
  await convert({ name: 'notes.md', bytes: new TextEncoder().encode('# a\n\n'.concat('text '.repeat(500))) }, 'md-pdf', {
    onProgress: (p) => seen.push(p.fraction),
  });
  ok(seen.length >= 2, `progress was reported (${seen.length} updates)`);
  for (let i = 1; i < seen.length; i++) ok(seen[i] >= seen[i - 1], `progress is monotonic: ${seen.join(',')}`);
  ok(seen[seen.length - 1] === 1, 'finishes at 100%');
});

test('output names keep the original stem and take the new extension', async () => {
  const result = await convert({ name: 'My Report 2026.docx', bytes: new Uint8Array(readFileSync(join(tmp, 'report.docx')).buffer) }, 'docx-txt').catch(() => null);
  if (result) eq(result.files[0].name, 'My Report 2026.txt');
  const md = await convert({ name: 'notes.md', bytes: new TextEncoder().encode('hi') }, 'md-docx');
  eq(md.files[0].name, 'notes.docx');
});

test('blocksToMarkdown escapes pipes so tables survive a round trip', () => {
  const md = blocksToMarkdown([{ type: 'table', head: [[{ text: 'a|b' }]], rows: [[[{ text: 'c' }]]] }]);
  ok(md.includes('a\\|b'), 'pipe escaped inside a cell');
});

await run('convert');
