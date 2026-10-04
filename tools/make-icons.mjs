/**
 * Draws the OmniBox icon set.
 *
 *   node tools/make-icons.mjs
 *
 * No image libraries and no design tools: the icon is rasterised here with 4×4
 * supersampling and written with the app's own PNG encoder, so the whole set is
 * reproducible from source and nothing is a binary blob of unknown origin.
 *
 * The mark: a white arrow dropping into an orange box — "put anything in, take
 * anything out", which is exactly what the three tabs do.
 */

import { encodePng } from '../app/core/image.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'icons');

const BG = [11, 15, 20];     // #0b0f14 — the app background
const ORANGE = [255, 106, 0]; // #ff6a00 — the app accent
const WHITE = [255, 255, 255];

const SUPERSAMPLE = 4;

/** Standard rounded-rectangle hit test. */
function inRounded(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** A downward triangle (the arrow head). */
function inTriangle(x, y, apexX, apexY, leftX, baseY, rightX) {
  if (y < baseY || y > apexY) return false;
  const t = (y - baseY) / (apexY - baseY); // 0 at the base, 1 at the tip
  const half = (rightX - leftX) / 2;
  const centre = (leftX + rightX) / 2;
  const width = half * (1 - t);
  return Math.abs(x - centre) <= width;
}

/** Colour of one sample point, in the glyph's own coordinate space. */
function sample(x, y) {
  const arrowShaft = inRounded(x, y, 0.455, 0.13, 0.545, 0.40, 0.012);
  const arrowHead = inTriangle(x, y, 0.5, 0.53, 0.32, 0.36, 0.68);
  const box = inRounded(x, y, 0.21, 0.48, 0.79, 0.86, 0.085);
  if (arrowShaft || arrowHead) return WHITE;
  if (box) return ORANGE;
  return BG;
}

/** Render one square icon. `inset` shrinks the glyph for maskable safe zones. */
function render(size, { inset = 1 } = {}) {
  const rgb = new Uint8Array(size * size * 3);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0; let g = 0; let b = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          // sample in normalised space, then scale the glyph for masking
          let nx = (px + (sx + 0.5) / SUPERSAMPLE) / size;
          let ny = (py + (sy + 0.5) / SUPERSAMPLE) / size;
          nx = 0.5 + (nx - 0.5) * inset;
          ny = 0.5 + (ny - 0.5) * inset;
          const [cr, cg, cb] = sample(nx, ny);
          r += cr; g += cg; b += cb;
        }
      }
      const n = SUPERSAMPLE * SUPERSAMPLE;
      const at = (py * size + px) * 3;
      rgb[at] = Math.round(r / n);
      rgb[at + 1] = Math.round(g / n);
      rgb[at + 2] = Math.round(b / n);
    }
  }
  return rgb;
}

const ICONS = [
  { file: 'icon-512.png', size: 512, inset: 1 },
  { file: 'icon-192.png', size: 192, inset: 1 },
  { file: 'icon-maskable-512.png', size: 512, inset: 0.78 },
  { file: 'apple-touch-icon.png', size: 180, inset: 0.92 },
  { file: 'favicon-32.png', size: 32, inset: 1 },
];

mkdirSync(OUT_DIR, { recursive: true });
for (const { file, size, inset } of ICONS) {
  const png = await encodePng({ width: size, height: size, rgb: render(size, { inset }) });
  writeFileSync(join(OUT_DIR, file), png);
  console.log(`  ${file.padEnd(24)} ${size}×${size}  ${png.length.toLocaleString()} bytes`);
}
console.log(`\n  ✓ ${ICONS.length} icons written to icons/`);
