# OmniBox

**Convert documents, get downloader commands, check API keys — one page, no server.**

OmniBox is a single-page tool with three tabs. Everything runs on your device: there is no
backend, no account, no telemetry, and nothing you drop into it is uploaded anywhere. Open
`index.html` from a file, or install it as an app (it is a PWA, so it works offline once loaded).

```
Convert   PDF · Word · Markdown · HTML · spreadsheets · CSV · images · ZIP     in-browser
Download  any link → the exact yt-dlp command, plus direct saves when possible  advisory
Keys      is that API key still good, and what can it do?                       in-browser
```

---

## Convert

Drop files, pick an output, get a file back. Conversions are written from scratch — the PDF
writer, the ZIP reader, the .docx and .xlsx readers are all in `app/core/`, so there is no
library to trust and no upload to make.

| From | To |
| --- | --- |
| PDF | text, Word (.docx), Markdown, images (extracted) |
| Word (.docx/.doc) | PDF, text, Markdown |
| Markdown / plain text | PDF, Word |
| HTML | Markdown, text, Word |
| XLSX | CSV (one per sheet, zipped), PDF, JSON |
| CSV / TSV | Excel, PDF, JSON |
| JSON | CSV, Excel |
| Images (JPEG, PNG) | PDF (one page each, or combined) |
| ZIP | extracted files, or repacked |

**Honest about the output**, because this is the part most tools lie about:

- A PDF rebuilt from a Word file is a **faithful re-render, not a pixel-perfect clone**. Fonts
  substitute when the original face is unavailable, and complex multi-column layouts can move.
- A **scanned PDF has no text layer**, so "PDF → text" is empty. The app detects that and says
  so instead of handing you a blank file.
- PDFs have **no concept of "heading"** — structure in PDF → Word/Markdown is inferred from how
  lines look (sizes, spacing, bullets). Nothing is dropped; some things are re-styled.
- **WebP, GIF, HEIC and SVG cannot be embedded** by this app's PDF writer. You are told this and
  told what to do instead (re-save as JPEG or PNG).
- Big files are held in memory to be converted. Past a few hundred megabytes, browsers give up;
  the app warns before that point rather than crashing silently.

## Download

The uncomfortable truth, stated up front: **a web page cannot download from YouTube, Instagram,
TikTok or Facebook.** The media URLs are signed and IP-bound, the servers refuse cross-origin
reads, and as of 2026 YouTube additionally blocks yt-dlp itself without an external JavaScript
runtime. The public Invidious/Piped bridges that used to mask this have almost all been closed by
their operators to survive. Any site that claims otherwise is proxying through its own server.

So the Download tab does the honest, useful half:

1. **Classifies your link** — which platform, or whether it is a direct media/image/file URL.
2. **Builds the exact yt-dlp command** for your choices: resolution (up to 4K), container
   (mp4/mkv/webm), audio-only (mp3/m4a/opus/flac/wav, with bitrate), playlists, subtitles,
   SponsorBlock, cookie source for private posts, and a rate limit. Copy it as POSIX shell,
   PowerShell, or JSON.
3. **Saves direct URLs in the browser** when the server actually allows it — it probes the URL
   first and reports the real answer, including when CORS blocks the read and you should just
   open it in a new tab.
4. **Ships a helper script** (`tools/fetch.mjs`, Node 18+) that runs on *your* machine: it calls
   yt-dlp for platform links, downloads direct URLs with resume support, and can check keys that
   browsers are not allowed to call.

```bash
node tools/fetch.mjs doctor                      # what is installed, and how to install the rest
node tools/fetch.mjs get <link> --quality 1080   # video
node tools/fetch.mjs get <link> --audio --audio-format mp3 --bitrate 192
node tools/fetch.mjs key openai --key sk-...     # check a key the browser cannot reach
node tools/fetch.mjs convert in.docx out.pdf     # exact conversion via LibreOffice, if installed
```

For YouTube specifically you also need **Deno** (`deno --version`), or yt-dlp fails with 403s and
offers only low-quality formats. The app says this on the tab itself, not in fine print.

Download only what you have the right to download: your own uploads, openly licensed material,
or content whose licence permits it.

## Keys

Paste a key, press check, get a verdict: **valid · invalid · expired/restricted · rate-limited ·
out of credit · blocked by CORS**, plus what the key can actually do (identity, scopes, model
count, hourly headroom, expiry countdown).

| Provider | Cheapest call used |
| --- | --- |
| GitHub | `GET /user` |
| Anthropic | `GET /v1/models` |
| Google Gemini | `GET /v1beta/models` |
| OpenRouter | `GET /api/v1/key` |
| Groq · Mistral · DeepSeek · Hugging Face · OpenAI | each provider's own model/key read endpoint |

Design rules that are enforced by tests, not by good intentions (`tests/network.test.mjs`):

- Every check is a **read-only GET**. No check may call a generation endpoint — a key check must
  never cost money. The suite fails if any provider starts pointing at one.
- Anthropic is called with `anthropic-dangerous-direct-browser-access: true` and
  `anthropic-version: 2023-06-01`, because without the first header the response is unreadable
  from a browser. This was measured, not assumed.
- A **429 counts as a working key** that is temporarily throttled — the single most common
  misreading of an API key.

**Where keys go:** into this tab's memory, or into this browser's `localStorage` if you tick
"remember". They are sent to that provider and nowhere else. But be clear-eyed: a key typed into
a browser is visible to anyone who can open devtools on that machine. Use short-lived,
least-privilege keys here, and prefer the helper script for keys you care about.

---

## Run it

```bash
# no build step, no dependencies
open index.html                 # or serve the folder: python3 -m http.server 8300
node tools/run-tests.mjs        # 107 tests across 5 suites
node tools/make-icons.mjs       # regenerate the icon set (uses the app's own PNG encoder)
```

Install as an app: open it over HTTPS (GitHub Pages, or any static host), then "Add to home
screen". The service worker caches the app shell only — it never caches API calls, and it never
intercepts cross-origin requests.

## Tests

`node tools/run-tests.mjs` — suites: `core` (primitives), `documents` (PDF/Word/Excel engines),
`convert` (the whole matrix), `network` (command builder + key checker), `ui-wiring` (page,
manifest, service worker, helper CLI).

Format output is verified with **independent readers**, not with our own code: Python's `pypdf`,
`python-docx`, `openpyxl`, `Pillow` and `zipfile`. A writer and its matching reader can share the
same misunderstanding; a third-party reader cannot. Those checks skip politely where Python is
unavailable — everything else always runs.

## Real limits

- **Nothing is uploaded, so nothing is preserved.** Close the tab and the work is gone. Save the
  file you produced.
- **YouTube is not downloadable from this page.** See above; the tab gives you the working command
  and the helper explains the install.
- **Scanned PDFs have no text to extract.** No OCR is built in.
- **Interlaced PNGs and some TIFF/HEIC variants** are refused with a reason rather than mangled.
- **ZIP extraction flattens paths** in the output names (by design — a browser cannot write folders).
- **Key checks depend on the provider's CORS policy**, which can change without notice. When a
  call is blocked, the app says "blocked", not "invalid".
- **Big conversions are memory-bound.** A 500 MB spreadsheet will not convert in a browser tab.

No dependencies. No build step. No licence to accept — take the code and use it.
