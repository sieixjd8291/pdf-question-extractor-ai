import type { HandwritingEngine } from './engine';
import {
  ALIGN_ID,
  CROSS_STYLE_ID,
  PAGE_SIZES,
  mistakeMask,
  type AssignmentSettings,
  type HandwritingFont,
  type PageBlocks,
  type PageLayout,
  type TextBlock,
  type TextOffsets,
} from './catalog';

const FONT_CSS_HREF = '/fonts/handwriting/fonts.css';
let stylesheet: Promise<void> | null = null;

/** Injects the self-hosted handwriting @font-face sheet once, on demand. */
export function ensureFontStylesheet(): Promise<void> {
  if (!stylesheet) {
    stylesheet = new Promise((resolve) => {
      const existing = document.getElementById('handwriting-fonts') as HTMLLinkElement | null;
      if (existing?.sheet) return resolve();
      const link = existing ?? document.createElement('link');
      link.addEventListener('load', () => resolve(), { once: true });
      link.addEventListener('error', () => resolve(), { once: true });
      if (!existing) {
        link.rel = 'stylesheet';
        link.href = FONT_CSS_HREF;
        document.head.appendChild(link);
      }
    });
  }
  return stylesheet;
}

if (typeof document !== 'undefined') void ensureFontStylesheet();

export async function loadFont(family: string, sample = 'Handwriting abc'): Promise<void> {
  await ensureFontStylesheet();
  const spec = `100px "${family}"`;
  try {
    // Load both the text's glyph ranges and the basic Latin face; canvas only
    // draws with faces that are fully loaded before the draw call.
    await Promise.all([document.fonts.load(spec, sample), document.fonts.load(spec, 'abcABC')]);
    await document.fonts.ready;
  } catch {
    // A missing face falls back to the next font; layout still measures it.
  }
}

export async function registerCustomFont(file: File): Promise<string> {
  const family = `Custom ${file.name.replace(/\.(ttf|otf|woff2?)$/i, '').slice(0, 40)}`;
  const face = new FontFace(family, await file.arrayBuffer());
  await face.load();
  document.fonts.add(face);
  return family;
}

const CONTROL: Record<string, number> = {
  ' ': -1,
  '\n': -2,
  '\f': -3,
  '\u0001': -4,
  '\u0002': -5,
  '\u0003': -6,
  '\u0004': -7,
};

const TYPO_LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export interface Segmented {
  units: string[];
  seq: number[];
}

/** Splits prepared text into grapheme units (so Devanagari matras stay attached). */
export function segment(prepared: string): Segmented {
  const units: string[] = [];
  const index = new Map<string, number>();
  const idOf = (g: string) => {
    let id = index.get(g);
    if (id === undefined) {
      id = units.length;
      units.push(g);
      index.set(g, id);
    }
    return id;
  };
  for (const ch of TYPO_LETTERS) idOf(ch);
  const graphemes: string[] = typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(prepared), (s) => s.segment)
    : Array.from(prepared);
  const seq: number[] = [];
  for (const g of graphemes) {
    if (g === '\r') continue;
    const control = CONTROL[g];
    if (control !== undefined) seq.push(control);
    else if (/^\s+$/.test(g)) seq.push(g.includes('\n') ? -2 : -1);
    else seq.push(idOf(g));
  }
  return { units, seq };
}

const widthCache = new Map<string, Map<string, number>>();
let measureCtx: CanvasRenderingContext2D | null = null;

export function measureUnits(units: string[], font: HandwritingFont): Float32Array {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  const ctx = measureCtx!;
  const key = `${font.family}|${font.sizeAdjust}`;
  let cache = widthCache.get(key);
  if (!cache) {
    cache = new Map();
    widthCache.set(key, cache);
  }
  ctx.font = `${100 * font.sizeAdjust}px "${font.family}", cursive`;
  const out = new Float32Array(units.length + 1);
  units.forEach((u, i) => {
    let w = cache!.get(u);
    if (w === undefined) {
      w = ctx.measureText(u).width;
      cache!.set(u, w);
    }
    out[i] = w;
  });
  let space = cache.get(' ');
  if (space === undefined) {
    space = ctx.measureText(' ').width || 28 * font.sizeAdjust;
    cache.set(' ', space);
  }
  out[units.length] = space;
  return out;
}

/** Fonts changed (e.g. custom upload replaced): drop stale measurements. */
export function clearMeasureCache(family?: string) {
  if (!family) widthCache.clear();
  else for (const k of widthCache.keys()) if (k.startsWith(`${family}|`)) widthCache.delete(k);
}

