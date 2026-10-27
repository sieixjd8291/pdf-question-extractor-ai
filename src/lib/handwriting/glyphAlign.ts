/**
 * Global matching of ink clusters ("atoms") to the characters of a text.
 *
 * Every row of writing is a left-to-right list of atoms; the text is one list of
 * characters. A dynamic program finds the cheapest way to walk both lists at once,
 * where each character takes 1-3 neighbouring atoms (multi-stroke marks like « or a
 * broken letter), several characters share one atom (joined letters, cut later at
 * the thinnest ink), or a stray atom / unwritten character is skipped. Costs come
 * from typical handwritten glyph shapes (width, height above the baseline, stroke
 * count), word gaps, line wraps and, when available, the AI's box for each character.
 * Doing this globally means one odd glyph can't shift every letter after it.
 */
import { GLYPH_PRIORS } from './glyphPriors';

export interface AtomFeat {
  row: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  area: number;
  /** Ink pixels per column, top and bottom ink row per column (relative to x0). */
  cols: Uint32Array;
  colTop: Int32Array;
  colBot: Int32Array;
  /** Largest value in cols. */
  peak: number;
}

export interface LetterSpec {
  c: string;
  spaceBefore: boolean;
  lineStart: boolean;
  /** Where the AI saw this character, in pixels. */
  hint?: { cx: number; cy: number };
}

export type AlignOp =
  | { kind: 'skipAtom'; atom: number }
  | { kind: 'skipLetter'; letter: number }
  | { kind: 'merge'; letter: number; atoms: number[] }
  | { kind: 'split'; atoms: number[]; letters: number[]; cuts: number[] };

interface Geometry {
  /** Pixels per x-height. */
  scale: number;
  /** Baseline per row as y = a + b * x, or null when unknown. */
  base: ({ a: number; b: number } | null)[];
}

const DEFAULT_PRIOR = [1.2, 0, 0.9, 1] as const;
const SKIP_LETTER = 3;
const SPLIT_BASE = 0.8;
/** Most letters one connected stroke may hold (a cursive word). */
const MAX_JOINED = 12;

function priorOf(c: string) {
  return GLYPH_PRIORS[c] ?? DEFAULT_PRIOR;
}

interface Box { x0: number; x1: number; y0: number; y1: number }

function median(values: number[]): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Thinnest ink column in [from, to] near target; returns relative column and its ink. */
function thinnest(cols: Uint32Array, peak: number, from: number, to: number, target: number) {
  let best = Math.round(target);
  let bestScore = Infinity;
  const span = Math.max(1, to - from);
  for (let i = Math.max(1, from); i <= to && i < cols.length - 1; i++) {
    const score = cols[i] / peak + (Math.abs(i - target) / span) * 0.35;
    if (score < bestScore) { bestScore = score; best = i; }
  }
  best = Math.max(1, Math.min(cols.length - 1, best));
  return { col: best, ink: cols[best] / peak };
}

/** Sub-box of an atom between two relative columns, trimmed to its ink. */
function subBox(a: AtomFeat, c0: number, c1: number): Box | null {
  let x0 = -1, x1 = -1, y0 = Infinity, y1 = -Infinity;
  for (let c = c0; c < c1; c++) {
    if (!a.cols[c]) continue;
    if (x0 < 0) x0 = c;
    x1 = c;
    if (a.colTop[c] < y0) y0 = a.colTop[c];
    if (a.colBot[c] > y1) y1 = a.colBot[c];
  }
  return x0 < 0 ? null : { x0: a.x0 + x0, x1: a.x0 + x1, y0, y1 };
}

export function alignGlyphs(atoms: AtomFeat[], letters: LetterSpec[]): AlignOp[] {
  const K = atoms.length;
  const N = letters.length;
  if (!N) return atoms.map((_, atom) => ({ kind: 'skipAtom', atom }));
  if (!K) return letters.map((_, letter) => ({ kind: 'skipLetter', letter }));

  const areas = atoms.map((a) => a.area);
  const medArea = median(areas) || 1;
  const priors = letters.map((l) => priorOf(l.c));
  const tiny = atoms.map((a) => a.area < medArea * 0.15);
  // Leading atoms of a row, ignoring specks, and the reach of the ink before each atom.
  const rowLead = new Uint8Array(K);
  const reach = new Float64Array(K).fill(-Infinity);
  for (let i = 0; i < K; i++) {
    const first = i === 0 || atoms[i - 1].row !== atoms[i].row;
    if (first) rowLead[i] = 1;
    else {
      reach[i] = Math.max(reach[i - 1], atoms[i - 1].x1);
      let lead = 1;
      for (let t = i - 1; t >= 0 && atoms[t].row === atoms[i].row; t--) if (!tiny[t]) { lead = 0; break; }
      rowLead[i] = lead;
    }
  }

  const sumPriorW = priors.reduce((s, p) => s + p[2], 0);
  const sumAtomW = atoms.reduce((s, a, i) => s + (tiny[i] ? 0 : a.x1 - a.x0 + 1), 0);
  let geo: Geometry = { scale: Math.max(4, sumAtomW / Math.max(0.5, sumPriorW)), base: [] };

  let ops: AlignOp[] = [];
  for (let pass = 0; pass < 3; pass++) {
    ops = runDp(atoms, letters, priors, geo, rowLead, reach, medArea);
    const next = estimateGeometry(atoms, letters, priors, ops, geo);
    if (!next) break;
    geo = next;
  }
  return ops;
}

