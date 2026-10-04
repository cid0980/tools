/** Primitives: bytes/strings, the XML parser, and ZIP in both directions. */

import { test, ok, eq, deep, rejects, run, python, pythonHas } from './helpers/harness.mjs';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeFileName, withExtension, formatBytes, kindOf, extOf, base64ToBytes, bytesToBase64, uniqueName, str, utf8 } from '../app/core/util.js';
import { parseXml, findAll, childNodes, textOf, attr, escapeXml, decodeEntities } from '../app/core/xml.js';
import { writeZip, readZip, crc32, looksLikeZip, inflateZlib } from '../app/core/zip.js';

const tmp = mkdtempSync(join(tmpdir(), 'omnibox-'));

/* ------------------------------------------------------------------ strings */

test('filenames are sanitised without losing the extension', () => {
  eq(safeFileName('../../etc/passwd.pdf'), 'passwd.pdf');
  eq(safeFileName('C:\\Users\\me\\report 2026.docx'), 'report 2026.docx');
  eq(safeFileName('with\u0000null.pdf'), 'withnull.pdf');
  eq(safeFileName('...'), 'file');
  eq(safeFileName('a/b/c.png'), 'c.png');
  eq(withExtension('report.PDF', 'docx'), 'report.docx');
  eq(withExtension('no-extension', 'pdf'), 'no-extension.pdf');
  eq(extOf('archive.tar.gz'), 'gz');
  eq(kindOf('clip.mp4'), 'video');
  eq(kindOf('sheet.xlsx'), 'sheet');
  eq(kindOf('script.py'), 'text');
  eq(formatBytes(999), '999 B');
  eq(formatBytes(2048), '2.00 KB');
  eq(uniqueName('a.pdf', ['a.pdf', 'a (2).pdf']), 'a (3).pdf');
});

test('base64 round-trips binary without blowing the stack', () => {
  const bytes = new Uint8Array(200000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) % 256;
  const back = base64ToBytes(bytesToBase64(bytes));
  eq(back.length, bytes.length);
  ok(back.every((v, i) => v === bytes[i]), 'every byte survives');
});

/* ---------------------------------------------------------------------- XML */

test('the XML parser handles namespaces, entities, CDATA and comments', () => {
  const doc = parseXml('<?xml version="1.0"?><w:document xmlns:w="ns"><w:body>'
    + '<w:p><w:r><w:t>Hello &amp; goodbye</w:t></w:r></w:p>'
    + '<!-- a comment --><w:p><w:t><![CDATA[raw <text>]]></w:t></w:p>'
    + '<w:tbl><w:tr><w:tc><w:t>cell</w:t></w:tc></w:tr></w:tbl>'
    + '</w:body></w:document>');
  const paragraphs = findAll(doc, 'w:p');
  eq(paragraphs.length, 2, 'two paragraphs');
  eq(textOf(paragraphs[0]), 'Hello & goodbye');
  eq(textOf(paragraphs[1]), 'raw <text>', 'CDATA text');
  eq(findAll(doc, 'w:tbl').length, 1);
  eq(decodeEntities('&lt;b&gt; &amp; &#65;&#x42;'), '<b> & AB');
  eq(escapeXml('a<b>&"'), 'a&lt;b&gt;&amp;&quot;');
});

test('attribute lookup works with or without the namespace prefix', () => {
  const doc = parseXml('<root><x a="1" w:val="Heading1" r:id="rId3"/></root>');
  const node = childNodes(childNodes(doc)[0])[0]; // the <x> inside <root>
  eq(attr(node, 'w:val'), 'Heading1');
  eq(attr(node, 'val'), 'Heading1', 'prefix-free lookup');
  eq(attr(node, 'r:id'), 'rId3');
  eq(attr(node, 'missing', 'fallback'), 'fallback');
});

test('the parser survives broken markup instead of throwing', () => {
  ok(parseXml('<a><b>text</a>'), 'unclosed tags do not throw');
  ok(parseXml('garbage <> <<> text'), 'junk does not throw');
  ok(parseXml(''), 'empty input is fine');
});

/* ---------------------------------------------------------------------- ZIP */

test('crc32 matches the canonical vector', () => {
  eq(crc32(utf8('abc')).toString(16), '352441c2');
  eq(crc32(utf8('')).toString(16), '0');
});

test('ZIP round-trips stored and deflated entries', async () => {
  const big = new Uint8Array(120000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7) % 251;
  const zip = await writeZip([
    { name: 'hello.txt', text: 'hello' },
    { name: 'folder/' },
    { name: 'folder/big.bin', bytes: big },
  ], { compress: true });
  ok(looksLikeZip(zip));
  const { entries } = await readZip(zip);
  deep([...entries.keys()], ['hello.txt', 'folder', 'folder/big.bin']);
  eq(str(entries.get('hello.txt').bytes), 'hello');
  ok(entries.get('folder').dir, 'directories are flagged');
  deep(entries.get('folder/big.bin').bytes, big);
  ok(zip.length < big.length / 4, 'deflate actually compressed it');
});

test('ZIP written without compression still reads back', async () => {
  const zip = await writeZip([{ name: 'a.txt', text: 'x'.repeat(1000) }], { compress: false });
  const { entries } = await readZip(zip);
  eq(entries.get('a.txt').method, 0, 'stored');
  eq(str(entries.get('a.txt').bytes), 'x'.repeat(1000));
});

test('a Python-written ZIP is readable, and Python can read ours', async () => {
  if (!pythonHas(['zipfile'])) return;
  const path = join(tmp, 'py.zip');
  python(`import zipfile
with zipfile.ZipFile(${JSON.stringify(path)},'w',zipfile.ZIP_DEFLATED) as z:
    z.writestr('deep/nested.txt','from python')
    z.writestr('data.bin', bytes(range(256))*40)`);
  const { entries } = await readZip(readFileSync(path));
  eq(str(entries.get('deep/nested.txt').bytes), 'from python');
  eq(entries.get('data.bin').bytes.length, 256 * 40);

  const ours = join(tmp, 'ours.zip');
  writeFileSync(ours, await writeZip([{ name: 'x/y.txt', text: 'from omnibox' }]));
  const check = python(`import zipfile
z = zipfile.ZipFile(${JSON.stringify(ours)})
print(z.testzip() is None, z.read('x/y.txt').decode())`);
  ok(check.ok, 'python opened our file');
  eq(check.out, 'True from omnibox');
});

test('a non-ZIP is rejected with a clear message', async () => {
  await rejects(() => readZip(utf8('this is not a zip at all, not even close')), /Not a ZIP/);
});

test('zlib inflate handles what PDF streams actually contain', async () => {
  const payload = utf8('q '.repeat(3000));
  const deflated = await (async () => {
    const stream = new Blob([payload]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  })();
  eq(str(await inflateZlib(deflated)), 'q '.repeat(3000));
});

test('an empty file list produces a valid, empty archive', async () => {
  const zip = await writeZip([]);
  const { entries } = await readZip(zip);
  eq(entries.size, 0);
});

await run('core');
