/**
 * Static wiring tests for the parts a headless Node run cannot exercise: the page,
 * the manifest, the service worker and the helper CLI.
 *
 * This is where "it works in the test suite but the button does nothing" gets
 * caught. Every id the controller asks for must exist in the HTML; every file the
 * page, manifest or service worker promises must exist on disk; the helper script
 * must actually run.
 */

import { test, ok, eq, run } from './helpers/harness.mjs';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const exists = (p) => existsSync(join(ROOT, p));

const appJs = read('app/ui/app.js');
const page = read('index.html');
const sw = read('sw.js');
const manifest = JSON.parse(read('manifest.webmanifest'));

const uniq = (list) => [...new Set(list)];

/* ------------------------------------------------------- imports and DOM ids */

test('every module the UI imports exports what the UI imports', async () => {
  const specifiers = uniq([...appJs.matchAll(/^import\s+(?:([\w*\s{},]+?)\s+from\s+)?['"]([^'"]+)['"]/gm)]
    .map(([, names, from]) => ({ names: names || '', from })));
  ok(specifiers.length >= 4, `the controller imports its modules (${specifiers.length})`);
  for (const { names, from } of specifiers) {
    if (!from.startsWith('.')) continue;
    const target = join(ROOT, 'app/ui', from);
    ok(existsSync(target), `${from} exists`);
    const module = await import(target);
    const cleaned = names.replace(/[{}]/g, ' ').split(',').map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    for (const name of cleaned) {
      ok(name in module, `${from} exports ${name}`);
    }
  }
});

