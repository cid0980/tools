#!/usr/bin/env node
/**
 * OmniBox helper — a small program that runs on YOUR machine.
 *
 * Not a server, not a service, no install: `node fetch.mjs <link>`. It exists
 * because two jobs genuinely cannot be done from a web page:
 *
 *   1. Downloading from YouTube/Instagram/TikTok/etc. — those streams are
 *      signed and IP-bound, and the servers refuse cross-origin reads. yt-dlp
 *      on a real machine is the only honest answer.
 *   2. Checking API keys whose provider does not allow browser calls (and any
 *      key you would rather not paste into a browser at all).
 *
 * It also delegates exact document conversion to LibreOffice when that is
 * installed, which gives Word/PDF-grade output the browser cannot match.
 *
 *   node fetch.mjs doctor
 *   node fetch.mjs get "https://youtu.be/…" --audio --audio-format mp3
 *   node fetch.mjs get "https://example.com/clip.mp4"            # direct, with resume
 *   node fetch.mjs key openai --key sk-…
 *   node fetch.mjs convert report.docx report.pdf               # needs LibreOffice
 *   node fetch.mjs --json spec.json                             # what OmniBox copies
 *
 * Node 18+ and nothing else. It never sends your data anywhere except to the
 * platform or provider you asked about.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, statSync, renameSync, unlinkSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const argv = process.argv.slice(2);

/* ------------------------------------------------------------------ helpers */

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', b: '\x1b[1m', g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', off: '\x1b[0m' }
  : { dim: '', b: '', g: '', y: '', r: '', c: '', off: '' };

const say = (...parts) => console.log(...parts);
const fail = (message, code = 1) => { console.error(`${C.r}✗${C.off} ${message}`); process.exit(code); };

function have(command) {
  const probe = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return probe.status === 0;
}

function flag(name, { value = null } = {}) {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return value === null ? false : null;
  if (value === null) return true;
  return argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : value;
}

function humanSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes; let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function mediaKind(url) {
  const clean = url.split('?')[0].toLowerCase();
  if (/\.(mp4|webm|mkv|mov|m4v|avi)$/.test(clean)) return 'video';
  if (/\.(mp3|m4a|opus|flac|wav|ogg|aac)$/.test(clean)) return 'audio';
  if (/\.(jpe?g|png|webp|gif|avif|bmp|svg)$/.test(clean)) return 'image';
  return null;
}

const PLATFORM_HOSTS = ['youtube.com', 'youtu.be', 'instagram.com', 'tiktok.com', 'facebook.com', 'fb.watch', 'twitter.com', 'x.com', 'reddit.com', 'vimeo.com', 'twitch.tv', 'dailymotion.com', 'soundcloud.com', 'pinterest.com', 'linkedin.com', 'threads.net', 'snapchat.com'];

function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }
function isPlatform(url) {
  const host = hostOf(url);
  return PLATFORM_HOSTS.some((h) => host === h || host.endsWith('.' + h));
}

/* ------------------------------------------------------------------- doctor */

function doctor() {
  say(`${C.b}OmniBox helper — environment${C.off}\n`);
  const rows = [
    ['node', process.version, true],
    ['yt-dlp', have('yt-dlp') ? 'found' : 'MISSING — needed for YouTube/Instagram/…', have('yt-dlp')],
    ['ffmpeg', have('ffmpeg') ? 'found' : 'MISSING — needed to merge video+audio and convert to MP3', have('ffmpeg')],
    ['deno', have('deno') ? 'found' : 'missing — YouTube now needs a JS runtime for yt-dlp', have('deno')],
    ['libreoffice', have('soffice') || have('libreoffice') ? 'found' : 'missing — exact Word/PDF conversion unavailable', have('soffice') || have('libreoffice')],
  ];
  for (const [name, status, ok] of rows) {
    say(`  ${ok ? C.g + '✓' : C.y + '·'}${C.off} ${name.padEnd(12)} ${status}`);
  }
  say(`\n${C.dim}Install missing pieces:${C.off}`);
  say(`  Android/Termux : pkg install python ffmpeg && pip install -U yt-dlp && pkg install deno`);
  say(`  Windows        : winget install yt-dlp.yt-dlp Gyan.FFmpeg DenoLand.Deno`);
  say(`  macOS          : brew install yt-dlp ffmpeg deno`);
  say(`  Linux          : your package manager, or pip install -U yt-dlp`);
  if (!have('yt-dlp')) say(`\n${C.y}Platform downloads will not work until yt-dlp is on PATH.${C.off}`);
  if (!have('deno')) say(`${C.y}YouTube specifically needs deno, or you will see 403 errors and low-quality formats.${C.off}`);
}

