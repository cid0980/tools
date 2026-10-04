/**
 * The downloader's honest core.
 *
 * The uncomfortable truth this module is built around: a web page cannot
 * download from YouTube, Instagram, TikTok and friends. Those platforms require
 * a real tool on a real machine — since 2026 YouTube even requires an external
 * JavaScript runtime (Deno) for yt-dlp to complete a download. Public
 * Invidious/Piped instances used to bridge that gap; most have now closed their
 * video endpoints to browsers on purpose.
 *
 * So this module does the part that *is* honest and useful:
 *   • classify the link,
 *   • turn your quality/audio/format choices into the exact yt-dlp command,
 *   • and tell you plainly what the browser can and cannot do itself.
 *
 * Nothing here pretends. The command it prints is the command that works.
 */

export const PLATFORMS = [
  { id: 'youtube', name: 'YouTube', hosts: ['youtube.com', 'youtu.be', 'music.youtube.com', 'm.youtube.com'], needsCookies: 'for age-restricted, private or members-only videos', jsRuntime: true },
  { id: 'instagram', name: 'Instagram', hosts: ['instagram.com', 'instagr.am'], needsCookies: 'almost always — Instagram serves very little to anonymous clients' },
  { id: 'tiktok', name: 'TikTok', hosts: ['tiktok.com', 'vm.tiktok.com'], needsCookies: 'sometimes, for private or region-locked videos' },
  { id: 'facebook', name: 'Facebook', hosts: ['facebook.com', 'fb.watch', 'fb.com'], needsCookies: 'usually, for anything not fully public' },
  { id: 'twitter', name: 'X / Twitter', hosts: ['twitter.com', 'x.com'], needsCookies: 'for sensitive or age-restricted media' },
  { id: 'reddit', name: 'Reddit', hosts: ['reddit.com', 'redd.it', 'v.redd.it'], needsCookies: null },
  { id: 'vimeo', name: 'Vimeo', hosts: ['vimeo.com'], needsCookies: 'for password-protected videos' },
  { id: 'twitch', name: 'Twitch', hosts: ['twitch.tv'], needsCookies: 'for subscriber-only VODs' },
  { id: 'dailymotion', name: 'Dailymotion', hosts: ['dailymotion.com', 'dai.ly'], needsCookies: null },
  { id: 'soundcloud', name: 'SoundCloud', hosts: ['soundcloud.com'], needsCookies: 'for private tracks' },
  { id: 'pinterest', name: 'Pinterest', hosts: ['pinterest.com', 'pin.it'], needsCookies: null },
  { id: 'linkedin', name: 'LinkedIn', hosts: ['linkedin.com'], needsCookies: 'usually' },
  { id: 'threads', name: 'Threads', hosts: ['threads.net'], needsCookies: 'usually' },
  { id: 'snapchat', name: 'Snapchat', hosts: ['snapchat.com'], needsCookies: 'usually' },
];

export const VIDEO_QUALITIES = [
  { id: 'best', label: 'Best available' },
  { id: '2160', label: '2160p (4K)' },
  { id: '1440', label: '1440p (2K)' },
  { id: '1080', label: '1080p' },
  { id: '720', label: '720p' },
  { id: '480', label: '480p' },
  { id: '360', label: '360p' },
  { id: 'worst', label: 'Smallest file' },
];

export const AUDIO_FORMATS = ['mp3', 'm4a', 'opus', 'flac', 'wav'];
export const AUDIO_BITRATES = ['best', '320', '256', '192', '128', '96'];
export const CONTAINERS = ['mp4', 'mkv', 'webm', 'auto'];
export const BROWSERS_FOR_COOKIES = ['none', 'chrome', 'firefox', 'edge', 'brave', 'safari', 'chromium', 'opera', 'vivaldi'];

const MEDIA_EXT = ['mp4', 'webm', 'mkv', 'mov', 'm4v', 'avi', 'mp3', 'm4a', 'wav', 'ogg', 'opus', 'flac', 'aac'];
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp', 'svg', 'tiff', 'heic'];

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

