/**
 * Turns an image of handwriting plus the text it contains into an OpenType font.
 *
 * Pipeline: binarize (Otsu) -> connected components -> split into lines -> cluster
 * components into ink "atoms" -> globally match atoms to the typed letters
 * (glyphAlign) -> trace each glyph to vector outlines -> build OTF.
 */
import { alignGlyphs, type AtomFeat, type LetterSpec } from './glyphAlign';

export interface InkComponent { x0: number; x1: number; y0: number; y1: number; area: number }

export interface InkMap {
  width: number;
  height: number;
  /** 0 = paper, n > 0 = pixel belongs to components[n - 1]. */
  labels: Int32Array;
  components: InkComponent[];
}

/** A vertical slice [cut0, cut1) of one connected component. */
interface PiecePart { comp: number; cut0: number; cut1: number }

export interface Piece {
  parts: PiecePart[];
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  area: number;
}

export interface SampleRow {
  text: string;
  letters: string[];
  pieces: Piece[];
}

export interface Segmentation {
  rows: SampleRow[];
  error?: string;
  /** Typed characters that could not be found in the writing. */
  missing?: string[];
}

const MIN_COMPONENT_AREA = 3;
/** After flattening, paper sits near 255; anything this bright is paper even if Otsu says ink. */
const PAPER_CUTOFF = 205;
const UNITS_PER_EM = 1000;
const X_HEIGHT_UNITS = 500;
const CAP_HEIGHT_UNITS = 700;
const SIDE_BEARING = 40;

const X_HEIGHT_LETTERS = new Set('acemnorsuvwxz');
const CAP_HEIGHT_LETTERS = new Set('ABCDEFGHIKLMNOPRSTUVWXYZ0123456789bdfhklt');
const BASELINE_EXCLUDED = new Set('gjpqyQJ,;()[]{}|/@$_');

export function lettersOf(text: string): string[] {
  return Array.from(text.replace(/\s+/g, ''));
}

function otsuThreshold(hist: Uint32Array, total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let weightB = 0;
  let best = 0;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    weightB += hist[t];
    if (!weightB) continue;
    const weightF = total - weightB;
    if (!weightF) break;
    sumB += t * hist[t];
    const meanB = sumB / weightB;
    const meanF = (sum - sumB) / weightF;
    const between = weightB * weightF * (meanB - meanF) ** 2;
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return Math.min(220, Math.max(40, threshold));
}

/** Separable sliding-window max over a w x h grid. */
function maxFilter(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let t = Math.max(0, x - r); t <= Math.min(w - 1, x + r); t++) m = Math.max(m, src[y * w + t]);
      tmp[y * w + x] = m;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let t = Math.max(0, y - r); t <= Math.min(h - 1, y + r); t++) m = Math.max(m, tmp[t * w + x]);
      out[y * w + x] = m;
    }
  }
  return out;
}

/**
 * Divides out the paper's own brightness so a phone photo's shading, shadows and
 * tint all become flat white. The paper level is the brightest value around each
 * spot (on a coarse grid wider than any pen stroke), smoothed, then interpolated.
 */
