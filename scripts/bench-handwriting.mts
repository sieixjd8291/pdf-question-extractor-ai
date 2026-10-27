// Accuracy benchmark for glyph segmentation: renders text in handwriting fonts
// from /tmp/hw/fonts/<name>.ttf and scores each cut-out glyph against the truth.
// Usage: MODE=text|boxes|ai [FONTS=a,b] [ONLY=name] [PARA=1] [VERBOSE=1] npx tsx scripts/bench-handwriting.mts
import sharp from 'sharp';
import fs from 'node:fs';
import opentype from 'opentype.js';
import { buildInkMap, segmentSample, segmentFromBoxes, segmentWithAi, rowMatched, type AiLine, type Segmentation } from '../src/lib/handwriting/sampleFont.ts';

const FONTS = (process.env.FONTS ?? 'caveat,patrick-hand,indie-flower,kalam,gochi-hand,architects-daughter,shadows-into-light,handlee,comic-neue,schoolbell').split(',');

interface Scenario { name: string; image: string[]; typed: string; tight?: number; size?: number }
const PUNCT1 = '. , ! ? : ; … - · – — ( ) [ ] " \' ‘ ’ , “ ” „ ‹ ›';
const PUNCT2 = '« » ¡ ¿ • ″ ′';
const PARA = [
  'It was the best of times, it was the worst of times, it was the',
  'age of wisdom, it was the age of foolishness, it was the epoch of',
  'belief, it was the epoch of incredulity, it was the season of Light,',
  'it was the season of Darkness, it was the spring of hope, it was the',
  'winter of despair, we had everything before us, we had nothing before',
  'us, we were all going direct to Heaven, we were all going direct the',
  'other way - in short, the period was so far like the present period,',
  'that some of its noisiest authorities insisted on its being received.',
  'for good or for evil, in the superlative degree of comparison only.',
  'There were a king with a large jaw and a queen with a plain face, on',
];
const SCENARIOS: Scenario[] = [
  ...(process.env.PARA ? [{ name: 'paragraph', image: PARA, typed: PARA.join(' '), size: 40 }] : []),
  {
    name: 'user-sheet',
    image: ['ABCDEFGHIJKLMNOPQRSTUVWX', 'YZ', 'abcdefghijklmnopqrstuvwxyz', '0123456789', PUNCT1, PUNCT2],
    typed: `ABCDEFGHIJKLMNOPQRSTUVWXYZ\nabcdefghijklmnopqrstuvwxyz\n\n0123456789\n\n${PUNCT1} ${PUNCT2}`,
  },
  {
    name: 'user-sheet-exact-lines',
    image: ['ABCDEFGHIJKLMNOPQRSTUVWX', 'YZ', 'abcdefghijklmnopqrstuvwxyz', '0123456789', PUNCT1, PUNCT2],
    typed: `ABCDEFGHIJKLMNOPQRSTUVWX\nYZ\nabcdefghijklmnopqrstuvwxyz\n0123456789\n${PUNCT1}\n${PUNCT2}`,
  },
  {
    name: 'alphabet-wrap-lower',
    image: ['ABCDEFGHIJKLM', 'NOPQRSTUVWXYZ', 'abcdefghijklmnopqrs', 'tuvwxyz 0123456789'],
    typed: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ\nabcdefghijklmnopqrstuvwxyz 0123456789',
  },
  {
    name: 'pangram-wrapped',
    image: ['The quick brown fox jumps', 'over the lazy dog. Pack my box', 'with five dozen liquor jugs!'],
    typed: 'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs!',
  },
  {
    name: 'pangram-tight',
    image: ['Sphinx of black quartz,', 'judge my vow. 2468 & 1357?'],
    typed: 'Sphinx of black quartz,\njudge my vow. 2468 & 1357?',
    tight: 0.12,
  },
  {
    name: 'symbols',
    image: ['@ # $ % ^ & * + = / \\ | ~ < > { }', '"Hello," she said; it\'s 9:30 (am).'],
    typed: '@ # $ % ^ & * + = / \\ | ~ < > { }\n"Hello," she said; it\'s 9:30 (am).',
  },
];

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

interface Truth { c: string; line: number; box: [number, number, number, number] }

async function render(fontName: string, sc: Scenario, seed: number) {
  const font = opentype.loadSync(`/tmp/hw/fonts/${fontName}.ttf`);
  const rand = rng(seed);
  const size = sc.size ?? 64;
  const lineH = size * 1.55;
  const W = 1600;
  const truth: Truth[] = [];
  let paths = '';
  let maxX = 0;
  sc.image.forEach((line, li) => {
    let x = 30 + rand() * 10;
    const base = 30 + size + li * lineH + (rand() - 0.5) * 6;
    const slope = (rand() - 0.5) * 0.02;
    for (const ch of Array.from(line)) {
      const glyph = font.charToGlyph(ch);
      const adv = (glyph.advanceWidth ?? font.unitsPerEm * 0.5) * (size / font.unitsPerEm);
      if (ch === ' ') { x += adv * (1 + rand() * 0.6); continue; }
      const jy = (rand() - 0.5) * size * 0.06 + slope * x;
      const s = size * (0.94 + rand() * 0.12);
      const p = glyph.getPath(x, base + jy, s);
      const bb = p.getBoundingBox();
      if (Number.isFinite(bb.x1) && bb.x2 > bb.x1) {
        paths += `<path d="${p.toPathData(2)}" fill="#1a1a1a"/>`;
        truth.push({ c: ch, line: li, box: [bb.x1, bb.y1, bb.x2, bb.y2] });
      }
      x += adv * (1 - (sc.tight ?? 0) + (rand() - 0.5) * 0.08);
      maxX = Math.max(maxX, x);
    }
  });
  const H = Math.ceil(30 + size + (sc.image.length - 1) * lineH + size * 0.9);
  // Red spell-check squiggle under the lowercase row, like the user's sample.
  const squiggle = `<path d="M30 ${50 + size + lineH * 2} ${Array.from({ length: 80 }, (_, i) => `L${30 + i * 8} ${50 + size + lineH * 2 + (i % 2 ? 3 : -3)}`).join(' ')}" stroke="#e33" stroke-width="2" fill="none"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#f6f3ec"/>${sc.name.startsWith('user') ? squiggle : ''}${paths}</svg>`;
  const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (process.env.SAVE) await sharp(Buffer.from(svg)).png().toFile(`/tmp/hw/${fontName}-${sc.name}.png`);
  const img = { width: info.width, height: info.height, data: new Uint8ClampedArray(data), colorSpace: 'srgb' } as ImageData;
  return { img, truth, W: info.width, H: info.height };
}

