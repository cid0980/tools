/**
 * A very small XML parser.
 *
 * Why hand-rolled: `DOMParser` does not exist in Node, and .docx / .xlsx / ODF
 * are just XML inside a ZIP — so the whole converter stack needs one parser that
 * behaves identically in the browser and in the test runner. This handles the
 * subset those formats use: elements, attributes, namespaces (kept verbatim),
 * text, CDATA, comments, processing instructions, entities. No DTD, no XSLT,
 * no validation — and it never throws on unknown junk, it just skips it.
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

export function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    const known = ENTITIES[body];
    return known === undefined ? whole : known;
  });
}

export function escapeXml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // control characters are illegal in XML 1.0 and Word refuses the file
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

export function localName(tag) {
  const name = String(tag || '');
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

function makeNode(name, attrs) {
  return { name, local: localName(name), attrs: attrs || {}, children: [], text: '' };
}

/**
 * Parse XML (or HTML-ish) text into a lightweight tree.
 * @returns {{name: string, attrs: object, children: Array, text: string}}
 */
export function parseXml(input) {
  const src = String(input == null ? '' : input);
  const root = makeNode('#document', {});
  const stack = [root];
  let i = 0;

  const top = () => stack[stack.length - 1];
  const addText = (chunk) => {
    if (chunk) top().text += decodeEntities(chunk);
  };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) { addText(src.slice(i)); break; }
    if (lt > i) addText(src.slice(i, lt));

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      const body = src.slice(lt + 9, end === -1 ? src.length : end);
      top().text += body;
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt + 2);
      i = end === -1 ? src.length : end + 1;
      continue;
    }

    const gt = findTagEnd(src, lt);
    if (gt === -1) { addText(src.slice(lt)); break; }
    const raw = src.slice(lt + 1, gt);

    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      // unwind to the matching element, tolerant of stray close tags
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].name === name) { stack.length = s; break; }
      }
      i = gt + 1;
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const space = body.search(/[\s]/);
    const name = (space === -1 ? body : body.slice(0, space)).trim();
    const attrs = space === -1 ? {} : parseAttrs(body.slice(space));
    if (!name) { i = gt + 1; continue; }

    const node = makeNode(name, attrs);
    node.parent = top();
    top().children.push(node);
    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }

  // tolerate unclosed elements: everything collapses into the root anyway
  return root;
}

/** Find the '>' that closes a tag, ignoring '>' inside quoted attributes. */
function findTagEnd(src, start) {
  let quote = null;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') return i;
  }
  return -1;
}

function parseAttrs(chunk) {
  const attrs = {};
  const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(chunk))) {
    const value = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : (m[5] || '');
    attrs[m[1]] = decodeEntities(value);
  }
  return attrs;
}

/* ------------------------------------------------------------------ traversal */

export function childNodes(node, name = null) {
  const kids = (node && node.children) || [];
  if (!name) return kids;
  const want = localName(name);
  return kids.filter((c) => c.local === want);
}

export function child(node, name, { deep = false } = {}) {
  const list = deep ? findAll(node, name) : childNodes(node, name);
  return list[0] || null;
}

export function findAll(node, name, out = []) {
  if (!node) return out;
  const want = localName(name);
  const stack = [node];
  while (stack.length) {
    const current = stack.pop();
    for (const kid of current.children || []) {
      if (kid.local === want) out.push(kid);
      stack.push(kid);
    }
  }
  return out;
}

/** Concatenated text of a node and its descendants. */
export function textOf(node) {
  if (!node) return '';
  let out = node.text || '';
  for (const kid of node.children || []) out += textOf(kid);
  return out;
}

export function attr(node, name, fallback = null) {
  if (!node || !node.attrs) return fallback;
  if (name in node.attrs) return node.attrs[name];
  const want = localName(name);
  for (const [key, value] of Object.entries(node.attrs)) if (localName(key) === want) return value;
  return fallback;
}

export function attrNumber(node, name, fallback = 0) {
  const raw = attr(node, name, null);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function xmlDeclaration() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
}

/** Serialise a tiny tree back to XML (used when writing .docx / .xlsx). */
export function serialize(node) {
  if (typeof node === 'string') return escapeXml(node);
  const attrs = Object.entries(node.attrs || {})
    .map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join('');
  const kids = (node.children || []).map(serialize).join('');
  const text = node.text ? escapeXml(node.text) : '';
  return `<${node.name}${attrs}>${text}${kids}</${node.name}>`;
}

export function el(name, attrs = {}, children = []) {
  return { name, local: localName(name), attrs: attrs || {}, children, text: '' };
}

export function textEl(name, text, attrs = {}) {
  const node = el(name, attrs);
  node.text = String(text == null ? '' : text);
  return node;
}
