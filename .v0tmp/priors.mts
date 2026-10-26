import fs from 'node:fs';
import sharp from 'sharp';
import opentype from 'opentype.js';
import { buildInkMap, clusterRow } from '../src/lib/handwriting/sampleFont.ts';

const dir = '/tmp/hw/prior';
const families = new Map<string, opentype.Font[]>();
for (const f of fs.readdirSync(dir)) {
  const fam = f.replace(/-(latin|latin-ext)-\d+\.ttf$/, '');
  const font = opentype.loadSync(`${dir}/${f}`);
  const list = families.get(fam) ?? [];
  if (/-latin-\d/.test(f)) list.unshift(font); else list.push(font);
  families.set(fam, list);
}

const chars = [
  ...Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)),
  ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(161 + i)).filter((c) => c !== '\u00AD'),
  ...'‘’‚“”„†‡•…‰‹›′″€™–—←→✓'.split(''),
];

const samples = new Map<string, number[][]>();
for (const [fam, fonts] of families) {
  const base = fonts[0];
  const xGlyph = base.charToGlyph('x');
  const xh = xGlyph.getBoundingBox().y2;
  if (!(xh > 0)) continue;
  for (const ch of chars) {
    const font = fonts.find((f) => f.charToGlyph(ch).index !== 0);
    if (!font) continue;
    const glyph = font.charToGlyph(ch);
    const bb = glyph.getBoundingBox();
    if (!(bb.x2 > bb.x1)) continue;
    const fx = font.charToGlyph('x').getBoundingBox().y2 || xh;
    const size = 90;
    const px = size / font.unitsPerEm;
    const W = Math.ceil((bb.x2 - bb.x1) * px) + 20;
    const H = Math.ceil((bb.y2 - bb.y1) * px) + 20;
    const path = glyph.getPath(10 - bb.x1 * px, 10 + bb.y2 * px, size);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#fff"/><path d="${path.toPathData(2)}" fill="#000"/></svg>`;
    const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const ink = buildInkMap({ width: info.width, height: info.height, data: new Uint8ClampedArray(data) } as ImageData);
    const ids = ink.components.map((c, i) => (c.area >= 3 ? i + 1 : 0)).filter(Boolean);
    const atoms = clusterRow(ink, ids, ch).length;
    const list = samples.get(ch) ?? [];
    list.push([bb.y2 / fx, bb.y1 / fx, (bb.x2 - bb.x1) / fx, atoms]);
    samples.set(ch, list);
  }
  process.stderr.write(`${fam} `);
}

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r2 = (n: number) => Math.round(n * 100) / 100;
let out = `/**
 * Typical handwritten glyph shapes, measured from ${families.size} handwriting fonts:
 * [top, bottom, width, strokes] with top/bottom/width in x-heights relative to the
 * baseline (up is positive) and strokes = separate ink clusters left to right.
 * Generated; used as priors when matching ink to typed characters.
 */
export const GLYPH_PRIORS: Record<string, readonly [number, number, number, number]> = {\n`;
for (const ch of chars) {
  const list = samples.get(ch);
  if (!list || list.length < 3) continue;
  const atoms = median(list.map((s) => s[3]));
  out += `  ${JSON.stringify(ch)}: [${r2(median(list.map((s) => s[0])))}, ${r2(median(list.map((s) => s[1])))}, ${r2(median(list.map((s) => s[2])))}, ${Math.round(atoms)}],\n`;
}
out += '};\n';
fs.writeFileSync('/vercel/share/v0-project/src/lib/handwriting/glyphPriors.ts', out);
console.log('\nwrote', samples.size);
