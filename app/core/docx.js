/**
 * .docx in both directions, written by hand.
 *
 * A .docx is a ZIP containing XML — so with zip.js and xml.js in place, the whole
 * Office path is ours. Reading produces the shared block model (paragraphs with
 * bold/italic runs, heading styles, lists, tables, embedded images) and writing
 * turns that model back into a real .docx with styles, numbering and media.
 *
 * Honest scope: text, formatting, headings, lists, tables and images survive.
 * Columns, text boxes, footnotes, smart art and tracked changes do not.
 */

import { parseXml, findAll, childNodes, child, attr, textOf, escapeXml, xmlDeclaration } from './xml.js';
import { writeZip, readZip } from './zip.js';
import { str, extOf, MIME } from './util.js';

const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
};

const HEADING_LEVEL = {
  Title: 1, Heading1: 1, Heading2: 2, Heading3: 3, Heading4: 4, Heading5: 5, Heading6: 6,
};

/* =========================================================== reading ======= */

function styleIdOf(paragraph) {
  const pr = child(paragraph, 'w:pPr');
  const style = pr && child(pr, 'w:pStyle');
  return style ? attr(style, 'w:val', '') : '';
}

function isNumericStyle(styleId) {
  return /^(ListParagraph|ListNumber|ListBullet|List|Numbering)/i.test(styleId || '');
}