function glyphCost(box: Box, row: number, li: number, letters: LetterSpec[], priors: (readonly number[])[], geo: Geometry) {
  const [top, bottom, width] = priors[li];
  const s = geo.scale;
  const w = box.x1 - box.x0 + 1;
  const pad = 0.2 * s;
  let cost = 2 * Math.log((w + pad) / (width * s + pad)) ** 2;
  const base = geo.base[row];
  const cx = (box.x0 + box.x1) / 2;
  if (base) {
    const b = base.a + base.b * cx;
    const dt = (box.y0 - (b - top * s)) / s;
    const db = (box.y1 - (b - bottom * s)) / s;
    cost += 0.6 * (Math.min(dt * dt, 6) + Math.min(db * db, 6));
  } else {
    const h = box.y1 - box.y0 + 1;
    cost += 0.5 * Math.log((h + pad) / ((top - bottom) * s + pad)) ** 2;
  }
  const hint = letters[li].hint;
  if (hint) {
    const dx = (cx - hint.cx) / s;
    const dy = ((box.y0 + box.y1) / 2 - hint.cy) / s;
    cost += 0.4 * Math.min(dx * dx + dy * dy, 16);
  }
  return cost;
}

function runDp(
  atoms: AtomFeat[], letters: LetterSpec[], priors: (readonly number[])[], geo: Geometry,
  rowLead: Uint8Array, reach: Float64Array, medArea: number,
): AlignOp[] {
  const K = atoms.length;
  const N = letters.length;
  const S = N + 1;
  const cost = new Float64Array((K + 1) * S).fill(Infinity);
  // Back pointers: kind (0 none, 1 skip atom, 2 skip letter, 3 merge, 4 split) and size.
  const kind = new Uint8Array((K + 1) * S);
  const size = new Uint8Array((K + 1) * S);
  const s = geo.scale;
  cost[0] = 0;

  const skipAtom = atoms.map((a) => 0.4 + 3.6 * Math.sqrt(Math.min(1, a.area / medArea)));

  /** Cost of starting a glyph for letter j at atom i: line wraps and word gaps. */
  const joinCost = (i: number, j: number) => {
    if (j === 0) return 0;
    const l = letters[j];
    if (rowLead[i]) return l.lineStart ? 0 : l.spaceBefore ? 0.4 : 1.0;
    let c = l.lineStart ? 2.5 : 0;
    const g = (atoms[i].x0 - reach[i]) / s;
    if (l.spaceBefore || l.lineStart) c += 1.2 * Math.max(0, 0.45 - g);
    else c += 0.5 * Math.max(0, g - 1.2);
    return c;
  };

  const cache = new Map<number, AtomFeat>();
  const combined = (i: number, n: number) => {
    if (n === 1) return atoms[i];
    const key = i * 4 + n;
    let out = cache.get(key);
    if (!out) {
      out = combineAtoms(atoms.slice(i, i + n));
      cache.set(key, out);
    }
    return out;
  };

  const relax = (to: number, c: number, k: number, n: number) => {
    if (c < cost[to]) { cost[to] = c; kind[to] = k; size[to] = n; }
  };

  // Long texts: only explore letters near where this atom's share of the ink
  // says they should be. Short texts search everything.
  const widthBefore = new Float64Array(K + 1);
  for (let i = 0; i < K; i++) widthBefore[i + 1] = widthBefore[i] + atoms[i].x1 - atoms[i].x0 + 1;
  const band = N <= 250 ? N : Math.max(60, Math.ceil(N * 0.15));

  for (let i = 0; i <= K; i++) {
    const center = Math.round((N * widthBefore[i]) / Math.max(1, widthBefore[K]));
    const jFrom = Math.max(0, center - band);
    const jTo = Math.min(N, center + band);
    for (let j = jFrom; j <= jTo; j++) {
      const here = cost[i * S + j];
      if (here === Infinity) continue;
      if (i < K) relax((i + 1) * S + j, here + skipAtom[i], 1, 1);
      if (j < N) relax(i * S + j + 1, here + SKIP_LETTER, 2, 1);
      if (i === K || j === N) continue;
      const join = joinCost(i, j);

      // One letter from n neighbouring atoms of the same row.
      let box: Box = { x0: atoms[i].x0, x1: atoms[i].x1, y0: atoms[i].y0, y1: atoms[i].y1 };
      let groupArea = atoms[i].area;
      let gapCost = 0;
      const strokes = priors[j][3];
      for (let n = 1; n <= 4 && i + n <= K; n++) {
        if (n > 1) {
          const a = atoms[i + n - 1];
          if (a.row !== atoms[i].row) break;
          const gap = (a.x0 - box.x1) / s;
          if (gap > 1.5) break;
          gapCost += 1.0 * Math.max(0, gap - 0.25);
          box = { x0: Math.min(box.x0, a.x0), x1: Math.max(box.x1, a.x1), y0: Math.min(box.y0, a.y0), y1: Math.max(box.y1, a.y1) };
          groupArea += a.area;
        }
        let strokeCost = 0;
        if (n < strokes) strokeCost = 0.9 * (strokes - n);
        else if (n > strokes) {
          // Extra small marks (dots, accents, broken bits) are cheap; extra letters are not.
          for (let t = strokes; t < n; t++) {
            const small = [...atoms.slice(i, i + n)].sort((p, q) => p.area - q.area)[t - strokes];
            strokeCost += small.area < groupArea * 0.25 ? 0.35 : 0.9;
          }
        }
        const c = here + join + gapCost + strokeCost + glyphCost(box, atoms[i].row, j, letters, priors, geo);
        relax((i + n) * S + j + 1, c, 3, n);
      }

      // m letters joined in one atom, or in n atoms that overlap (an f bar over the
      // next letter's stem, with that letter's dot as a second atom).
      for (let n = 1; n <= 2 && i + n <= K; n++) {
        if (n > 1 && (atoms[i + 1].row !== atoms[i].row || atoms[i + 1].x0 - atoms[i].x1 > 0.3 * s)) break;
        const a = combined(i, n);
        const aw = a.x1 - a.x0 + 1;
        let expected = priors[j][2];
        let strokes = priors[j][3];
        for (let m = 2; m <= MAX_JOINED && j + m <= N; m++) {
          if (letters[j + m - 1].lineStart) break;
          expected += priors[j + m - 1][2];
          strokes += priors[j + m - 1][3];
          const ratio = aw / (expected * s);
          if (ratio < 0.5) break;
          if (ratio > 2) continue;
          const to = (i + n) * S + j + m;
          if (here + join + SPLIT_BASE * (m - 1) >= cost[to]) continue;
          const split = splitAtom(a, letters, priors, j, m);
          if (!split) continue;
          let c = here + join + SPLIT_BASE * (m - 1) + split.ink * 1.5 + 0.9 * Math.max(0, n - strokes);
          for (let t = 0; t < m; t++) {
            c += glyphCost(split.boxes[t], a.row, j + t, letters, priors, geo);
            if (t > 0 && letters[j + t].spaceBefore) c += 0.6;
          }
          relax(to, c, 4, n * 16 + m);
        }
      }
    }
  }

  const ops: AlignOp[] = [];
  let i = K;
  let j = N;
  while (i > 0 || j > 0) {
    const at = i * S + j;
    const k = kind[at];
    const n = size[at];
    if (k === 1) { ops.push({ kind: 'skipAtom', atom: i - 1 }); i--; }
    else if (k === 2) { ops.push({ kind: 'skipLetter', letter: j - 1 }); j--; }
    else if (k === 3) { ops.push({ kind: 'merge', letter: j - 1, atoms: Array.from({ length: n }, (_, t) => i - n + t) }); i -= n; j--; }
    else if (k === 4) {
      const na = n >> 4;
      const m = n & 15;
      const split = splitAtom(combined(i - na, na), letters, priors, j - m, m)!;
      ops.push({
        kind: 'split',
        atoms: Array.from({ length: na }, (_, t) => i - na + t),
        letters: Array.from({ length: m }, (_, t) => j - m + t),
        cuts: split.cuts,
      });
      i -= na; j -= m;
    } else break;
  }
  return ops.reverse();
}

