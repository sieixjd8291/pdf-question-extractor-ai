/**
 * Manual "clean up" eraser for the Cam Scanner mode (Adobe Scan style).
 * Everything runs on canvas pixel data in the browser — nothing is uploaded.
 *
 * Each brush dab is repaired with a paper model: colour comes from the clean,
 * ink-free paper pixels around it (so text can never leak in), and fine grain
 * comes from real residuals of that same paper (so it does not look blurred).
 * Strokes replay dab by dab, so live painting and re-renders at any resolution
 * match, and cost stays bounded per dab.
 */

/** One brush sample: position normalized 0–1, radius as a fraction of min(w,h). */
export interface ErasePoint {
  x: number;
  y: number;
  r: number;
  feather?: number;
}

/** A completed clean-up stroke: erase a mark or restore the original pixels. */
export interface ScanEraseStroke {
  pts: ErasePoint[];
  /** Missing on older saved strokes means erase for backward compatibility. */
  mode?: 'erase' | 'restore';
  feather?: number;
}

/** Width of the original→fill blend ramp at the mask edge, in pixels. */
const DEFAULT_FEATHER_PX = 1.5;

/**
 * Applies erase strokes to `canvas` in place. Stroke coordinates are
 * normalized to the canvas, so the same strokes reproduce identically at
 * preview and export resolutions.
 */
export function applyEraseStrokes(
  canvas: HTMLCanvasElement,
  strokes: ScanEraseStroke[],
  /** Filtered/cropped image before any clean-up strokes. Required for restore strokes. */
  original?: HTMLCanvasElement | null
): void {
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!ctx) return;
  const originalCtx = original?.getContext('2d', { alpha: false, willReadFrequently: true }) ?? null;
  for (const stroke of strokes) {
    if (stroke.pts.length === 0) continue;
    if (stroke.mode === 'restore' && originalCtx) {
      restoreStrokeRegion(ctx, originalCtx, canvas.width, canvas.height, stroke);
    } else if (stroke.mode !== 'restore') {
      eraseStrokeRegion(ctx, canvas.width, canvas.height, stroke);
    }
  }
}

/** Paints the pre-eraser pixels back through the brush mask. */
function restoreStrokeRegion(
  ctx: CanvasRenderingContext2D,
  originalCtx: CanvasRenderingContext2D,
  w: number,
  h: number,
  stroke: ScanEraseStroke
): void {
  const pts = stroke.pts;
  const minDim = Math.min(w, h);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    const rpx = p.r * minDim;
    const x = p.x * w;
    const y = p.y * h;
    minX = Math.min(minX, x - rpx);
    minY = Math.min(minY, y - rpx);
    maxX = Math.max(maxX, x + rpx);
    maxY = Math.max(maxY, y + rpx);
  }
  const x0 = Math.max(0, Math.floor(minX) - 2);
  const y0 = Math.max(0, Math.floor(minY) - 2);
  const x1 = Math.min(w - 1, Math.ceil(maxX) + 2);
  const y1 = Math.min(h - 1, Math.ceil(maxY) + 2);
  const rw = x1 - x0 + 1;
  const rh = y1 - y0 + 1;
  if (rw < 1 || rh < 1) return;

  const current = ctx.getImageData(x0, y0, rw, rh);
  const source = originalCtx.getImageData(x0, y0, rw, rh);
  const mask = new Float32Array(rw * rh);
  for (const p of pts) {
    const cx = p.x * w - x0;
    const cy = p.y * h - y0;
    const radius = Math.max(0.5, p.r * minDim);
    const featherPx = p.feather ?? stroke.feather ?? DEFAULT_FEATHER_PX;
    const outer = radius + featherPx;
    const yFrom = Math.max(0, Math.ceil(cy - outer));
    const yTo = Math.min(rh - 1, Math.floor(cy + outer));
    for (let yy = yFrom; yy <= yTo; yy++) {
      const dy = yy - cy;
      const xSpan = Math.sqrt(Math.max(0, outer * outer - dy * dy));
      const xFrom = Math.max(0, Math.ceil(cx - xSpan));
      const xTo = Math.min(rw - 1, Math.floor(cx + xSpan));
      for (let xx = xFrom; xx <= xTo; xx++) {
        const distance = Math.hypot(xx - cx, dy);
        const alpha = distance <= radius ? 1 : Math.max(0, 1 - (distance - radius) / featherPx);
        const i = yy * rw + xx;
        if (alpha > mask[i]) mask[i] = alpha;
      }
    }
  }

  for (let i = 0; i < mask.length; i++) {
    const alpha = mask[i];
    if (alpha <= 0) continue;
    const i4 = i * 4;
    current.data[i4] += (source.data[i4] - current.data[i4]) * alpha;
    current.data[i4 + 1] += (source.data[i4 + 1] - current.data[i4 + 1]) * alpha;
    current.data[i4 + 2] += (source.data[i4 + 2] - current.data[i4 + 2]) * alpha;
  }
  ctx.putImageData(current, x0, y0);
}