export interface LayoutResult {
  pages: number;
  glyphs: Float32Array;
  glyphCount: number;
  strokes: Array<{ page: number; kind: number; points: Float32Array }>;
  glyphsByPage: number[][];
  /** Movable text blocks per page, in page units, after user offsets are applied. */
  blocks: PageBlocks[];
}

export const GLYPH_STRIDE = 10;

const STROKE_UNDERLINE = 4;

/** Key of the page, a line on it, or a word within that line in `AssignmentDoc.textOffsets`. */
export function blockKey(page: number, line?: number, word?: number): string {
  if (line === undefined) return `p${page}`;
  if (word === undefined) return `p${page}.l${line}`;
  return `p${page}.l${line}.w${word}`;
}

interface Box { x0: number; y0: number; x1: number; y1: number }

const emptyBox = (): Box => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
const grow = (b: Box, x0: number, y0: number, x1: number, y1: number) => {
  if (x0 < b.x0) b.x0 = x0;
  if (y0 < b.y0) b.y0 = y0;
  if (x1 > b.x1) b.x1 = x1;
  if (y1 > b.y1) b.y1 = y1;
};

/**
 * Groups the engine's glyph stream into pages → lines → words, then shifts each
 * glyph (and its cross-out / caret / underline strokes) by the user's page, line
 * and word offsets. The engine emits glyphs line by line in reading order, so a
 * new line starts wherever x jumps back or the baseline jumps; a new word starts
 * wherever the gap to the previous glyph's advance is wider than a letter gap.
 */
