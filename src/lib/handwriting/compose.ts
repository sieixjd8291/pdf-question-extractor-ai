import type { HandwritingEngine } from './engine';
import {
  ALIGN_ID,
  CROSS_STYLE_ID,
  PAGE_SIZES,
  mistakeMask,
  type AssignmentSettings,
  type HandwritingFont,
  type PageLayout,
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
}

export const GLYPH_STRIDE = 10;

export function runLayout(
  engine: HandwritingEngine,
  s: AssignmentSettings,
  seg: Segmented,
  fontA: HandwritingFont,
  fontB: HandwritingFont,
  overrides: Record<number, PageLayout>,
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
    s.fontSize, s.letterSpacing, s.wordSpacing, s.tilt, s.charVariance, s.baselineWobble,
    s.autoMistake ? s.mistakeRate / 100 : 0, CROSS_STYLE_ID[s.crossStyle], ALIGN_ID[s.align], s.seed,
    s.fontMix, s.paragraphIndent, s.sizeVariance, s.lineSlope, s.inkOpacity, s.inkVariance, s.marginJitter,
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

  const out = engine.layout(input);
  const pages = Math.max(1, out[0]);
  const glyphCount = out[1];
  const strokeCount = out[2];
  const glyphs = out.subarray(3, 3 + glyphCount * GLYPH_STRIDE);
  const glyphsByPage: number[][] = Array.from({ length: pages }, () => []);
  for (let i = 0; i < glyphCount; i++) glyphsByPage[glyphs[i * GLYPH_STRIDE]]?.push(i);
  const strokes: LayoutResult['strokes'] = [];
  let p = 3 + glyphCount * GLYPH_STRIDE;
  for (let k = 0; k < strokeCount; k++) {
    const page = out[p];
    const kind = out[p + 1];
    const count = out[p + 2];
    strokes.push({ page, kind, points: out.subarray(p + 3, p + 3 + count * 2) });
    p += 3 + count * 2;
  }
  return { pages, glyphs, glyphCount, strokes, glyphsByPage };
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
