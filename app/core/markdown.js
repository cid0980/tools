/**
 * Markdown and plain text → the shared block model.
 *
 * The block model is the pivot of the whole toolbox: every reader produces it
 * (markdown, docx, xlsx, pdf) and every writer consumes it (pdf, docx, text).
 * Keeping it small is what makes "and etc formats" tractable.
 *
 * Supported: ATX headings, paragraphs, unordered/ordered lists, fenced code,
 * blockquotes, horizontal rules, pipe tables, and inline bold/italic/code/
 * strikethrough/links. Anything else degrades to text rather than disappearing.
 */

const RE_HEADING = /^(#{1,6})\s+(.*)$/;
const RE_UL = /^\s*[-*+]\s+(.*)$/;
const RE_OL = /^\s*(\d+)[.)]\s+(.*)$/;
const RE_FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const RE_HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const RE_QUOTE = /^\s*>\s?(.*)$/;
const RE_TABLE_SEP = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

/** Inline markdown → runs. */
export function parseInline(text) {
  const runs = [];
  const src = String(text == null ? '' : text);
  let i = 0;
  let plain = '';

  const flush = () => { if (plain) { runs.push({ text: plain }); plain = ''; } };

  while (i < src.length) {
    const rest = src.slice(i);

    const codeMatch = /^`([^`]+)`/.exec(rest);
    if (codeMatch) { flush(); runs.push({ text: codeMatch[1], code: true }); i += codeMatch[0].length; continue; }

    const imageMatch = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
    if (imageMatch) {
      flush();
      runs.push({ text: imageMatch[1] || 'image', italic: true });
      i += imageMatch[0].length;
      continue;
    }

    const linkMatch = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
    if (linkMatch) {
      flush();
      runs.push({ text: linkMatch[1], link: linkMatch[2], underline: true });
      runs.push({ text: ` (${linkMatch[2]})`, size: 'small' });
      i += linkMatch[0].length;
      continue;
    }

    const boldMatch = /^(\*\*|__)(.+?)\1/.exec(rest);
    if (boldMatch) { flush(); runs.push({ text: boldMatch[2], bold: true }); i += boldMatch[0].length; continue; }

    const strikeMatch = /^~~(.+?)~~/.exec(rest);
    if (strikeMatch) { flush(); runs.push({ text: strikeMatch[1], strike: true }); i += strikeMatch[0].length; continue; }

    const italicMatch = /^(\*|_)([^*_]+?)\1/.exec(rest);
    if (italicMatch) { flush(); runs.push({ text: italicMatch[2], italic: true }); i += italicMatch[0].length; continue; }

    if (rest.startsWith('\\') && rest.length > 1 && '*_`[]()#'.includes(rest[1])) { plain += rest[1]; i += 2; continue; }

    plain += src[i];
    i += 1;
  }
  flush();
  return runs.length ? runs : [{ text: '' }];
}

export function stripInline(text) {
  return parseInline(text).map((r) => r.text).join('');
}

function splitRow(line) {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|')) body = body.slice(0, -1);
  return body.split('|').map((c) => c.trim());
}

/**
 * @param text markdown or plain text
 * @param options {markdown?: boolean} — false treats every blank-line-separated
 *                block as a paragraph and never looks for syntax
 * @returns {Array} blocks
 */
export function parseText(text, { markdown = true } = {}) {
  const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const blocks = [];
  let para = [];

  const flushPara = () => {
    if (!para.length) return;
    const joined = para.join('\n');
    // a single newline is a soft break inside a paragraph, a blank line ends it
    for (const chunk of joined.split('\n')) {
      blocks.push({ type: 'p', runs: markdown ? parseInline(chunk) : [{ text: chunk }] });
    }
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) { flushPara(); continue; }

    if (markdown) {
      const fence = RE_FENCE.exec(line);
      if (fence) {
        flushPara();
        const marker = fence[1];
        const lang = fence[2] || null;
        const code = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(marker)) { code.push(lines[i]); i++; }
        blocks.push({ type: 'code', text: code.join('\n'), lang });
        continue;
      }

      const heading = RE_HEADING.exec(trimmed);
      if (heading) { flushPara(); blocks.push({ type: 'h', level: heading[1].length, runs: parseInline(heading[2]) }); continue; }

      if (RE_HR.test(trimmed)) { flushPara(); blocks.push({ type: 'hr' }); continue; }

      const quote = RE_QUOTE.exec(line);
      if (quote) {
        flushPara();
        const quoted = [quote[1]];
        while (i + 1 < lines.length && RE_QUOTE.test(lines[i + 1])) { i++; quoted.push(RE_QUOTE.exec(lines[i])[1]); }
        blocks.push({ type: 'quote', runs: parseInline(quoted.join(' ')) });
        continue;
      }

      // pipe table: a header row followed by a separator row
      if (trimmed.includes('|') && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('|')) {
        flushPara();
        const head = splitRow(trimmed).map((c) => parseInline(c));
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          rows.push(splitRow(lines[i]).map((c) => parseInline(c)));
          i++;
        }
        i--;
        blocks.push({ type: 'table', head, rows });
        continue;
      }

      const ul = RE_UL.exec(line);
      if (ul) {
        flushPara();
        const items = [parseInline(ul[1])];
        while (i + 1 < lines.length && RE_UL.test(lines[i + 1])) { i++; items.push(parseInline(RE_UL.exec(lines[i])[1])); }
        blocks.push({ type: 'ul', items });
        continue;
      }

      const ol = RE_OL.exec(line);
      if (ol) {
        flushPara();
        const start = Number(ol[1]) || 1;
        const items = [parseInline(ol[2])];
        while (i + 1 < lines.length && RE_OL.test(lines[i + 1])) { i++; items.push(parseInline(RE_OL.exec(lines[i])[2])); }
        blocks.push({ type: 'ol', items, start });
        continue;
      }
    }

    para.push(markdown ? line : trimmed);
  }

  flushPara();
  return blocks;
}

/** Insert a page break before every level-1 heading except the first block. */
export function withPageBreaksPerHeading(blocks, level = 1) {
  const out = [];
  for (const block of blocks) {
    if (block.type === 'h' && block.level === level && out.length) out.push({ type: 'pagebreak' });
    out.push(block);
  }
  return out;
}

export function countWords(blocks) {
  let words = 0;
  for (const block of blocks || []) {
    const text = [block.runs, block.text, block.items].filter(Boolean).map((v) => {
      if (typeof v === 'string') return v;
      if (Array.isArray(v)) return v.map((item) => (Array.isArray(item) ? item.map((r) => r.text).join('') : item.text || '')).join(' ');
      return '';
    }).join(' ');
    words += (text.match(/[^\s]+/g) || []).length;
  }
  return words;
}