/** Runs of a paragraph, including hyperlinks and images. */
function paragraphRuns(paragraph, images, rels) {
  const runs = [];
  const walk = (node, inherited) => {
    for (const kid of childNodes(node)) {
      const local = kid.local;
      if (local === 'r') {
        const rPr = child(kid, 'w:rPr');
        const bold = !!(rPr && child(rPr, 'w:b')) || inherited.bold;
        const italic = !!(rPr && child(rPr, 'w:i')) || inherited.italic;
        const strike = !!(rPr && (child(rPr, 'w:strike') || child(rPr, 'w:dstrike')));
        const font = rPr && child(rPr, 'w:rFonts');
        const fontName = font ? attr(font, 'w:ascii', '') : '';
        const code = /Consolas|Courier|Mono/i.test(fontName || '');
        const vertAlign = rPr && child(rPr, 'w:vertAlign');
        const sup = vertAlign && attr(vertAlign, 'w:val', '') === 'superscript';
        let text = '';
        for (const piece of childNodes(kid)) {
          if (piece.local === 't') text += piece.text;
          else if (piece.local === 'br' || piece.local === 'cr') text += '\n';
          else if (piece.local === 'tab') text += '\t';
          else if (piece.local === 'drawing') {
            const blip = findAll(piece, 'a:blip')[0];
            const embed = blip ? attr(blip, 'r:embed', null) : null;
            const extent = findAll(piece, 'wp:extent')[0];
            const cx = extent ? Number(attr(extent, 'cx', '0')) : 0;
            const cy = extent ? Number(attr(extent, 'cy', '0')) : 0;
            if (embed && rels && rels[embed]) {
              const target = rels[embed].replace(/^\/?word\//, '').replace(/^\//, '');
              images.push({ target, widthPx: Math.round(cx / 9525), heightPx: Math.round(cy / 9525) });
            }
          }
        }
        if (text) runs.push({ text, bold, italic, strike, superscript: sup, code });
      } else if (local === 'hyperlink') {
        const id = attr(kid, 'r:id', null);
        const target = id && rels && rels[id] ? rels[id] : null;
        const before = runs.length;
        walk(kid, { ...inherited, link: target });
        if (target) for (let i = before; i < runs.length; i++) { runs[i].link = target; runs[i].underline = true; }
      } else if (local === 'ins') {
        walk(kid, inherited);
      } else if (local === 'smartTag' || local === 'sdt' || local === 'sdtContent') {
        walk(kid, inherited);
      }
    }
  };
  walk(paragraph, { bold: false, italic: false, link: null });
  return runs;
}

function tableToBlock(table, images, rels) {
  const rows = [];
  for (const tr of childNodes(table, 'w:tr')) {
    const cells = [];
    for (const tc of childNodes(tr, 'w:tc')) {
      const pieces = [];
      for (const p of childNodes(tc, 'w:p')) {
        const runs = paragraphRuns(p, images, rels);
        const text = runs.map((r) => r.text).join('');
        if (text) pieces.push(text);
      }
      cells.push(pieces.join('\n'));
    }
    rows.push(cells);
  }
  if (!rows.length) return null;
  const first = rows[0];
  const looksLikeHeader = rows.length > 1 && first.some((c) => c.trim());
  return looksLikeHeader
    ? { type: 'table', head: first.map((c) => [{ text: c }]), rows: rows.slice(1).map((r) => r.map((c) => [{ text: c }])) }
    : { type: 'table', rows: rows.map((r) => r.map((c) => [{ text: c }])) };
}

function readRels(xmlText) {
  const map = {};
  if (!xmlText) return map;
  const doc = parseXml(xmlText);
  for (const rel of findAll(doc, 'Relationship')) {
    const id = attr(rel, 'Id', null);
    const target = attr(rel, 'Target', null);
    if (id && target) map[id] = target;
  }
  return map;
}

/**
 * @returns {Promise<{blocks, meta, images: Map<string, Uint8Array>, warnings}>}
 */
export async function readDocx(input) {
  const { entries } = await readZip(input);
  const warnings = [];
  const documentEntry = entries.get('word/document.xml');
  if (!documentEntry) throw new Error('Not a Word document: word/document.xml is missing');

  const images = new Map();
  const doc = parseXml(str(documentEntry.bytes));
  const body = findAll(doc, 'w:body')[0];
  if (!body) throw new Error('Word document has no body');

  const rels = readRels(entries.has('word/_rels/document.xml.rels') ? str(entries.get('word/_rels/document.xml.rels').bytes) : '');

  const blocks = [];
  const pendingImages = [];

  for (const node of childNodes(body)) {
    const local = node.local;
    if (local === 'p') {
      const runs = paragraphRuns(node, pendingImages, rels);
      const text = runs.map((r) => r.text).join('');
      const styleId = styleIdOf(node);
      const isList = isNumericStyle(styleId);
      const numPr = child(child(node, 'w:pPr') || { children: [] }, 'w:numPr');
      const ilvl = numPr ? child(numPr, 'w:ilvl') : null;
      const numId = numPr ? child(numPr, 'w:numId') : null;
      const listKind = numId && attr(numId, 'w:val', '') !== '0' ? 'list' : null;

      const headingLevel = HEADING_LEVEL[styleId] || (/^Heading([1-6])$/.test(styleId) ? Number(styleId.slice(7)) : 0);

      if (!text.trim() && !pendingImages.length) {
        if (runs.length) blocks.push({ type: 'p', runs: [{ text: '' }] });
        continue;
      }

      if (headingLevel) {
        blocks.push({ type: 'h', level: headingLevel, runs: runs.length ? runs : [{ text: '' }] });
      } else if (isList || listKind) {
        // consecutive list paragraphs merge into one block
        const kind = /Bullet/i.test(styleId) ? 'ul' : /Number/i.test(styleId) ? 'ol' : (attr(numId || {}, 'w:val', '1') === '1' ? 'ul' : 'ol');
        const last = blocks[blocks.length - 1];
        if (last && last.type === kind && last.__list) last.items.push(runs);
        else blocks.push({ type: kind, items: [runs], __list: true, level: ilvl ? Number(attr(ilvl, 'w:val', '0')) : 0 });
      } else if (runs.length) {
        blocks.push({ type: 'p', runs });
      }

      if (pendingImages.length) {
        for (const info of pendingImages) {
          const entry = entries.get(`word/${info.target}`) || entries.get(info.target);
          if (!entry) { warnings.push(`Image ${info.target} referenced but not found in the file`); continue; }
          images.set(info.target, entry.bytes);
          blocks.push({
            type: 'image',
            name: info.target.split('/').pop(),
            mime: MIME[extOf(info.target)] || 'application/octet-stream',
            bytes: entry.bytes,
            width: info.widthPx, height: info.heightPx,
          });
        }
        pendingImages.length = 0;
      }
      continue;
    }
    if (local === 'tbl') {
      const table = tableToBlock(node, pendingImages, rels);
      if (table) blocks.push(table);
      for (const info of pendingImages) {
        const entry = entries.get(`word/${info.target}`) || entries.get(info.target);
        if (entry) blocks.push({ type: 'image', bytes: entry.bytes, width: info.widthPx, height: info.heightPx, name: info.target.split('/').pop() });
      }
      pendingImages.length = 0;
      continue;
    }
    if (local === 'sectPr' || local === 'bookmarkStart' || local === 'bookmarkEnd') continue;
  }

  for (const block of blocks) delete block.__list;

  const meta = {};
  if (entries.has('docProps/core.xml')) {
    const core = parseXml(str(entries.get('docProps/core.xml').bytes));
    const pick = (name) => { const node = findAll(core, name)[0]; return node ? textOf(node).trim() : ''; };
    meta.title = pick('dc:title') || pick('title');
    meta.author = pick('dc:creator') || pick('creator');
    meta.created = pick('dcterms:created') || '';
  }

  if (!blocks.length) warnings.push('This document produced no text — it may contain only objects OmniBox cannot read (text boxes, drawings, embedded files)');
  return { blocks, meta, images, warnings };
}

/* =========================================================== writing ======= */

function runXml(run) {
  const props = [];
  if (run.bold) props.push('<w:b/>');
  if (run.italic) props.push('<w:i/>');
  if (run.strike) props.push('<w:strike/>');
  if (run.underline) props.push('<w:u w:val="single"/>');
  if (run.code) props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="19"/>');
  if (run.superscript) props.push('<w:vertAlign w:val="superscript"/>');
  const rPr = props.length ? `<w:rPr>${props.join('')}</w:rPr>` : '';
  const text = String(run.text == null ? '' : run.text);
  const pieces = text.split('\n');
  const body = pieces.map((piece, i) => `${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${escapeXml(piece)}</w:t>`).join('');
  return `<w:r>${rPr}${body}</w:r>`;
}

function paragraphXml(runs, { style = null, numbering = null, align = null } = {}) {
  const pr = [];
  if (style) pr.push(`<w:pStyle w:val="${style}"/>`);
  if (numbering) pr.push(`<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numbering}"/></w:numPr>`);
  if (align) pr.push(`<w:jc w:val="${align}"/>`);
  const pPr = pr.length ? `<w:pPr>${pr.join('')}</w:pPr>` : '';
  const body = (runs || []).map(runXml).join('');
  return `<w:p>${pPr}${body}</w:p>`;
}

function tableXml(block) {
  const columns = Math.max((block.head || []).length, ...(block.rows || []).map((r) => r.length), 1);
  const width = Math.floor(9360 / columns);
  const borders = '<w:tblBorders>'
    + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="D4D4D8"/>`).join('')
    + '</w:tblBorders>';
  const cellXml = (content, isHead) => {
    const runs = Array.isArray(content) ? content.map((r) => ({ ...r, bold: isHead || r.bold })) : [{ text: String(content == null ? '' : content), bold: isHead }];
    const shade = isHead ? '<w:shd w:val="clear" w:color="auto" w:fill="EEF2FF"/>' : '';
    return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${shade}</w:tcPr>${paragraphXml(runs)}</w:tc>`;
  };
  const rows = [];
  if (block.head && block.head.length) rows.push(`<w:tr>${block.head.map((c) => cellXml(c, true)).join('')}</w:tr>`);
  for (const row of block.rows || []) rows.push(`<w:tr>${row.map((c) => cellXml(c, false)).join('')}</w:tr>`);
  // w:tblGrid is required by strict consumers (python-docx refuses the file without it)
  const grid = `<w:tblGrid>${Array.from({ length: columns }, () => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>`;
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/>${borders}<w:tblW w:w="0" w:type="auto"/></w:tblPr>${grid}${rows.join('')}</w:tbl>`;
}

function imageXml(relId, { widthPx = 400, heightPx = 300, name = 'image' } = {}) {
  const cx = Math.max(120000, Math.round((widthPx || 400) * 9525));
  const cy = Math.max(120000, Math.round((heightPx || 300) * 9525));
  const id = Math.abs([...String(name)].reduce((n, c) => n + c.charCodeAt(0), 7));
  return '<w:p><w:r><w:drawing>'
    + `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>`
    + `<wp:docPr id="${id % 100000}" name="Picture ${id % 1000}"/>`
    + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + `<pic:nvPicPr><pic:cNvPr id="${id % 100000}" name="${escapeXml(name)}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
    + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
    + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
}