function flattenBackground(gray: Uint8Array, w: number, h: number): void {
  const longest = Math.max(w, h);
  if (longest < 64) return;
  const cell = Math.max(4, Math.round(longest / 150));
  const gw = Math.ceil(w / cell);
  const gh = Math.ceil(h / cell);
  // 95th-percentile brightness of each cell, so a speck of glare doesn't count as paper.
  const grid = new Float32Array(gw * gh);
  const hist = new Uint16Array(256);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      hist.fill(0);
      let count = 0;
      for (let y = gy * cell; y < Math.min(h, (gy + 1) * cell); y++) {
        for (let x = gx * cell; x < Math.min(w, (gx + 1) * cell); x++) { hist[gray[y * w + x]]++; count++; }
      }
      let seen = 0;
      let v = 255;
      for (; v > 0; v--) { seen += hist[v]; if (seen >= count * 0.05) break; }
      grid[gy * gw + gx] = v;
    }
  }
  const sortedCells = Array.from(grid).sort((a, b) => a - b);
  const floor = Math.max(16, sortedCells[Math.floor(sortedCells.length * 0.9)] * 0.4);
  // Wide enough to see past the thickest strokes and letter bowls to the paper.
  let bg = maxFilter(grid, gw, gh, 3);
  for (let pass = 0; pass < 2; pass++) {
    const blurred = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        let s = 0;
        let c = 0;
        for (let dy = -2; dy <= 2; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= gh) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= gw) continue;
            s += bg[yy * gw + xx];
            c++;
          }
        }
        blurred[y * gw + x] = s / c;
      }
    }
    bg = blurred;
  }
  for (let y = 0; y < h; y++) {
    const fy = Math.min(gh - 1, Math.max(0, (y + 0.5) / cell - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(gh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(gw - 1, Math.max(0, (x + 0.5) / cell - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(gw - 1, x0 + 1);
      const tx = fx - x0;
      const top = bg[y0 * gw + x0] * (1 - tx) + bg[y0 * gw + x1] * tx;
      const bot = bg[y1 * gw + x0] * (1 - tx) + bg[y1 * gw + x1] * tx;
      // Floor at a share of the page's paper so a wide solid ink area isn't taken for paper;
      // anything darker (a desk) stays dark and is dropped later as an edge blob.
      const paper = Math.max(floor, top * (1 - ty) + bot * ty);
      const i = y * w + x;
      gray[i] = Math.min(255, Math.round((gray[i] * 255) / paper));
    }
  }
}

/** Median length of horizontal ink runs: the pen's stroke width in pixels. */
function strokeWidth(labels: Int32Array, w: number, h: number): number {
  const runs = new Uint32Array(64);
  let total = 0;
  for (let y = 0; y < h; y += 2) {
    let run = 0;
    for (let x = 0; x <= w; x++) {
      if (x < w && labels[y * w + x] === -1) { run++; continue; }
      if (run) { runs[Math.min(63, run)]++; total++; run = 0; }
    }
  }
  if (!total) return 1;
  let seen = 0;
  for (let r = 1; r < 64; r++) { seen += runs[r]; if (seen * 2 >= total) return r; }
  return 63;
}

export function buildInkMap(img: ImageData): InkMap {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const gray = new Uint8Array(n);
  const chroma = new Uint8Array(n);
  const hueBin = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3] / 255;
    const r = data[i * 4] * a + 255 * (1 - a);
    const g = data[i * 4 + 1] * a + 255 * (1 - a);
    const b = data[i * 4 + 2] * a + 255 * (1 - a);
    gray[i] = (r * 0.299 + g * 0.587 + b * 0.114) | 0;
    const max = Math.max(r, g, b);
    const c = max - Math.min(r, g, b);
    // Chroma relative to brightness, so colors survive in a dim corner of a photo.
    chroma[i] = max > 0 ? Math.min(255, Math.round((c * 255) / Math.max(max, 128))) : 0;
    if (c > 0) {
      const hue = max === r ? ((g - b) / c + 6) % 6 : max === g ? (b - r) / c + 2 : (r - g) / c + 4;
      hueBin[i] = Math.min(35, (hue * 6) | 0);
    }
  }
  flattenBackground(gray, w, h);
  let hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[gray[i]]++;
  let threshold = Math.min(PAPER_CUTOFF, otsuThreshold(hist, n));

  // Drop colored marks that are not the pen (red spell-check squiggles, highlighter,
  // colored ruling): with dark ink every strongly colored pixel goes; with colored
  // ink only pixels far from the pen's hue go. Otherwise a squiggle under a line
  // glues all its letters into one blob.
  const COLORED = 90;
  let dark = 0;
  let colored = 0;
  const hueCount = new Uint32Array(36);
  for (let i = 0; i < n; i++) {
    if (gray[i] > threshold) continue;
    dark++;
    if (chroma[i] >= COLORED) {
      colored++;
      hueCount[hueBin[i]]++;
    }
  }
  if (colored > 0) {
    const coloredPen = colored > dark * 0.5;
    const penHue = hueCount.indexOf(Math.max(...hueCount));
    const offHue = (bin: number) => Math.min(Math.abs(bin - penHue), 36 - Math.abs(bin - penHue)) > 3;
    hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) {
      if (chroma[i] >= COLORED && (!coloredPen || offHue(hueBin[i]))) gray[i] = 255;
      hist[gray[i]]++;
    }
    threshold = Math.min(PAPER_CUTOFF, otsuThreshold(hist, n));
  }

  const labels = new Int32Array(n);
  for (let i = 0; i < n; i++) if (gray[i] <= threshold) labels[i] = -1;
  const pen = strokeWidth(labels, w, h);

  const found: InkComponent[] = [];
  const stack = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (labels[start] !== -1) continue;
    const id = found.length + 1;
    const comp: InkComponent = { x0: w, x1: 0, y0: h, y1: 0, area: 0 };
    let sp = 0;
    stack[sp++] = start;
    labels[start] = id;
    while (sp) {
      const p = stack[--sp];
      const x = p % w;
      const y = (p - x) / w;
      comp.area++;
      if (x < comp.x0) comp.x0 = x;
      if (x > comp.x1) comp.x1 = x;
      if (y < comp.y0) comp.y0 = y;
      if (y > comp.y1) comp.y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (labels[q] === -1) {
            labels[q] = id;
            stack[sp++] = q;
          }
        }
      }
    }
    found.push(comp);
  }

  // Photo noise, paper grain and JPEG specks are far smaller than a pen dot; page
  // edges, desk and shadow blobs are large, solid and touch the border.
  const minArea = Math.max(MIN_COMPONENT_AREA, Math.round(Math.min(pen * pen * 0.5, (Math.max(w, h) / 100) ** 2)));
  const keep = new Int32Array(found.length + 1);
  const components: InkComponent[] = [];
  found.forEach((c, i) => {
    const bw = c.x1 - c.x0 + 1;
    const bh = c.y1 - c.y0 + 1;
    const touchesEdge = c.x0 === 0 || c.y0 === 0 || c.x1 === w - 1 || c.y1 === h - 1;
    const solid = c.area > bw * bh * 0.5 && bw > pen * 12 && bh > pen * 12;
    const edgeBlob = touchesEdge && (bw > w * 0.3 || bh > h * 0.3) && c.area > bw * bh * 0.35;
    if (c.area < minArea || solid || edgeBlob) return;
    components.push(c);
    keep[i + 1] = components.length;
  });
  if (components.length !== found.length) for (let i = 0; i < n; i++) if (labels[i]) labels[i] = keep[labels[i]];
  return { width: w, height: h, labels, components };
}

function isValid(c: InkComponent) {
  return c.area >= MIN_COMPONENT_AREA;
}

