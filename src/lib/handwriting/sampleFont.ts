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

/** A slice [cut0, cut1) x [cutY0, cutY1) of one connected component. */
interface PiecePart { comp: number; cut0: number; cut1: number; cutY0?: number; cutY1?: number }

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

/**
 * Strips thin, straight horizontal and vertical table borders / cell dividers
 * and rectangular section header badges (e.g. "[Uppercase Letters]", "[Numbers]")
 * from `labels` before connected-component labelling so a glyph sheet's grid
 * never glues letters together or masquerades as glyphs. Where a letter stroke
 * crosses a grid line, the stroke is thicker than the line and is preserved.
 */
function stripGridLines(labels: Int32Array, gray: Uint8Array, threshold: number, w: number, h: number, pen: number): void {
  if (w < 120 || h < 120) return;
  const maxThick = Math.max(3, Math.min(10, Math.round(pen * 1.8)));
  const minHorizSpan = Math.max(80, Math.round(w * 0.24));
  const maxHorizGap = Math.max(8, Math.round(w * 0.018));
  const gridCut = Math.max(218, Math.min(232, threshold + 45));
  const drop = new Uint8Array(w * h);
  const horizGrid = new Uint8Array(w * h);
  const isLine = (idx: number) => labels[idx] === -1 || gray[idx] <= gridCut;

  const vertThickAt = (x: number, y: number): number => {
    let y0 = y;
    while (y0 > 0 && isLine((y0 - 1) * w + x) && y - (y0 - 1) <= maxThick + 1) y0--;
    let y1 = y;
    while (y1 + 1 < h && isLine((y1 + 1) * w + x) && (y1 + 1) - y <= maxThick + 1) y1++;
    return y1 - y0 + 1;
  };

  const horizThickAt = (x: number, y: number): number => {
    let x0 = x;
    while (x0 > 0 && labels[y * w + (x0 - 1)] === -1 && x - (x0 - 1) <= maxThick + 1) x0--;
    let x1 = x;
    while (x1 + 1 < w && labels[y * w + (x1 + 1)] === -1 && (x1 + 1) - x <= maxThick + 1) x1++;
    return x1 - x0 + 1;
  };

  // 1) Detect horizontal grid lines (bridging small anti-aliasing / JPEG gaps and light-grey segments).
  for (let y = 0; y < h; y++) {
    let runStart = -1;
    let lastInkX = -1;
    let inkCols = 0;
    let selfCols = 0;
    let thinCols = 0;
    const flushHoriz = (endX: number) => {
      const span = endX - runStart;
      if (runStart >= 0 && span >= minHorizSpan && selfCols >= span * 0.45 && inkCols >= span * 0.68 && thinCols >= span * 0.48) {
        for (let xx = runStart; xx < endX; xx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy >= 0 && yy < h && isLine(yy * w + xx)) horizGrid[yy * w + xx] = 1;
          }
          if (labels[y * w + xx] === -1 && vertThickAt(xx, y) <= maxThick) {
            drop[y * w + xx] = 1;
          } else if (!isLine(y * w + xx)) {
            for (const dy of [-1, 1]) {
              const yy = y + dy;
              if (yy >= 0 && yy < h && labels[yy * w + xx] === -1 && vertThickAt(xx, yy) <= maxThick) {
                drop[yy * w + xx] = 1;
              }
            }
          }
        }
      }
      runStart = -1;
      lastInkX = -1;
      inkCols = 0;
      selfCols = 0;
      thinCols = 0;
    };

    for (let x = 0; x < w; x++) {
      let hasNear = false;
      let thinNear = false;
      const selfHas = isLine(y * w + x);
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        if (isLine(yy * w + x)) {
          hasNear = true;
          if (vertThickAt(x, yy) <= maxThick) thinNear = true;
        }
      }
      if (hasNear) {
        if (runStart < 0) runStart = x;
        lastInkX = x;
        inkCols++;
        if (selfHas) selfCols++;
        if (thinNear) thinCols++;
      } else if (runStart >= 0 && x - lastInkX > maxHorizGap) {
        flushHoriz(lastInkX + 1);
      }
    }
    if (runStart >= 0) flushHoriz(lastInkX + 1);
  }

  // 2) Detect rectangular section-header badges / folder tabs (e.g. "[Uppercase Letters]",
  // "[Lowercase Letters]", "[Numbers]", "[Punctuation & Symbols]") and erase both the box
  // and the small printed label words inside it so they are never read as glyphs.
  const minBadgeW = Math.max(28, Math.round(w * 0.04));
  const maxBadgeW = Math.round(w * 0.52);
  const minBadgeH = Math.max(10, Math.min(18, pen * 3));
  const maxBadgeH = Math.max(36, Math.round(h * 0.1));
  const badgeCut = Math.min(234, gridCut + 12);
  const isBadge = (idx: number) => labels[idx] === -1 || gray[idx] <= badgeCut;
  const badgeInterior = new Uint8Array(w * h);
  for (let yTop = 0; yTop < h - minBadgeH; yTop++) {
    let x = 0;
    while (x < w - minBadgeW) {
      if (!isBadge(yTop * w + x)) { x++; continue; }
      let xEnd = x;
      let gap = 0;
      let thin = 0;
      while (xEnd < w) {
        const has = isBadge(yTop * w + xEnd)
          || (yTop > 0 && isBadge((yTop - 1) * w + xEnd))
          || (yTop + 1 < h && isBadge((yTop + 1) * w + xEnd));
        if (has) {
          gap = 0;
          if (vertThickAt(xEnd, yTop) <= maxThick * 2) thin++;
          xEnd++;
        } else if (++gap <= 4 && xEnd + 1 < w) {
          xEnd++;
        } else {
          xEnd -= gap - 1;
          break;
        }
      }
      const bw = xEnd - x;
      // Only isolated header tabs/boxes sitting directly on (or just above) a horizontal table border qualify.
      if (bw >= minBadgeW && bw <= maxBadgeW && thin >= bw * 0.65 && !horizGrid[yTop * w + x + (bw >> 1)]) {
        for (let yBot = yTop + minBadgeH; yBot <= Math.min(h - 1, yTop + maxBadgeH); yBot++) {
          const bh = yBot - yTop;
          if (bw < bh * 1.7) continue;
          const botGridCount = (yy: number) => {
            let c = 0;
            for (let xx = x; xx < xEnd; xx++) if (horizGrid[yy * w + xx]) c++;
            return c;
          };
          if (botGridCount(yBot) < bw * 0.62) continue;
          while (yBot + 1 <= Math.min(h - 1, yTop + maxBadgeH) && botGridCount(yBot + 1) >= bw * 0.62) {
            yBot++;
          }
          const finalBh = yBot - yTop;
          let bestLeft = 0;
          let xLeft = x;
          for (let lx = Math.max(0, x - 6); lx <= Math.min(w - 1, x + 3); lx++) {
            let cnt = 0;
            for (let yy = yTop + 1; yy <= yBot; yy++) {
              if (isBadge(yy * w + lx) || (lx > 0 && isBadge(yy * w + lx - 1)) || (lx + 1 < w && isBadge(yy * w + lx + 1))) cnt++;
            }
            if (cnt > bestLeft) { bestLeft = cnt; xLeft = lx; }
          }
          let bestRight = 0;
          let xRight = xEnd - 1;
          for (let rx = Math.max(0, xEnd - 4); rx <= Math.min(w - 1, xEnd + 5); rx++) {
            let cnt = 0;
            for (let yy = yTop + 1; yy <= yBot; yy++) {
              if (isBadge(yy * w + rx) || (rx > 0 && isBadge(yy * w + rx - 1)) || (rx + 1 < w && isBadge(yy * w + rx + 1))) cnt++;
            }
            if (cnt > bestRight) { bestRight = cnt; xRight = rx; }
          }
          if (bestLeft >= finalBh * 0.6 && bestRight >= finalBh * 0.6) {
            for (let yy = Math.max(0, yTop - 2); yy <= Math.min(h - 1, yBot + 1); yy++) {
              for (let xx = Math.max(0, xLeft - 2); xx <= Math.min(w - 1, xRight + 2); xx++) {
                drop[yy * w + xx] = 1;
                if (yy < yBot - 1 && !horizGrid[yy * w + xx]) {
                  badgeInterior[yy * w + xx] = 1;
                }
              }
            }
            for (let xx = Math.max(0, xLeft - 2); xx <= Math.min(w - 1, xRight + 2); xx++) {
              for (let dy = -1; dy <= 1; dy++) {
                const yy = yBot + dy;
                if (yy >= 0 && yy < h) horizGrid[yy * w + xx] = 1;
              }
            }
            break;
          }
        }
      }
      x = Math.max(x + 1, xEnd);
    }
  }

  // Apply horizontal and badge removals to `labels` now so grid intersections (+ / T corners)
  // are no longer wide horizontally when vertical grid lines are measured in step 3.
  for (let i = 0; i < w * h; i++) if (drop[i]) labels[i] = 0;
  const isVertLine = (idx: number) => !badgeInterior[idx] && isLine(idx);

  // 3) Vertical grid lines (cell dividers): erase columns that bridge directly between two
  // horizontal grid lines (or span a large share of the image height), keeping letter stems intact.
  const minVertSpan = Math.max(22, Math.round(h * 0.035));
  const maxVertGap = 2;
  const veryTallRun = Math.max(90, Math.round(h * 0.22));
  const wideCheckLimit = maxThick * 3;
  const wideHorizAt = (x: number, y: number): number => {
    let x0 = x;
    while (x0 > 0 && labels[y * w + (x0 - 1)] === -1 && x - (x0 - 1) <= wideCheckLimit) x0--;
    let x1 = x;
    while (x1 + 1 < w && labels[y * w + (x1 + 1)] === -1 && (x1 + 1) - x <= wideCheckLimit) x1++;
    return x1 - x0 + 1;
  };
  const touchesHorizNear = (x: number, y: number): boolean => {
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx >= 0 && xx < w && horizGrid[yy * w + xx]) return true;
      }
    }
    return false;
  };

  for (let x = 0; x < w; x++) {
    let runStart = -1;
    let lastInkY = -1;
    let inkRowsCount = 0;
    let selfRowsCount = 0;
    let thinRowsCount = 0;
    const flushVert = (endY: number) => {
      const span = endY - runStart;
      if (runStart >= 0 && span >= minVertSpan && selfRowsCount >= span * 0.55 && inkRowsCount >= span * 0.82 && thinRowsCount >= span * 0.72) {
        const topTouch = touchesHorizNear(x, runStart);
        const botTouch = touchesHorizNear(x, endY - 1);
        let wideInterior = 0;
        let interiorRows = 0;
        for (let yy = runStart; yy < endY; yy++) {
          if (touchesHorizNear(x, yy)) continue;
          interiorRows++;
          if (wideHorizAt(x, yy) > maxThick + 2) wideInterior++;
        }
        const innerSpan = Math.max(1, interiorRows);
        const isCellWall = topTouch && botTouch && wideInterior <= Math.max(1, Math.round(innerSpan * 0.03));
        const isLongBorder = span >= veryTallRun && (topTouch || botTouch) && thinRowsCount >= span * 0.85 && wideInterior <= Math.max(2, Math.round(innerSpan * 0.05));
        if (isCellWall || isLongBorder) {
          for (let yy = runStart; yy < endY; yy++) {
            if (labels[yy * w + x] === -1 && horizThickAt(x, yy) <= maxThick) {
              drop[yy * w + x] = 1;
            } else if (!isVertLine(yy * w + x)) {
              for (const dx of [-1, 1]) {
                const xx = x + dx;
                if (xx >= 0 && xx < w && labels[yy * w + xx] === -1 && horizThickAt(xx, yy) <= maxThick) {
                  drop[yy * w + xx] = 1;
                }
              }
            }
          }
        }
      }
      runStart = -1;
      lastInkY = -1;
      inkRowsCount = 0;
      selfRowsCount = 0;
      thinRowsCount = 0;
    };

    for (let y = 0; y < h; y++) {
      let hasNear = false;
      let thinNear = false;
      const selfHas = isVertLine(y * w + x);
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        if (isVertLine(y * w + xx)) {
          hasNear = true;
          if (horizThickAt(xx, y) <= maxThick) thinNear = true;
        }
      }
      if (hasNear) {
        if (runStart < 0) runStart = y;
        lastInkY = y;
        inkRowsCount++;
        if (selfHas) selfRowsCount++;
        if (thinNear) thinRowsCount++;
      } else if (runStart >= 0 && y - lastInkY > maxVertGap) {
        flushVert(lastInkY + 1);
      }
    }
    if (runStart >= 0) flushVert(lastInkY + 1);
  }

  for (let i = 0; i < w * h; i++) if (drop[i]) labels[i] = 0;
}