const STYLES_XML = xmlDeclaration()
  + `<w:styles xmlns:w="${NS.w}">`
  + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>'
  + '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
  + [1, 2, 3, 4, 5, 6].map((level) => {
    const sizes = { 1: 48, 2: 36, 3: 28, 4: 24, 5: 22, 6: 22 };
    return `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/>`
      + `<w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="${level === 1 ? 0 : 240}" w:after="120"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>`
      + `<w:rPr><w:b/><w:sz w:val="${sizes[level]}"/></w:rPr></w:style>`;
  }).join('')
  + '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>'
  + '<w:pPr><w:ind w:left="720"/></w:pPr><w:rPr><w:i/><w:color w:val="52525B"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/>'
  + '<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F4F4F5"/></w:pPr>'
  + '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/></w:rPr></w:style>'
  + '</w:styles>';

const NUMBERING_XML = xmlDeclaration()
  + `<w:numbering xmlns:w="${NS.w}">`
  + '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>'
  + '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/>'
  + '<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>'
  + '<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr></w:lvl></w:abstractNum>'
  + '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>'
  + '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/>'
  + '<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>'
  + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
  + '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>'
  + '</w:numbering>';

/**
 * @param blocks block model
 * @param meta {title, author, subject}
 * @returns {Promise<Uint8Array>}
 */