/** Column profile of several atoms taken together. */
function combineAtoms(list: AtomFeat[]): AtomFeat {
  const x0 = Math.min(...list.map((a) => a.x0));
  const x1 = Math.max(...list.map((a) => a.x1));
  const w = x1 - x0 + 1;
  const cols = new Uint32Array(w);
  const colTop = new Int32Array(w).fill(2 ** 30);
  const colBot = new Int32Array(w).fill(-1);
  for (const a of list) {
    for (let c = 0; c < a.cols.length; c++) {
      if (!a.cols[c]) continue;
      const t = a.x0 - x0 + c;
      cols[t] += a.cols[c];
      colTop[t] = Math.min(colTop[t], a.colTop[c]);
      colBot[t] = Math.max(colBot[t], a.colBot[c]);
    }
  }
  let peak = 1;
  for (const v of cols) if (v > peak) peak = v;
  return {
    row: list[0].row, x0, x1,
    y0: Math.min(...list.map((a) => a.y0)), y1: Math.max(...list.map((a) => a.y1)),
    area: list.reduce((s, a) => s + a.area, 0), cols, colTop, colBot, peak,
  };
}

/** Cuts one atom into m letters at the thinnest ink near width-proportional positions. */
function splitAtom(a: AtomFeat, letters: LetterSpec[], priors: (readonly number[])[], j: number, m: number) {
  const w = a.x1 - a.x0 + 1;
  if (w < m * 2) return null;
  const weights = Array.from({ length: m }, (_, t) => priors[j + t][2] + 0.1);
  const total = weights.reduce((x, y) => x + y, 0);
  const cuts: number[] = [];
  const boxes: Box[] = [];
  let acc = 0;
  let prev = 0;
  let ink = 0;
  for (let t = 0; t < m - 1; t++) {
    acc += weights[t];
    const target = (acc / total) * w;
    const reachCols = (Math.min(weights[t], weights[t + 1]) / total) * w * 0.45;
    const cut = thinnest(a.cols, a.peak, Math.max(prev + 1, Math.floor(target - reachCols)), Math.ceil(target + reachCols), target);
    if (cut.col <= prev) return null;
    const box = subBox(a, prev, cut.col);
    if (!box) return null;
    boxes.push(box);
    cuts.push(a.x0 + cut.col);
    ink += cut.ink;
    prev = cut.col;
  }
  const last = subBox(a, prev, w);
  if (!last) return null;
  boxes.push(last);
  return { cuts, boxes, ink };
}