test('every element the controller reaches for exists somewhere', () => {
  const asked = uniq([...appJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  // some elements are built by the controller itself (innerHTML templates), the
  // rest live in the page — either is fine, a typo is not
  const declared = new Set([
    ...[...page.matchAll(/id="([^"]+)"/g)].map((m) => m[1]),
    ...[...appJs.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]),
  ]);
  const missing = asked.filter((id) => !declared.has(id));
  deepEq(missing, [], `nothing creates: ${missing.join(', ')}`);
  ok(asked.length >= 40, `the controller wires up a real interface (${asked.length} elements)`);
});

test('no controller hook in the page is left dangling', () => {
  // hooks with a prefix the controller owns; presentational ids are not our business
  const declared = uniq([...page.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...appJs.matchAll(/['"]([\w-]+)['"]/g)].map((m) => m[1]));
  const hooks = declared.filter((id) => /^(dl|keys|opt|about|file)-|^(drop|toast|memory-chip|paste-btn|clear-btn)$/.test(id));
  const orphans = hooks.filter((id) => !used.has(id));
  deepEq(orphans, [], `the page declares hooks the controller never touches: ${orphans.join(', ')}`);
  ok(hooks.length >= 20, `the page declares ${hooks.length} controller hooks`);
});

/* ------------------------------------------------------------ files on disk */

test('every local file the page references exists', () => {
  const refs = uniq([...page.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]))
    .filter((url) => !/^(https?:|data:|#|mailto:)/.test(url));
  ok(refs.includes('app/ui/app.js'), 'the controller is loaded');
  ok(refs.includes('manifest.webmanifest'), 'the manifest is linked');
  for (const ref of refs) ok(exists(ref.replace(/^\.\//, '')), `${ref} exists`);
});

test('every file the service worker precaches exists', () => {
  const shell = uniq([...sw.matchAll(/'\.\/([^']+)'/g)].map((m) => m[1]));
  ok(shell.length >= 8, `the shell lists ${shell.length} files`);
  for (const file of shell) ok(exists(file), `${file} exists (listed in the service worker shell)`);
});

/* ----------------------------------------------------------------- manifest */

test('the manifest describes a real installable app', () => {
  ok(manifest.name.includes('OmniBox'), 'named');
  ok(manifest.short_name.length <= 12, 'short name fits under an icon');
  eq(manifest.display, 'standalone');
  ok(/^\.\/.*(index\.html)?$/.test(manifest.start_url), `start_url is relative: ${manifest.start_url}`);
  ok(/^#/.test(manifest.theme_color), 'theme colour set');
  eq(manifest.theme_color, '#0b0f14', 'theme matches the page background');
  ok(manifest.background_color, 'background colour set');
});

test('the manifest icons exist at the sizes it claims, including a maskable one', () => {
  const sizes = manifest.icons.map((icon) => icon.sizes);
  ok(sizes.includes('192x192'), '192 for Android');
  ok(sizes.includes('512x512'), '512 for the store and splash');
  ok(manifest.icons.some((icon) => icon.purpose === 'maskable'), 'a maskable icon, or Android crops it badly');
  for (const icon of manifest.icons) {
    ok(exists(icon.src), `${icon.src} exists`);
    ok(/^image\/png$/.test(icon.type), `${icon.src} is a PNG`);
    const [w, h] = icon.sizes.split('x').map(Number);
    const header = readFileSync(join(ROOT, icon.src));
    deepEq([header.readUInt32BE(16), header.readUInt32BE(20)], [w, h], `${icon.src} is really ${icon.sizes}`);
  }
});

/* ---------------------------------------------------------------- indexing */

test('the page is honest about what it cannot do', () => {
  const text = page.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  ok(/nothing leaves this device|no upload|never uploaded|stay on your device/i.test(text), 'says files are not uploaded');
  ok(/re-render|pixel-perfect/i.test(text), 'says what a rebuilt document really is');
  ok(/cannot download YouTube|YouTube[\s\S]{0,80}cannot|yt-dlp/i.test(text), 'the downloader explains the YouTube reality');
  ok(/Deno/.test(text), 'including the 2026 runtime requirement');
  ok(/devtools|localStorage/i.test(text), 'the key checker explains where keys go');
  ok(/not a pixel-perfect|re-render|layout may move|not a pixel/i.test(text), 'conversion quality is stated honestly');
  ok(/right to download|your own uploads|respect/i.test(text), 'the legal note is present');
});

test('the theme is the orange / white / black one, not a default', () => {
  ok(/#ff6a00|#ff6|--orange/i.test(page), 'orange accent');
  ok(/#0b0f14/i.test(page), 'near-black background');
  ok(/prefers-color-scheme|--ink|#fff|white/i.test(page), 'light text');
  ok(/@media[^{]*max-width/i.test(page), 'it has a mobile layout');
});

/* ------------------------------------------------------------------ helper */

test('the helper script runs and explains itself', () => {
  ok(exists('tools/fetch.mjs'), 'tools/fetch.mjs exists');
  const out = execFileSync(process.execPath, [join(ROOT, 'tools/fetch.mjs'), '--help'], { encoding: 'utf8', timeout: 20000 });
  for (const command of ['doctor', 'get', 'key', 'convert']) ok(out.includes(command), `--help documents "${command}"`);
  for (const flag of ['--audio', '--quality', '--audio-format', '--playlist', '--cookies']) ok(out.includes(flag), `--help documents ${flag}`);
  ok(/yt-dlp|YouTube/i.test(out), 'and says what it does about platform links');
});

test('the helper and the browser agree on the option menus', () => {
  // the helper is standalone on purpose (it runs on a machine without the app),
  // but the two must not drift apart on what they accept
  const helper = read('tools/fetch.mjs');
  const html = page;
  for (const format of ['mp3', 'm4a', 'opus', 'flac', 'wav']) {
    ok(helper.includes(format), `helper knows ${format}`);
    ok(html.includes(`value="${format}"`), `page offers ${format}`);
  }
  for (const height of ['2160', '1440', '1080', '720', '480', '360']) {
    ok(helper.includes(height), `helper knows ${height}p`);
    ok(html.includes(`value="${height}"`), `page offers ${height}p`);
  }
  for (const flag of ['--sponsorblock', '--subs', '--limit-rate']) {
    ok(helper.includes(flag), `helper documents ${flag}`);
  }
});

test('the service worker never caches the providers', () => {
  ok(/request\.method\s*!==\s*'GET'|method !== "GET"/.test(sw), 'only GET is intercepted');
  ok(/origin\s*!==\s*(self\.)?location\.origin|url\.origin !== location\.origin/.test(sw), 'cross-origin is left alone');
  ok(/\.catch\(|catch\s*\(/.test(sw), 'a failed fetch falls back to the network, not a blank page');
  ok(/caches\.delete|skipWaiting|clients\.claim/.test(sw), 'the worker can update itself');
  for (const host of ['api.github.com', 'api.anthropic.com', 'generativelanguage', 'openrouter', 'groq', 'mistral', 'deepseek', 'huggingface', 'api.openai.com']) {
    ok(!new RegExp(`caches?\\.\\w+\\('${host}`).test(sw), `${host} is not cached`);
  }
});

function deepEq(actual, expected, message) {
  const same = actual.length === expected.length && actual.every((v, i) => v === expected[i]);
  ok(same, `${message} — got [${actual.join(', ')}]`);
}

await run('wiring');