function score(seg: Segmentation, truth: Truth[]) {
  // Flatten predicted (letter, box) in reading order and align with truth by order.
  const pred = seg.rows.filter(rowMatched).flatMap((r) => r.pieces.map((p, i) => ({ c: r.letters[i], p })));
  let ok = 0;
  const used = new Set<number>();
  const fails: string[] = [];
  for (const t of truth) {
    // A truth glyph is correct if some predicted glyph with the same char has IoU > 0.5.
    const idx = pred.findIndex((q, i) => {
      if (used.has(i) || q.c !== t.c) return false;
      const ix = Math.min(q.p.x1 + 1, t.box[2]) - Math.max(q.p.x0, t.box[0]);
      const iy = Math.min(q.p.y1 + 1, t.box[3]) - Math.max(q.p.y0, t.box[1]);
      if (ix <= 0 || iy <= 0) return false;
      const inter = ix * iy;
      const a = (q.p.x1 - q.p.x0 + 1) * (q.p.y1 - q.p.y0 + 1);
      const b = (t.box[2] - t.box[0]) * (t.box[3] - t.box[1]);
      return inter / (a + b - inter) > 0.5;
    });
    if (idx >= 0) { used.add(idx); ok++; } else fails.push(t.c);
  }
  const wrong = pred.length - used.size;
  return { ok, total: truth.length, wrong, fails, missing: seg.missing ?? [] };
}

/** Simulates a Gemini reading: right text, boxes off by a fraction of a glyph. */
function fakeAi(truth: Truth[], sc: Scenario, W: number, H: number, seed: number, noise: number): AiLine[] {
  const rand = rng(seed * 7 + 1);
  return sc.image.map((text, li) => ({
    text,
    chars: truth.filter((t) => t.line === li).map((t) => {
      const w = t.box[2] - t.box[0];
      const h = t.box[3] - t.box[1];
      const dx = (rand() - 0.5) * 2 * noise * w;
      const dy = (rand() - 0.5) * 2 * noise * h;
      const g = 1 + (rand() - 0.5) * noise;
      return { c: t.c, sure: true, box: [(t.box[0] + dx) / W, (t.box[1] + dy) / H, (t.box[0] + dx + w * g) / W, (t.box[1] + dy + h * g) / H] as [number, number, number, number] };
    }),
  }));
}

const mode = process.env.MODE ?? 'text';
const totals = { ok: 0, total: 0, wrong: 0 };
const per: Record<string, { ok: number; total: number }> = {};
for (const sc of SCENARIOS) {
  if (process.env.ONLY && !sc.name.includes(process.env.ONLY)) continue;
  for (const [fi, f] of FONTS.entries()) {
    const { img, truth, W, H } = await render(f, sc, fi + 1);
    const ink = buildInkMap(img);
    let seg: Segmentation; const t0 = performance.now();
    if (mode === 'text') seg = segmentSample(ink, sc.typed);
    else if (mode === 'boxes') seg = segmentFromBoxes(ink, fakeAi(truth, sc, W, H, fi + 1, Number(process.env.NOISE ?? 0.25)));
    else seg = segmentWithAi(ink, fakeAi(truth, sc, W, H, fi + 1, Number(process.env.NOISE ?? 0.25)));
    if (process.env.PARA) console.log(f, "ms", Math.round(performance.now() - t0));
    const s = score(seg, truth);
    totals.ok += s.ok; totals.total += s.total; totals.wrong += s.wrong;
    per[sc.name] ??= { ok: 0, total: 0 };
    per[sc.name].ok += s.ok; per[sc.name].total += s.total;
    if (process.env.VERBOSE && s.ok < s.total) {
      console.log(`  ${f}/${sc.name}: ${s.ok}/${s.total} wrong=${s.wrong} ${seg.error ?? ''} fails=[${s.fails.join(' ')}] missing=[${s.missing.join(' ')}]`);
      if (process.env.VERBOSE === '2') for (const r of seg.rows) console.log('     ', rowMatched(r) ? 'ok ' : 'BAD', `${r.pieces.length}/${r.letters.length}`, r.text);
      if (process.env.VERBOSE === '3') {
        for (const r of seg.rows) console.log('   pred', r.pieces.map((p, i) => `${r.letters[i]}[${p.x0},${p.y0}-${p.x1},${p.y1}]`).join(' '));
        console.log('   truth', truth.map((t) => `${t.c}[${t.box.map(Math.round).join(',')}]`).join(' '));
      }
    }
  }
}
for (const [k, v] of Object.entries(per)) console.log(`${k.padEnd(24)} ${(100 * v.ok / v.total).toFixed(1)}%  (${v.ok}/${v.total})`);
console.log(`TOTAL ${mode} ${(100 * totals.ok / totals.total).toFixed(1)}%  wrong=${totals.wrong}`);
fs.writeFileSync('/tmp/hw/last.json', JSON.stringify(per));
