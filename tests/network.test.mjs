/**
 * The downloader's command builder and the API-key checker.
 *
 * Nothing in here touches the network. The yt-dlp argv is asserted exactly — it
 * is the product of the Download tab, so a silent regression there ships a wrong
 * command to every user. The key checks run against a fetch double, including a
 * guard test that no provider check ever uses a billable endpoint.
 */

import { test, ok, eq, deep, rejects, run, mockFetch } from './helpers/harness.mjs';
import {
  PLATFORMS, VIDEO_QUALITIES, AUDIO_FORMATS, CONTAINERS, DOWNLOAD_PRESETS, DOWNLOADER_NOTES,
  classifyUrl, hostOf, buildArgs, buildCommand, buildPowerShellCommand, quoteArg,
  platformAdvice, probeDirectUrl, canSaveInBrowser,
} from '../app/core/ytdlp.js';
import { PROVIDERS, providerById, checkKey, checkAll, KEY_SECURITY_NOTE } from '../app/core/keys.js';

/* ------------------------------------------------------------ link handling */

test('links are classified by platform first, then by file type', () => {
  eq(classifyUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ').kind, 'platform');
  eq(classifyUrl('https://youtu.be/dQw4w9WgXcQ').platform.id, 'youtube');
  eq(classifyUrl('https://m.youtube.com/watch?v=x').platform.id, 'youtube');
  eq(classifyUrl('https://www.instagram.com/reel/Cabc123/').platform.id, 'instagram');
  eq(classifyUrl('https://vm.tiktok.com/abc/').platform.id, 'tiktok');
  eq(classifyUrl('https://redd.it/abc').platform.id, 'reddit');
  eq(classifyUrl('https://cdn.example.com/clip.mp4').kind, 'direct-media');
  eq(classifyUrl('https://cdn.example.com/clip.mp4').ext, 'mp4');
  eq(classifyUrl('https://cdn.example.com/song.opus').kind, 'direct-media');
  eq(classifyUrl('https://images.example.com/hero.JPG').kind, 'direct-image');
  eq(classifyUrl('https://images.example.com/hero.JPG').ext, 'jpg', 'extensions are case-folded');
  eq(classifyUrl('https://files.example.com/report.pdf').kind, 'direct-file');
  eq(classifyUrl('https://example.com/some/page').kind, 'unknown-page');
  eq(classifyUrl('ftp://example.com/x.mp4').kind, 'invalid');
  eq(classifyUrl('').kind, 'invalid');
});

test('a look-alike host is not mistaken for a platform', () => {
  eq(classifyUrl('https://notyoutube.com/watch?v=1').kind, 'unknown-page');
  eq(classifyUrl('https://youtube.com.evil.example/watch?v=1').kind, 'unknown-page');
  eq(classifyUrl('https://evil-instagram.com/p/x/').kind, 'unknown-page');
  eq(hostOf('https://WWW.YouTube.com/watch'), 'youtube.com');
});

/* --------------------------------------------------------- the yt-dlp argv */

test('the canonical 1080p MP4 command is exactly right', () => {
  const args = buildArgs({ url: 'https://youtu.be/abc', quality: '1080', container: 'mp4' });
  deep(args, [
    '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b',
    '--merge-output-format', 'mp4',
    '-S', 'vcodec:h264,res,acodec:aac',
    '--no-playlist',
    '--embed-thumbnail',
    '--embed-metadata',
    '--newline', '--no-color',
    '-o', '%(title)s.%(ext)s',
    'https://youtu.be/abc',
  ]);
});

test('audio-only mode asks for audio only', () => {
  const args = buildArgs({ url: 'https://x/y', mode: 'audio', audioFormat: 'mp3', audioBitrate: '192' });
  ok(args.includes('-x'), 'extract audio');
  eq(args[args.indexOf('--audio-format') + 1], 'mp3');
  eq(args[args.indexOf('--audio-quality') + 1], '192K');
  ok(!args.includes('-f'), 'no video format selection');
  ok(!args.includes('--merge-output-format'), 'no container merging');
  ok(args.includes('--embed-thumbnail'), 'cover art by default');
  eq(args[args.length - 1], 'https://x/y');
});

test('"best" audio quality maps to yt-dlp\'s 0, and bad values fall back safely', () => {
  const best = buildArgs({ url: 'u', mode: 'audio', audioBitrate: 'best' });
  eq(best[best.indexOf('--audio-quality') + 1], '0');
  const odd = buildArgs({ url: 'u', mode: 'audio', audioFormat: 'ogg-vorbis', audioBitrate: '999' });
  eq(odd[odd.indexOf('--audio-format') + 1], 'mp3', 'unknown format falls back to mp3');
  eq(odd[odd.indexOf('--audio-quality') + 1], '999K');
});

test('quality presets map to real format selectors', () => {
  eq(buildArgs({ url: 'u', quality: 'best' })[1], 'bv*+ba/b');
  eq(buildArgs({ url: 'u', quality: 'worst' })[1], 'wv*+wa/w');
  eq(buildArgs({ url: 'u', quality: '2160' })[1], 'bv*[height<=2160]+ba/b[height<=2160]/b');
  eq(buildArgs({ url: 'u', quality: '1080p' })[1], 'bv*[height<=1080]+ba/b[height<=1080]/b', 'a stray suffix does not break it');
  for (const quality of VIDEO_QUALITIES) {
    const args = buildArgs({ url: 'u', quality: quality.id });
    ok(args.includes('-f'), `${quality.id} produces a format selector`);
  }
  for (const container of CONTAINERS) {
    const args = buildArgs({ url: 'u', container });
    if (container === 'auto') ok(!args.includes('--merge-output-format'), 'auto means let yt-dlp choose');
    else eq(args[args.indexOf('--merge-output-format') + 1], container);
  }
});

test('subtitles, cookies, sponsorblock and rate limits are opt-in', () => {
  const plain = buildArgs({ url: 'u' });
  for (const flag of ['--write-subs', '--sub-langs', '--cookies-from-browser', '--sponsorblock-remove', '--limit-rate', '--download-archive']) {
    ok(!plain.includes(flag), `${flag} is not added unless asked for`);
  }
  const video = buildArgs({ url: 'u', subtitles: true, subtitleLangs: 'en,es', sponsorblock: true, cookiesFromBrowser: 'firefox', limitRate: '500K', archive: true, playlist: true });
  eq(video[video.indexOf('--sub-langs') + 1], 'en,es');
  ok(video.includes('--embed-subs'), 'subtitles are embedded, not left beside the video');
  eq(video[video.indexOf('--cookies-from-browser') + 1], 'firefox');
  eq(video[video.indexOf('--sponsorblock-remove') + 1], 'sponsor,selfpromo');
  eq(video[video.indexOf('--limit-rate') + 1], '500K');
  eq(video[video.indexOf('--download-archive') + 1], 'omnibox-archive.txt');
  ok(!video.includes('--no-playlist'), 'an explicit playlist request is respected');
});

test('subtitles and sponsorblock are ignored in audio mode', () => {
  const args = buildArgs({ url: 'u', mode: 'audio', subtitles: true, sponsorblock: true });
  ok(!args.includes('--write-subs'), 'no subtitle files for an audio rip');
  ok(!args.includes('--sponsorblock-remove'), 'no video segments to cut');
});

test('output paths and extra args are passed through cleanly', () => {
  const args = buildArgs({ url: 'u', outDir: '/home/me/videos/', filename: '%(uploader)s - %(title)s.%(ext)s' });
  eq(args[args.indexOf('-o') + 1], '/home/me/videos/%(uploader)s - %(title)s.%(ext)s');
  const windows = buildArgs({ url: 'u', outDir: 'D:\\Media\\' });
  eq(windows[windows.indexOf('-o') + 1], 'D:\\Media/%(title)s.%(ext)s');
  const extras = buildArgs({ url: 'u', extraArgs: ['--cookies', 'cookies.txt'] });
  ok(extras.includes('--cookies') && extras.includes('cookies.txt'));
  const single = buildArgs({ url: 'u', extraArgs: '--geo-bypass' });
  ok(single.includes('--geo-bypass'));
  eq(buildArgs({ url: 'u' })[buildArgs({ url: 'u' }).length - 1], 'u', 'the URL is always last');
});

/* --------------------------------------------------------------- the string */

test('shell quoting survives filenames that would otherwise run commands', () => {
  eq(quoteArg('simple'), 'simple');
  eq(quoteArg(''), "''");
  eq(quoteArg('has space'), "'has space'");
  eq(quoteArg("it's"), "'it'\\''s'");
  const spec = { url: 'https://x/y', filename: 'a b; rm -rf ~.mp4', outDir: '/tmp/my videos' };
  const command = buildCommand(spec);
  // output directory and filename are one -o argument, so both live inside one pair of quotes
  ok(command.includes("'/tmp/my videos/a b; rm -rf ~.mp4'"), 'the dangerous name is inside quotes: ' + command);
  ok(command.startsWith('yt-dlp '), 'the command is runnable as-is');
  ok(!command.includes('`'), 'no command substitution');
  const noDir = buildCommand({ url: 'https://x/y', filename: 'a b; rm -rf ~.mp4' });
  ok(noDir.includes("'a b; rm -rf ~.mp4'"), 'quoted with or without an output directory');
  const dollars = buildCommand({ url: 'https://x/y', filename: '$(whoami).mp4' });
  ok(dollars.includes("'$(whoami).mp4'"), 'command substitution cannot fire');
});

test('the PowerShell variant quotes the Windows way', () => {
  const command = buildPowerShellCommand({ url: 'https://x/y', filename: 'my video.%(ext)s' });
  ok(command.includes('"my video.%(ext)s"'), 'double quotes: ' + command);
  ok(!command.includes("'\\''"), 'no POSIX escaping survives');
});

test('every preset produces a runnable command', () => {
  for (const preset of DOWNLOAD_PRESETS) {
    const url = 'https://example.com/videos/1';
    const command = buildCommand({ url, ...preset.spec });
    ok(command.startsWith('yt-dlp '), `${preset.id} starts with yt-dlp`);
    ok(command.endsWith(url), `${preset.id} ends with the URL`);
    const argv = buildArgs({ url, ...preset.spec });
    eq(argv[argv.length - 1], url, `${preset.id} passes the URL as one argument`);
    if (preset.spec.mode === 'audio') ok(command.includes('-x'), `${preset.id} extracts audio`);
    else ok(command.includes('-f'), `${preset.id} selects a format`);
  }
  ok(DOWNLOAD_PRESETS.some((p) => p.id === 'video-1080' && p.spec.quality === '1080'), 'the 1080p preset exists');
  ok(DOWNLOAD_PRESETS.some((p) => p.spec.mode === 'audio' && p.spec.audioFormat === 'mp3'), 'an MP3 preset exists');
});

/* ------------------------------------------------------------------ honesty */

test('the notes tell the truth about what a browser cannot do', () => {
  for (const key of ['browserCannot', 'publicInstances', 'youtube2026', 'legal', 'helper']) {
    ok(typeof DOWNLOADER_NOTES[key] === 'string' && DOWNLOADER_NOTES[key].length > 60, `${key} is written out`);
  }
  ok(/cannot fetch YouTube/.test(DOWNLOADER_NOTES.browserCannot), 'the core limitation is stated plainly');
  ok(/Deno/.test(DOWNLOADER_NOTES.youtube2026), 'the 2026 Deno requirement is stated');
  ok(/your own uploads|right to download/.test(DOWNLOADER_NOTES.legal), 'the legal note points at rights, not just risk');
  ok(/YOUR machine/.test(DOWNLOADER_NOTES.helper), 'the helper is described as local');
});

test('platform advice is specific per platform', () => {
  const youtube = platformAdvice(classifyUrl('https://youtu.be/x'));
  eq(youtube.platform, 'YouTube');
  ok(youtube.lines.some((l) => /Deno/.test(l)), 'YouTube gets the JS-runtime warning');
  ok(youtube.lines.some((l) => /cookies/i.test(l)), 'and the cookies hint');
  const instagram = platformAdvice(classifyUrl('https://instagram.com/reel/x/'));
  ok(instagram.lines.some((l) => /almost always/.test(l)), 'Instagram gets the honest cookies warning');
  const reddit = platformAdvice(classifyUrl('https://redd.it/x'));
  ok(reddit.lines.some((l) => /usually work/.test(l)), 'platforms without caveats say so');
  eq(platformAdvice({ kind: 'direct-media' }), null, 'direct links get no platform lecture');
});

/* ------------------------------------------------------- direct-URL probing */

const headersOf = (map) => ({ get: (name) => map[String(name).toLowerCase()] ?? null });

test('a CORS-friendly direct file is recognised as saveable', async () => {
  const probe = await probeDirectUrl('https://cdn.example.com/clip.mp4', {
    fetchImpl: async () => ({ ok: true, status: 200, url: 'https://cdn.example.com/clip.mp4', headers: headersOf({ 'content-type': 'video/mp4', 'content-length': '1048576', 'content-disposition': 'attachment; filename="holiday clip.mp4"' }) }),
  });
  ok(probe.readable && probe.ok, 'readable');
  eq(probe.kind, 'video');
  eq(probe.size, 1048576);
  eq(probe.filename, 'holiday clip.mp4');
  ok(canSaveInBrowser(probe), 'the browser can save this one');
});

test('a server that refuses HEAD is retried with a ranged GET', async () => {
  const seen = [];
  const probe = await probeDirectUrl('https://picky.example.com/x.mp3', {
    fetchImpl: async (url, init) => {
      seen.push(init.method);
      if (init.method === 'HEAD') throw new TypeError('HEAD not allowed');
      return { ok: true, status: 206, url, headers: headersOf({ 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-0/9000000' }) };
    },
  });
  deep(seen, ['HEAD', 'GET']);
  eq(probe.status, 206);
  ok(probe.ok, '206 is a success');
  eq(probe.kind, 'audio');
});

test('a UTF-8 content-disposition filename is decoded', async () => {
  const probe = await probeDirectUrl('https://cdn.example.com/x', {
    fetchImpl: async (url) => ({ ok: true, status: 200, url, headers: headersOf({ 'content-type': 'image/jpeg', 'content-disposition': "attachment; filename*=UTF-8''caf%C3%A9%20photo.jpg" }) }),
  });
  eq(probe.filename, 'café photo.jpg');
  eq(probe.kind, 'image');
});

test('a blocked URL is reported as blocked, with the workaround', async () => {
  const probe = await probeDirectUrl('https://closed.example.com/x.mp4', {
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
  });
  ok(!probe.ok && !probe.readable);
  eq(probe.reason, 'blocked');
  ok(/CORS/.test(probe.message), 'names CORS: ' + probe.message);
  ok(/new tab/.test(probe.message), 'and offers the honest fallback: ' + probe.message);
  ok(!canSaveInBrowser(probe));
});

test('a hang is cut off by the timeout, not by the user', async () => {
  const probe = await probeDirectUrl('https://slow.example.com/x.mp4', {
    timeoutMs: 25,
    fetchImpl: (url, init) => new Promise((_, reject) => {
      if (init.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  eq(probe.reason, 'timeout');
  ok(/did not answer in time/.test(probe.message));
});

test('an HTML page is not mistaken for a media file', async () => {
  const probe = await probeDirectUrl('https://example.com/watch', {
    fetchImpl: async (url) => ({ ok: true, status: 200, url, headers: headersOf({ 'content-type': 'text/html; charset=utf-8' }) }),
  });
  eq(probe.kind, 'file', 'no false video claim');
  ok(probe.ok, 'still readable — it is a file you can save');
});

/* --------------------------------------------------------------- key registry */

test('every registered provider is honest about its browser support', () => {
  const ids = PROVIDERS.map((p) => p.id);
  for (const expected of ['github', 'anthropic', 'google', 'openrouter', 'groq', 'mistral', 'deepseek', 'huggingface', 'openai']) {
    ok(ids.includes(expected), `${expected} is registered`);
  }
  for (const provider of PROVIDERS) {
    ok(typeof provider.check === 'function', `${provider.id} can be checked`);
    ok(provider.name && provider.kind && provider.prefixHint && provider.tokenUrl, `${provider.id} explains itself`);
    ok(provider.tokenUrl.startsWith('https://'), `${provider.id} links to https`);
    ok(provider.cors && provider.cors.ok === true, `${provider.id} is probe-verified as browser-reachable`);
    ok(/^(GET|POST) \//.test(provider.cheapestCall), `${provider.id} names its cheapest call`);
  }
  const anthropic = providerById('anthropic');
  eq(anthropic.cors.needs, 'anthropic-dangerous-direct-browser-access: true',
    'Anthropic is flagged as needing the direct-browser header it really does need');
  ok(!PROVIDERS.filter((p) => p.id !== 'anthropic').some((p) => p.cors.needs), 'no other provider needs a special header');
  eq(providerById('nope'), null);
});

test('no key check ever calls a billable endpoint', async () => {
  const calls = [];
  const body = { data: [], models: [], login: 'me', name: 'Me' };
  for (const provider of PROVIDERS) {
    await provider.check('sk-test-key', {
      fetchImpl: async (url, init = {}) => {
        calls.push({ url: String(url), method: (init.method || 'GET').toUpperCase() });
        return { ok: true, status: 200, url: String(url), headers: headersOf({}), json: async () => body, clone() { return this; } };
      },
    });
  }
  for (const call of calls) {
    eq(call.method, 'GET', `${call.url} must be a read, not a generation`);
    ok(!/completions|generateContent|:generateMessage|\/messages/i.test(call.url), `no billable path used: ${call.url}`);
  }
  ok(calls.length === PROVIDERS.length, 'every provider was exercised');
});

test('Anthropic is called with the exact header set it requires', async () => {
  let seen = null;
  await providerById('anthropic').check('sk-ant-test', {
    fetchImpl: async (url, init) => {
      seen = { url: String(url), headers: init.headers };
      return { ok: true, status: 200, url: String(url), headers: headersOf({}), json: async () => ({ data: [{ id: 'claude-sonnet-4-5' }, { id: 'claude-haiku-4-5' }] }), clone() { return this; } };
    },
  });
  eq(seen.headers['anthropic-version'], '2023-06-01');
  eq(seen.headers['anthropic-dangerous-direct-browser-access'], 'true', 'without this header the browser cannot read the response');
  eq(seen.headers['x-api-key'], 'sk-ant-test');
  ok(seen.url.includes('/v1/models'), 'the free model list, not a message call');
});

test('a valid GitHub token reports identity, scopes and expiry', async () => {
  const expiry = new Date(Date.now() + 30 * 86400000).toISOString();
  const fetchImpl = mockFetch([['https://api.github.com/user', {
    status: 200,
    headers: { 'x-oauth-scopes': 'repo, gist', 'github-authentication-token-expiration': expiry, 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999' },
    body: { login: 'octocat', name: 'The Octocat' },
  }]]);
  const verdict = await checkKey('github', ' github_pat_abc ', { fetchImpl });
  eq(verdict.status, 'valid');
  eq(verdict.message, 'Key is valid');
  eq(verdict.meta.Identity, '@octocat (The Octocat)');
  eq(verdict.meta['Token type'], 'fine-grained');
  eq(verdict.meta['API calls left'], '4999 of 5000 this hour');
  ok(/days left/.test(verdict.meta.Expiry), 'expiry is human-readable: ' + verdict.meta.Expiry);
  eq(verdict.warn, null, 'no warning when there is plenty of time left');
  eq(verdict.provider, 'github');
});

test('a token that expires this week gets a warning', async () => {
  const expiry = new Date(Date.now() + 3 * 86400000).toISOString();
  const verdict = await checkKey('github', 'ghp_x', {
    fetchImpl: mockFetch([['https://api.github.com/user', { status: 200, headers: { 'github-authentication-token-expiration': expiry }, body: { login: 'me' } }]]),
  });
  eq(verdict.status, 'valid');
  ok(/expires in 3 days/.test(verdict.warn), verdict.warn);
  eq(verdict.meta['Token type'], 'classic');
  eq(verdict.meta.Scopes, '(none)', 'a classic token with no scopes says so');
});

test('each HTTP verdict is translated into something actionable', async () => {
  const cases = [
    [401, 'invalid', /wrong, revoked or expired/],
    [429, 'limited', /working key, throttled/],
    [403, 'restricted', /lacks permission/],
    [402, 'billing', /out of credit/],
    [500, 'error', /HTTP 500/],
  ];
  for (const [status, expected, pattern] of cases) {
    const verdict = await checkKey('groq', 'key', {
      fetchImpl: mockFetch([['https://api.groq.com/openai/v1/models', { status, body: { error: { message: 'detail from the provider' } } }]]),
    });
    eq(verdict.status, expected, `HTTP ${status} → ${expected}`);
    ok(pattern.test(verdict.message), `${status}: ${verdict.message}`);
    if (status === 500) ok(/detail from the provider/.test(verdict.message), 'the provider\'s own words are shown');
  }
});

test('an unreachable provider is reported as blocked, not as an invalid key', async () => {
  const blocked = await checkKey('openai', 'sk-x', { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  eq(blocked.status, 'blocked');
  ok(/CORS/.test(blocked.message), blocked.message);
  ok(/helper script/.test(blocked.message), 'points at the way around it');
  const timeout = await checkKey('openai', 'sk-x', { fetchImpl: async () => { throw Object.assign(new Error('stop'), { name: 'AbortError' }); } });
  eq(timeout.status, 'timeout');
});

test('an empty key is not sent anywhere', async () => {
  let called = 0;
  const verdict = await checkKey('github', '   ', { fetchImpl: async () => { called++; return {}; } });
  eq(verdict.status, 'empty');
  eq(called, 0, 'no request was made');
  await rejects(() => checkKey('not-a-provider', 'x'), /Unknown provider/);
});

test('checkAll only asks about the providers that have keys', async () => {
  const asked = [];
  const results = await checkAll({ github: 'a', groq: 'b' }, {
    fetchImpl: async (url) => {
      asked.push(String(url).split('/')[2]);
      return { ok: true, status: 200, url: String(url), headers: headersOf({}), json: async () => ({ login: 'me', data: [] }), clone() { return this; } };
    },
  });
  eq(results.length, 2, 'two providers had keys');
  deep(results.map((r) => r.provider), ['github', 'groq'], 'results come back in registry order');
  deep(asked, ['api.github.com', 'api.groq.com']);
  const withCallback = [];
  await checkAll({ mistral: 'c' }, { onResult: (r) => withCallback.push(r.provider), fetchImpl: async (url) => ({ ok: true, status: 200, url: String(url), headers: headersOf({}), json: async () => ({ data: [] }), clone() { return this; } }) });
  deep(withCallback, ['mistral'], 'the UI callback fires per provider as they finish');
});

test('the security note does not oversell localStorage', () => {
  ok(/localStorage/.test(KEY_SECURITY_NOTE), 'says where keys go');
  ok(/no server/.test(KEY_SECURITY_NOTE), 'says where they do NOT go');
  ok(/devtools/.test(KEY_SECURITY_NOTE), 'and admits the honest risk');
  ok(/least-privilege/.test(KEY_SECURITY_NOTE), 'with advice that actually helps');
});

await run('network');