function arrangeText(
  glyphs: Float32Array,
  glyphCount: number,
  strokes: LayoutResult['strokes'],
  pages: number,
  s: AssignmentSettings,
  overrides: Record<number, PageLayout>,
  fontA: HandwritingFont,
  fontB: HandwritingFont,
  wa: Float32Array,
  wb: Float32Array,
  offsets: TextOffsets,
): PageBlocks[] {
  const fs = s.fontSize;
  const S = GLYPH_STRIDE;
  const spaceW = (wa[wa.length - 1] * fs) / 100;
  const wordGap = Math.max(fs * 0.07, 0.5 * Math.max(fs * 0.12, spaceW + s.wordSpacing));
  const lineOf = new Int32Array(glyphCount);
  const wordOf = new Int32Array(glyphCount);
  const lineBase: number[][] = Array.from({ length: pages }, () => []);
  const wordCount: number[][] = Array.from({ length: pages }, () => []);
  const advOf = new Float32Array(glyphCount);

  let curPage = -1;
  let line = -1;
  let word = -1;
  let prevX = 0;
  let prevEnd = 0;
  let prevY = 0;
  let lineH = s.layout.lineHeight;
  for (let i = 0; i < glyphCount; i++) {
    const o = i * S;
    const page = glyphs[o];
    const x = glyphs[o + 2];
    const y = glyphs[o + 3];
    const scale = glyphs[o + 5];
    const useB = glyphs[o + 6] > 0.5;
    const flags = glyphs[o + 9];
    const unitW = (useB ? wb : wa)[glyphs[o + 1]] ?? 50;
    const adv = (unitW * fs) / 100 * scale + s.letterSpacing * (scale < 0.75 ? 0.62 : 1);
    advOf[i] = Math.max(adv, fs * scale * 0.15);
    if (page !== curPage) {
      curPage = page;
      line = -1;
      lineH = layoutForPage(s, overrides, page).lineHeight;
    }
    if ((flags & GLYPH_FLAG.insert) !== 0 && line >= 0) {
      lineOf[i] = line;
      wordOf[i] = word;
      continue;
    }
    if (line < 0 || x < prevX - fs * 0.5 || Math.abs(y - prevY) > lineH * 0.55) {
      line = lineBase[page].length;
      lineBase[page].push(y);
      wordCount[page].push(1);
      word = 0;
    } else if (x - prevEnd > wordGap) {
      word = wordCount[page][line]++;
    }
    lineOf[i] = line;
    wordOf[i] = word;
    prevX = x;
    prevEnd = x + adv;
    prevY = y;
  }

  const glyphBox = (i: number, dx: number, dy: number): Box => {
    const o = i * S;
    const f = glyphs[o + 6] > 0.5 ? fontB : fontA;
    const px = fs * glyphs[o + 5] * f.sizeAdjust;
    const x = glyphs[o + 2] + dx;
    const y = glyphs[o + 3] + dy;
    return { x0: x, y0: y - px * 0.78, x1: x + advOf[i], y1: y + px * 0.28 };
  };

  const wordBoxesPre: Box[][][] = lineBase.map((lines, page) => lines.map((_, l) => Array.from({ length: wordCount[page][l] }, emptyBox)));
  for (let i = 0; i < glyphCount; i++) {
    const page = glyphs[i * S];
    const b = glyphBox(i, 0, 0);
    const wb_ = wordBoxesPre[page]?.[lineOf[i]]?.[wordOf[i]];
    if (wb_) grow(wb_, b.x0, b.y0, b.x1, b.y1);
  }

  const off = (key: string) => offsets[key];
  const shiftFor = (page: number, l: number, w: number): [number, number] => {
    let dx = 0;
    let dy = 0;
    const a = off(blockKey(page));
    if (a) { dx += a.x; dy += a.y; }
    if (l >= 0) {
      const b = off(blockKey(page, l));
      if (b) { dx += b.x; dy += b.y; }
      if (w >= 0) {
        const c = off(blockKey(page, l, w));
        if (c) { dx += c.x; dy += c.y; }
      }
    }
    return [dx, dy];
  };

  for (const st of strokes) {
    const pts = st.points;
    const n = pts.length / 2;
    if (!n || st.page >= pages) continue;
    let mx = 0;
    let my = 0;
    for (let k = 0; k < n; k++) {
      mx += pts[k * 2];
      my += pts[k * 2 + 1];
    }
    mx /= n;
    my /= n;
    let bestLine = -1;
    let bestDist = Infinity;
    lineBase[st.page].forEach((base, l) => {
      const d = Math.abs(base - my);
      if (d < bestDist) {
        bestDist = d;
        bestLine = l;
      }
    });
    let bestWord = -1;
    if (bestLine >= 0 && st.kind !== STROKE_UNDERLINE) {
      const words = wordBoxesPre[st.page][bestLine];
      const pad = fs * 0.2;
      bestWord = words.findIndex((b) => mx >= b.x0 - pad && mx <= b.x1 + pad);
    }
    const [dx, dy] = shiftFor(st.page, bestLine, bestWord);
    if (dx === 0 && dy === 0) continue;
    for (let k = 0; k < n; k++) {
      pts[k * 2] += dx;
      pts[k * 2 + 1] += dy;
    }
  }

  const wordBoxes: Box[][][] = lineBase.map((lines, page) => lines.map((_, l) => Array.from({ length: wordCount[page][l] }, emptyBox)));
  for (let i = 0; i < glyphCount; i++) {
    const o = i * S;
    const page = glyphs[o];
    const [dx, dy] = shiftFor(page, lineOf[i], wordOf[i]);
    if (dx !== 0 || dy !== 0) {
      glyphs[o + 2] += dx;
      glyphs[o + 3] += dy;
    }
    const b = glyphBox(i, 0, 0);
    const target = wordBoxes[page]?.[lineOf[i]]?.[wordOf[i]];
    if (target) grow(target, b.x0, b.y0, b.x1, b.y1);
  }

  return wordBoxes.map((lines, page) => {
    const pageBox = emptyBox();
    const lineBlocks: TextBlock[] = [];
    const wordBlocks: TextBlock[] = [];
    lines.forEach((words, l) => {
      const lineBox = emptyBox();
      words.forEach((b, w) => {
        if (!Number.isFinite(b.x0)) return;
        wordBlocks.push({ id: blockKey(page, l, w), ...b });
        grow(lineBox, b.x0, b.y0, b.x1, b.y1);
      });
      if (!Number.isFinite(lineBox.x0)) return;
      lineBlocks.push({ id: blockKey(page, l), ...lineBox });
      grow(pageBox, lineBox.x0, lineBox.y0, lineBox.x1, lineBox.y1);
    });
    return {
      page: Number.isFinite(pageBox.x0) ? { id: blockKey(page), ...pageBox } : null,
      lines: lineBlocks,
      words: wordBlocks,
    };
  });
}

let lastEngineLayout: { engine: HandwritingEngine; input: Float32Array; output: Float32Array } | null = null;