/** Re-estimates the x-height scale and each row's baseline from a matching. */
function estimateGeometry(atoms: AtomFeat[], letters: LetterSpec[], priors: (readonly number[])[], ops: AlignOp[], geo: Geometry): Geometry | null {
  const placed: { row: number; box: Box; li: number }[] = [];
  for (const op of ops) {
    if (op.kind === 'merge') {
      const group = op.atoms.map((t) => atoms[t]);
      placed.push({
        row: group[0].row, li: op.letter,
        box: { x0: Math.min(...group.map((g) => g.x0)), x1: Math.max(...group.map((g) => g.x1)), y0: Math.min(...group.map((g) => g.y0)), y1: Math.max(...group.map((g) => g.y1)) },
      });
    } else if (op.kind === 'split') {
      const a = op.atoms.length === 1 ? atoms[op.atoms[0]] : combineAtoms(op.atoms.map((t) => atoms[t]));
      const edges = [a.x0, ...op.cuts, a.x1 + 1].map((x) => x - a.x0);
      op.letters.forEach((li, t) => {
        const box = subBox(a, edges[t], edges[t + 1]);
        if (box) placed.push({ row: a.row, li, box });
      });
    }
  }
  const scales = placed
    .filter((p) => priors[p.li][0] - priors[p.li][1] >= 0.8)
    .map((p) => (p.box.y1 - p.box.y0 + 1) / (priors[p.li][0] - priors[p.li][1]));
  if (scales.length < 2) return null;
  const scale = median(scales);
  const rows = Math.max(...atoms.map((a) => a.row)) + 1;
  const base: Geometry['base'] = [];
  for (let r = 0; r < rows; r++) {
    const pts: { x: number; y: number; strong: boolean }[] = [];
    for (const p of placed) {
      if (p.row !== r) continue;
      const [top, bottom] = priors[p.li];
      const strong = /[\p{L}\p{N}]/u.test(letters[p.li].c);
      const cx = (p.box.x0 + p.box.x1) / 2;
      pts.push({ x: cx, y: p.box.y1 + bottom * scale, strong });
      if (!strong) pts.push({ x: cx, y: p.box.y0 + top * scale, strong });
    }
    const use = pts.filter((p) => p.strong).length >= 3 ? pts.filter((p) => p.strong) : pts;
    if (!use.length) { base.push(null); continue; }
    let slope = 0;
    if (use.length >= 4) {
      const mx = use.reduce((t, p) => t + p.x, 0) / use.length;
      const my = use.reduce((t, p) => t + p.y, 0) / use.length;
      let sxx = 0, sxy = 0;
      for (const p of use) { sxx += (p.x - mx) ** 2; sxy += (p.x - mx) * (p.y - my); }
      slope = sxx ? Math.max(-0.2, Math.min(0.2, sxy / sxx)) : 0;
    }
    base.push({ a: median(use.map((p) => p.y - slope * p.x)), b: slope });
  }
  return { scale: Number.isFinite(scale) && scale > 2 ? scale : geo.scale, base };
}