/** Brush radius growth so the anti-aliased fringe of a mark is inside the hole. */
const GROW_PX = 2;
/** Soft blend ramp at the edge of the hole. */
const EDGE_PX = 1.5;
/** Width of the ring of surrounding pixels sampled for paper colour. */
const RING_PX = 7;
const MAX_SAMPLES = 90;

/** Repairs every dab of a stroke with a paper model (never copies content). */
function eraseStrokeRegion(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  stroke: ScanEraseStroke
): void {
  const minDim = Math.min(w, h);
  for (const p of stroke.pts) {
    const r = Math.max(0.75, p.r * minDim) + GROW_PX;
    fillDab(ctx, w, h, p.x * w, p.y * h, r);
  }
}

function hash01(x: number, y: number): number {
  let n = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/**
 * Paper model for one disc:
 *  1. Sample a ring around the disc and keep ONLY paper-like pixels (ink and
 *     its anti-aliased fringe are brighter-than-threshold rejected), so no
 *     text colour can leak in.
 *  2. Colour = inverse-distance blend of those paper samples, so the fill
 *     matches the nearest border exactly and relaxes to the local average.
 *  3. Grain = residuals of real paper pixels (after removing a fitted plane),
 *     picked pseudo-randomly, so the fill keeps true sensor/paper noise
 *     instead of looking blurred.
 */
function fillDab(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  cx: number,
  cy: number,
  r: number
): void {
  const outer = r + RING_PX;
  const x0 = Math.max(0, Math.floor(cx - outer));
  const y0 = Math.max(0, Math.floor(cy - outer));
  const x1 = Math.min(w - 1, Math.ceil(cx + outer));
  const y1 = Math.min(h - 1, Math.ceil(cy + outer));
  const rw = x1 - x0 + 1;
  const rh = y1 - y0 + 1;
  if (rw < 3 || rh < 3) return;

  const image = ctx.getImageData(x0, y0, rw, rh);
  const d = image.data;
  const lcx = cx - x0;
  const lcy = cy - y0;
  const inner = r + EDGE_PX + 1;
  const inner2 = inner * inner;
  const outer2 = outer * outer;

  const ringIdx: number[] = [];
  const ringLuma: number[] = [];
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const d2 = (x - lcx) * (x - lcx) + (y - lcy) * (y - lcy);
      if (d2 < inner2 || d2 > outer2) continue;
      const i = (y * rw + x) * 4;
      ringIdx.push(y * rw + x);
      ringLuma.push((d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8);
    }
  }
  if (ringIdx.length < 6) return;

  const sorted = Float32Array.from(ringLuma).sort();
  const ref = sorted[Math.floor(sorted.length * 0.7)];
  const spread = Math.max(
    6,
    (sorted[Math.floor(sorted.length * 0.85)] - sorted[Math.floor(sorted.length * 0.55)]) * 2
  );
  const minLuma = ref - spread - 6;

  let paper: number[] = [];
  for (let j = 0; j < ringIdx.length; j++) if (ringLuma[j] >= minLuma) paper.push(ringIdx[j]);
  if (paper.length < 6) paper = ringIdx;
  if (paper.length > MAX_SAMPLES) {
    const step = paper.length / MAX_SAMPLES;
    const picked: number[] = [];
    for (let k = 0; k < MAX_SAMPLES; k++) picked.push(paper[Math.floor(k * step)]);
    paper = picked;
  }
  const m = paper.length;

  const sx = new Float32Array(m);
  const sy = new Float32Array(m);
  const sv = new Float32Array(m * 3);
  for (let k = 0; k < m; k++) {
    const idx = paper[k];
    const x = idx % rw;
    const y = (idx - x) / rw;
    sx[k] = x - lcx;
    sy[k] = y - lcy;
    sv[k * 3] = d[idx * 4];
    sv[k * 3 + 1] = d[idx * 4 + 1];
    sv[k * 3 + 2] = d[idx * 4 + 2];
  }

  // Least-squares plane v = a + bx*x + by*y per channel, centered on the dab.
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sx1 = 0;
  let sy1 = 0;
  for (let k = 0; k < m; k++) {
    sxx += sx[k] * sx[k];
    sxy += sx[k] * sy[k];
    syy += sy[k] * sy[k];
    sx1 += sx[k];
    sy1 += sy[k];
  }
  const A = [
    [m, sx1, sy1],
    [sx1, sxx, sxy],
    [sy1, sxy, syy],
  ];
  const det3 = (a: number[][]) =>
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
    a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
    a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const detA = det3(A);
  const plane = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let c = 0; c < 3; c++) {
    let b0 = 0;
    let bx = 0;
    let by = 0;
    for (let k = 0; k < m; k++) {
      const v = sv[k * 3 + c];
      b0 += v;
      bx += v * sx[k];
      by += v * sy[k];
    }
    if (Math.abs(detA) < 1e-3) {
      plane[c] = [b0 / m, 0, 0];
      continue;
    }
    const col = (j: number, rhs: number[]) => A.map((row, i) => row.map((v, q) => (q === j ? rhs[i] : v)));
    const rhs = [b0, bx, by];
    plane[c] = [det3(col(0, rhs)) / detA, det3(col(1, rhs)) / detA, det3(col(2, rhs)) / detA];
  }

  // Grain bank: luma-correlated residuals of real paper after plane removal.
  const grain = new Float32Array(m * 3);
  let grainEnergy = 0;
  for (let k = 0; k < m; k++) {
    for (let c = 0; c < 3; c++) {
      const res = sv[k * 3 + c] - (plane[c][0] + plane[c][1] * sx[k] + plane[c][2] * sy[k]);
      grain[k * 3 + c] = res;
      grainEnergy += res * res;
    }
  }
  const grainStd = Math.sqrt(grainEnergy / (m * 3));
  const clampGrain = Math.max(4, grainStd * 3);

  const hole = r + EDGE_PX;
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const dx = x - lcx;
      const dy = y - lcy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > hole) continue;
      const alpha = dist <= r ? 1 : 1 - (dist - r) / EDGE_PX;

      let wsum = 0;
      let cr = 0;
      let cg = 0;
      let cb = 0;
      for (let k = 0; k < m; k++) {
        const ex = sx[k] - dx;
        const ey = sy[k] - dy;
        const wt = 1 / (ex * ex + ey * ey + 1);
        const w2 = wt * wt;
        wsum += w2;
        cr += sv[k * 3] * w2;
        cg += sv[k * 3 + 1] * w2;
        cb += sv[k * 3 + 2] * w2;
      }
      cr /= wsum;
      cg /= wsum;
      cb /= wsum;

      const g = Math.floor(hash01(x0 + x, y0 + y) * m) * 3;
      const gr = Math.max(-clampGrain, Math.min(clampGrain, grain[g]));
      const gg = Math.max(-clampGrain, Math.min(clampGrain, grain[g + 1]));
      const gb = Math.max(-clampGrain, Math.min(clampGrain, grain[g + 2]));

      const i = (y * rw + x) * 4;
      d[i] += (cr + gr - d[i]) * alpha;
      d[i + 1] += (cg + gg - d[i + 1]) * alpha;
      d[i + 2] += (cb + gb - d[i + 2]) * alpha;
    }
  }
  ctx.putImageData(image, x0, y0);
}