function measure(ink: InkMap, parts: PiecePart[]): Piece {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, area = 0;
  const { width: w, labels, components } = ink;
  for (const part of parts) {
    const c = components[part.comp - 1];
    const fromX = Math.max(c.x0, part.cut0);
    const toX = Math.min(c.x1, part.cut1 - 1);
    for (let y = c.y0; y <= c.y1; y++) {
      const row = y * w;
      for (let x = fromX; x <= toX; x++) {
        if (labels[row + x] !== part.comp) continue;
        area++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return { parts, x0, x1, y0, y1, area };
}

function columnInk(ink: InkMap, piece: Piece): Uint32Array {
  const cols = new Uint32Array(piece.x1 - piece.x0 + 1);
  const { width: w, labels, components } = ink;
  for (const part of piece.parts) {
    const c = components[part.comp - 1];
    const fromX = Math.max(c.x0, part.cut0, piece.x0);
    const toX = Math.min(c.x1, part.cut1 - 1, piece.x1);
    for (let y = c.y0; y <= c.y1; y++) {
      const row = y * w;
      for (let x = fromX; x <= toX; x++) if (labels[row + x] === part.comp) cols[x - piece.x0]++;
    }
  }
  return cols;
}

export function mergePieces(ink: InkMap, a: Piece, b: Piece): Piece {
  return measure(ink, [...a.parts, ...b.parts]);
}

/** Thinnest ink column (relative to piece.x0) within [from, to], preferring columns near `target`. */
function thinnestColumn(cols: Uint32Array, from: number, to: number, target: number): number {
  const peak = Math.max(1, ...cols);
  let best = Math.round(target);
  let bestScore = Infinity;
  for (let i = Math.max(1, from); i <= to && i < cols.length - 1; i++) {
    const score = cols[i] / peak + (Math.abs(i - target) / Math.max(1, to - from)) * 0.35;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/** Splits at the thinnest ink column in the middle half of the piece. */
export function splitPiece(ink: InkMap, piece: Piece): [Piece, Piece] | null {
  const width = piece.x1 - piece.x0 + 1;
  if (width < 4) return null;
  const cols = columnInk(ink, piece);
  const bestCol = thinnestColumn(cols, Math.floor(width * 0.25), Math.ceil(width * 0.75), width / 2);
  return cutPiece(ink, piece, piece.x0 + bestCol);
}

function cutPiece(ink: InkMap, piece: Piece, cut: number): [Piece, Piece] | null {
  const left: PiecePart[] = [];
  const right: PiecePart[] = [];
  for (const p of piece.parts) {
    if (p.cut0 < cut) left.push({ comp: p.comp, cut0: p.cut0, cut1: Math.min(p.cut1, cut) });
    if (p.cut1 > cut) right.push({ comp: p.comp, cut0: Math.max(p.cut0, cut), cut1: p.cut1 });
  }
  const a = measure(ink, left);
  const b = measure(ink, right);
  if (!a.area || !b.area) return null;
  return [a, b];
}

const HIGH_MARK_CHARS = /['"`^*°‘’“”]/;

/**
 * Folds small marks that sit above a letter (i/j dots, accents) into that letter.
 * Handwritten dots often drift sideways off the stem, so the overlap test in
 * clusterRow misses them and they would otherwise become an extra "letter".
 */
function attachMarks(ink: InkMap, pieces: Piece[], text: string): Piece[] {
  if (pieces.length < 2) return pieces;
  const areaMedian = median(pieces.map((p) => p.area));
  const widthMedian = median(pieces.map((p) => p.x1 - p.x0 + 1)) || 1;
  const heightMedian = median(pieces.map((p) => p.y1 - p.y0 + 1)) || 1;
  // A text with apostrophes or quotes has real standalone high marks, so only
  // attach marks that actually overlap a letter horizontally.
  const maxGap = HIGH_MARK_CHARS.test(text) ? 0 : widthMedian * 0.35;
  const isMark = (p: Piece) => p.area < areaMedian * 0.25;
  const out = [...pieces];
  for (let i = 0; i < out.length; i++) {
    const p = out[i];
    if (!isMark(p)) continue;
    let best = -1;
    let bestGap = Infinity;
    for (let j = 0; j < out.length; j++) {
      const q = out[j];
      if (j === i || q.area < p.area * 1.8) continue;
      const qh = q.y1 - q.y0 + 1;
      if (p.y1 > q.y0 + qh * 0.35) continue;
      // An i dot floats just above its stem; a mark far higher is a stray pen tick.
      if (q.y0 - p.y1 > Math.max(qh, heightMedian) * 0.9) continue;
      const gap = Math.max(0, Math.max(p.x0, q.x0) - Math.min(p.x1, q.x1));
      // Among touching candidates, the one most directly below the mark wins.
      const overlap = Math.max(0, Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0) + 1) / (p.x1 - p.x0 + 1);
      const centerDist = Math.abs((p.x0 + p.x1) / 2 - (q.x0 + q.x1) / 2) / ((q.x1 - q.x0 + 1) * 4)
        // A dot beside a tall letter's top (f, l) is less likely its own than one above a stem.
        + Math.max(0, (p.y1 - q.y0) / qh) * 2;
      if (gap <= maxGap && gap - overlap + centerDist < bestGap) {
        bestGap = gap - overlap + centerDist;
        best = j;
      }
    }
    if (best < 0) continue;
    out[best] = mergePieces(ink, out[best], p);
    out.splice(i, 1);
    i = -1;
  }
  return out.sort((a, b) => a.x0 - b.x0);
}

export function clusterRow(ink: InkMap, compIds: number[], text = '', splitSideBySide = false): Piece[] {
  const comps = compIds.map((id) => ({ id, c: ink.components[id - 1] })).sort((p, q) => p.c.x0 - q.c.x0);
  const parent = comps.map((_, i) => i);
  const rowHeight = median(comps.map((p) => p.c.y1 - p.c.y0 + 1));
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < comps.length; i++) {
    const a = comps[i].c;
    for (let j = i + 1; j < comps.length; j++) {
      const b = comps[j].c;
      if (b.x0 > a.x1) break;
      const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + 1;
      const narrower = Math.min(a.x1 - a.x0, b.x1 - b.x0) + 1;
      // Only strokes stacked above each other (i dots, : ; ! ? =) are one glyph for
      // sure; side-by-side strokes (an f bar over the next stem) stay apart and the
      // matcher decides whether they belong together.
      const vOverlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + 1;
      const shorter = Math.min(a.y1 - a.y0, b.y1 - b.y0) + 1;
      const taller = Math.max(a.y1 - a.y0 + 1, b.y1 - b.y0 + 1, rowHeight);
      if (-vOverlap > taller * 0.9) continue;
      if (overlap > narrower * 0.5 && (!splitSideBySide || vOverlap < shorter * 0.4)) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, PiecePart[]>();
  comps.forEach((p, i) => {
    const root = find(i);
    const list = groups.get(root) ?? [];
    list.push({ comp: p.id, cut0: -Infinity, cut1: Infinity });
    groups.set(root, list);
  });
  const pieces = [...groups.values()].map((parts) => measure(ink, parts)).sort((a, b) => a.x0 - b.x0);
  return attachMarks(ink, pieces, text);
}

interface Band { y0: number; y1: number }

/**
 * Splits a band at the sparsest row where the strokes on each side clearly
 * belong to different lines. Pixel density alone would also cut capitals in
 * half (dense top and bottom bars), so a cut is only kept when nearly all ink
 * sits in strokes that are mostly above or mostly below it.
 */
function splitBand(ink: InkMap, isInk: Uint8Array, band: Band, density: Float64Array, centroid: Float64Array): Band[] {
  const h = band.y1 - band.y0 + 1;
  if (h < 12) return [band];
  let peak = 0;
  for (let y = band.y0; y <= band.y1; y++) peak = Math.max(peak, density[y]);
  const margin = Math.max(3, Math.round(h * 0.15));
  const candidates: number[] = [];
  for (let y = band.y0 + margin; y <= band.y1 - margin; y++) {
    const v = density[y];
    if (v > peak * 0.35 || v > density[y - 1] || v > density[y + 1]) continue;
    let above = 0;
    let below = 0;
    for (let t = band.y0; t < y; t++) above = Math.max(above, density[t]);
    for (let t = y + 1; t <= band.y1; t++) below = Math.max(below, density[t]);
    if (v <= Math.min(above, below) * 0.45) candidates.push(y);
  }
  candidates.sort((a, b) => density[a] - density[b]);

  const { width: W, labels } = ink;
  for (const cut of candidates.slice(0, 8)) {
    const above = new Map<number, number>();
    const below = new Map<number, number>();
    for (let y = band.y0; y <= band.y1; y++) {
      const side = y < cut ? above : below;
      for (let x = 0; x < W; x++) {
        const id = labels[y * W + x];
        if (id && isInk[id]) side.set(id, (side.get(id) ?? 0) + 1);
      }
    }
    let total = 0;
    let mixed = 0;
    let topMass = 0;
    let bottomMass = 0;
    for (const id of new Set([...above.keys(), ...below.keys()])) {
      const a = above.get(id) ?? 0;
      const b = below.get(id) ?? 0;
      total += a + b;
      const share = a / (a + b);
      if (share >= 0.8) topMass += a + b;
      else if (share <= 0.2) bottomMass += a + b;
      else mixed += a + b;
    }
    // Both sides need real writing (not just i dots), and few strokes may straddle.
    const hasRow = (lo: number, hi: number) => {
      let n = 0;
      for (const id of new Set([...above.keys(), ...below.keys()])) {
        if (centroid[id] >= lo && centroid[id] <= hi) n++;
      }
      return n >= 2;
    };
    if (
      mixed <= total * 0.2 &&
      topMass >= total * 0.15 &&
      bottomMass >= total * 0.15 &&
      hasRow(band.y0, cut - 1) &&
      hasRow(cut, band.y1)
    ) {
      return [
        ...splitBand(ink, isInk, { y0: band.y0, y1: cut - 1 }, density, centroid),
        ...splitBand(ink, isInk, { y0: cut, y1: band.y1 }, density, centroid),
      ];
    }
  }
  return [band];
}

/**
 * Rows of writing from the horizontal ink density. Rows whose ascenders and
 * descenders touch are split at the sparse gap between them; thin bands (i dots
 * and accents floating above a line) are folded into their nearest line.
 */
function findLineBands(ink: InkMap, valid: number[], centroid: Float64Array, typedLines: number): Band[] {
  const { width: W, height: H, labels } = ink;
  const isInk = new Uint8Array(ink.components.length + 1);
  for (const id of valid) isInk[id] = 1;
  const raw = new Float64Array(H);
  for (let y = 0; y < H; y++) {
    let n = 0;
    for (let x = 0; x < W; x++) {
      const id = labels[y * W + x];
      if (id && isInk[id]) n++;
    }
    raw[y] = n;
  }
  const heights = valid.map((id) => ink.components[id - 1].y1 - ink.components[id - 1].y0 + 1);
  const win = Math.max(1, Math.round(median(heights) / 10));
  const density = new Float64Array(H);
  for (let y = 0; y < H; y++) {
    let s = 0;
    let c = 0;
    for (let t = Math.max(0, y - win); t <= Math.min(H - 1, y + win); t++) { s += raw[t]; c++; }
    density[y] = s / c;
  }

  const spans: Band[] = [];
  for (let y = 0; y < H; y++) {
    if (!raw[y]) continue;
    const y0 = y;
    while (y < H && raw[y]) y++;
    spans.push({ y0, y1: y - 1 });
  }
  const bands = spans.flatMap((b) => splitBand(ink, isInk, b, density, centroid));
  return foldMarkBands(bands, raw, typedLines);
}

/**
 * Folds bands that hold only stray marks (i dots, accents, a pen tick) into the
 * nearest line. Each band is judged against the typical line, measured once, so
 * a short line of digits or capitals is never folded just because a neighbour
 * grew taller by absorbing something else.
 */
function foldMarkBands(bands: Band[], raw: Float64Array, typedLines: number): Band[] {
  if (bands.length < 2) return bands;
  const height = (b: Band) => b.y1 - b.y0 + 1;
  const inkOf = (b: Band) => {
    let s = 0;
    for (let y = b.y0; y <= b.y1; y++) s += raw[y];
    return s;
  };
  const maxInk = Math.max(...bands.map(inkOf));
  const lines = bands.filter((b) => inkOf(b) >= maxInk * 0.2);
  const lineHeight = median(lines.map(height));
  const lineInk = median(lines.map(inkOf));
  const isTiny = (b: Band) => height(b) < lineHeight * 0.35 && inkOf(b) < lineInk * 0.06;
  const isMark = (b: Band) => height(b) < lineHeight * 0.5 && inkOf(b) < lineInk * 0.25;

  const out = [...bands];
  for (;;) {
    let pick = -1;
    for (let i = 0; i < out.length; i++) {
      const b = out[i];
      if (!isTiny(b) && !(out.length > typedLines && isMark(b))) continue;
      if (pick < 0 || inkOf(b) < inkOf(out[pick])) pick = i;
    }
    if (pick < 0 || out.length < 2) break;
    const above = pick > 0 ? out[pick].y0 - out[pick - 1].y1 : Infinity;
    const below = pick < out.length - 1 ? out[pick + 1].y0 - out[pick].y1 : Infinity;
    const lo = Math.min(pick, above <= below ? pick - 1 : pick + 1);
    out.splice(lo, 2, { y0: out[lo].y0, y1: out[lo + 1].y1 });
  }
  return out;
}

/** Rows of writing, each as left-to-right ink clusters (letters, or parts of one). */
function inkRows(ink: InkMap, text: string): Piece[][] | null {
  const valid = ink.components.map((c, i) => (isValid(c) ? i + 1 : 0)).filter(Boolean);
  if (!valid.length) return null;

  // Vertical centre of each stroke's ink (not its box), so a long descender or
  // ascender doesn't pull a word into the neighbouring line.
  const centroid = new Float64Array(ink.components.length + 1);
  for (const id of valid) {
    const c = ink.components[id - 1];
    let sum = 0;
    let n = 0;
    for (let y = c.y0; y <= c.y1; y++) {
      for (let x = c.x0; x <= c.x1; x++) {
        if (ink.labels[y * ink.width + x] === id) { sum += y; n++; }
      }
    }
    centroid[id] = n ? sum / n : (c.y0 + c.y1) / 2;
  }
  const typedLines = Math.max(1, text.split('\n').filter((l) => l.trim()).length);
  const bands = findLineBands(ink, valid, centroid, typedLines);
  const buckets: number[][] = bands.map(() => []);
  for (const id of valid) {
    const cy = centroid[id];
    let row = 0;
    let bestDist = Infinity;
    bands.forEach((b, i) => {
      const d = cy < b.y0 ? b.y0 - cy : cy > b.y1 ? cy - b.y1 : 0;
      if (d < bestDist) {
        bestDist = d;
        row = i;
      }
    });
    buckets[row].push(id);
  }

  const rows = buckets.map((ids) => clusterRow(ink, ids, text, true));
  // Ruling lines and underlines: long, flat strokes spanning many letters.
  const widthMedian = median(rows.flat().map((p) => p.x1 - p.x0 + 1)) || 1;
  return rows
    .map((pieces) => pieces.filter((p) => !(p.x1 - p.x0 + 1 > widthMedian * 4 && p.y1 - p.y0 + 1 < (p.x1 - p.x0 + 1) * 0.08)))
    .filter((pieces) => pieces.length);
}

function atomFeature(ink: InkMap, piece: Piece, row: number): AtomFeat {
  const w = piece.x1 - piece.x0 + 1;
  const cols = columnInk(ink, piece);
  const colTop = new Int32Array(w).fill(2 ** 30);
  const colBot = new Int32Array(w).fill(-1);
  const { width: W, labels, components } = ink;
  for (const part of piece.parts) {
    const c = components[part.comp - 1];
    const fromX = Math.max(c.x0, part.cut0, piece.x0);
    const toX = Math.min(c.x1, part.cut1 - 1, piece.x1);
    for (let y = c.y0; y <= c.y1; y++) {
      for (let x = fromX; x <= toX; x++) {
        if (labels[y * W + x] !== part.comp) continue;
        const i = x - piece.x0;
        if (y < colTop[i]) colTop[i] = y;
        if (y > colBot[i]) colBot[i] = y;
      }
    }
  }
  let peak = 1;
  for (const v of cols) if (v > peak) peak = v;
  return { row, x0: piece.x0, x1: piece.x1, y0: piece.y0, y1: piece.y1, area: piece.area, cols, colTop, colBot, peak };
}

function letterSpecs(lines: string[]): LetterSpec[] {
  const out: LetterSpec[] = [];
  lines.forEach((line) => {
    line.split(/\s+/).filter(Boolean).forEach((word, wi) => {
      Array.from(word).forEach((c, ci) => out.push({ c, spaceBefore: ci === 0 && wi > 0, lineStart: ci === 0 && wi === 0 }));
    });
  });
  return out;
}

/**
 * Matches every typed character to its ink across all rows at once (see
 * glyphAlign). `keep[i] === false` letters still claim their ink, so their
 * neighbours stay clean, but are left out of the result.
 */
function matchLetters(ink: InkMap, rowPieces: Piece[][], letters: LetterSpec[], keep?: boolean[]): Segmentation {
  const atomPieces = rowPieces.flatMap((pieces) => [...pieces].sort((a, b) => a.x0 - b.x0));
  const feats = rowPieces.flatMap((pieces, r) => [...pieces].sort((a, b) => a.x0 - b.x0).map((p) => atomFeature(ink, p, r)));
  const ops = alignGlyphs(feats, letters);
  const placed: { row: number; letter: number; piece: Piece }[] = [];
  const missing: string[] = [];
  for (const op of ops) {
    if (op.kind === 'skipLetter') missing.push(letters[op.letter].c);
    else if (op.kind === 'merge') {
      const piece = measure(ink, op.atoms.flatMap((a) => atomPieces[a].parts));
      placed.push({ row: feats[op.atoms[0]].row, letter: op.letter, piece });
    } else if (op.kind === 'split') {
      const whole = measure(ink, op.atoms.flatMap((a) => atomPieces[a].parts));
      const row = feats[op.atoms[0]].row;
      let rest: Piece | null = whole;
      const parts: Piece[] = [];
      for (const cut of op.cuts) {
        const halves: [Piece, Piece] | null = rest ? cutPiece(ink, rest, cut) : null;
        if (!halves) break;
        parts.push(halves[0]);
        rest = halves[1];
      }
      if (rest) parts.push(rest);
      if (parts.length !== op.letters.length) {
        // A cut landed on empty columns: keep the whole cluster for the first letter.
        placed.push({ row, letter: op.letters[0], piece: whole });
        op.letters.slice(1).forEach((l) => missing.push(letters[l].c));
      } else {
        op.letters.forEach((l, t) => placed.push({ row, letter: l, piece: parts[t] }));
      }
    }
  }
  const rows: SampleRow[] = [];
  for (let r = 0; r < rowPieces.length; r++) {
    const mine = placed.filter((p) => p.row === r && keep?.[p.letter] !== false).sort((a, b) => a.letter - b.letter);
    if (!mine.length) continue;
    let text = '';
    mine.forEach((p, i) => {
      const l = letters[p.letter];
      if (i > 0 && (l.spaceBefore || l.lineStart)) text += ' ';
      text += l.c;
    });
    rows.push({ text, letters: mine.map((p) => letters[p.letter].c), pieces: mine.map((p) => p.piece) });
  }
  if (!rows.length) return { rows: [], error: 'None of the text could be matched to the writing. Check the text matches the image.' };
  if (letters.length > 1 && missing.length * 2 >= letters.length) {
    return {
      rows,
      missing,
      error: `Only ${letters.length - missing.length} of ${letters.length} characters were found in the writing. Check that each typed line matches a line in the image.`,
    };
  }
  return { rows, ...(missing.length ? { missing } : {}) };
}

export function segmentSample(ink: InkMap, text: string): Segmentation {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { rows: [], error: 'Type the text that appears in the image.' };
  const rows = inkRows(ink, text);
  if (!rows) return { rows: [], error: 'No handwriting was found in this image.' };
  return matchLetters(ink, rows, letterSpecs(lines));
}

/** One character located by the AI; box is [x0, y0, x1, y1] as fractions of the image. */
export interface AiChar { c: string; box: [number, number, number, number]; sure?: boolean }
export interface AiLine { text: string; chars: AiChar[] }

/** Word number of each AI char, taken from the line text so sentences keep their spaces. */
function wordIndexes(line: AiLine): number[] {
  const words = line.text.split(/\s+/).filter(Boolean);
  const flat = words.join('');
  const chars = line.chars.map((ch) => ch.c).join('');
  if (Array.from(flat).length !== line.chars.length || flat !== chars) {
    // Box list and text disagree: fall back to gaps wider than the typical letter gap.
    const out: number[] = [];
    const gaps = line.chars.slice(1).map((ch, i) => ch.box[0] - line.chars[i].box[2]);
    const typical = [...gaps].sort((a, b) => a - b)[gaps.length >> 1] ?? 0;
    const width = median(line.chars.map((ch) => ch.box[2] - ch.box[0]));
    let w = 0;
    line.chars.forEach((_, i) => {
      if (i > 0 && gaps[i - 1] > Math.max(typical * 2.5, width * 0.45)) w++;
      out.push(w);
    });
    return out;
  }
  const out: number[] = [];
  words.forEach((word, wi) => Array.from(word).forEach(() => out.push(wi)));
  return out;
}

/**
 * Cuts out one glyph per AI-located character. The AI boxes only say roughly
 * where each character is; the real glyph is the ink inside: each connected
 * stroke goes to the box it overlaps most, and strokes shared by neighbouring
 * boxes (joined letters) are sliced at the gap between those boxes.
 */
export function segmentFromBoxes(ink: InkMap, aiLines: AiLine[]): Segmentation {
  const { width: W, height: H, labels, components } = ink;
  const lines = aiLines
    .map((l) => {
      const word = wordIndexes(l);
      return {
      chars: l.chars
        .map((ch, i) => {
          const [a, b, c, d] = ch.box;
          return {
            c: ch.c, word: word[i] ?? 0, sure: ch.sure !== false,
            x0: Math.floor(a * W), y0: Math.floor(b * H), x1: Math.ceil(c * W), y1: Math.ceil(d * H),
          };
        })
        .filter((ch) => ch.x1 > ch.x0 && ch.y1 > ch.y0 && !/\s/.test(ch.c))
        .sort((p, q) => p.x0 + p.x1 - (q.x0 + q.x1)),
      };
    })
    .filter((l) => l.chars.length);
  if (!lines.length) return { rows: [], error: 'AI did not locate any characters.' };

  // Per-line column cuts halfway through the gap (or overlap) between neighbours.
  const cuts = lines.map((l) => l.chars.slice(1).map((ch, i) => Math.round((l.chars[i].x1 + ch.x0) / 2)));
  const widths = lines.flatMap((l) => l.chars.map((ch) => ch.x1 - ch.x0)).sort((a, b) => a - b);
  const medianW = widths[widths.length >> 1] || 1;
  const parts: PiecePart[][][] = lines.map((l) => l.chars.map(() => []));

  components.forEach((comp, idx) => {
    if (!isValid(comp)) return;
    const id = idx + 1;
    const cw = comp.x1 - comp.x0 + 1;
    const ch = comp.y1 - comp.y0 + 1;
    let best: { line: number; overlap: number } | null = null;
    lines.forEach((l, li) => {
      let overlap = 0;
      for (const box of l.chars) {
        const ox = Math.min(comp.x1 + 1, box.x1) - Math.max(comp.x0, box.x0);
        const oy = Math.min(comp.y1 + 1, box.y1) - Math.max(comp.y0, box.y0);
        if (ox > 0 && oy > 0) overlap += ox * oy;
      }
      if (overlap > 0 && (!best || overlap > best.overlap)) best = { line: li, overlap };
    });
    if (!best) return;
    const { line } = best as { line: number; overlap: number };
    // Skip ruling lines and underlines: long, flat strokes spanning many characters.
    if (cw > medianW * 3 && ch < cw * 0.12) return;
    const l = lines[line];
    const boundaries = [comp.x0, ...cuts[line].filter((x) => x > comp.x0 && x <= comp.x1), comp.x1 + 1];
    for (let s = 0; s + 1 < boundaries.length; s++) {
      const cut0 = boundaries[s];
      const cut1 = boundaries[s + 1];
      const mid = (cut0 + cut1) / 2;
      let target = l.chars.findIndex((_, i) => i === l.chars.length - 1 || mid < cuts[line][i]);
      if (target < 0) target = l.chars.length - 1;
      let has = false;
      for (let y = comp.y0; y <= comp.y1 && !has; y++) {
        for (let x = cut0; x < cut1; x++) {
          if (labels[y * W + x] === id) { has = true; break; }
        }
      }
      if (has) parts[line][target].push({ comp: id, cut0, cut1 });
    }
  });

  const rows: SampleRow[] = lines.map((l, li) => {
    const letters: string[] = [];
    const pieces: Piece[] = [];
    let text = '';
    let lastWord = -1;
    l.chars.forEach((box, i) => {
      // Unsure glyphs still claim their ink (so neighbours stay clean) but are not used.
      if (!box.sure || !parts[li][i].length) return;
      const piece = measure(ink, parts[li][i]);
      if (piece.area < MIN_COMPONENT_AREA) return;
      if (lastWord >= 0 && box.word !== lastWord) text += ' ';
      text += box.c;
      lastWord = box.word;
      letters.push(box.c);
      pieces.push(piece);
    });
    return { text, letters, pieces };
  }).filter((r) => r.letters.length);
  if (!rows.length) return { rows: [], error: 'No ink was found inside the characters the AI located.' };
  return { rows };
}

/**
 * Picks the best glyph cut-out for an AI reading. The AI's per-character boxes
 * win whenever they cover nearly every character: they say which ink is which
 * letter, so equal counts can't hide a shifted row. Text-only segmentation is
 * the fallback when boxes are missing or sparse.
 */
/**
 * Pairs each letter of an AI line with the AI char that names it. The box list
 * can disagree with the line text (a dropped or extra char), so they are lined
 * up by longest common subsequence instead of by position.
 */
function aiCharFor(letters: string[], chars: AiChar[]): (AiChar | undefined)[] {
  const n = letters.length;
  const m = chars.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = letters[i] === chars[j].c ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: (AiChar | undefined)[] = new Array(n).fill(undefined);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (letters[i] === chars[j].c) { out[i++] = chars[j++]; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  return out;
}

/**
 * Segments using an AI reading: the AI's text says which characters to find,
 * and its per-character boxes pull each match toward where the AI saw it. The
 * ink itself still decides the exact cut, so loose AI boxes can't slice letters.
 */
export function segmentWithAi(ink: InkMap, aiLines: AiLine[]): Segmentation & { text: string; source: 'text' | 'boxes' } {
  const lines = aiLines.filter((l) => l.text.trim());
  const text = lines.map((l) => l.text.trim()).join('\n');
  if (!lines.length) return { rows: [], error: 'AI did not find any characters.', text, source: 'text' };
  const rows = inkRows(ink, text);
  if (!rows) return { rows: [], error: 'No handwriting was found in this image.', text, source: 'text' };
  const letters = letterSpecs(lines.map((l) => l.text.trim()));
  const keep: boolean[] = [];
  let hinted = 0;
  let li = 0;
  for (const line of lines) {
    const own = lettersOf(line.text);
    const chars = aiCharFor(own, line.chars ?? []);
    own.forEach((_, i) => {
      const ch = chars[i];
      const spec = letters[li++];
      keep.push(ch?.sure !== false);
      if (!ch) return;
      const [x0, y0, x1, y1] = ch.box;
      spec.hint = { cx: ((x0 + x1) / 2) * ink.width, cy: ((y0 + y1) / 2) * ink.height };
      hinted++;
    });
  }
  return { ...matchLetters(ink, rows, letters, keep), text, source: hinted ? 'boxes' : 'text' };
}

export function rowMatched(row: SampleRow) {
  return row.pieces.length === row.letters.length && row.letters.length > 0;
}

function median(values: number[]): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Least-squares baseline through glyph bottoms, so slanted lines stay level. */
function fitBaseline(row: SampleRow): (x: number) => number {
  const pts = row.pieces
    .map((p, i) => ({ x: (p.x0 + p.x1) / 2, y: p.y1, ch: row.letters[i] }))
    .filter((p) => p.ch && !BASELINE_EXCLUDED.has(p.ch) && /[\p{L}\p{N}]/u.test(p.ch));
  const source = pts.length ? pts : row.pieces.map((p) => ({ x: (p.x0 + p.x1) / 2, y: p.y1 }));
  if (source.length < 3) {
    const base = median(source.map((p) => p.y));
    return () => base;
  }
  const n = source.length;
  const mx = source.reduce((a, p) => a + p.x, 0) / n;
  const my = source.reduce((a, p) => a + p.y, 0) / n;
  let sxx = 0, sxy = 0;
  for (const p of source) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  const slope = sxx ? Math.max(-0.3, Math.min(0.3, sxy / sxx)) : 0;
  const residuals = source.map((p) => p.y - (my + slope * (p.x - mx)));
  const offset = median(residuals);
  return (x: number) => my + offset + slope * (x - mx);
}

interface Candidate { ink: InkMap; piece: Piece; base: number; scale: number }

export interface SampleInput { ink: InkMap; rows: SampleRow[] }

export interface BuiltFont { buffer: ArrayBuffer; chars: string[] }

interface TraceSegment { type: 'L' | 'Q'; x1: number; y1: number; x2: number; y2: number; x3?: number; y3?: number }
interface TracePath { segments: TraceSegment[]; isholepath: boolean }

function signedArea(pts: [number, number][]) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export async function buildFontFromSamples(familyName: string, samples: SampleInput[]): Promise<BuiltFont> {
  const [opentype, tracerModule] = await Promise.all([import('opentype.js'), import('imagetracerjs')]);
  const tracer = tracerModule.default;

  const candidates = new Map<string, Candidate[]>();
  const spaceGaps: number[] = [];

  for (const { ink, rows } of samples) {
    const matched = rows.filter(rowMatched);
    if (!matched.length) continue;
    const baselines = matched.map(fitBaseline);
    const xh: number[] = [];
    const cap: number[] = [];
    const heights: number[] = [];
    matched.forEach((row, r) => {
      row.pieces.forEach((p, i) => {
        const ch = row.letters[i];
        const h = baselines[r]((p.x0 + p.x1) / 2) - p.y0;
        heights.push(p.y1 - p.y0 + 1);
        if (X_HEIGHT_LETTERS.has(ch)) xh.push(h);
        else if (CAP_HEIGHT_LETTERS.has(ch)) cap.push(h);
      });
    });
    const scale = xh.length >= 2
      ? X_HEIGHT_UNITS / median(xh)
      : cap.length
        ? CAP_HEIGHT_UNITS / median(cap)
        : CAP_HEIGHT_UNITS / median(heights);
    if (!Number.isFinite(scale) || scale <= 0) continue;

    matched.forEach((row, r) => {
      const words = row.text.split(/\s+/).filter(Boolean).map((w) => Array.from(w).length);
      let index = 0;
      words.forEach((len, w) => {
        index += len;
        if (w < words.length - 1) {
          const gap = row.pieces[index].x0 - row.pieces[index - 1].x1;
          if (gap > 0) spaceGaps.push(gap * scale);
        }
      });
      row.pieces.forEach((piece, i) => {
        const ch = row.letters[i];
        const list = candidates.get(ch) ?? [];
        list.push({ ink, piece, base: baselines[r]((piece.x0 + piece.x1) / 2), scale });
        candidates.set(ch, list);
      });
    });
  }

  if (!candidates.size) throw new Error('No line matched its text yet.');

  const glyphs = [new opentype.Glyph({ name: '.notdef', unicode: 0, advanceWidth: 500, path: new opentype.Path() })];
  const spaceWidth = Math.round(Math.max(160, Math.min(600, (median(spaceGaps) || 300) - SIDE_BEARING * 2)));
  glyphs.push(new opentype.Glyph({ name: 'space', unicode: 32, advanceWidth: spaceWidth, path: new opentype.Path() }));
  glyphs.push(new opentype.Glyph({ name: 'uni00A0', unicode: 160, advanceWidth: spaceWidth, path: new opentype.Path() }));

  let top = 0;
  let bottom = 0;
  const chars: string[] = [];
  const pad = 2;

  for (const [ch, list] of candidates) {
    // A paragraph gives many copies of each letter; use the most typical one so a
    // rushed or mis-cut copy never becomes the glyph.
    const size = (c: Candidate) => ({
      w: (c.piece.x1 - c.piece.x0 + 1) * c.scale,
      h: (c.piece.y1 - c.piece.y0 + 1) * c.scale,
      a: c.piece.area * c.scale * c.scale,
      d: (c.piece.y1 - c.base) * c.scale,
    });
    const sizes = list.map(size);
    const mw = median(sizes.map((s) => s.w)) || 1;
    const mh = median(sizes.map((s) => s.h)) || 1;
    const ma = median(sizes.map((s) => s.a)) || 1;
    const md = median(sizes.map((s) => s.d));
    let bestIndex = 0;
    let bestScore = Infinity;
    sizes.forEach((s, i) => {
      const score = Math.abs(Math.log(s.w / mw)) + Math.abs(Math.log(s.h / mh)) + 0.5 * Math.abs(Math.log(s.a / ma)) + Math.abs(s.d - md) / mh;
      if (score < bestScore) { bestScore = score; bestIndex = i; }
    });
    const { ink, piece, base, scale } = list[bestIndex];

    const gw = piece.x1 - piece.x0 + 1 + pad * 2;
    const gh = piece.y1 - piece.y0 + 1 + pad * 2;
    const data = new Uint8ClampedArray(gw * gh * 4).fill(255);
    for (const part of piece.parts) {
      const c = ink.components[part.comp - 1];
      const fromX = Math.max(c.x0, part.cut0);
      const toX = Math.min(c.x1, part.cut1 - 1);
      for (let y = c.y0; y <= c.y1; y++) {
        for (let x = fromX; x <= toX; x++) {
          if (ink.labels[y * ink.width + x] !== part.comp) continue;
          const o = ((y - piece.y0 + pad) * gw + (x - piece.x0 + pad)) * 4;
          data[o] = data[o + 1] = data[o + 2] = 0;
        }
      }
    }

    const traced = tracer.imagedataToTracedata({ width: gw, height: gh, data }, {
      ltres: 0.8,
      qtres: 0.8,
      pathomit: 4,
      rightangleenhance: false,
      colorsampling: 0,
      numberofcolors: 2,
      colorquantcycles: 1,
      blurradius: 0,
      pal: [{ r: 0, g: 0, b: 0, a: 255 }, { r: 255, g: 255, b: 255, a: 255 }],
    });

    const toX = (px: number) => Math.round((px - pad) * scale + SIDE_BEARING);
    const toY = (py: number) => Math.round((base - (py - pad + piece.y0)) * scale);
    const path = new opentype.Path();
    for (const tp of (traced.layers[0] ?? []) as TracePath[]) {
      let segs = tp.segments;
      if (!segs.length) continue;
      const area = signedArea(segs.map((s) => [toX(s.x1), toY(s.y1)] as [number, number]));
      if ((area > 0) === tp.isholepath) {
        segs = [...segs].reverse().map((s) =>
          s.type === 'Q'
            ? { type: 'Q', x1: s.x3!, y1: s.y3!, x2: s.x2, y2: s.y2, x3: s.x1, y3: s.y1 }
            : { type: 'L', x1: s.x2, y1: s.y2, x2: s.x1, y2: s.y1 },
        );
      }
      path.moveTo(toX(segs[0].x1), toY(segs[0].y1));
      for (const s of segs) {
        if (s.type === 'Q') path.quadraticCurveTo(toX(s.x2), toY(s.y2), toX(s.x3!), toY(s.y3!));
        else path.lineTo(toX(s.x2), toY(s.y2));
      }
      path.close();
    }

    top = Math.max(top, toY(pad));
    bottom = Math.min(bottom, toY(gh - pad));
    const code = ch.codePointAt(0)!;
    glyphs.push(new opentype.Glyph({
      name: `uni${code.toString(16).toUpperCase().padStart(4, '0')}`,
      unicode: code,
      advanceWidth: Math.round((piece.x1 - piece.x0 + 1) * scale + SIDE_BEARING * 2),
      path,
    }));
    chars.push(ch);
  }

  const font = new opentype.Font({
    familyName: familyName || 'My Handwriting',
    styleName: 'Regular',
    unitsPerEm: UNITS_PER_EM,
    ascender: Math.max(800, top),
    descender: Math.min(-250, bottom),
    glyphs,
  });
  return { buffer: font.toArrayBuffer(), chars: chars.sort() };
}

export async function loadSampleImage(file: File): Promise<{ ink: InkMap; url: string; aiImage: string }> {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
  const natW = img.naturalWidth || 1600;
  const natH = img.naturalHeight || 400;
  const longest = Math.max(natW, natH);
  const scale = isSvg ? 3000 / longest : Math.min(1, 3000 / longest);
  const w = Math.max(1, Math.round(natW * scale));
  const h = Math.max(1, Math.round(natH * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const ink = buildInkMap(ctx.getImageData(0, 0, w, h));
  const aiScale = Math.min(1, 1600 / Math.max(w, h));
  const small = document.createElement('canvas');
  small.width = Math.max(1, Math.round(w * aiScale));
  small.height = Math.max(1, Math.round(h * aiScale));
  small.getContext('2d')!.drawImage(canvas, 0, 0, small.width, small.height);
  return { ink, url, aiImage: small.toDataURL('image/jpeg', 0.9) };
}