export function runLayout(
  engine: HandwritingEngine,
  s: AssignmentSettings,
  seg: Segmented,
  fontA: HandwritingFont,
  fontB: HandwritingFont,
  overrides: Record<number, PageLayout>,
  offsets: TextOffsets = {},
): LayoutResult {
  const size = PAGE_SIZES[s.pageSize];
  const useB = s.combineFonts && fontB.family !== fontA.family;
  const wa = measureUnits(seg.units, fontA);
  const wb = useB ? measureUnits(seg.units, fontB) : wa;
  const n = seg.units.length;
  const ov = Object.entries(overrides);
  const input = new Float32Array(32 + 1 + n * 3 + 1 + seg.seq.length + 1 + ov.length * 6);
  const L = s.layout;
  const params = [
    size.width, size.height, L.marginLeft, L.marginRight, L.marginTop, L.marginBottom, L.lineHeight,
    s.fontSize, s.letterSpacing, s.wordSpacing, s.tilt, s.charVariance, s.snapToLines ? 0 : s.baselineWobble,
    s.autoMistake ? s.mistakeRate / 100 : 0, CROSS_STYLE_ID[s.crossStyle], ALIGN_ID[s.align], s.seed,
    s.fontMix, s.paragraphIndent, s.sizeVariance, s.snapToLines ? 0 : s.lineSlope, s.inkOpacity, s.inkVariance, s.marginJitter,
    useB ? 1 : 0, wa[n], wb[n], s.headingScale, s.underlineHeadings ? 1 : 0, 300,
    mistakeMask(s.mistakeKinds) || 1, s.mistakeSeed,
  ];
  input.set(params, 0);
  let o = 32;
  input[o++] = n;
  for (let i = 0; i < n; i++) {
    const u = seg.units[i];
    input[o++] = wa[i];
    input[o++] = wb[i];
    input[o++] = u.length === 1 && u.charCodeAt(0) < 128 ? u.charCodeAt(0) : 0;
  }
  input[o++] = seg.seq.length;
  input.set(seg.seq, o);
  o += seg.seq.length;
  input[o++] = ov.length;
  for (const [page, g] of ov) {
    input.set([Number(page), g.marginLeft, g.marginRight, g.marginTop, g.marginBottom, g.lineHeight], o);
    o += 6;
  }

  // Offsets only move existing glyphs. Keep one bounded, immutable geometry result
  // so dragging never re-runs WASM wrapping or mistake generation.
  const cached = lastEngineLayout;
  const sameGeometry = cached?.engine === engine && cached.input.length === input.length && input.every((value, i) => value === cached.input[i]);
  const out = sameGeometry ? cached.output : engine.layout(input);
  if (!sameGeometry) lastEngineLayout = { engine, input, output: out };
  const pages = Math.max(1, out[0]);
  const glyphCount = out[1];
  const strokeCount = out[2];
  const glyphs = out.slice(3, 3 + glyphCount * GLYPH_STRIDE);
  const glyphsByPage: number[][] = Array.from({ length: pages }, () => []);
  for (let i = 0; i < glyphCount; i++) glyphsByPage[glyphs[i * GLYPH_STRIDE]]?.push(i);
  const strokes: LayoutResult['strokes'] = [];
  let p = 3 + glyphCount * GLYPH_STRIDE;
  for (let k = 0; k < strokeCount; k++) {
    const page = out[p];
    const kind = out[p + 1];
    const count = out[p + 2];
    strokes.push({ page, kind, points: out.slice(p + 3, p + 3 + count * 2) });
    p += 3 + count * 2;
  }
  const blocks = arrangeText(glyphs, glyphCount, strokes, pages, s, overrides, fontA, useB ? fontB : fontA, wa, wb, offsets);
  return { pages, glyphs, glyphCount, strokes, glyphsByPage, blocks };
}

export const GLYPH_FLAG = { mistake: 1, heading: 2, overwrite: 4, overwritten: 8, insert: 16 } as const;

export interface MistakeCounts {
  crossOut: number;
  caret: number;
  overwrite: number;
}

export function countMistakes(layout: LayoutResult): MistakeCounts {
  const counts: MistakeCounts = { crossOut: 0, caret: 0, overwrite: 0 };
  let prevMistake = false;
  for (let i = 0; i < layout.glyphCount; i++) {
    const flags = layout.glyphs[i * GLYPH_STRIDE + 9];
    const isMistake = (flags & GLYPH_FLAG.mistake) !== 0;
    if (isMistake && !prevMistake) counts.crossOut++;
    prevMistake = isMistake;
    if (flags & GLYPH_FLAG.insert) counts.caret++;
    if (flags & GLYPH_FLAG.overwrite) counts.overwrite++;
  }
  return counts;
}

export function layoutForPage(s: AssignmentSettings, overrides: Record<number, PageLayout>, page: number): PageLayout {
  return overrides[page] ?? s.layout;
}
