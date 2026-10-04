/**
 * OmniBox — UI controller.
 *
 * Plain DOM, no framework. All the substance lives in ../core/*, which is
 * DOM-free and unit-tested; this file only wires it to buttons, progress bars
 * and downloads.
 */

import { saveBytes, formatBytes, kindOf, KIND_ICON, safeFileName, stemOf, extOf, te, tooBigForMemory, MEMORY_LIMIT_BYTES } from '../core/util.js';
import { convert, conversionsFor, conversionById } from '../core/convert.js';
import { classifyUrl, buildCommand, buildPowerShellCommand, buildArgs, probeDirectUrl, platformAdvice, DOWNLOADER_NOTES, DOWNLOAD_PRESETS } from '../core/ytdlp.js';
import { PROVIDERS, checkKey, checkAll, KEY_SECURITY_NOTE } from '../core/keys.js';
import { writeZip } from '../core/zip.js';

const $ = (id) => document.getElementById(id);
const state = {
  files: [],
  keys: {},
  keyResults: {},
  spec: null,
  lastCommand: '',
};

/* ------------------------------------------------------------------ helpers */

let toastTimer;
function toast(message, ms = 2800) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function esc(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} copied`);
  } catch {
    // clipboard API needs a secure context; fall back to a textarea
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); toast(`${label} copied`); } catch { toast('Could not copy — select the text manually'); }
    area.remove();
  }
}

/* -------------------------------------------------------------------- tabs */

function selectTab(name) {
  for (const button of document.querySelectorAll('nav [data-tab]')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === name));
  }
  for (const id of ['convert', 'download', 'keys']) $(`tab-${id}`).hidden = id !== name;
  if (name === 'keys') renderKeys();
  location.hash = name === 'convert' ? '' : `#${name}`;
}

for (const button of document.querySelectorAll('nav [data-tab]')) {
  button.addEventListener('click', () => selectTab(button.dataset.tab));
}

/* ================================================================== CONVERT */

function options() {
  return {
    pageSize: $('opt-pagesize').value,
    fontSize: Number($('opt-fontsize').value) || 11,
    maxRows: Number($('opt-maxrows').value) || 500,
    pagePerHeading: $('opt-pagebreak').checked,
    captions: $('opt-captions').checked,
  };
}