/**
 * Detects hollow rectangular frames (cell borders, section label boxes, table outlines)
 * whose ink sits almost entirely along their 4 outer edges.
 */
function isHollowFrame(labels: Int32Array, w: number, comp: InkComponent, id: number, pen: number): boolean {
  const bw = comp.x1 - comp.x0 + 1;
  const bh = comp.y1 - comp.y0 + 1;
  const minSide = Math.max(18, pen * 7);
  if (bw < minSide || bh < minSide) return false;
  if (bw < Math.max(28, pen * 10) && bh < Math.max(28, pen * 10)) return false;
  const border = Math.max(3, Math.min(Math.floor(Math.min(bw, bh) * 0.2), Math.round(pen * 2.2)));
  let borderInk = 0;
  let innerInk = 0;
  let topCols = 0, botCols = 0, leftRows = 0, rightRows = 0;
  const topSeen = new Uint8Array(bw);
  const botSeen = new Uint8Array(bw);
  const leftSeen = new Uint8Array(bh);
  const rightSeen = new Uint8Array(bh);

  for (let y = comp.y0; y <= comp.y1; y++) {
    const row = y * w;
    const onTop = y - comp.y0 < border;
    const onBot = comp.y1 - y < border;
    for (let x = comp.x0; x <= comp.x1; x++) {
      if (labels[row + x] !== id) continue;
      const onLeft = x - comp.x0 < border;
      const onRight = comp.x1 - x < border;
      if (onTop || onBot || onLeft || onRight) {
        borderInk++;
        if (onTop && !topSeen[x - comp.x0]) { topSeen[x - comp.x0] = 1; topCols++; }
        if (onBot && !botSeen[x - comp.x0]) { botSeen[x - comp.x0] = 1; botCols++; }
        if (onLeft && !leftSeen[y - comp.y0]) { leftSeen[y - comp.y0] = 1; leftRows++; }
        if (onRight && !rightSeen[y - comp.y0]) { rightSeen[y - comp.y0] = 1; rightRows++; }
      } else {
        innerInk++;
      }
    }
  }
  const total = borderInk + innerInk;
  if (!total) return false;
  // A rectangular frame covers almost all 4 sides and has very little ink in its interior,
  // or is a wide multi-cell frame spanning a large part of the page.
  const fourSides = topCols >= bw * 0.75 && botCols >= bw * 0.75 && leftRows >= bh * 0.75 && rightRows >= bh * 0.75;
  if (fourSides && innerInk <= total * 0.12 && (bw > pen * 14 || bh > pen * 14)) return true;
  if (bw > w * 0.35 && bh > pen * 6 && innerInk <= total * 0.25 && (topCols >= bw * 0.7 || botCols >= bw * 0.7)) return true;
  return false;
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
  // colored ruling, template pill badges): with dark ink every strongly colored pixel goes;
  // with colored ink only pixels far from the pen's hue go. Otherwise a squiggle under a line
  // glues all its letters into one blob.
  const COLORED = 65;
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
  stripGridLines(labels, gray, threshold, w, h, pen);

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
  // edges, desk, shadow blobs, ruled lines and hollow table/header boxes are dropped.
  const minArea = Math.max(MIN_COMPONENT_AREA, Math.round(Math.min(pen * pen * 0.5, (Math.max(w, h) / 100) ** 2)));
  const keep = new Int32Array(found.length + 1);
  const components: InkComponent[] = [];
  found.forEach((c, i) => {
    const id = i + 1;
    const bw = c.x1 - c.x0 + 1;
    const bh = c.y1 - c.y0 + 1;
    const touchesEdge = c.x0 === 0 || c.y0 === 0 || c.x1 === w - 1 || c.y1 === h - 1;
    const solid = c.area > bw * bh * 0.5 && bw > pen * 12 && bh > pen * 12;
    const edgeBlob = touchesEdge && (bw > w * 0.3 || bh > h * 0.3) && c.area > bw * bh * 0.35;
    if (c.area < minArea || solid || edgeBlob || isHollowFrame(labels, w, c, id, pen)) return;
    components.push(c);
    keep[id] = components.length;
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
    const fromY = Math.max(c.y0, part.cutY0 ?? -Infinity);
    const toY = Math.min(c.y1, (part.cutY1 ?? Infinity) - 1);
    for (let y = fromY; y <= toY; y++) {
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
  const width = piece.x1 - piece.x0 + 1;
  const cols = new Uint32Array(width);
  const { width: w, labels, components } = ink;
  for (const part of piece.parts) {
    const c = components[part.comp - 1];
    const fromX = Math.max(c.x0, part.cut0, piece.x0);
    const toX = Math.min(c.x1, part.cut1 - 1, piece.x1);
    const fromY = Math.max(c.y0, part.cutY0 ?? -Infinity, piece.y0);
    const toY = Math.min(c.y1, (part.cutY1 ?? Infinity) - 1, piece.y1);
    for (let y = fromY; y <= toY; y++) {
      const row = y * w;
      for (let x = fromX; x <= toX; x++) {
        if (labels[row + x] === part.comp) cols[x - piece.x0]++;
      }
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
    if (p.cut0 < cut) left.push({ comp: p.comp, cut0: p.cut0, cut1: Math.min(p.cut1, cut), cutY0: p.cutY0, cutY1: p.cutY1 });
    if (p.cut1 > cut) right.push({ comp: p.comp, cut0: Math.max(p.cut0, cut), cut1: p.cut1, cutY0: p.cutY0, cutY1: p.cutY1 });
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
/**
 * How far above or below a letter a mark may float and still be pre-joined to it
 * (i dots, the parts of ! ? : ;). Measured against the row's typical letter
 * height, not the taller stroke, so a tall joined word doesn't reach a stray
 * tick in the line gap. Marks further away stay separate and the matcher, which
 * knows which letters carry a dot, decides.
 */
const STACKED_GAP = 0.45;
function stackedGapLimit(boxes: { x0: number; x1: number; y0: number; y1: number; area: number }[]): number {
  if (!boxes.length) return 0;
  const areaMedian = median(boxes.map((b) => b.area));
  const letters = boxes.filter((b) => b.area >= areaMedian * 0.25);
  return STACKED_GAP * (median((letters.length ? letters : boxes).map((b) => b.y1 - b.y0 + 1)) || 1);
}

/**
 * Vertical distance between two strokes' ink in the columns they share, so a
 * mark over the low part of a joined word isn't measured against its ascender.
 */
function inkGap(ink: InkMap, idA: number, idB: number): number {
  const a = ink.components[idA - 1];
  const b = ink.components[idB - 1];
  const from = Math.max(a.x0, b.x0);
  const to = Math.min(a.x1, b.x1);
  const extent = (id: number, c: InkComponent) => {
    let top = Infinity;
    let bot = -Infinity;
    for (let y = c.y0; y <= c.y1; y++) {
      for (let x = from; x <= to; x++) {
        if (ink.labels[y * ink.width + x] !== id) continue;
        if (y < top) top = y;
        bot = y;
        break;
      }
    }
    return { top, bot };
  };
  const ea = extent(idA, a);
  const eb = extent(idB, b);
  if (ea.top === Infinity || eb.top === Infinity) return Math.max(0, b.y0 - a.y1, a.y0 - b.y1);
  return Math.max(0, eb.top - ea.bot - 1, ea.top - eb.bot - 1);
}

function attachMarks(ink: InkMap, pieces: Piece[], text: string): Piece[] {
  if (pieces.length < 2) return pieces;
  const areaMedian = median(pieces.map((p) => p.area));
  const widthMedian = median(pieces.map((p) => p.x1 - p.x0 + 1)) || 1;
  const stackGap = stackedGapLimit(pieces);
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
      const isTopMark = p.y1 <= q.y0 + qh * 0.35;
      const gap = Math.max(0, Math.max(p.x0, q.x0) - Math.min(p.x1, q.x1));
      const minInkDist = Math.min(...p.parts.flatMap((pp) => q.parts.map((qp) => inkGap(ink, pp.comp, qp.comp))));
      if (isTopMark) {
        // An i dot floats just above its stem; a mark far higher is a stray pen tick.
        if (q.y0 - p.y1 > stackGap || minInkDist > stackGap) continue;
        if (gap > maxGap) continue;
      } else {
        // Detached crossbar, hook, or tail touching or overlapping the glyph's stem/body.
        if (gap > 1 || minInkDist > 3 || p.y0 > q.y1 + 3) continue;
      }
      // Among touching candidates, the one most directly aligned with the mark wins.
      const overlap = Math.max(0, Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0) + 1) / (p.x1 - p.x0 + 1);
      const centerDist = Math.abs((p.x0 + p.x1) / 2 - (q.x0 + q.x1) / 2) / ((q.x1 - q.x0 + 1) * 4)
        // A dot beside a tall letter's top (f, l) is less likely its own than one above a stem.
        + (isTopMark ? Math.max(0, (p.y1 - q.y0) / qh) * 2 : 0);
      if (gap - overlap + centerDist < bestGap) {
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

export function clusterRow(ink: InkMap, compIds: number[], text = '', splitSideBySide = false, band?: Band, sharedIds?: Set<number>): Piece[] {
  const comps = compIds
    .map((id) => {
      const raw = ink.components[id - 1];
      const clip = band && (!sharedIds || sharedIds.has(id));
      const y0 = clip ? Math.max(raw.y0, band.y0) : raw.y0;
      const y1 = clip ? Math.min(raw.y1, band.y1) : raw.y1;
      return { id, clip: Boolean(clip), c: { ...raw, y0, y1 } };
    })
    .filter((p) => p.c.y1 >= p.c.y0)
    .sort((p, q) => p.c.x0 - q.c.x0);
  const parent = comps.map((_, i) => i);
  const stackGap = stackedGapLimit(comps.map((p) => p.c));
  const medH = median(comps.map((p) => p.c.y1 - p.c.y0 + 1)) || 1;
  const medW = median(comps.map((p) => p.c.x1 - p.c.x0 + 1)) || 1;
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < comps.length; i++) {
    const a = comps[i].c;
    const aw = a.x1 - a.x0 + 1;
    const ah = a.y1 - a.y0 + 1;
    for (let j = i + 1; j < comps.length; j++) {
      const b = comps[j].c;
      if (b.x0 > a.x1) break;
      const bw = b.x1 - b.x0 + 1;
      const bh = b.y1 - b.y0 + 1;
      const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + 1;
      const narrower = Math.min(aw, bw);
      const wider = Math.max(aw, bw);
      const combinedW = Math.max(a.x1, b.x1) - Math.min(a.x0, b.x0) + 1;
      // Only strokes stacked above each other (i dots, : ; ! ? =) or overlapping strokes of one
      // character (crossbar/hook on a stem) merge immediately; side-by-side strokes stay apart.
      const vOverlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + 1;
      const shorter = Math.min(ah, bh);
      const combinedH = Math.max(a.y1, b.y1) - Math.min(a.y0, b.y0) + 1;
      if (vOverlap < shorter * 0.25 && ah >= medH * 0.6 && bh >= medH * 0.6 && combinedH > medH * 1.45) continue;
      if (-vOverlap > stackGap || (vOverlap <= 0 && inkGap(ink, comps[i].id, comps[j].id) > stackGap)) continue;
      const sameGlyphOverlap = overlap >= wider * 0.6 && combinedW <= medW * 1.35 && inkGap(ink, comps[i].id, comps[j].id) <= 3;
      if (overlap > narrower * 0.5 && (!splitSideBySide || vOverlap < shorter * 0.4 || sameGlyphOverlap)) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, PiecePart[]>();
  comps.forEach((p, i) => {
    const root = find(i);
    const list = groups.get(root) ?? [];
    list.push({
      comp: p.id,
      cut0: -Infinity,
      cut1: Infinity,
      ...(p.clip && band ? { cutY0: band.y0, cutY1: band.y1 + 1 } : {}),
    });
    groups.set(root, list);
  });
  const pieces = [...groups.values()].map((parts) => measure(ink, parts)).filter((p) => p.area > 0).sort((a, b) => a.x0 - b.x0);
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
  const margin = Math.max(3, Math.round(h * 0.12));
  const candidates: number[] = [];
  for (let y = band.y0 + margin; y <= band.y1 - margin; y++) {
    const v = density[y];
    if (v > peak * 0.45 || v > density[y - 1] || v > density[y + 1]) continue;
    let above = 0;
    let below = 0;
    for (let t = band.y0; t < y; t++) above = Math.max(above, density[t]);
    for (let t = y + 1; t <= band.y1; t++) below = Math.max(below, density[t]);
    if (v <= Math.min(above, below) * 0.52) candidates.push(y);
  }
  candidates.sort((a, b) => density[a] - density[b]);

  const { width: W, labels } = ink;
  for (const cut of candidates.slice(0, 10)) {
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
      if (share >= 0.78) topMass += a + b;
      else if (share <= 0.22) bottomMass += a + b;
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
    const minSideMass = Math.min(total * 0.14, Math.max(24, total * 0.05));
    if (
      mixed <= total * 0.24 &&
      mixed <= Math.min(topMass, bottomMass) * 0.7 &&
      topMass >= minSideMass &&
      bottomMass >= minSideMass &&
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
  const medCompH = median(valid.map((id) => ink.components[id - 1].y1 - ink.components[id - 1].y0 + 1)) || 1;
  const buckets: number[][] = bands.map(() => []);
  for (const id of valid) {
    const c = ink.components[id - 1];
    const ch = c.y1 - c.y0 + 1;
    // If a tall stroke or unsevered border bridges multiple bands, let each band claim its vertical slice.
    if (bands.length > 1 && ch > medCompH * 2.15) {
      const matchedBands: number[] = [];
      bands.forEach((b, i) => {
        const ov = Math.min(c.y1, b.y1) - Math.max(c.y0, b.y0) + 1;
        if (ov >= Math.min(medCompH * 0.55, (b.y1 - b.y0 + 1) * 0.5)) {
          matchedBands.push(i);
        }
      });
      if (matchedBands.length >= 2) {
        matchedBands.forEach((i) => buckets[i].push(id));
        continue;
      }
    }
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

  // Only pass vertical band clip for the specific component IDs shared across multiple bands.
  const sharedIds = new Set<number>();
  const seenIds = new Set<number>();
  for (const ids of buckets) {
    for (const id of ids) {
      if (seenIds.has(id)) sharedIds.add(id);
      seenIds.add(id);
    }
  }
  const rows = buckets.map((ids, i) =>
    clusterRow(ink, ids, text, true, ids.some((id) => sharedIds.has(id)) ? bands[i] : undefined, sharedIds),
  );
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
    const fromY = Math.max(c.y0, part.cutY0 ?? -Infinity, piece.y0);
    const toY = Math.min(c.y1, (part.cutY1 ?? Infinity) - 1, piece.y1);
    for (let y = fromY; y <= toY; y++) {
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

function letterSpecs(lines: string[], rowCount?: number): LetterSpec[] {
  const out: LetterSpec[] = [];
  const lockRows = rowCount !== undefined && rowCount === lines.length;
  lines.forEach((line, lineIdx) => {
    line.split(/\s+/).filter(Boolean).forEach((word, wi) => {
      Array.from(word).forEach((c, ci) =>
        out.push({
          c,
          spaceBefore: ci === 0 && wi > 0,
          lineStart: ci === 0 && wi === 0,
          ...(lockRows ? { row: lineIdx } : {}),
        }),
      );
    });
  });
  return out;
}

/**
 * Matches every typed character to its ink across all rows at once (see
 * glyphAlign). `keep[i] === false` letters still claim their ink, so their
 * neighbours stay clean, but are left out of the result.
 */
function matchLetters(
  ink: InkMap, rowPieces: Piece[][], letters: LetterSpec[], keep?: boolean[],
  placedOut?: { letter: number; piece: Piece }[],
): Segmentation {
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
  placedOut?.push(...placed);
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
  return matchLetters(ink, rows, letterSpecs(lines, rows.length));
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
  const medianH = median(lines.flatMap((l) => l.chars.map((ch) => ch.y1 - ch.y0))) || 1;
  // Vertical row bounds so a tall component or unsevered border never bleeds into adjacent rows.
  const lineY = lines.map((l) => ({
    y0: median(l.chars.map((ch) => ch.y0)),
    y1: median(l.chars.map((ch) => ch.y1)),
    minY: Math.min(...l.chars.map((ch) => ch.y0)),
    maxY: Math.max(...l.chars.map((ch) => ch.y1)),
  }));
  const rowBounds = lines.map((_, li) => {
    const prev = li > 0 && lineY[li].y0 > lineY[li - 1].y0 + medianH * 0.4
      ? Math.round((lineY[li - 1].y1 + lineY[li].y0) / 2)
      : Math.max(0, Math.floor(lineY[li].minY - medianH * 0.6));
    const next = li + 1 < lines.length && lineY[li + 1].y0 > lineY[li].y0 + medianH * 0.4
      ? Math.round((lineY[li].y1 + lineY[li + 1].y0) / 2)
      : Math.min(H, Math.ceil(lineY[li].maxY + medianH * 0.6));
    return { cutY0: prev, cutY1: Math.max(prev + 1, next) };
  });
  const parts: PiecePart[][][] = lines.map((l) => l.chars.map(() => []));

  components.forEach((comp, idx) => {
    if (!isValid(comp)) return;
    const id = idx + 1;
    const cw = comp.x1 - comp.x0 + 1;
    const ch = comp.y1 - comp.y0 + 1;
    // Skip ruling lines and underlines: long, flat strokes spanning many characters.
    if (cw > medianW * 3 && ch < cw * 0.12) return;

    const assignToLine = (line: number, clipY: boolean) => {
      const l = lines[line];
      const { cutY0, cutY1 } = clipY ? rowBounds[line] : { cutY0: undefined, cutY1: undefined };
      const effY0 = cutY0 !== undefined ? Math.max(comp.y0, cutY0) : comp.y0;
      const effY1 = cutY1 !== undefined ? Math.min(comp.y1, cutY1 - 1) : comp.y1;
      const effH = effY1 - effY0 + 1;
      if (effH <= 0) return;

      // A small mark that only grazes a loose AI box from far above or below is a stray
      // pen tick, not part of the glyph. i dots and accents sit just outside the box.
      if (cw < medianW * 0.6 && effH < medianH * 0.6) {
        const home = l.chars.reduce((b, box) => {
          const d = Math.abs((comp.x0 + comp.x1) / 2 - (box.x0 + box.x1) / 2);
          return d < b.d ? { d, box } : b;
        }, { d: Infinity, box: l.chars[0] }).box;
        const inside = Math.min(effY1 + 1, home.y1) - Math.max(effY0, home.y0);
        const away = Math.max(home.y0 - effY1, effY0 - home.y1);
        if (inside < effH * 0.5 && away > (home.y1 - home.y0) * 0.35) return;
      }
      // Separate character strokes stay whole and go to the character box they overlap
      // most, unless a stroke spans well across multiple character boxes (joined letters).
      const boxOverlaps = l.chars.map((box, bi) => {
        const ox = Math.min(comp.x1 + 1, box.x1) - Math.max(comp.x0, box.x0);
        const oy = Math.min(effY1 + 1, box.y1) - Math.max(effY0, box.y0);
        return { bi, ox: Math.max(0, ox), area: ox > 0 && oy > 0 ? ox * oy : 0 };
      });
      const strongBoxes = boxOverlaps.filter((o, bi) => {
        const bw = Math.max(1, l.chars[bi].x1 - l.chars[bi].x0);
        return o.ox >= Math.min(cw, bw) * 0.45 && o.area > 0;
      });
      if (cw <= medianW * 1.35 && strongBoxes.length <= 1) {
        let bestTarget = 0;
        let bestScore = -Infinity;
        const cx = (comp.x0 + comp.x1) / 2;
        l.chars.forEach((box, bi) => {
          const score = boxOverlaps[bi].area - Math.abs(cx - (box.x0 + box.x1) / 2) * 0.25;
          if (score > bestScore) { bestScore = score; bestTarget = bi; }
        });
        let has = false;
        for (let y = effY0; y <= effY1 && !has; y++) {
          for (let x = comp.x0; x <= comp.x1; x++) {
            if (labels[y * W + x] === id) { has = true; break; }
          }
        }
        if (has) parts[line][bestTarget].push({ comp: id, cut0: comp.x0, cut1: comp.x1 + 1, cutY0, cutY1 });
        return;
      }
      const boundaries = [comp.x0, ...cuts[line].filter((x) => x > comp.x0 && x <= comp.x1), comp.x1 + 1];
      for (let s = 0; s + 1 < boundaries.length; s++) {
        const cut0 = boundaries[s];
        const cut1 = boundaries[s + 1];
        const mid = (cut0 + cut1) / 2;
        let target = l.chars.findIndex((_, i) => i === l.chars.length - 1 || mid < cuts[line][i]);
        if (target < 0) target = l.chars.length - 1;
        let has = false;
        for (let y = effY0; y <= effY1 && !has; y++) {
          for (let x = cut0; x < cut1; x++) {
            if (labels[y * W + x] === id) { has = true; break; }
          }
        }
        if (has) parts[line][target].push({ comp: id, cut0, cut1, cutY0, cutY1 });
      }
    };

    const lineMatches: { line: number; overlap: number }[] = [];
    lines.forEach((l, li) => {
      let overlap = 0;
      for (const box of l.chars) {
        const ox = Math.min(comp.x1 + 1, box.x1) - Math.max(comp.x0, box.x0);
        const oy = Math.min(comp.y1 + 1, box.y1) - Math.max(comp.y0, box.y0);
        if (ox > 0 && oy > 0) overlap += ox * oy;
      }
      if (overlap > 0) lineMatches.push({ line: li, overlap });
    });
    if (!lineMatches.length) return;
    if (lineMatches.length > 1 && ch > medianH * 1.55) {
      // Component bridges across multiple rows: slice it vertically per overlapping row.
      for (const m of lineMatches) assignToLine(m.line, true);
    } else {
      lineMatches.sort((a, b) => b.overlap - a.overlap);
      assignToLine(lineMatches[0].line, ch > medianH * 2.5);
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
function normalizeSymbolTokens(line: string, targetCount?: number): string {
  const replaced = line
    .replace(/(^|\s)<=(?=\s|$)/g, '$1≤')
    .replace(/(^|\s)>=(?=\s|$)/g, '$1≥')
    .replace(/(^|\s)!=(?=\s|$)/g, '$1≠')
    .replace(/(^|\s)TM(?=\s|$)/g, '$1™');
  if (replaced === line) return line;
  if (targetCount === undefined) return replaced;
  const origDiff = Math.abs(lettersOf(line).length - targetCount);
  const newDiff = Math.abs(lettersOf(replaced).length - targetCount);
  return newDiff <= origDiff ? replaced : line;
}

const SECTION_HEADER_RE = /^(uppercase(\s+letters)?|lowercase(\s+letters)?|numbers|digits|punctuation(\s*(&|and)\s*symbols)?|symbols|math(\s*\/\s*special\s*glyphs)?|special\s+glyphs|ligatures|sample\s+text|pangrams?)$/i;

/**
 * Recognizes standard handwriting glyph sheet templates (full 7-row sheets or cropped
 * sections of Uppercase, Lowercase, Numbers, and Punctuation & Symbols) directly from
 * the ink layout when every row aligns cleanly.
 */
export function detectGlyphTemplate(ink: InkMap): (Segmentation & { text: string }) | null {
  const upper13 = ['A B C D E F G H I J K L M', 'N O P Q R S T U V W X Y Z'];
  const lower13 = ['a b c d e f g h i j k l m', 'n o p q r s t u v w x y z'];
  const digits10 = '0 1 2 3 4 5 6 7 8 9';
  const punct1 = '. , ; : ! ? \' " ( ) - _ / \\ | @ # $ % &';
  const punct2a = '* + = < > ≤ ≥ ~ ^ ` [ ] { } , . ₹ € ™ ®';
  const punct2b = '* + = < > ≤ ≥ ~ ^ ` [ ] { } , ₹ € ™ ®';

  const candidates: string[][] = [
    [...upper13, ...lower13, digits10, punct1, punct2a],
    [...upper13, ...lower13, digits10, punct1, punct2b],
    [...upper13, ...lower13, digits10],
    [...upper13, ...lower13],
    [upper13[1], ...lower13, digits10],
    [...lower13, digits10, punct1, punct2a],
    [...lower13, digits10, punct1, punct2b],
    [...upper13, digits10],
    [...lower13, digits10],
    [...upper13],
    [...lower13],
    [digits10, punct1, punct2a],
    [digits10, punct1, punct2b],
    [punct1, punct2a],
    [punct1, punct2b],
  ];

  // Quick row-band count check so we only evaluate candidates matching the image's line count.
  const bandCheck = inkRows(ink, '1\n2\n3\n4\n5\n6\n7');
  if (!bandCheck || bandCheck.length < 2) return null;

  let bestResult: (Segmentation & { text: string }) | null = null;
  let bestScore = -Infinity;

  for (const lines of candidates) {
    if (lines.length !== bandCheck.length) continue;
    const rows = inkRows(ink, lines.join('\n'));
    if (!rows || rows.length !== lines.length) continue;
    // Verify each row's atom count is close to the template row's glyph count before full DP.
    let atomDiff = 0;
    const countsMatch = rows.every((r, idx) => {
      const target = lettersOf(lines[idx]).length;
      atomDiff += Math.abs(r.length - target);
      return r.length >= target - 3 && r.length <= target + 9;
    });
    if (!countsMatch) continue;
    const text = lines.join('\n');
    const seg = segmentSample(ink, text);
    if (seg.error || seg.rows.length !== lines.length || !seg.rows.every(rowMatched)) continue;
    const totalExpected = lines.reduce((n, l) => n + lettersOf(l).length, 0);
    const missingCount = seg.missing?.length ?? 0;
    if (missingCount > Math.max(2, Math.floor(totalExpected * 0.06))) continue;
    const matchedCount = seg.rows.reduce((n, r) => n + r.letters.length, 0);
    const score = matchedCount * 20 - missingCount * 50 - atomDiff * 5;
    if (score > bestScore) {
      bestScore = score;
      bestResult = { ...seg, text };
    }
  }
  return bestResult;
}

export function segmentWithAi(ink: InkMap, aiLines: AiLine[]): Segmentation & { text: string; source: 'text' | 'boxes' } {
  const cleanedAiLines = aiLines.filter((l) => l.text.trim() && !SECTION_HEADER_RE.test(l.text.trim()));
  const baseLines = cleanedAiLines.length ? cleanedAiLines : aiLines.filter((l) => l.text.trim());
  const prelimRows = inkRows(ink, baseLines.map((l) => l.text).join('\n')) ?? [];
  const expandedLines: AiLine[] = [];
  baseLines.forEach((l) => {
    const trimmed = l.text.trim();
    const charsOnly = lettersOf(trimmed).join('');
    if (
      (charsOnly === 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' || charsOnly === 'abcdefghijklmnopqrstuvwxyz') &&
      prelimRows.length > baseLines.length &&
      (!l.chars || l.chars.length === 0)
    ) {
      expandedLines.push(
        { text: Array.from(charsOnly.slice(0, 13)).join(' '), chars: [] },
        { text: Array.from(charsOnly.slice(13)).join(' '), chars: [] },
      );
    } else {
      expandedLines.push(l);
    }
  });
  const finalRows = inkRows(ink, expandedLines.map((l) => l.text).join('\n')) ?? prelimRows;
  const lines = expandedLines
    .map((l, idx) => ({ ...l, text: normalizeSymbolTokens(l.text.trim(), finalRows[idx]?.length) }))
    .filter((l) => l.text);
  const text = lines.map((l) => l.text).join('\n');
  if (!lines.length) return { rows: [], error: 'AI did not find any characters.', text, source: 'text' };
  const rows = inkRows(ink, text);
  if (!rows) return { rows: [], error: 'No handwriting was found in this image.', text, source: 'text' };
  const letters = letterSpecs(lines.map((l) => l.text.trim()), rows.length);
  const keep: boolean[] = [];
  const raw: ({ cx: number; cy: number; line: number } | undefined)[] = [];
  lines.forEach((line, lineNo) => {
    const own = lettersOf(line.text);
    const chars = aiCharFor(own, line.chars ?? []);
    own.forEach((_, i) => {
      const ch = chars[i];
      keep.push(ch?.sure !== false);
      if (!ch) { raw.push(undefined); return; }
      const [x0, y0, x1, y1] = ch.box;
      raw.push({ cx: ((x0 + x1) / 2) * ink.width, cy: ((y0 + y1) / 2) * ink.height, line: lineNo });
    });
  });
  if (!raw.some(Boolean)) {
    const matched = matchLetters(ink, rows, letters, keep);
    const tmpl = detectGlyphTemplate(ink);
    if (tmpl) {
      const matchedGlyphs = matched.rows.reduce((n, r) => n + (rowMatched(r) ? r.letters.length : 0), 0) - (matched.missing?.length ?? 0) * 2;
      const tmplGlyphs = tmpl.rows.reduce((n, r) => n + (rowMatched(r) ? r.letters.length : 0), 0) - (tmpl.missing?.length ?? 0) * 2;
      if (matched.error || tmplGlyphs > matchedGlyphs) {
        return { ...tmpl, source: 'text' };
      }
    }
    return { ...matched, text, source: 'text' };
  }

  // 1) Un-hinted global alignment + calibrated hints (handles shifted AI boxes on freeform text).
  const placed: { letter: number; piece: Piece }[] = [];
  const plain = matchLetters(ink, rows, letters, keep, placed);
  const hints = calibrateHints(raw, placed);
  if (hints) {
    const calLetters = letters.map((l, i) => (hints[i] ? { ...l, hint: hints[i] } : { ...l }));
    return { ...matchLetters(ink, rows, calLetters, keep), text, source: 'boxes' };
  }

  // When calibrateHints fails, the un-hinted alignment disagreed with the AI's 2D
  // character locations (e.g., on a multi-section glyph sheet with headers/grids).
  // Evaluate 2D AI-hinted matching and direct box segmentation, scoring by how well
  // pieces sit on their AI target rows and avoid multi-row merged towers.
  const allPieces = rows.flat();
  const medH = median(allPieces.map((p) => p.y1 - p.y0 + 1)) || 24;
  const scoreCandidate = (seg: Segmentation, placedList?: { letter: number; piece: Piece }[]): number => {
    const matchedRows = seg.rows.filter(rowMatched);
    const unique = new Set<string>();
    let matchedCount = 0;
    let tallPenalty = 0;
    for (const r of matchedRows) {
      for (let i = 0; i < r.pieces.length; i++) {
        const p = r.pieces[i];
        unique.add(r.letters[i]);
        matchedCount++;
        if (p.y1 - p.y0 + 1 > medH * 2.35) tallPenalty += 1500;
      }
    }
    let offRowPenalty = 0;
    if (placedList) {
      for (const p of placedList) {
        const h = raw[p.letter];
        if (!h) continue;
        const dy = Math.abs((p.piece.y0 + p.piece.y1) / 2 - h.cy);
        if (dy > medH * 1.4) offRowPenalty += 1200;
      }
    }
    return unique.size * 1000 + matchedCount * 10 - tallPenalty - offRowPenalty - (seg.error ? 50000 : 0);
  };

  const rawPlaced: { letter: number; piece: Piece }[] = [];
  const rawLetters = letters.map((l, i) => (raw[i] ? { ...l, hint: { cx: raw[i]!.cx, cy: raw[i]!.cy } } : { ...l }));
  const rawSeg = matchLetters(ink, rows, rawLetters, keep, rawPlaced);
  const boxed = segmentFromBoxes(ink, lines);

  const candidates: { seg: Segmentation; source: 'text' | 'boxes'; score: number }[] = [
    { seg: rawSeg, source: 'boxes', score: scoreCandidate(rawSeg, rawPlaced) },
    ...(boxed.rows.length ? [{ seg: boxed, source: 'boxes' as const, score: scoreCandidate(boxed) }] : []),
    { seg: plain, source: 'text', score: scoreCandidate(plain, placed) },
  ];
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  return { ...best.seg, text, source: best.source };
}

/** Least-squares line through points, or null when x has no spread. */
function fitLine(pts: [number, number][]): { a: number; b: number } | null {
  const n = pts.length;
  if (n < 2) return null;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n;
  const my = pts.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of pts) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); }
  if (sxx < 1e-6) return { a: 1, b: my - mx };
  return { a: sxy / sxx, b: my - (sxy / sxx) * mx };
}

/**
 * Robust 1-D map from AI coordinate to ink coordinate. Candidate maps come from
 * pairs of points (plus pure offsets); the one most points agree with within
 * `tol` wins and is refit on its agreeing points, so a few misread letters
 * can't bend it.
 */
function robustMap(pts: [number, number][], tol: number): { a: number; b: number; inliers: boolean[] } | null {
  if (pts.length < 3) return null;
  const score = (a: number, b: number) => pts.reduce((n, [x, y]) => n + (Math.abs(a * x + b - y) <= tol ? 1 : 0), 0);
  let best = { a: 1, b: 0, n: -1 };
  const step = Math.max(1, Math.floor(pts.length / 40));
  for (let i = 0; i < pts.length; i += step) {
    const off = { a: 1, b: pts[i][1] - pts[i][0] };
    const no = score(off.a, off.b);
    if (no > best.n) best = { ...off, n: no };
    for (let j = i + step; j < pts.length; j += step) {
      const dx = pts[j][0] - pts[i][0];
      if (Math.abs(dx) < tol * 4) continue;
      const a = (pts[j][1] - pts[i][1]) / dx;
      if (a < 0.6 || a > 1.6) continue;
      const b = pts[i][1] - a * pts[i][0];
      const n = score(a, b);
      if (n > best.n) best = { a, b, n };
    }
  }
  const inliers = pts.map(([x, y]) => Math.abs(best.a * x + best.b - y) <= tol);
  const fit = fitLine(pts.filter((_, i) => inliers[i])) ?? best;
  if (fit.a < 0.6 || fit.a > 1.6) return null;
  return { a: fit.a, b: fit.b, inliers: pts.map(([x, y]) => Math.abs(fit.a * x + fit.b - y) <= tol) };
}

/**
 * Moves AI hint points onto the ink using letters already placed by the ink alone.
 * Returns null when the AI coordinates don't agree with the ink well enough to help.
 */
function calibrateHints(
  raw: ({ cx: number; cy: number; line: number } | undefined)[],
  placed: { letter: number; piece: Piece }[],
): ({ cx: number; cy: number } | undefined)[] | null {
  const pairs = placed.flatMap((p) => {
    const h = raw[p.letter];
    return h ? [{ h, x: (p.piece.x0 + p.piece.x1) / 2, y: (p.piece.y0 + p.piece.y1) / 2, height: p.piece.y1 - p.piece.y0 + 1 }] : [];
  });
  if (pairs.length < 3) return null;
  const size = median(pairs.map((p) => p.height)) || 1;
  const tol = size * 0.35;
  const mx = robustMap(pairs.map((p) => [p.h.cx, p.x]), tol);
  const my = robustMap(pairs.map((p) => [p.h.cy, p.y]), tol * 1.5);
  if (!mx || !my) return null;
  const agree = pairs.filter((_, i) => mx.inliers[i] && my.inliers[i]).length;
  if (agree < pairs.length * 0.6) return null;
  // Per line, a leftover offset (a line the model drew a bit higher or further right).
  const lineOff = new Map<number, { dx: number; dy: number }>();
  for (const line of new Set(pairs.map((p) => p.h.line))) {
    const mine = pairs.filter((p, i) => p.h.line === line && mx.inliers[i] && my.inliers[i]);
    if (mine.length < 3) continue;
    lineOff.set(line, {
      dx: median(mine.map((p) => p.x - (mx.a * p.h.cx + mx.b))),
      dy: median(mine.map((p) => p.y - (my.a * p.h.cy + my.b))),
    });
  }
  return raw.map((h) => {
    if (!h) return undefined;
    const off = lineOff.get(h.line) ?? { dx: 0, dy: 0 };
    return { cx: mx.a * h.cx + mx.b + off.dx, cy: my.a * h.cy + my.b + off.dy };
  });
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
      const fromY = Math.max(c.y0, part.cutY0 ?? -Infinity);
      const toY = Math.min(c.y1, (part.cutY1 ?? Infinity) - 1);
      for (let y = fromY; y <= toY; y++) {
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
      pathomit: piece.area < 25 ? 0 : 2,
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
  let natW = img.naturalWidth;
  let natH = img.naturalHeight;
  if (isSvg && (!natW || !natH || (natW === 300 && natH === 150))) {
    try {
      const svgText = await file.text();
      const vb = /viewBox\s*=\s*["']\s*[-+\d.]+\s+[-+\d.]+\s+([\d.]+)\s+([\d.]+)/i.exec(svgText);
      if (vb) {
        natW = parseFloat(vb[1]) || natW;
        natH = parseFloat(vb[2]) || natH;
      }
    } catch {
      // ignore SVG parse fallback errors
    }
  }
  natW = natW || 1600;
  natH = natH || 400;
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
  const aiScale = Math.min(1, 1200 / Math.max(w, h));
  const small = document.createElement('canvas');
  small.width = Math.max(1, Math.round(w * aiScale));
  small.height = Math.max(1, Math.round(h * aiScale));
  small.getContext('2d')!.drawImage(canvas, 0, 0, small.width, small.height);
  return { ink, url, aiImage: small.toDataURL('image/jpeg', 0.85) };
}