export async function writeDocx(blocks, meta = {}) {
  const bodyParts = [];
  const media = [];
  const rels = [];

  const addImage = (block, index) => {
    const ext = extOf(block.name || '') || (block.mime === 'image/png' ? 'png' : 'jpg');
    const target = `media/image${index}.${ext}`;
    media.push({ name: `word/${target}`, bytes: block.bytes });
    const id = `rIdImg${index}`;
    rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/>`);
    return imageXml(id, { widthPx: block.width, heightPx: block.height, name: block.name || target });
  };

  let imageIndex = 1;
  for (const block of blocks || []) {
    const type = block.type || 'p';
    if (type === 'h') bodyParts.push(paragraphXml(block.runs || [{ text: '' }], { style: `Heading${Math.min(6, Math.max(1, block.level || 1))}` }));
    else if (type === 'p') bodyParts.push(paragraphXml(block.runs || []));
    else if (type === 'quote') bodyParts.push(paragraphXml(block.runs || [], { style: 'Quote' }));
    else if (type === 'code') {
      const lines = String(block.text || '').split('\n');
      for (const line of lines) bodyParts.push(paragraphXml([{ text: line, code: true }], { style: 'Code' }));
    } else if (type === 'ul') for (const item of block.items || []) bodyParts.push(paragraphXml(Array.isArray(item) ? item : [{ text: String(item) }], { numbering: 1 }));
    else if (type === 'ol') for (const item of block.items || []) bodyParts.push(paragraphXml(Array.isArray(item) ? item : [{ text: String(item) }], { numbering: 2 }));
    else if (type === 'hr') bodyParts.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="CCCCCC"/></w:pBdr></w:pPr></w:p>');
    else if (type === 'table') bodyParts.push(tableXml(block));
    else if (type === 'pagebreak') bodyParts.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    else if (type === 'image') {
      if (!block.bytes) continue;
      bodyParts.push(addImage(block, imageIndex++));
    }
  }

  if (!bodyParts.length) bodyParts.push(paragraphXml([{ text: '' }]));

  const documentXml = xmlDeclaration()
    + `<w:document xmlns:w="${NS.w}" xmlns:r="${NS.r}" xmlns:wp="${NS.wp}" xmlns:a="${NS.a}">`
    + '<w:body>' + bodyParts.join('') + '</w:body></w:document>';

  const documentRels = xmlDeclaration()
    + `<Relationships xmlns="${NS.rel}">`
    + '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'
    + '<Relationship Id="rIdCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="../docProps/core.xml"/>'
    + '<Relationship Id="rIdApp" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="../docProps/app.xml"/>'
    + rels.join('')
    + '</Relationships>';

  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const core = xmlDeclaration()
    + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
    + 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + `<dc:title>${escapeXml(meta.title || 'OmniBox document')}</dc:title>`
    + `<dc:creator>${escapeXml(meta.author || 'OmniBox')}</dc:creator>`
    + '<cp:lastModifiedBy>OmniBox</cp:lastModifiedBy>'
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>`
    + `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>`
    + '</cp:coreProperties>';

  const contentTypes = xmlDeclaration()
    + `<Types xmlns="${NS.ct}">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Default Extension="png" ContentType="image/png"/>'
    + '<Default Extension="jpg" ContentType="image/jpeg"/>'
    + '<Default Extension="jpeg" ContentType="image/jpeg"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
    + '</Types>';

  const rootRels = xmlDeclaration()
    + `<Relationships xmlns="${NS.rel}">`
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
    + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
    + '</Relationships>';

  const app = xmlDeclaration()
    + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
    + 'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
    + '<Application>OmniBox</Application><AppVersion>1.0</AppVersion></Properties>';

  const files = [
    { name: '[Content_Types].xml', text: contentTypes },
    { name: '_rels/.rels', text: rootRels },
    { name: 'docProps/core.xml', text: core },
    { name: 'docProps/app.xml', text: app },
    { name: 'word/document.xml', text: documentXml },
    { name: 'word/_rels/document.xml.rels', text: documentRels },
    { name: 'word/styles.xml', text: STYLES_XML },
    { name: 'word/numbering.xml', text: NUMBERING_XML },
    ...media,
  ];
  return writeZip(files, { compress: true });
}

/** Convenience: text or markdown straight to .docx. */
export async function textToDocx(text, { markdown = true, ...meta } = {}) {
  const { parseText } = await import('./markdown.js');
  return writeDocx(parseText(text, { markdown }), meta);
}

/** docx → plain text, for "Word → Text". */
export function docxBlocksToText(blocks) {
  const out = [];
  for (const block of blocks || []) {
    const runText = (runs) => (Array.isArray(runs) ? runs : []).map((r) => (typeof r === 'string' ? r : r.text || '')).join('');
    if (block.type === 'h') out.push(runText(block.runs), '');
    else if (block.type === 'p') out.push(runText(block.runs), '');
    else if (block.type === 'quote') out.push('> ' + runText(block.runs), '');
    else if (block.type === 'code') out.push(String(block.text || ''), '');
    else if (block.type === 'ul') out.push(...(block.items || []).map((i) => `- ${runText(i)}`), '');
    else if (block.type === 'ol') out.push(...(block.items || []).map((i, n) => `${n + 1}. ${runText(i)}`), '');
    else if (block.type === 'table') {
      if (block.head) out.push(block.head.map(runText).join(' | '));
      for (const row of block.rows || []) out.push(row.map(runText).join(' | '));
      out.push('');
    } else if (block.type === 'image') out.push(`[image: ${block.name || ''}]`);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