async function addFiles(fileList) {
  const incoming = [...fileList];
  for (const file of incoming) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    state.files.push({ id: `f${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: safeFileName(file.name || 'file'), size: bytes.length, bytes, results: null });
  }
  renderFiles();
  if (incoming.length) toast(`${incoming.length} file${incoming.length === 1 ? '' : 's'} ready`);
}

function renderFiles() {
  const list = $('file-list');
  if (!state.files.length) { list.innerHTML = ''; $('memory-chip').hidden = true; return; }

  const total = state.files.reduce((n, f) => n + f.size, 0);
  const chip = $('memory-chip');
  chip.hidden = false;
  chip.className = 'chip' + (total > MEMORY_LIMIT_BYTES ? ' warn' : '');
  chip.textContent = `${state.files.length} file${state.files.length === 1 ? '' : 's'} · ${formatBytes(total)} in memory`;

  list.innerHTML = state.files.map((file) => {
    const kind = kindOf(file.name);
    const targets = conversionsFor(file.name);
    const multiTargets = conversionsFor(file.name, { multiple: state.files.length });
    const buttons = (file.results ? [] : (state.files.length > 1 ? multiTargets : targets))
      .map((t) => t.blocked
        ? `<span class="chip warn">${esc(t.note)}</span>`
        : `<button class="btn" data-convert="${esc(t.id)}" data-file="${file.id}">${esc(t.label)}</button>`).join('');
    const results = file.results ? `
      <div class="alert ${file.results.error ? 'bad' : 'good'}">
        ${file.results.error
          ? esc(file.results.error)
          : `Done in ${(file.results.ms / 1000).toFixed(1)}s · ${file.results.files.length} file${file.results.files.length === 1 ? '' : 's'} · ${formatBytes(file.results.files.reduce((n, f) => n + f.bytes.length, 0))}`}
      </div>
      ${file.results.files?.length ? `<div class="row" style="margin-top:8px">${file.results.files.map((out, i) => `<button class="btn primary" data-save="${file.id}:${i}">⤓ ${esc(out.name)} · ${formatBytes(out.bytes.length)}</button>`).join('')}${file.results.files.length > 1 ? `<button class="btn ghost" data-savez="${file.id}">⤓ All as ZIP</button>` : ''}</div>` : ''}
      ${file.results.warnings?.length ? `<div class="alert warn">${file.results.warnings.map(esc).join('<br>')}</div>` : ''}
      ${file.results.notes?.length ? `<p class="note">${file.results.notes.map(esc).join('<br>')}</p>` : ''}
      <div class="row" style="margin-top:10px">
        <button class="btn ghost" data-reset="${file.id}">Convert again</button>
        <button class="btn ghost" data-remove="${file.id}">Remove</button>
      </div>` : '';
    const progress = file.progress !== undefined && file.progress < 1 ? `
      <div class="bar" style="margin-top:10px"><i style="width:${Math.round(file.progress * 100)}%"></i></div>
      <p class="tiny muted" style="margin:6px 0 0">${esc(file.phase || 'Working…')} · ${Math.round(file.progress * 100)}%</p>` : '';

    return `<div class="file" data-id="${file.id}">
      <div class="name">${KIND_ICON[kind] || '📦'} ${esc(file.name)}</div>
      <div class="meta">${formatBytes(file.size)} · ${kind}</div>
      ${buttons ? `<div class="row">${buttons}</div>` : ''}
      ${progress}
      ${results}
    </div>`;
  }).join('');
}

$('file-list').addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target) return;
  const { convert: conversionId, file: fileId, save, savez, reset, remove } = target.dataset;

  if (remove) { state.files = state.files.filter((f) => f.id !== remove); renderFiles(); return; }
  if (reset) { const file = state.files.find((f) => f.id === reset); if (file) { file.results = null; file.progress = undefined; renderFiles(); } return; }

  if (save) {
    const [id, index] = save.split(':');
    const file = state.files.find((f) => f.id === id);
    const out = file?.results?.files?.[Number(index)];
    if (out) saveBytes(out.bytes, out.name, out.mime);
    return;
  }
  if (savez) {
    const file = state.files.find((f) => f.id === savez);
    if (!file?.results?.files?.length) return;
    toast('Packing ZIP…');
    const zip = await writeZip(file.results.files.map((f) => ({ name: f.name, bytes: f.bytes })));
    saveBytes(zip, `${stemOf(file.name)}-omnibox.zip`, 'application/zip');
    return;
  }
  if (!conversionId || !fileId) return;

  const file = state.files.find((f) => f.id === fileId);
  if (!file) return;
  const conversion = conversionById(conversionId);
  if (conversion?.accepts?.length > 1 && state.files.length > 1) {
    // a multi-file conversion (images → one PDF) takes the whole selection
    runConvert(file, conversionId, state.files.filter((f) => conversion.accepts.includes(extOf(f.name))));
    return;
  }
  runConvert(file, conversionId, [file]);
});

async function runConvert(file, conversionId, group) {
  const started = Date.now();
  file.progress = 0.02; file.phase = 'Starting'; renderFiles();
  try {
    const result = await convert(
      { name: file.name, bytes: file.bytes, files: group.map((f) => ({ name: f.name, bytes: f.bytes })) },
      conversionId,
      {
        options: options(),
        onProgress: ({ phase, fraction }) => {
          file.phase = phase; file.progress = Math.max(0.02, Math.min(0.98, fraction));
          const bar = document.querySelector(`[data-id="${file.id}"] .bar > i`);
          const label = document.querySelector(`[data-id="${file.id}"] .tiny.muted`);
          if (bar) bar.style.width = `${Math.round(file.progress * 100)}%`;
          if (label) label.textContent = `${phase} · ${Math.round(file.progress * 100)}%`;
        },
      },
    );
    file.results = { ...result, ms: Date.now() - started };
    file.progress = 1;
    if (result.files.length === 1 && result.files[0].bytes.length < 40 * 1024 * 1024) {
      // small outputs are saved straight away — that is what people want 95% of the time
      saveBytes(result.files[0].bytes, result.files[0].name, result.files[0].mime);
      toast(`${result.files[0].name} saved`);
    } else {
      toast(`${result.files.length} files ready — tap to save`);
    }
  } catch (err) {
    file.results = { error: err.message || String(err), files: [] };
    file.progress = 1;
  }
  renderFiles();
}

// file intake: picker, drag & drop, paste
$('drop').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
$('paste-btn').addEventListener('click', async () => {
  try {
    const items = await navigator.clipboard.read();
    const files = [];
    for (const item of items) {
      for (const type of item.types) {
        if (type.startsWith('image/') || type === 'text/plain') {
          const blob = await item.getType(type);
          const ext = type === 'text/plain' ? 'txt' : type.split('/')[1];
          files.push(new File([blob], `pasted-${Date.now()}.${ext}`, { type }));
        }
      }
    }
    if (!files.length) return toast('Nothing usable on the clipboard');
    await addFiles(files);
  } catch {
    toast('The browser would not hand over the clipboard — use the file picker');
  }
});
for (const type of ['dragenter', 'dragover']) {
  $('drop').addEventListener(type, (e) => { e.preventDefault(); $('drop').classList.add('over'); });
}
for (const type of ['dragleave', 'drop']) {
  $('drop').addEventListener(type, (e) => { e.preventDefault(); $('drop').classList.remove('over'); });
}
$('drop').addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); });
window.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) addFiles(files);
});
$('clear-btn').addEventListener('click', () => { state.files = []; renderFiles(); toast('List cleared'); });

/* ================================================================= DOWNLOAD */

function spec() {
  const subLangs = $('dl-sublangs').value;
  return {
    url: $('dl-url').value.trim(),
    mode: $('dl-mode').value,
    quality: $('dl-quality').value,
    container: $('dl-container').value,
    audioFormat: $('dl-audioformat').value,
    audioBitrate: $('dl-bitrate').value,
    cookiesFromBrowser: $('dl-cookies').value,
    outDir: $('dl-outdir').value.trim(),
    limitRate: $('dl-limitrate').value.trim(),
    subtitles: !!subLangs,
    subtitleLangs: subLangs || 'en',
    playlist: $('dl-playlist').checked,
    embedThumbnail: $('dl-thumb').checked,
    embedMetadata: $('dl-meta').checked,
    sponsorblock: $('dl-sponsor').checked,
  };
}

function refreshCommand() {
  const current = spec();
  state.spec = current;
  state.lastCommand = current.url ? buildCommand(current) : '';
  $('dl-command').textContent = current.url ? state.lastCommand : '(paste a link above)';
  const audio = current.mode === 'audio';
  $('dl-audioformat-wrap').hidden = !audio;
  $('dl-bitrate-wrap').hidden = !audio;
  $('dl-quality').disabled = audio;
  $('dl-container').disabled = audio;
}

function renderVerdict(classification, advice) {
  const box = $('dl-verdict');
  if (!classification || classification.kind === 'invalid') {
    box.innerHTML = classification ? `<div class="alert warn">${esc(classification.reason)}</div>` : '';
    $('dl-options').hidden = true;
    return;
  }
  const chips = [];
  if (classification.kind === 'platform') chips.push(`<span class="chip">${esc(classification.platform.name)} page</span>`);
  if (classification.kind === 'direct-media') chips.push('<span class="chip good">direct media file</span>');
  if (classification.kind === 'direct-image') chips.push('<span class="chip good">direct image</span>');
  if (classification.kind === 'direct-file') chips.push('<span class="chip good">direct file</span>');
  if (classification.kind === 'unknown-page') chips.push('<span class="chip warn">unrecognised page</span>');

  let html = `<div class="row" style="margin-top:10px">${chips.join('')}</div>`;
  if (classification.kind === 'platform') {
    html += `<div class="alert info"><b>This needs a real downloader.</b> ${esc(DOWNLOADER_NOTES.browserCannot)}</div>`;
    if (advice) html += `<p class="note"><b>${esc(advice.platform)}:</b> ${advice.lines.map(esc).join('<br>')}</p>`;
    $('dl-options').hidden = false;
  } else if (classification.kind.startsWith('direct')) {
    html += '<div class="alert good">This is a direct file URL — the browser may be able to save it right here. Try it; if the server refuses cross-origin reads, open it in a new tab instead.</div>';
    $('dl-options').hidden = false;
  } else {
    html += `<div class="alert warn">Not a recognised platform or a direct file link. ${esc(DOWNLOADER_NOTES.publicInstances)}</div>`;
    $('dl-options').hidden = false;
  }
  box.innerHTML = html;
  refreshCommand();
  renderDirectPanel(classification);
}

function renderDirectPanel(classification) {
  const box = $('dl-direct');
  if (!classification || !classification.kind?.startsWith('direct')) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="row" style="margin-top:10px">
      <button class="btn primary" id="dl-try">Try saving it here</button>
      <button class="btn ghost" id="dl-opentab">Open in a new tab</button>
    </div><div id="dl-try-result"></div>`;
  $('dl-opentab').addEventListener('click', () => {
    window.open($('dl-url').value.trim(), '_blank', 'noopener');
    toast('Opened in a new tab — long-press or right-click to save');
  });
  $('dl-try').addEventListener('click', async () => {
    const url = $('dl-url').value.trim();
    const result = $('dl-try-result');
    result.innerHTML = '<div class="alert info">Checking whether the server allows it…</div>';
    const probe = await probeDirectUrl(url);
    if (!probe.readable || !probe.ok) {
      result.innerHTML = `<div class="alert warn">${esc(probe.message || 'The browser could not read this URL.')}<br><br>Use <b>Open in a new tab</b> — normal navigation is not restricted the way fetch() is.</div>`;
      return;
    }
    result.innerHTML = `<div class="alert good">Allowed. ${probe.type || 'unknown type'}${probe.size ? ` · ${formatBytes(probe.size)}` : ''} — downloading…</div><div class="bar"><i id="dl-bar"></i></div>`;
    try {
      const res = await fetch(url);
      const total = Number(res.headers.get('content-length') || 0);
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (total) $('dl-bar').style.width = `${Math.round((received / total) * 100)}%`;
      }
      const bytes = new Uint8Array(received);
      let at = 0;
      for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
      const name = probe.filename || decodeURIComponent((new URL(url).pathname.split('/').pop()) || 'download');
      saveBytes(bytes, name, probe.type);
      result.innerHTML = `<div class="alert good">Saved ${esc(name)} · ${formatBytes(bytes.length)}</div>`;
    } catch (err) {
      result.innerHTML = `<div class="alert bad">Download failed: ${esc(err.message)}. Try <b>Open in a new tab</b>.</div>`;
    }
  });
}

$('dl-inspect').addEventListener('click', () => {
  const classification = classifyUrl($('dl-url').value);
  renderVerdict(classification, platformAdvice(classification));
});
$('dl-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('dl-inspect').click(); });
$('dl-url').addEventListener('input', () => { if (state.spec) refreshCommand(); });

for (const id of ['dl-mode', 'dl-quality', 'dl-container', 'dl-audioformat', 'dl-bitrate', 'dl-cookies', 'dl-outdir', 'dl-limitrate', 'dl-sublangs', 'dl-playlist', 'dl-thumb', 'dl-meta', 'dl-sponsor']) {
  $(id).addEventListener('change', refreshCommand);
  $(id).addEventListener('input', refreshCommand);
}

$('dl-copy').addEventListener('click', () => { refreshCommand(); if (state.lastCommand) copy(state.lastCommand, 'Command'); });
$('dl-copy-ps').addEventListener('click', () => copy(buildPowerShellCommand(spec()), 'PowerShell command'));
$('dl-copy-json').addEventListener('click', () => copy(JSON.stringify(spec(), null, 2), 'JSON spec'));
$('dl-helper').addEventListener('click', async () => {
  try {
    const res = await fetch('tools/fetch.mjs');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    saveBytes(te.encode(text), 'fetch.mjs', 'text/javascript');
    toast('fetch.mjs saved — run: node fetch.mjs <link>');
  } catch (err) {
    toast('Could not fetch the helper here — it ships next to the app in the repository');
  }
});

/* ===================================================================== KEYS */

function renderKeys() {
  $('keys-hint').textContent = KEY_SECURITY_NOTE;
  const list = $('keys-list');
  list.innerHTML = PROVIDERS.map((provider) => {
    const result = state.keyResults[provider.id];
    const statusChip = result ? {
      valid: `<span class="chip good">✓ ${esc(result.message)}</span>`,
      limited: `<span class="chip warn">⏳ ${esc(result.message)}</span>`,
      invalid: `<span class="chip bad">✗ ${esc(result.message)}</span>`,
      restricted: `<span class="chip bad">⚠ ${esc(result.message)}</span>`,
      billing: `<span class="chip warn">💳 ${esc(result.message)}</span>`,
      blocked: `<span class="chip warn">🚧 ${esc(result.message)}</span>`,
      timeout: `<span class="chip warn">⏱ ${esc(result.message)}</span>`,
    }[result.status] || `<span class="chip bad">${esc(result.message)}</span>` : '';

    const corsNote = provider.cors.needs ? `needs <span class="mono">${esc(provider.cors.needs)}</span>`
      : provider.cors.measured ? 'measured' : 'supported';

    return `<div class="card">
      <div class="row between">
        <div>
          <h2 style="margin:0">${esc(provider.name)}</h2>
          <p class="hint" style="margin:2px 0 0">${esc(provider.kind)} · checks with <span class="mono">${esc(provider.cheapestCall)}</span> · browser calls: ${corsNote}</p>
        </div>
      </div>
      <div class="row" style="margin-top:10px">
        <input class="grow" type="password" id="key-${provider.id}" placeholder="${esc(provider.prefixHint || provider.keyLabel)}" autocomplete="off" spellcheck="false" value="${esc(state.keys[provider.id] || '')}" />
        <button class="btn" data-check="${provider.id}">Check</button>
      </div>
      <div class="row tiny" style="margin-top:6px">
        <a href="${esc(provider.tokenUrl)}" target="_blank" rel="noopener">Get a ${esc(provider.keyLabel.toLowerCase())} →</a>
        ${result ? `<span class="muted">checked in ${result.ms} ms${result.http ? ` · HTTP ${result.http}` : ''}</span>` : ''}
      </div>
      ${statusChip ? `<div class="row" style="margin-top:8px">${statusChip}</div>` : ''}
      ${result?.warn ? `<div class="alert warn">${esc(result.warn)}</div>` : ''}
      ${result?.meta && Object.keys(result.meta).length ? `<table class="report">${Object.entries(result.meta).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>` : ''}
      ${result?.detail ? `<p class="note mono">${esc(result.detail)}</p>` : ''}
    </div>`;
  }).join('');
}

async function runKeyCheck(providerId) {
  const input = $(`key-${providerId}`);
  const key = input ? input.value.trim() : state.keys[providerId];
  state.keys[providerId] = key;
  if (!key) { toast('Paste a key first'); return; }
  state.keyResults[providerId] = { status: 'timeout', message: 'Checking…', ms: 0 };
  renderKeys();
  const result = await checkKey(providerId, key);
  state.keyResults[providerId] = result;
  if ($('keys-remember').checked) persistKeys();
  renderKeys();
}

$('keys-list').addEventListener('click', (e) => {
  const button = e.target.closest('button[data-check]');
  if (button) runKeyCheck(button.dataset.check);
});
$('keys-list').addEventListener('input', (e) => {
  const match = e.target.id?.match(/^key-(.+)$/);
  if (match) state.keys[match[1]] = e.target.value;
});
$('keys-check-all').addEventListener('click', async () => {
  for (const provider of PROVIDERS) {
    const input = $(`key-${provider.id}`);
    if (input && input.value.trim()) { state.keys[provider.id] = input.value.trim(); }
  }
  const entered = Object.entries(state.keys).filter(([, v]) => v);
  if (!entered.length) return toast('No keys entered yet');
  toast(`Checking ${entered.length} key${entered.length === 1 ? '' : 's'}…`);
  await checkAll(state.keys, { onResult: (result) => { state.keyResults[result.provider] = result; renderKeys(); } });
  if ($('keys-remember').checked) persistKeys();
  toast('Checks finished');
});
$('keys-copy').addEventListener('click', () => {
  const lines = ['OmniBox API key report — ' + new Date().toISOString(), ''];
  for (const [id, result] of Object.entries(state.keyResults)) {
    lines.push(`${result.name || id}: ${result.status}${result.http ? ` (HTTP ${result.http})` : ''}${result.ms ? ` in ${result.ms} ms` : ''}`);
    if (result.message) lines.push(`  ${result.message}`);
    for (const [k, v] of Object.entries(result.meta || {})) lines.push(`  ${k}: ${v}`);
    lines.push('');
  }
  copy(lines.join('\n'), 'Report');
});
$('keys-clear').addEventListener('click', () => {
  state.keys = {}; state.keyResults = {};
  try { localStorage.removeItem('omnibox.keys.v1'); } catch {}
  $('keys-remember').checked = false;
  renderKeys();
  toast('Keys forgotten');
});

let remembered = false;
try {
  remembered = localStorage.getItem('omnibox.keys.remember') === '1';
  if (remembered) {
    state.keys = JSON.parse(localStorage.getItem('omnibox.keys.v1') || '{}');
    $('keys-remember').checked = true;
  }
} catch { /* storage can be unavailable in private modes */ }

function persistKeys() {
  try {
    if ($('keys-remember').checked) {
      localStorage.setItem('omnibox.keys.v1', JSON.stringify(state.keys));
      localStorage.setItem('omnibox.keys.remember', '1');
    } else {
      localStorage.removeItem('omnibox.keys.v1');
      localStorage.removeItem('omnibox.keys.remember');
    }
  } catch { toast('This browser refused to store the keys'); }
}
$('keys-remember').addEventListener('change', persistKeys);

/* ==================================================================== ABOUT */

const ABOUT = `
  <p><b>Everything runs in this tab.</b> No file is uploaded, no key is sent anywhere except to the provider you are checking,
  and there is no server behind any of it. That is why it works offline, and why the conversion engine is written from scratch
  instead of pulling in a few megabytes of libraries.</p>
  <h3 style="font-size:14px;margin-bottom:4px">What converts reliably</h3>
  <p class="tiny">PDF ⇄ Word, PDF ⇄ text/Markdown, images → PDF, Markdown/text → PDF/Word, HTML → Markdown/Word,
  spreadsheets ⇄ CSV/JSON/PDF, PDF image extraction, ZIP. Verified in the test suite against independent readers
  (Python's pypdf, python-docx, openpyxl and zipfile) — not just against itself.</p>
  <h3 style="font-size:14px;margin-bottom:4px">What does not, and why</h3>
  <p class="tiny">
  <b>PDF → image (page pictures):</b> rendering a page needs a full rasteriser; this app extracts the images a PDF already contains instead.<br>
  <b>Word → PDF fidelity:</b> it re-renders with standard PDF fonts. Text, tables, lists and images land correctly; exact font matching and column layouts do not.<br>
  <b>Legacy formats:</b> <span class="mono">.doc</span>, <span class="mono">.ppt</span>, <span class="mono">.xls</span> (binary, pre-2007) are not readable here. Ask the helper script to call LibreOffice if you have it installed.<br>
  <b>WebP/GIF/HEIC images:</b> not embeddable in a PDF by this app — re-save as JPEG or PNG.<br>
  <b>Password-protected or scanned PDFs:</b> no text layer to extract; the app says so per file.</p>
  <h3 style="font-size:14px;margin-bottom:4px">The downloader, without the sales pitch</h3>
  <p class="tiny">A web page cannot download from YouTube, Instagram, TikTok or Facebook — the streams are signed and IP-bound and the servers refuse cross-origin reads.
  Public Piped/Invidious instances used to bridge that; most have closed their video endpoints to browsers. So OmniBox does the honest part: it turns your
  quality/audio/format choices into the exact command that works, and ships a small local helper (fetch.mjs) that runs on your machine.
  Direct file and image URLs <i>can</i> be saved in-browser, and the app tries that first.</p>
  <p class="tiny muted">Version 1.0 · build: modules, no dependencies, no bundler.</p>
`;

$('about-btn').addEventListener('click', () => { $('about-body').innerHTML = ABOUT; $('about-sheet').hidden = false; });
$('about-close').addEventListener('click', () => { $('about-sheet').hidden = true; });
$('about-sheet').addEventListener('click', (e) => { if (e.target === $('about-sheet')) $('about-sheet').hidden = true; });

/* ================================================================== startup */

$('dl-why').textContent = DOWNLOADER_NOTES.browserCannot;
refreshCommand();
renderKeys();
if (location.hash === '#download') selectTab('download');
else if (location.hash === '#keys') selectTab('keys');
else selectTab('convert');

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline install is a bonus, not a requirement */ });
  });
}
