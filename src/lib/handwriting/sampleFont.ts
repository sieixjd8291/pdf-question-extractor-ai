/**
 * Turns an image of handwriting plus the text it contains into an OpenType font.
 *
 * Pipeline: binarize (Otsu) -> connected components -> split into lines -> cluster
 * components into glyph "pieces" -> match pieces to the typed letters (word gaps,
 * then merge/split per word) -> trace each piece to vector outlines -> build OTF.
 */

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
}

const MIN_COMPONENT_AREA = 3;
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

export function buildInkMap(img: ImageData): InkMap {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const gray = new Uint8Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3] / 255;
    const lum = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114;
    const v = (lum * a + 255 * (1 - a)) | 0;
    gray[i] = v;
    hist[v]++;
  }
  const threshold = otsuThreshold(hist, n);

  const labels = new Int32Array(n);
  for (let i = 0; i < n; i++) if (gray[i] <= threshold) labels[i] = -1;

  const components: InkComponent[] = [];
  const stack = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (labels[start] !== -1) continue;
    const id = components.length + 1;
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
    components.push(comp);
  }
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

/** Splits at the thinnest ink column in the middle half of the piece. */
export function splitPiece(ink: InkMap, piece: Piece): [Piece, Piece] | null {
  const width = piece.x1 - piece.x0 + 1;
  if (width < 4) return null;
  const cols = columnInk(ink, piece);
  const from = Math.floor(width * 0.25);
  const to = Math.ceil(width * 0.75);
  const mid = width / 2;
  let bestCol = Math.round(mid);
  let bestScore = Infinity;
  for (let i = from; i <= to && i < width; i++) {
    const score = cols[i] + Math.abs(i - mid) * 0.02;
    if (score < bestScore) {
      bestScore = score;
      bestCol = i;
    }
  }
  const cut = piece.x0 + bestCol;
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

export function clusterRow(ink: InkMap, compIds: number[]): Piece[] {
  const comps = compIds.map((id) => ({ id, c: ink.components[id - 1] })).sort((p, q) => p.c.x0 - q.c.x0);
  const parent = comps.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < comps.length; i++) {
    const a = comps[i].c;
    for (let j = i + 1; j < comps.length; j++) {
      const b = comps[j].c;
      if (b.x0 > a.x1) break;
      const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + 1;
      const narrower = Math.min(a.x1 - a.x0, b.x1 - b.x0) + 1;
      if (overlap > narrower * 0.5) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, PiecePart[]>();
  comps.forEach((p, i) => {
    const root = find(i);
    const list = groups.get(root) ?? [];
    list.push({ comp: p.id, cut0: -Infinity, cut1: Infinity });
    groups.set(root, list);
  });
  return [...groups.values()].map((parts) => measure(ink, parts)).sort((a, b) => a.x0 - b.x0);
}

function fitWord(ink: InkMap, group: Piece[], count: number): Piece[] {
  const pieces = [...group];
  const letterWidth = median(pieces.map((p) => p.x1 - p.x0 + 1)) || 1;
  while (pieces.length > count && pieces.length > 1) {
    let best = 0;
    let bestCost = Infinity;
    for (let i = 0; i < pieces.length - 1; i++) {
      const a = pieces[i];
      const b = pieces[i + 1];
      // Small marks (i/j dots, accents) next to a letter are the likeliest leftovers.
      const cost = (b.x0 - a.x1) / letterWidth + Math.min(a.area, b.area) / Math.max(a.area, b.area);
      if (cost < bestCost) {
        bestCost = cost;
        best = i;
      }
    }
    pieces.splice(best, 2, mergePieces(ink, pieces[best], pieces[best + 1]));
  }
  let guard = 0;
  while (pieces.length < count && guard++ < 400) {
    let widest = 0;
    for (let i = 1; i < pieces.length; i++) {
      if (pieces[i].x1 - pieces[i].x0 > pieces[widest].x1 - pieces[widest].x0) widest = i;
    }
    const halves = splitPiece(ink, pieces[widest]);
    if (!halves) break;
    pieces.splice(widest, 1, ...halves);
  }
  return pieces;
}

/** Matches pieces of one line of writing to the words of one line of text. */
function autoAssign(ink: InkMap, pieces: Piece[], text: string): Piece[] {
  const words = text.split(/\s+/).filter(Boolean).map((w) => Array.from(w).length);
  const k = pieces.length;
  const W = words.length;
  if (!k || !W) return pieces;
  if (W === 1 || k < W) return fitWord(ink, pieces, words.reduce((a, b) => a + b, 0));

  // gapBefore[i]: clear space between piece i and everything to its left, in letter widths.
  const letterWidth = median(pieces.map((p) => p.x1 - p.x0 + 1)) || 1;
  const gapBefore = new Float64Array(k);
  let reach = pieces[0].x1;
  for (let i = 1; i < k; i++) {
    gapBefore[i] = (pieces[i].x0 - reach) / letterWidth;
    reach = Math.max(reach, pieces[i].x1);
  }

  // Choose word breaks that sit on wide gaps AND give each word about as many
  // pieces as it has letters; plain "largest gaps" fails on tight handwriting.
  const MISMATCH_COST = 0.45;
  const score: number[][] = Array.from({ length: W + 1 }, () => new Array(k + 1).fill(-Infinity));
  const from: number[][] = Array.from({ length: W + 1 }, () => new Array(k + 1).fill(-1));
  score[0][0] = 0;
  for (let w = 1; w <= W; w++) {
    for (let end = w; end <= k - (W - w); end++) {
      for (let start = w - 1; start < end; start++) {
        const prev = score[w - 1][start];
        if (prev === -Infinity) continue;
        const s = prev + (w > 1 ? gapBefore[start] : 0) - MISMATCH_COST * Math.abs(end - start - words[w - 1]);
        if (s > score[w][end]) {
          score[w][end] = s;
          from[w][end] = start;
        }
      }
    }
  }
  const bounds: number[] = [k];
  for (let w = W, end = k; w > 0; w--) {
    end = from[w][end];
    bounds.unshift(end);
  }
  const out: Piece[] = [];
  for (let w = 0; w < W; w++) out.push(...fitWord(ink, pieces.slice(bounds[w], bounds[w + 1]), words[w]));
  return out;
}

export function segmentSample(ink: InkMap, text: string): Segmentation {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { rows: [], error: 'Type the text that appears in the image.' };
  const valid = ink.components.map((c, i) => (isValid(c) ? i + 1 : 0)).filter(Boolean);
  if (!valid.length) return { rows: [], error: 'No handwriting was found in this image.' };

  const profile = new Uint32Array(ink.height);
  for (const id of valid) {
    const c = ink.components[id - 1];
    for (let y = c.y0; y <= c.y1; y++) profile[y]++;
  }
  let first = 0;
  while (first < ink.height && !profile[first]) first++;
  let last = ink.height - 1;
  while (last > 0 && !profile[last]) last--;

  const separators: number[] = [];
  if (lines.length > 1) {
    const gaps: { mid: number; size: number }[] = [];
    let y = first;
    while (y <= last) {
      if (profile[y]) {
        y++;
        continue;
      }
      const start = y;
      while (y <= last && !profile[y]) y++;
      gaps.push({ mid: (start + y) / 2, size: y - start });
    }
    if (gaps.length < lines.length - 1) {
      return {
        rows: [],
        error: `Found ${gaps.length + 1} line${gaps.length ? 's' : ''} of writing but your text has ${lines.length}. Leave clear space between lines, or match the line breaks.`,
      };
    }
    gaps.sort((a, b) => b.size - a.size);
    separators.push(...gaps.slice(0, lines.length - 1).map((g) => g.mid).sort((a, b) => a - b));
  }

  const buckets: number[][] = lines.map(() => []);
  for (const id of valid) {
    const c = ink.components[id - 1];
    const cy = (c.y0 + c.y1) / 2;
    let row = 0;
    while (row < separators.length && cy > separators[row]) row++;
    buckets[row].push(id);
  }

  const rows = lines.map((line, i) => ({
    text: line,
    letters: lettersOf(line),
    pieces: autoAssign(ink, clusterRow(ink, buckets[i]), line),
  }));
  return { rows };
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
    const byArea = [...list].sort((a, b) => a.piece.area - b.piece.area);
    const { ink, piece, base, scale } = byArea[byArea.length >> 1];

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

export async function loadSampleImage(file: File): Promise<{ ink: InkMap; url: string }> {
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
  return { ink: buildInkMap(ctx.getImageData(0, 0, w, h)), url };
}