export function classifyUrl(url) {
  const text = String(url || '').trim();
  if (!/^https?:\/\//i.test(text)) return { kind: 'invalid', reason: 'That does not look like a link (it needs to start with http:// or https://)' };

  let parsed;
  try { parsed = new URL(text); } catch { return { kind: 'invalid', reason: 'That link could not be parsed' }; }

  const host = hostOf(text);
  const platform = PLATFORMS.find((p) => p.hosts.some((h) => host === h || host.endsWith('.' + h)));
  const ext = (parsed.pathname.match(/\.([a-z0-9]{2,5})$/i) || [, ''])[1].toLowerCase();

  if (MEDIA_EXT.includes(ext)) return { kind: 'direct-media', ext, host, platform };
  if (IMAGE_EXT.includes(ext)) return { kind: 'direct-image', ext, host, platform };
  if (platform) return { kind: 'platform', platform, host };
  if (/\.(zip|pdf|docx?|xlsx?|csv|txt|json)$/i.test(parsed.pathname)) return { kind: 'direct-file', ext, host };
  return { kind: 'unknown-page', host };
}

/* ------------------------------------------------------------- the command */

/**
 * @param spec { url, mode: 'video'|'audio', quality, container, audioFormat,
 *               audioBitrate, playlist, subtitles, subtitleLangs, embedThumbnail,
 *               embedMetadata, sponsorblock, cookiesFromBrowser, outDir, filename,
 *               limitRate, archive, extraArgs }
 * @returns {string[]} argv (without the program name)
 */
export function buildArgs(spec = {}) {
  const {
    url, mode = 'video', quality = 'best', container = 'mp4',
    audioFormat = 'mp3', audioBitrate = 'best',
    playlist = false, subtitles = false, subtitleLangs = 'en',
    embedThumbnail = true, embedMetadata = true, sponsorblock = false,
    cookiesFromBrowser = 'none', outDir = '', filename = '%(title)s.%(ext)s',
    limitRate = '', archive = false, extraArgs = [],
  } = spec;

  const args = [];

  // format selection
  if (mode === 'audio') {
    args.push('-x', '--audio-format', AUDIO_FORMATS.includes(audioFormat) ? audioFormat : 'mp3');
    args.push('--audio-quality', audioBitrate === 'best' ? '0' : `${audioBitrate}K`);
  } else if (quality === 'best') {
    args.push('-f', 'bv*+ba/b');
  } else if (quality === 'worst') {
    args.push('-f', 'wv*+wa/w');
  } else {
    const height = String(quality).replace(/\D/g, '');
    args.push('-f', `bv*[height<=${height}]+ba/b[height<=${height}]/b`);
  }

  if (mode === 'video' && container !== 'auto' && CONTAINERS.includes(container)) {
    args.push('--merge-output-format', container === 'mp4' ? 'mp4' : container);
    if (container === 'mp4') args.push('-S', 'vcodec:h264,res,acodec:aac'); // maximum player compatibility
  }

  if (!playlist) args.push('--no-playlist');
  if (subtitles && mode === 'video') {
    args.push('--write-subs', '--sub-langs', subtitleLangs || 'en', '--embed-subs');
  }
  if (embedThumbnail) args.push('--embed-thumbnail');
  if (embedMetadata) args.push('--embed-metadata');
  if (sponsorblock && mode === 'video') args.push('--sponsorblock-remove', 'sponsor,selfpromo');
  if (cookiesFromBrowser && cookiesFromBrowser !== 'none') args.push('--cookies-from-browser', cookiesFromBrowser);
  if (limitRate) args.push('--limit-rate', limitRate);
  if (archive) args.push('--download-archive', 'omnibox-archive.txt');

  // progress that can be parsed line by line (the helper reads it)
  args.push('--newline', '--no-color');

  const template = outDir ? `${outDir.replace(/[\\/]+$/, '')}/${filename}` : filename;
  args.push('-o', template);

  for (const extra of [].concat(extraArgs || [])) if (extra) args.push(String(extra));

  if (url) args.push(String(url));
  return args;
}

/** POSIX-safe single quoting. */
export function quoteArg(arg) {
  const text = String(arg);
  if (text === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function buildCommand(spec = {}) {
  return ['yt-dlp', ...buildArgs(spec)].map(quoteArg).join(' ');
}

/** A PowerShell-friendly variant for Windows users. */
export function buildPowerShellCommand(spec = {}) {
  // strip the shell-quoting, use double quotes for the awkward args
  const args = ['yt-dlp', ...buildArgs(spec)].map((arg) => (/[\s"]/.test(String(arg)) ? `"${String(arg).replace(/"/g, '\\"')}"` : String(arg)));
  return args.join(' ');
}

/* ------------------------------------------------------------------- notes */

export const DOWNLOADER_NOTES = {
  browserCannot: 'A web page cannot fetch YouTube, Instagram, TikTok or Facebook media: the streams are signed and IP-bound, and the servers refuse cross-origin requests. No amount of JavaScript changes that — every site claiming to do it is either proxying through a server of its own or broken.',
  publicInstances: 'The usual workaround — public Piped/Invidious instances — is mostly gone: operators have closed their video endpoints to browsers to survive YouTube\'s blocking. OmniBox does not pretend to route around that.',
  youtube2026: 'For YouTube, yt-dlp now needs an external JavaScript runtime (Deno is the recommended one) to solve the signature challenges. Without it you will see 403 errors and only low-quality formats. Install Deno, then run: deno --version',
  legal: 'Download only what you have the right to download: your own uploads, Creative Commons material, or content whose licence allows it. Respect each platform\'s terms and local copyright law.',
  helper: 'The helper script (fetch.mjs) is a small Node program that runs on YOUR machine — not a server, not a service. It calls yt-dlp for platform links, downloads direct URLs with resume, and can check API keys that browsers are not allowed to call.',
};

/** What to tell the user for each platform, before they run anything. */
export function platformAdvice(classification) {
  if (!classification || !classification.platform) return null;
  const p = classification.platform;
  const lines = [];
  if (p.jsRuntime) lines.push(DOWNLOADER_NOTES.youtube2026);
  if (p.needsCookies) lines.push(`${p.name} ${p.needsCookies}. With the helper you can pass --cookies-from-browser and it will use your logged-in session.`);
  if (!lines.length) lines.push(`${p.name} links usually work without extra steps.`);
  return { platform: p.name, lines };
}

/* ------------------------------------------------- direct links in a browser */

/**
 * Can the browser itself save this? Sometimes — and when it can, that is the
 * nicest path: no helper, no terminal.
 *
 * CORS is the gate. A server that does not send Access-Control-Allow-Origin
 * cannot be read by fetch(), even though the file may be perfectly public. In
 * that case the honest fallback is "open it in a new tab and save it" — normal
 * navigation is not subject to CORS at all.
 */
export async function probeDirectUrl(url, { fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const started = Date.now();

  const attempt = async (method, headers) => {
    const res = await fetchImpl(url, { method, headers, redirect: 'follow', signal: controller ? controller.signal : undefined });
    return res;
  };

  try {
    let res;
    try {
      res = await attempt('HEAD');
    } catch (err) {
      // A timeout is not a server refusing HEAD, and retrying with a signal that has
      // already fired would hang forever. Only retry a genuine refusal.
      if (controller && controller.signal.aborted) throw err;
      // plenty of servers reject HEAD; a one-byte ranged GET is the polite retry
      res = await attempt('GET', { Range: 'bytes=0-0' });
    }
    const type = res.headers.get('content-type') || '';
    const length = Number(res.headers.get('content-length') || 0);
    const disposition = res.headers.get('content-disposition') || '';
    const filename = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition)?.[1];
    const ms = Date.now() - started;
    return {
      ok: res.ok || res.status === 206 || res.status === 0,
      status: res.status,
      type,
      size: Number.isFinite(length) ? length : 0,
      filename: filename ? decodeURIComponent(filename) : null,
      finalUrl: res.url || url,
      ms,
      kind: type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : type.startsWith('audio/') ? 'audio' : 'file',
      readable: true,
    };
  } catch (err) {
    const ms = Date.now() - started;
    const isAbort = err && err.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      ms,
      readable: false,
      reason: isAbort ? 'timeout' : 'blocked',
      message: isAbort
        ? 'The server did not answer in time.'
        : 'The browser could not read this URL (almost always CORS: the server does not allow cross-origin reads). It may still be perfectly downloadable — open it in a new tab and save it.',
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Which of the dropped/extracted files can be saved directly in the browser. */
export function canSaveInBrowser(probe) {
  return !!(probe && probe.readable && probe.ok);
}

export const DOWNLOAD_PRESETS = [
  { id: 'video-1080', label: 'Video · 1080p MP4', spec: { mode: 'video', quality: '1080', container: 'mp4' } },
  { id: 'video-best', label: 'Video · best quality', spec: { mode: 'video', quality: 'best', container: 'mp4' } },
  { id: 'video-small', label: 'Video · smallest file', spec: { mode: 'video', quality: 'worst', container: 'mp4' } },
  { id: 'audio-mp3', label: 'Audio only · MP3', spec: { mode: 'audio', audioFormat: 'mp3', audioBitrate: '192' } },
  { id: 'audio-m4a', label: 'Audio only · M4A', spec: { mode: 'audio', audioFormat: 'm4a' } },
  { id: 'audio-best', label: 'Audio only · best (FLAC)', spec: { mode: 'audio', audioFormat: 'flac' } },
];