/* ------------------------------------------------------- yt-dlp command line */

/** Same shape as the app's builder, kept standalone so this file has no imports. */
function ytdlpArgs(spec = {}) {
  const {
    url, mode = 'video', quality = 'best', container = 'mp4', audioFormat = 'mp3', audioBitrate = 'best',
    playlist = false, subtitles = false, subtitleLangs = 'en', embedThumbnail = true, embedMetadata = true,
    sponsorblock = false, cookiesFromBrowser = 'none', outDir = '', filename = '%(title)s.%(ext)s',
    limitRate = '', archive = false,
  } = spec;
  const args = [];
  if (mode === 'audio') {
    args.push('-x', '--audio-format', audioFormat, '--audio-quality', audioBitrate === 'best' ? '0' : `${audioBitrate}K`);
  } else if (quality === 'best') args.push('-f', 'bv*+ba/b');
  else if (quality === 'worst') args.push('-f', 'wv*+wa/w');
  else args.push('-f', `bv*[height<=${quality}]+ba/b[height<=${quality}]/b`);
  if (mode === 'video' && container && container !== 'auto') {
    args.push('--merge-output-format', container);
    if (container === 'mp4') args.push('-S', 'vcodec:h264,res,acodec:aac');
  }
  if (!playlist) args.push('--no-playlist');
  if (subtitles && mode === 'video') args.push('--write-subs', '--sub-langs', subtitleLangs || 'en', '--embed-subs');
  if (embedThumbnail) args.push('--embed-thumbnail');
  if (embedMetadata) args.push('--embed-metadata');
  if (sponsorblock && mode === 'video') args.push('--sponsorblock-remove', 'sponsor,selfpromo');
  if (cookiesFromBrowser && cookiesFromBrowser !== 'none') args.push('--cookies-from-browser', cookiesFromBrowser);
  if (limitRate) args.push('--limit-rate', limitRate);
  if (archive) args.push('--download-archive', 'omnibox-archive.txt');
  args.push('--newline', '--no-color', '-o', outDir ? `${outDir.replace(/[\\/]+$/, '')}/${filename}` : filename);
  if (url) args.push(url);
  return args;
}

function runYtDlp(spec) {
  if (!have('yt-dlp')) {
    fail('yt-dlp is not installed. Run `node fetch.mjs doctor` for install commands.');
  }
  if (spec.url && isPlatform(spec.url) && /youtube|youtu\.be/.test(spec.url) && !have('deno')) {
    say(`${C.y}!${C.off} deno is missing: YouTube will likely fail or give you only low-quality formats.`);
    say(`${C.dim}  Install it (see "node fetch.mjs doctor") — continuing anyway.${C.off}\n`);
  }
  const args = ytdlpArgs(spec);
  say(`${C.dim}$ yt-dlp ${args.join(' ')}${C.off}\n`);
  const child = spawn('yt-dlp', args, { stdio: 'inherit' });
  child.on('exit', (code) => {
    if (code === 0) say(`\n${C.g}✓ done${C.off}`);
    else {
      say(`\n${C.r}✗ yt-dlp exited with code ${code}${C.off}`);
      say(`${C.dim}Common causes: 403 → install deno (YouTube); "sign in" → use --cookies-from-browser; unavailable → the video is region- or account-locked.${C.off}`);
    }
    process.exit(code === 0 ? 0 : 1);
  });
}

/* --------------------------------------------------------- direct downloads */

async function directDownload(url, { outDir = '.', filename = null } = {}) {
  let target = filename || decodeURIComponent((new URL(url).pathname.split('/').pop()) || 'download');
  const partial = join(outDir, `${target}.part`);
  const final = join(outDir, target);
  let startAt = 0;
  if (existsSync(partial)) startAt = statSync(partial).size;
  else if (existsSync(final)) { say(`${C.y}!${C.off} ${target} already exists — resuming into a .part copy`); }

  const headers = startAt ? { Range: `bytes=${startAt}-` } : {};
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok && res.status !== 206) fail(`Server said HTTP ${res.status} for ${url}`);
  if (startAt && res.status !== 206) { say(`${C.y}!${C.off} server ignored the resume request — starting over`); startAt = 0; if (existsSync(partial)) unlinkSync(partial); }

  const total = Number(res.headers.get('content-length') || 0) + startAt;
  const type = res.headers.get('content-type') || 'application/octet-stream';
  const disposition = res.headers.get('content-disposition') || '';
  const fromHeader = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition)?.[1];

  if (!filename && fromHeader) {
    target = decodeURIComponent(fromHeader);
  }
  const outPath = join(outDir, target);
  const partPath = `${outPath}.part`;

  say(`${C.dim}${type}${total ? ` · ${humanSize(total)}` : ''} → ${outPath}${C.off}`);
  const stream = createWriteStream(partPath, { flags: startAt ? 'a' : 'w' });
  let received = startAt;
  let last = Date.now();

  await new Promise((resolvePromise, reject) => {
    const body = res.body;
    body.on('data', (chunk) => {
      received += chunk.length;
      const now = Date.now();
      if (now - last > 200) {
        last = now;
        const pct = total ? `${((received / total) * 100).toFixed(1)}%` : '?';
        process.stderr.write(`\r  ${pct}  ${humanSize(received)}${total ? ` / ${humanSize(total)}` : ''}   `);
      }
      if (!stream.write(chunk)) body.pause();
    });
    stream.on('drain', () => body.resume());
    body.on('end', () => stream.end());
    stream.on('finish', resolvePromise);
    body.on('error', reject);
    stream.on('error', reject);
  });

  if (total && received !== total) {
    say(`\n${C.y}!${C.off} got ${humanSize(received)} of ${humanSize(total)} — run the same command again to resume`);
    process.exitCode = 2;
    return;
  }
  renameSync(partPath, outPath);
  process.stderr.write('\r'.padEnd(60) + '\r');
  say(`${C.g}✓${C.off} saved ${outPath} (${humanSize(received)})`);
}

/* ------------------------------------------------------------ key checking */

const KEY_CHECKS = {
  openai: { name: 'OpenAI', url: 'https://api.openai.com/v1/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  anthropic: { name: 'Anthropic', url: 'https://api.anthropic.com/v1/models', headers: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }) },
  google: { name: 'Google Gemini', url: (k) => `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(k)}`, headers: () => ({}) },
  openrouter: { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1/key', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  groq: { name: 'Groq', url: 'https://api.groq.com/openai/v1/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  mistral: { name: 'Mistral', url: 'https://api.mistral.ai/v1/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  deepseek: { name: 'DeepSeek', url: 'https://api.deepseek.com/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  huggingface: { name: 'Hugging Face', url: 'https://huggingface.co/api/whoami-v2', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  github: { name: 'GitHub', url: 'https://api.github.com/user', headers: (k) => ({ Authorization: `Bearer ${k}`, Accept: 'application/vnd.github+json' }) },
};

async function checkKeyProvider(provider, key) {
  const spec = KEY_CHECKS[provider];
  if (!spec) fail(`Unknown provider "${provider}". Known: ${Object.keys(KEY_CHECKS).join(', ')}`);
  const url = typeof spec.url === 'function' ? spec.url(key) : spec.url;
  const started = Date.now();
  try {
    const res = await fetch(url, { headers: spec.headers(key) });
    const ms = Date.now() - started;
    const verdict = res.ok ? `${C.g}valid${C.off}`
      : res.status === 429 ? `${C.y}valid but rate-limited${C.off}`
      : res.status === 401 ? `${C.r}invalid / revoked${C.off}`
      : res.status === 403 ? `${C.y}key works, insufficient permission${C.off}`
      : res.status === 402 ? `${C.y}key works, no credit${C.off}`
      : `${C.r}HTTP ${res.status}${C.off}`;
    say(`${C.b}${spec.name}${C.off}: ${verdict}  ${C.dim}(HTTP ${res.status} in ${ms} ms)${C.off}`);

    if (provider === 'github' && res.ok) {
      const expiry = res.headers.get('github-authentication-token-expiration');
      const scopes = res.headers.get('x-oauth-scopes');
      const remaining = res.headers.get('x-ratelimit-remaining');
      const limit = res.headers.get('x-ratelimit-limit');
      const body = await res.json().catch(() => ({}));
      say(`  user: ${body.login || '?'}${expiry ? ` · expires ${expiry}` : ' · no expiry'}${scopes ? ` · scopes: ${scopes}` : ''}`);
      if (limit) say(`  API calls left this hour: ${remaining}/${limit}`);
    } else if (provider === 'openrouter' && res.ok) {
      const body = await res.json().catch(() => ({ data: {} }));
      const data = body.data || {};
      say(`  label: ${data.label || '?'} · spend: $${Number(data.usage || 0).toFixed(2)}${data.limit !== null && data.limit !== undefined ? ` of $${Number(data.limit).toFixed(2)}` : ' (no limit)'}`);
    } else if (res.ok) {
      const body = await res.json().catch(() => null);
      const count = body?.data?.length ?? body?.models?.length ?? null;
      if (count !== null) say(`  ${count} models visible to this key`);
    }
    return res.ok;
  } catch (err) {
    fail(`Could not reach the provider: ${err.message}`);
  }
}

/* ------------------------------------------------------------ libreoffice */

function convertWithLibreOffice(input, output) {
  if (!input || !output) fail('Usage: node fetch.mjs convert <input> <output.docx|pdf|...>');
  const soffice = have('soffice') ? 'soffice' : have('libreoffice') ? 'libreoffice' : null;
  if (!soffice) {
    fail('LibreOffice is not installed, so exact conversion is unavailable.\n'
      + '  Ubuntu/Debian: sudo apt install libreoffice\n'
      + '  macOS: brew install --cask libreoffice\n'
      + '  Windows: winget install TheDocumentFoundation.LibreOffice\n'
      + 'The browser converter in OmniBox handles the common cases without it.');
  }
  const outDir = resolve(output, '..');
  say(`${C.dim}$ ${soffice} --headless --convert-to ${output.split('.').pop()} --outdir ${outDir} ${input}${C.off}`);
  const result = spawnSync(soffice, ['--headless', '--convert-to', output.split('.').pop(), '--outdir', outDir, resolve(input)], { stdio: 'inherit' });
  if (result.status !== 0) fail('LibreOffice reported a failure.');
  say(`${C.g}✓${C.off} wrote into ${outDir}`);
}

/* -------------------------------------------------------------------- main */

async function main() {
  const command = argv[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    say(`${C.b}OmniBox helper${C.off}

  node fetch.mjs doctor                                  check what is installed
  node fetch.mjs get <link> [options]                    download (yt-dlp or direct)
  node fetch.mjs key <provider> --key <key>              check a key from the CLI
  node fetch.mjs convert <in> <out>                      exact conversion via LibreOffice
  node fetch.mjs --json <spec.json>                      run a spec copied from OmniBox

${C.b}get options${C.off}
  --audio                 audio only        --audio-format mp3|m4a|opus|flac|wav
  --quality 2160|1440|1080|720|480|360   max height
  --container mp4|mkv|webm               container to merge into
  --bitrate 192           audio bitrate     --playlist      whole playlist
  --subs en               embed subtitles   --cookies firefox (sign in for private posts)
  --sponsorblock          cut sponsor parts --limit-rate 5M
  --out-dir ./downloads   where to save     --name "%(title)s.%(ext)s"

${C.dim}Everything runs locally. No accounts, no telemetry, no server.${C.off}`);
    return;
  }

  if (command === 'doctor') return doctor();

  if (command === '--json') {
    const path = argv[1] || fail('Usage: node fetch.mjs --json spec.json');
    const spec = JSON.parse(readFileSync(path, 'utf8'));
    if (spec.provider) return checkKeyProvider(spec.provider, spec.key || fail('The spec needs a "key" field'));
    if (!spec.url) fail('The spec needs a "url" field');
    if (isPlatform(spec.url)) return runYtDlp(spec);
    return directDownload(spec.url, { outDir: spec.outDir || '.', filename: spec.filename || null });
  }

  if (command === 'key') {
    const provider = argv[1] || fail('Usage: node fetch.mjs key <provider> --key <key>');
    const key = flag('key', { value: '' });
    if (!key) fail('Pass the key with --key <key> (or put it in a spec file with --json)');
    return checkKeyProvider(provider, key);
  }

  if (command === 'convert') return convertWithLibreOffice(argv[1], argv[2]);

  if (command === 'get') {
    const url = argv[1] || fail('Usage: node fetch.mjs get <link> [options]');
    if (!/^https?:\/\//i.test(url)) fail('That does not look like a link');
    if (isPlatform(url)) {
      return runYtDlp({
        url,
        mode: flag('audio') ? 'audio' : 'video',
        quality: flag('quality', { value: 'best' }),
        container: flag('container', { value: 'mp4' }),
        audioFormat: flag('audio-format', { value: 'mp3' }),
        audioBitrate: flag('bitrate', { value: 'best' }),
        playlist: flag('playlist'),
        subtitles: !!flag('subs', { value: '' }),
        subtitleLangs: flag('subs', { value: 'en' }),
        cookiesFromBrowser: flag('cookies', { value: 'none' }),
        outDir: flag('out-dir', { value: '' }),
        filename: flag('name', { value: '%(title)s.%(ext)s' }),
        limitRate: flag('limit-rate', { value: '' }),
        sponsorblock: flag('sponsorblock'),
        archive: flag('archive'),
      });
    }
    const kind = mediaKind(url);
    if (!kind) say(`${C.y}!${C.off} Not a recognised platform or obvious file extension — trying a direct download anyway.`);
    return directDownload(url, { outDir: flag('out-dir', { value: '.' }), filename: flag('name', { value: null }) });
  }

  fail(`Unknown command "${command}". Run: node fetch.mjs help`);
}

main().catch((err) => fail(err.stack || String(err)));
