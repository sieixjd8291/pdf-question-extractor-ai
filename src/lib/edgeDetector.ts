import type { ScanQuad } from './scannerFilters';

export interface Point {
  x: number;
  y: number;
}

export interface CandidateQuad {
  pts: [Point, Point, Point, Point]; // TL, TR, BR, BL in working pixels
  score: number;
  source: string;
  twoPagePair?: TwoPageHullPair;
}

interface Line2D {
  a: number;
  b: number;
  c: number; // a*x + b*y + c = 0, where a^2 + b^2 = 1
}

/**
 * Validates whether a quadrilateral is geometrically plausible, strictly convex,
 * and within normalized bounds [0, 1].
 */
export function isSaneQuad(quad: ScanQuad): boolean {
  if (!quad || !quad.tl || !quad.tr || !quad.br || !quad.bl) return false;
  const p = [quad.tl, quad.tr, quad.br, quad.bl];

  for (let i = 0; i < 4; i++) {
    if (
      !Number.isFinite(p[i].x) ||
      !Number.isFinite(p[i].y) ||
      p[i].x < -0.05 ||
      p[i].x > 1.05 ||
      p[i].y < -0.05 ||
      p[i].y > 1.05
    ) {
      return false;
    }
  }

  // Strictly convex: cross products of successive edges must all share the same sign
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = p[i];
    const b = p[(i + 1) % 4];
    const c = p[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const s = cross > 1e-7 ? 1 : cross < -1e-7 ? -1 : 0;
    if (s === 0) return false;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }

  const sides = [
    Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y),
    Math.hypot(p[2].x - p[1].x, p[2].y - p[1].y),
    Math.hypot(p[3].x - p[2].x, p[3].y - p[2].y),
    Math.hypot(p[0].x - p[3].x, p[0].y - p[3].y),
  ];
  if (Math.min(...sides) < 0.04) return false;

  // Approximate area via Shoelace formula
  const area =
    0.5 *
    Math.abs(
      p[0].x * p[1].y -
        p[1].x * p[0].y +
        (p[1].x * p[2].y - p[2].x * p[1].y) +
        (p[2].x * p[3].y - p[3].x * p[2].y) +
        (p[3].x * p[0].y - p[0].x * p[3].y)
    );

  return area >= 0.005 && area <= 1.05;
}

// ---------------------------------------------------------------------------
// 2D Polygon & Geometry Utilities
// ---------------------------------------------------------------------------

export function polygonArea(pts: Point[]): number {
  let a = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(a) * 0.5;
}

export function polygonPerimeter(pts: Point[]): number {
  let p = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    p += Math.hypot(pts[j].x - pts[i].x, pts[j].y - pts[i].y);
  }
  return p;
}

/** Monotone chain convex hull algorithm */
export function convexHull(pts: Point[]): Point[] {
  if (pts.length <= 3) return pts.slice();
  const sorted = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);

  const cross = (o: Point, a: Point, b: Point) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: Point[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: Point[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function pointToSegmentDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Douglas-Peucker polygon simplification */
export function douglasPeucker(pts: Point[], epsilon: number): Point[] {
  if (pts.length <= 2) return pts;
  let maxDist = 0;
  let index = 0;
  const n = pts.length;
  for (let i = 1; i < n - 1; i++) {
    const d = pointToSegmentDist(pts[i], pts[0], pts[n - 1]);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist > epsilon) {
    const left = douglasPeucker(pts.slice(0, index + 1), epsilon);
    const right = douglasPeucker(pts.slice(index), epsilon);
    return left.slice(0, left.length - 1).concat(right);
  }
  return [pts[0], pts[n - 1]];
}

/** Orders 4 points clockwise starting from Top-Left */
export function orderQuadCorners(pts: Point[]): [Point, Point, Point, Point] {
  if (pts.length !== 4) {
    throw new Error('orderQuadCorners requires exactly 4 points');
  }

  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= 4;
  cy /= 4;

  // Sort clockwise by polar angle
  const sorted = pts
    .slice()
    .sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));

  // Determine top-left corner: minimum (x + y)
  let bestTlIdx = 0;
  let minSum = Infinity;
  for (let i = 0; i < 4; i++) {
    const s = sorted[i].x + sorted[i].y;
    if (s < minSum) {
      minSum = s;
      bestTlIdx = i;
    }
  }

  const tl = sorted[bestTlIdx];
  const tr = sorted[(bestTlIdx + 1) % 4];
  const br = sorted[(bestTlIdx + 2) % 4];
  const bl = sorted[(bestTlIdx + 3) % 4];

  return [tl, tr, br, bl];
}

export function isConvexQuad(q: [Point, Point, Point, Point]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const s = cross > 1e-4 ? 1 : cross < -1e-4 ? -1 : 0;
    if (s === 0) return false;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

export function quadAnglesScore(q: [Point, Point, Point, Point]): number {
  let score = 1;
  for (let i = 0; i < 4; i++) {
    const prev = q[(i + 3) % 4];
    const curr = q[i];
    const next = q[(i + 1) % 4];

    const v1x = prev.x - curr.x;
    const v1y = prev.y - curr.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;

    const dot = v1x * v2x + v1y * v2y;
    const len1 = Math.hypot(v1x, v1y);
    const len2 = Math.hypot(v2x, v2y);
    if (len1 < 1e-4 || len2 < 1e-4) return 0;

    const cosTheta = Math.max(-1, Math.min(1, dot / (len1 * len2)));
    const angleDeg = (Math.acos(cosTheta) * 180) / Math.PI;

    // Interior document angles should be reasonably close to 90 degrees (35 to 145)
    if (angleDeg < 35 || angleDeg > 145) return 0;
    score *= Math.sin((angleDeg * Math.PI) / 180);
  }
  return score;
}

/** Intersect two 2D lines in standard form: a*x + b*y + c = 0 */
function intersectLines(l1: Line2D, l2: Line2D): Point | null {
  const det = l1.a * l2.b - l1.b * l2.a;
  if (Math.abs(det) < 1e-5) return null;
  const x = (l1.b * l2.c - l2.b * l1.c) / det;
  const y = (l2.a * l1.c - l1.a * l2.c) / det;
  return { x, y };
}

/** Computes a 4-point quadrilateral from 4 boundary lines: top, right, bottom, left */
function quadFrom4Lines(
  top: Line2D,
  right: Line2D,
  bottom: Line2D,
  left: Line2D
): [Point, Point, Point, Point] | null {
  const tl = intersectLines(top, left);
  const tr = intersectLines(top, right);
  const br = intersectLines(bottom, right);
  const bl = intersectLines(bottom, left);
  if (!tl || !tr || !br || !bl) return null;

  const quad = orderQuadCorners([tl, tr, br, bl]);
  if (!isConvexQuad(quad)) return null;
  if (quadAnglesScore(quad) <= 0) return null;
  return quad;
}

/** Given a simplified polygon of 4 to 12 points, extracts the best 4-corner quad */
export function reducePolygonToQuad(
  pts: Point[],
  hullArea: number
): [Point, Point, Point, Point] | null {
  if (pts.length === 4) {
    const q = orderQuadCorners(pts);
    return isConvexQuad(q) && quadAnglesScore(q) > 0 ? q : null;
  }
  if (pts.length < 4) return null;

  // For polygons with > 4 points, test combinations of 4 vertices
  // Cap at 12 to maintain predictable speed
  const subset = pts.length > 12 ? pts.slice(0, 12) : pts;
  let bestQuad: [Point, Point, Point, Point] | null = null;
  let bestScore = -1;
  const n = subset.length;

  for (let i = 0; i < n - 3; i++) {
    for (let j = i + 1; j < n - 2; j++) {
      for (let k = j + 1; k < n - 1; k++) {
        for (let l = k + 1; l < n; l++) {
          const cand = orderQuadCorners([subset[i], subset[j], subset[k], subset[l]]);
          if (!isConvexQuad(cand)) continue;
          const aScore = quadAnglesScore(cand);
          if (aScore <= 0) continue;

          const area = polygonArea(cand);
          const areaRatio = area / Math.max(1, hullArea);
          if (areaRatio < 0.5) continue;

          const composite = areaRatio * aScore;
          if (composite > bestScore) {
            bestScore = composite;
            bestQuad = cand;
          }
        }
      }
    }
  }

  return bestQuad;
}

// ---------------------------------------------------------------------------
// Multi-Channel Preprocessing and Edge Field
// ---------------------------------------------------------------------------

export interface OrientedEdgeField {
  w: number;
  h: number;
  scaleX: number;
  scaleY: number;
  gray: Uint8Array;
  colorGrad: Float32Array;
  horizEdgeGrad: Float32Array; // Prioritizes high-gradient horizontal edges for top/bottom boundary points
  vertEdgeGrad: Float32Array;  // Prioritizes high-gradient vertical edges for left/right boundary points
  gradX: Float32Array;
  gradY: Float32Array;
  smooth: Float32Array;
  blurBg: Float32Array;
  magRef: number;
  horizMagRef: number;
  vertMagRef: number;
  borderBg: [number, number, number];
  borderDev: number;
}

function prepOrientedEdgeField(
  source: HTMLImageElement | HTMLCanvasElement,
  rotation: 0 | 90 | 180 | 270 = 0
): OrientedEdgeField | null {
  const origW = (source as HTMLImageElement).naturalWidth || source.width;
  const origH = (source as HTMLImageElement).naturalHeight || source.height;
  if (!origW || !origH) return null;

  const isRotated90 = rotation === 90 || rotation === 270;
  const orientedW = isRotated90 ? origH : origW;
  const orientedH = isRotated90 ? origW : origH;

  // Working resolution target: ~420px max dimension for sub-millisecond precision
  const targetMax = 420;
  const scale = Math.min(1, targetMax / Math.max(orientedW, orientedH));
  const w = Math.max(64, Math.round(orientedW * scale));
  const h = Math.max(64, Math.round(orientedH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!ctx) return null;

  // Progressive downscale: a single bilinear step at a ~7x reduction decimates
  // (individual source texels get picked), which aliases the page boundary and
  // shifts gradient statistics on the working field — enough to move detected
  // corners on borderline scenes. An intermediate pass at ~2.5x the target
  // with high-quality smoothing keeps the small field faithful to the capture
  // regardless of how large the stored master is.
  const drawOriented = (
    target: HTMLCanvasElement,
    tw: number,
    th: number
  ) => {
    const tctx = target.getContext('2d', { alpha: false });
    if (!tctx) return;
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = 'high';
    tctx.save();
    if (rotation === 90) {
      tctx.translate(tw, 0);
      tctx.rotate(Math.PI / 2);
      tctx.drawImage(source, 0, 0, th, tw);
    } else if (rotation === 180) {
      tctx.translate(tw, th);
      tctx.rotate(Math.PI);
      tctx.drawImage(source, 0, 0, tw, th);
    } else if (rotation === 270) {
      tctx.translate(0, th);
      tctx.rotate((3 * Math.PI) / 2);
      tctx.drawImage(source, 0, 0, th, tw);
    } else {
      tctx.drawImage(source, 0, 0, tw, th);
    }
    tctx.restore();
  };

  const reduction = Math.max(orientedW, orientedH) / targetMax;
  if (reduction > 3) {
    const midScale = 2.5 / reduction;
    const mid = document.createElement('canvas');
    mid.width = Math.max(1, Math.round(orientedW * midScale));
    mid.height = Math.max(1, Math.round(orientedH * midScale));
    drawOriented(mid, mid.width, mid.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(mid, 0, 0, w, h);
  } else {
    drawOriented(canvas, w, h);
  }

  return prepareEdgeFieldFromPixels(ctx.getImageData(0, 0, w, h).data, w, h, orientedW, orientedH);
}

export function prepareEdgeFieldFromPixels(
  data: Uint8ClampedArray, w: number, h: number, orientedW = w, orientedH = h
): OrientedEdgeField {
  const n = w * h;

  const rChan = new Uint8Array(n);
  const gChan = new Uint8Array(n);
  const bChan = new Uint8Array(n);
  const gray = new Uint8Array(n);

  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = data[j];
    const g = data[j + 1];
    const b = data[j + 2];
    rChan[i] = r;
    gChan[i] = g;
    bChan[i] = b;
    // BT.601 integer luma
    gray[i] = (r * 77 + g * 150 + b * 29) >> 8;
  }

  // Gaussian 3x3 smoothing on luminance
  const smooth = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    const rPrev = (y - 1) * w;
    const rCurr = y * w;
    const rNext = (y + 1) * w;
    for (let x = 1; x < w - 1; x++) {
      smooth[rCurr + x] =
        (gray[rPrev + x - 1] + 2 * gray[rPrev + x] + gray[rPrev + x + 1] +
         2 * gray[rCurr + x - 1] + 4 * gray[rCurr + x] + 2 * gray[rCurr + x + 1] +
         gray[rNext + x - 1] + 2 * gray[rNext + x] + gray[rNext + x + 1]) / 16;
    }
  }

  // Background estimation via separable box blur (radius approx 1/20 of dimension)
  const bgRadius = Math.max(4, Math.round(Math.min(w, h) / 24));
  const blurBg = computeBoxBlurFloat(smooth, w, h, bgRadius);

  // Multi-Channel Color Sobel Gradient
  const colorGrad = new Float32Array(n);
  const horizEdgeGrad = new Float32Array(n);
  const vertEdgeGrad = new Float32Array(n);
  const gradX = new Float32Array(n);
  const gradY = new Float32Array(n);

  let gradSum = 0;
  let horizGradSum = 0;
  let vertGradSum = 0;
  let gradCount = 0;

  for (let y = 1; y < h - 1; y++) {
    const rPrev = (y - 1) * w;
    const rCurr = y * w;
    const rNext = (y + 1) * w;
    for (let x = 1; x < w - 1; x++) {
      const idx = rCurr + x;

      // Luminance Sobel
      const gxL =
        -smooth[rPrev + x - 1] + smooth[rPrev + x + 1] -
        2 * smooth[rCurr + x - 1] + 2 * smooth[rCurr + x + 1] -
        smooth[rNext + x - 1] + smooth[rNext + x + 1];

      const gyL =
        -smooth[rPrev + x - 1] - 2 * smooth[rPrev + x] - smooth[rPrev + x + 1] +
        smooth[rNext + x - 1] + 2 * smooth[rNext + x] + smooth[rNext + x + 1];

      gradX[idx] = gxL;
      gradY[idx] = gyL;
      const magL = Math.hypot(gxL, gyL);

      // Red Sobel
      const gxR =
        -rChan[rPrev + x - 1] + rChan[rPrev + x + 1] -
        2 * rChan[rCurr + x - 1] + 2 * rChan[rCurr + x + 1] -
        rChan[rNext + x - 1] + rChan[rNext + x + 1];
      const gyR =
        -rChan[rPrev + x - 1] - 2 * rChan[rPrev + x] - rChan[rPrev + x + 1] +
        rChan[rNext + x - 1] + 2 * rChan[rNext + x] + rChan[rNext + x + 1];
      const magR = Math.hypot(gxR, gyR);

      // Green Sobel
      const gxG =
        -gChan[rPrev + x - 1] + gChan[rPrev + x + 1] -
        2 * gChan[rCurr + x - 1] + 2 * gChan[rCurr + x + 1] -
        gChan[rNext + x - 1] + gChan[rNext + x + 1];
      const gyG =
        -gChan[rPrev + x - 1] - 2 * gChan[rPrev + x] - gChan[rPrev + x + 1] +
        gChan[rNext + x - 1] + 2 * gChan[rNext + x] + gChan[rNext + x + 1];
      const magG = Math.hypot(gxG, gyG);

      // Blue Sobel
      const gxB =
        -bChan[rPrev + x - 1] + bChan[rPrev + x + 1] -
        2 * bChan[rCurr + x - 1] + 2 * bChan[rCurr + x + 1] -
        bChan[rNext + x - 1] + bChan[rNext + x + 1];
      const gyB =
        -bChan[rPrev + x - 1] - 2 * bChan[rPrev + x] - bChan[rPrev + x + 1] +
        bChan[rNext + x - 1] + 2 * bChan[rNext + x] + bChan[rNext + x + 1];
      const magB = Math.hypot(gxB, gyB);

      // Maximal response across color channels
      const maxMag = Math.max(magL, magR, magG, magB);
      colorGrad[idx] = maxMag;

      // Multi-channel directional absolute components
      const absGx = Math.max(Math.abs(gxL), Math.abs(gxR), Math.abs(gxG), Math.abs(gxB));
      const absGy = Math.max(Math.abs(gyL), Math.abs(gyR), Math.abs(gyG), Math.abs(gyB));

      // Prioritize high-gradient horizontal edges for top/bottom boundary points:
      // Horizontal edges produce strong vertical derivatives (|Gy|).
      // Suppresses vertical text strokes and column dividers (|Gx| >> |Gy|) from inner content.
      const horizFactor = absGy / (Math.hypot(absGy, absGx * 0.65) + 1e-4);
      const hGrad = absGy * (0.35 + 0.65 * horizFactor);
      horizEdgeGrad[idx] = hGrad;

      // Prioritize high-gradient vertical edges for left/right boundary points:
      // Vertical edges produce strong horizontal derivatives (|Gx|).
      // Suppresses horizontal text lines, underlines, and header dividers (|Gy| >> |Gx|) from inner content.
      const vertFactor = absGx / (Math.hypot(absGx, absGy * 0.65) + 1e-4);
      const vGrad = absGx * (0.35 + 0.65 * vertFactor);
      vertEdgeGrad[idx] = vGrad;

      if (x > 8 && x < w - 8 && y > 8 && y < h - 8) {
        gradSum += maxMag;
        horizGradSum += hGrad;
        vertGradSum += vGrad;
        gradCount++;
      }
    }
  }

  const avgGrad = gradCount > 0 ? gradSum / gradCount : 25;
  const magRef = Math.max(30, avgGrad * 2.2);

  const avgHorizGrad = gradCount > 0 ? horizGradSum / gradCount : 20;
  const horizMagRef = Math.max(22, avgHorizGrad * 2.2);

  const avgVertGrad = gradCount > 0 ? vertGradSum / gradCount : 20;
  const vertMagRef = Math.max(22, avgVertGrad * 2.2);

  // Border background sample
  let bR = 0, bG = 0, bB = 0, bLuma = 0;
  let bCount = 0;
  for (let x = 0; x < w; x++) {
    const idxT = x;
    const idxB = (h - 1) * w + x;
    bR += rChan[idxT] + rChan[idxB];
    bG += gChan[idxT] + gChan[idxB];
    bB += bChan[idxT] + bChan[idxB];
    bLuma += gray[idxT] + gray[idxB];
    bCount += 2;
  }
  for (let y = 1; y < h - 1; y++) {
    const idxL = y * w;
    const idxR = y * w + (w - 1);
    bR += rChan[idxL] + rChan[idxR];
    bG += gChan[idxL] + gChan[idxR];
    bB += bChan[idxL] + bChan[idxR];
    bLuma += gray[idxL] + gray[idxR];
    bCount += 2;
  }
  const meanLuma = bCount > 0 ? bLuma / bCount : 128;
  const borderBg: [number, number, number] = [
    bCount > 0 ? Math.round(bR / bCount) : 128,
    bCount > 0 ? Math.round(bG / bCount) : 128,
    bCount > 0 ? Math.round(bB / bCount) : 128,
  ];

  // Variance on border
  let bVar = 0;
  for (let x = 0; x < w; x++) {
    const d1 = gray[x] - meanLuma;
    const d2 = gray[(h - 1) * w + x] - meanLuma;
    bVar += d1 * d1 + d2 * d2;
  }
  for (let y = 1; y < h - 1; y++) {
    const d1 = gray[y * w] - meanLuma;
    const d2 = gray[y * w + (w - 1)] - meanLuma;
    bVar += d1 * d1 + d2 * d2;
  }
  const borderDev = Math.sqrt(bVar / Math.max(1, bCount));

  return {
    w,
    h,
    scaleX: orientedW / w,
    scaleY: orientedH / h,
    gray,
    colorGrad,
    horizEdgeGrad,
    vertEdgeGrad,
    gradX,
    gradY,
    smooth,
    blurBg,
    magRef,
    horizMagRef,
    vertMagRef,
    borderBg,
    borderDev,
  };
}

function computeBoxBlurFloat(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const dst = new Float32Array(w * h);

  // Horizontal pass
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) {
      const col = Math.max(0, Math.min(w - 1, k));
      sum += src[row + col];
    }
    const win = 2 * r + 1;
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / win;
      const leftCol = Math.max(0, x - r);
      const rightCol = Math.min(w - 1, x + r + 1);
      sum += src[row + rightCol] - src[row + leftCol];
    }
  }

  // Vertical pass
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) {
      const row = Math.max(0, Math.min(h - 1, k)) * w;
      sum += tmp[row + x];
    }
    const win = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum / win;
      const topRow = Math.max(0, y - r) * w;
      const btmRow = Math.min(h - 1, y + r + 1) * w;
      sum += tmp[btmRow + x] - tmp[topRow + x];
    }
  }

  return dst;
}

// ---------------------------------------------------------------------------
// Robust Line Fitting via RANSAC and Theil-Sen
// ---------------------------------------------------------------------------

/**
 * Deterministic PRNG (mulberry32). RANSAC previously drew its sample pairs
 * from Math.random(), so the same photo produced different quads on
 * successive detections. Detection reseeds this at the start of every pass,
 * making results reproducible run-to-run.
 */
let rngState = 0x9e3779b9;

function resetDetectionRng(): void {
  rngState = 0x9e3779b9;
}

function randNext(): number {
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function fitLineRansac(
  pts: Point[],
  isHorizontal: boolean,
  distThreshold = 3.0,
  maxIterations = 240
): Line2D | null {
  if (pts.length < 5) return null;

  let bestInliers = 0;
  let bestLine: Line2D | null = null;
  const n = pts.length;

  for (let it = 0; it < maxIterations; it++) {
    const idx1 = Math.floor(randNext() * n);
    let idx2 = Math.floor(randNext() * n);
    if (idx1 === idx2) idx2 = (idx1 + 1) % n;

    const p1 = pts[idx1];
    const p2 = pts[idx2];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy);
    if (len < 12) continue;

    // Angle filtering: horizontal lines should have slope < 0.65 (around +/- 33 deg max tilt)
    if (isHorizontal && Math.abs(dy / len) > 0.6) continue;
    // Vertical lines should have dx / len < 0.6
    if (!isHorizontal && Math.abs(dx / len) > 0.6) continue;

    const la = -dy / len;
    const lb = dx / len;
    const lc = -(la * p1.x + lb * p1.y);

    let inliers = 0;
    for (let k = 0; k < n; k++) {
      const dist = Math.abs(la * pts[k].x + lb * pts[k].y + lc);
      if (dist <= distThreshold) inliers++;
    }

    if (inliers > bestInliers) {
      bestInliers = inliers;
      bestLine = { a: la, b: lb, c: lc };
    }
  }

  // Refine the line using least squares on all inliers
  if (bestLine && bestInliers >= Math.max(5, Math.round(n * 0.22))) {
    const inlierPts: Point[] = [];
    for (let k = 0; k < n; k++) {
      const dist = Math.abs(bestLine.a * pts[k].x + bestLine.b * pts[k].y + bestLine.c);
      if (dist <= distThreshold * 1.5) inlierPts.push(pts[k]);
    }
    return fitLineLeastSquares(inlierPts);
  }

  return null;
}

function fitLineLeastSquares(pts: Point[]): Line2D | null {
  if (pts.length < 2) return null;
  let mx = 0;
  let my = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    mx += pts[i].x;
    my += pts[i].y;
  }
  mx /= n;
  my /= n;

  let covXX = 0;
  let covXY = 0;
  let covYY = 0;
  for (let i = 0; i < n; i++) {
    const rx = pts[i].x - mx;
    const ry = pts[i].y - my;
    covXX += rx * rx;
    covXY += rx * ry;
    covYY += ry * ry;
  }

  const theta = 0.5 * Math.atan2(2 * covXY, covXX - covYY);
  const a = -Math.sin(theta);
  const b = Math.cos(theta);
  const c = -(a * mx + b * my);
  return { a, b, c };
}

/**
 * Page-vs-background polarity from the frame interior: positive = bright page
 * on a darker surround (the usual photo), negative = dark document on a
 * light desk, near zero = undecided. Gates boundary confirmations: the
 * interior side of a genuine page boundary lies on the page-polarity side of
 * the background, so the page's own cast shadow — a soft dark band just
 * OUTSIDE the boundary — no longer reads as the edge.
 *
 * Samples multiple interior regions (center, left-center, right-center,
 * top-center, bottom-center) so that central gutter/spine shadows in 2-page
 * documents do not drag the polarity down.
 */
function computePagePolarity(f: OrientedEdgeField): number {
  const { w, h, gray, borderBg } = f;
  const borderLuma = (borderBg[0] * 77 + borderBg[1] * 150 + borderBg[2] * 29) >> 8;

  const probeRegions = [
    { x0: Math.round(w * 0.40), x1: Math.round(w * 0.60), y0: Math.round(h * 0.40), y1: Math.round(h * 0.60) },
    { x0: Math.round(w * 0.18), x1: Math.round(w * 0.38), y0: Math.round(h * 0.35), y1: Math.round(h * 0.65) },
    { x0: Math.round(w * 0.62), x1: Math.round(w * 0.82), y0: Math.round(h * 0.35), y1: Math.round(h * 0.65) },
    { x0: Math.round(w * 0.35), x1: Math.round(w * 0.65), y0: Math.round(h * 0.18), y1: Math.round(h * 0.38) },
    { x0: Math.round(w * 0.35), x1: Math.round(w * 0.65), y0: Math.round(h * 0.62), y1: Math.round(h * 0.82) },
  ];

  let bestPol = 0;
  let maxAbs = 0;
  for (const r of probeRegions) {
    let sum = 0;
    let count = 0;
    for (let yy = r.y0; yy < r.y1; yy++) {
      for (let xx = r.x0; xx < r.x1; xx++) {
        sum += gray[yy * w + xx];
        count++;
      }
    }
    if (count > 0) {
      const pol = sum / count - borderLuma;
      if (Math.abs(pol) > maxAbs) {
        maxAbs = Math.abs(pol);
        bestPol = pol;
      }
    }
  }
  return bestPol;
}

// ---------------------------------------------------------------------------
// Detector 1: Multi-Scale Directional Inward Radar (Ray Scan)
// ---------------------------------------------------------------------------

/**
 * Scans inward from the four borders of the frame to locate the first persistent
 * paper boundary. Highly resilient to internal document content, text, tables, and photos.
 */
function runDirectionalInwardScan(
  f: OrientedEdgeField,
  minGradFraction: number
): [Point, Point, Point, Point] | null {
  const { w, h, horizEdgeGrad, vertEdgeGrad, horizMagRef, vertMagRef, gray } = f;
  const topThresh = Math.max(12, horizMagRef * minGradFraction);
  const btmThresh = Math.max(12, horizMagRef * minGradFraction);
  const leftThresh = Math.max(12, vertMagRef * minGradFraction);
  const rightThresh = Math.max(12, vertMagRef * minGradFraction);
  const pagePolarity = computePagePolarity(f);

  // Margin buffer to skip sensor noise at the very perimeter
  const padX = Math.max(4, Math.round(w * 0.02));
  const padY = Math.max(4, Math.round(h * 0.02));

  // Inward scan from TOP:
  // Prioritizes high-gradient horizontal edges (|Gy| dominant, suppressing vertical letter strokes/stems).
  // Detects the true outer edge transition rather than interior document content/headers.
  const topPoints: Point[] = [];
  const maxTopY = Math.min(Math.round(h * 0.55), padY + Math.round(h * 0.50));
  for (let x = padX; x < w - padX; x += 2) {
    let bestY = -1;
    let bestScore = 0;

    for (let y = padY + 4; y < maxTopY; y++) {
      const idx = y * w + x;
      const magH = horizEdgeGrad[idx];
      if (magH < Math.max(10, topThresh * 0.35)) continue;
      if (magH < horizEdgeGrad[(y - 1) * w + x] || magH < horizEdgeGrad[(y + 1) * w + x]) continue;

      let outSum = 0, outCnt = 0;
      for (let k = 2; k <= 5; k++) {
        const ny = y - k;
        if (ny >= padY) { outSum += gray[ny * w + x]; outCnt++; }
      }
      let inSum = 0, inCnt = 0;
      for (let k = 2; k <= 5; k++) {
        const ny = y + k;
        if (ny < h - padY) { inSum += gray[ny * w + x]; inCnt++; }
      }
      const outerL = outCnt > 0 ? outSum / outCnt : gray[idx];
      const innerL = inCnt > 0 ? inSum / inCnt : gray[idx];
      const stepDiff = innerL - outerL;

      const intoPage =
        pagePolarity > 8
          ? stepDiff >= 7 || (magH >= topThresh && stepDiff >= 3)
          : pagePolarity < -8
            ? stepDiff <= -7 || (magH >= topThresh && stepDiff <= -3)
            : Math.abs(stepDiff) >= 7 || magH >= topThresh;

      if (!intoPage) continue;

      const score = magH * (1.0 + Math.min(2.5, Math.abs(stepDiff) / 14));
      if (score > bestScore) {
        bestScore = score;
        bestY = y;
      }
      if (magH >= topThresh && Math.abs(stepDiff) >= 12) {
        bestY = y;
        break; // Outermost high-confidence edge hit
      }
    }
    if (bestY >= 0) topPoints.push({ x, y: bestY });
  }

  // Inward scan from BOTTOM:
  // Prioritizes high-gradient horizontal edges for bottom boundary points.
  const bottomPoints: Point[] = [];
  const minBtmY = Math.max(Math.round(h * 0.45), h - 1 - padY - Math.round(h * 0.50));
  for (let x = padX; x < w - padX; x += 2) {
    let bestY = -1;
    let bestScore = 0;

    for (let y = h - 1 - padY - 4; y > minBtmY; y--) {
      const idx = y * w + x;
      const magH = horizEdgeGrad[idx];
      if (magH < Math.max(10, btmThresh * 0.35)) continue;
      if (magH < horizEdgeGrad[(y - 1) * w + x] || magH < horizEdgeGrad[(y + 1) * w + x]) continue;

      let outSum = 0, outCnt = 0;
      for (let k = 2; k <= 5; k++) {
        const ny = y + k;
        if (ny <= h - 1 - padY) { outSum += gray[ny * w + x]; outCnt++; }
      }
      let inSum = 0, inCnt = 0;
      for (let k = 2; k <= 5; k++) {
        const ny = y - k;
        if (ny >= padY) { inSum += gray[ny * w + x]; inCnt++; }
      }
      const outerL = outCnt > 0 ? outSum / outCnt : gray[idx];
      const innerL = inCnt > 0 ? inSum / inCnt : gray[idx];
      const stepDiff = innerL - outerL;

      const intoPage =
        pagePolarity > 8
          ? stepDiff >= 7 || (magH >= btmThresh && stepDiff >= 3)
          : pagePolarity < -8
            ? stepDiff <= -7 || (magH >= btmThresh && stepDiff <= -3)
            : Math.abs(stepDiff) >= 7 || magH >= btmThresh;

      if (!intoPage) continue;

      const score = magH * (1.0 + Math.min(2.5, Math.abs(stepDiff) / 14));
      if (score > bestScore) {
        bestScore = score;
        bestY = y;
      }
      if (magH >= btmThresh && Math.abs(stepDiff) >= 12) {
        bestY = y;
        break;
      }
    }
    if (bestY >= 0) bottomPoints.push({ x, y: bestY });
  }

  // Inward scan from LEFT:
  // Prioritizes high-gradient vertical edges (|Gx| dominant, suppressing horizontal text lines).
  const leftPoints: Point[] = [];
  const maxLeftX = Math.min(Math.round(w * 0.55), padX + Math.round(w * 0.50));
  for (let y = padY; y < h - padY; y += 2) {
    let bestX = -1;
    let bestScore = 0;

    for (let x = padX + 4; x < maxLeftX; x++) {
      const idx = y * w + x;
      const magV = vertEdgeGrad[idx];
      if (magV < Math.max(10, leftThresh * 0.35)) continue;
      if (magV < vertEdgeGrad[y * w + x - 1] || magV < vertEdgeGrad[y * w + x + 1]) continue;

      let outSum = 0, outCnt = 0;
      for (let k = 2; k <= 5; k++) {
        const nx = x - k;
        if (nx >= padX) { outSum += gray[y * w + nx]; outCnt++; }
      }
      let inSum = 0, inCnt = 0;
      for (let k = 2; k <= 5; k++) {
        const nx = x + k;
        if (nx < w - padX) { inSum += gray[y * w + nx]; inCnt++; }
      }
      const outerL = outCnt > 0 ? outSum / outCnt : gray[idx];
      const innerL = inCnt > 0 ? inSum / inCnt : gray[idx];
      const stepDiff = innerL - outerL;

      const intoPage =
        pagePolarity > 8
          ? stepDiff >= 7 || (magV >= leftThresh && stepDiff >= 3)
          : pagePolarity < -8
            ? stepDiff <= -7 || (magV >= leftThresh && stepDiff <= -3)
            : Math.abs(stepDiff) >= 7 || magV >= leftThresh;

      if (!intoPage) continue;

      const score = magV * (1.0 + Math.min(2.5, Math.abs(stepDiff) / 14));
      if (score > bestScore) {
        bestScore = score;
        bestX = x;
      }
      if (magV >= leftThresh && Math.abs(stepDiff) >= 12) {
        bestX = x;
        break;
      }
    }
    if (bestX >= 0) leftPoints.push({ x: bestX, y });
  }

  // Inward scan from RIGHT:
  // Prioritizes high-gradient vertical edges for right boundary points.
  const rightPoints: Point[] = [];
  const minRightX = Math.max(Math.round(w * 0.45), w - 1 - padX - Math.round(w * 0.50));
  for (let y = padY; y < h - padY; y += 2) {
    let bestX = -1;
    let bestScore = 0;

    for (let x = w - 1 - padX - 4; x > minRightX; x--) {
      const idx = y * w + x;
      const magV = vertEdgeGrad[idx];
      if (magV < Math.max(10, rightThresh * 0.35)) continue;
      if (magV < vertEdgeGrad[y * w + x - 1] || magV < vertEdgeGrad[y * w + x + 1]) continue;

      let outSum = 0, outCnt = 0;
      for (let k = 2; k <= 5; k++) {
        const nx = x + k;
        if (nx <= w - 1 - padX) { outSum += gray[y * w + nx]; outCnt++; }
      }
      let inSum = 0, inCnt = 0;
      for (let k = 2; k <= 5; k++) {
        const nx = x - k;
        if (nx >= padX) { inSum += gray[y * w + nx]; inCnt++; }
      }
      const outerL = outCnt > 0 ? outSum / outCnt : gray[idx];
      const innerL = inCnt > 0 ? inSum / inCnt : gray[idx];
      const stepDiff = innerL - outerL;

      const intoPage =
        pagePolarity > 8
          ? stepDiff >= 7 || (magV >= rightThresh && stepDiff >= 3)
          : pagePolarity < -8
            ? stepDiff <= -7 || (magV >= rightThresh && stepDiff <= -3)
            : Math.abs(stepDiff) >= 7 || magV >= rightThresh;

      if (!intoPage) continue;

      const score = magV * (1.0 + Math.min(2.5, Math.abs(stepDiff) / 14));
      if (score > bestScore) {
        bestScore = score;
        bestX = x;
      }
      if (magV >= rightThresh && Math.abs(stepDiff) >= 12) {
        bestX = x;
        break;
      }
    }
    if (bestX >= 0) rightPoints.push({ x: bestX, y });
  }

  const topL = fitLineRansac(topPoints, true);
  const btmL = fitLineRansac(bottomPoints, true);
  const leftL = fitLineRansac(leftPoints, false);
  const rightL = fitLineRansac(rightPoints, false);

  if (!topL || !btmL || !leftL || !rightL) return null;

  return quadFrom4Lines(topL, rightL, btmL, leftL);
}

// ---------------------------------------------------------------------------
// Detector 2: Contour Boundary Partition & Line Intersection (Line-Fit Quad)
// ---------------------------------------------------------------------------

/**
 * Partitions a contour into 4 edge segments using the 4 diagonal extremities,
 * fits robust lines to each segment, and intersects them.
 * Immune to rounded corners, curled edges, and finger occlusions.
 */
export function fitQuadToContourByLines(pts: Point[]): [Point, Point, Point, Point] | null {
  if (pts.length < 8) return null;

  // Calculate center
  let cx = 0, cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= pts.length;
  cy /= pts.length;

  // Estimate principal orientation
  let m20 = 0, m02 = 0, m11 = 0;
  for (const p of pts) {
    const rx = p.x - cx;
    const ry = p.y - cy;
    m20 += rx * rx;
    m02 += ry * ry;
    m11 += rx * ry;
  }
  const theta = 0.5 * Math.atan2(2 * m11, m20 - m02);
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);

  // Find 4 extremal indices in the aligned frame
  let minUV = Infinity, maxUV = -Infinity;
  let minUmV = Infinity, maxUmV = -Infinity;
  let idxTL = 0, idxBR = 0, idxTR = 0, idxBL = 0;

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const u = (p.x - cx) * cosT + (p.y - cy) * sinT;
    const v = -(p.x - cx) * sinT + (p.y - cy) * cosT;

    const s = u + v;
    const d = u - v;

    if (s < minUV) { minUV = s; idxTL = i; }
    if (s > maxUV) { maxUV = s; idxBR = i; }
    if (d > maxUmV) { maxUmV = d; idxTR = i; }
    if (d < minUmV) { minUmV = d; idxBL = i; }
  }

  // Ensure 4 distinct corner indices
  const indices = [idxTL, idxTR, idxBR, idxBL];
  const unique = new Set(indices);
  if (unique.size < 4) return null;

  // Slice points along the 4 perimeter segments by picking the shorter perimeter direction
  const getDirectSlice = (fromIdx: number, toIdx: number): Point[] => {
    const fwdDist = (toIdx - fromIdx + pts.length) % pts.length;
    const bwdDist = (fromIdx - toIdx + pts.length) % pts.length;
    const step = fwdDist <= bwdDist ? 1 : -1;
    const res: Point[] = [];
    let curr = fromIdx;
    while (curr !== toIdx) {
      res.push(pts[curr]);
      curr = (curr + step + pts.length) % pts.length;
    }
    res.push(pts[toIdx]);
    return res;
  };

  const topSlice = getDirectSlice(idxTL, idxTR);
  const rightSlice = getDirectSlice(idxTR, idxBR);
  const btmSlice = getDirectSlice(idxBR, idxBL);
  const leftSlice = getDirectSlice(idxBL, idxTL);

  const topL = fitLineRansac(topSlice, true, 2.5) || fitLineLeastSquares(topSlice);
  const rightL = fitLineRansac(rightSlice, false, 2.5) || fitLineLeastSquares(rightSlice);
  const btmL = fitLineRansac(btmSlice, true, 2.5) || fitLineLeastSquares(btmSlice);
  const leftL = fitLineRansac(leftSlice, false, 2.5) || fitLineLeastSquares(leftSlice);

  if (!topL || !rightL || !btmL || !leftL) return null;

  return quadFrom4Lines(topL, rightL, btmL, leftL);
}

// ---------------------------------------------------------------------------
// Morphological and Connected-Component Utilities
// ---------------------------------------------------------------------------

/**
 * Square-window morphology is separable, so each pass is a 1D running count along rows then columns.
 * `erode` treats out-of-image pixels as background; dilation ignores them.
 */
function morphPass1D(src: Uint8Array, w: number, h: number, r: number, horizontal: boolean, erode: boolean): Uint8Array {
  const out = new Uint8Array(w * h);
  const lines = horizontal ? h : w, len = horizontal ? w : h, step = horizontal ? 1 : w, lineStep = horizontal ? w : 1;
  const full = 2 * r + 1;
  for (let l = 0; l < lines; l++) {
    const base = l * lineStep;
    let count = 0;
    for (let p = 0; p < Math.min(r, len); p++) count += src[base + p * step];
    for (let p = 0; p < len; p++) {
      const add = p + r, sub = p - r - 1;
      if (add < len) count += src[base + add * step];
      if (sub >= 0) count -= src[base + sub * step];
      if (erode ? (count === full && p >= r && p + r < len) : count > 0) out[base + p * step] = 1;
    }
  }
  return out;
}

function morphCloseMask(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const dilated = morphPass1D(morphPass1D(mask, w, h, r, true, false), w, h, r, false, false);
  return morphPass1D(morphPass1D(dilated, w, h, r, true, true), w, h, r, false, true);
}

export function findMaskComponentHulls(
  mask: Uint8Array,
  w: number,
  h: number,
  minArea: number,
  maxArea: number
): Point[][] {
  const visited = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  const hulls: Point[][] = [];

  for (let y = 2; y < h - 2; y += 2) {
    const row = y * w;
    for (let x = 2; x < w - 2; x += 2) {
      const startIdx = row + x;
      if (!mask[startIdx] || visited[startIdx]) continue;

      const compBoundary: Point[] = [];
      let compCount = 0;
      let qHead = 0, qTail = 0;
      queue[qTail++] = startIdx;
      visited[startIdx] = 1;

      while (qHead < qTail) {
        const idx = queue[qHead++];
        compCount++;

        const cy = (idx / w) | 0;
        const cx = idx - cy * w;

        if (cx <= 1 || cx >= w - 2 || cy <= 1 || cy >= h - 2 ||
          !mask[idx - 1] || !mask[idx + 1] || !mask[idx - w] || !mask[idx + w]) {
          compBoundary.push({ x: cx, y: cy });
        }

        let nb = idx - w;
        if (cy > 0 && mask[nb] && !visited[nb]) { visited[nb] = 1; queue[qTail++] = nb; }
        nb = idx + w;
        if (cy < h - 1 && mask[nb] && !visited[nb]) { visited[nb] = 1; queue[qTail++] = nb; }
        nb = idx - 1;
        if (cx > 0 && mask[nb] && !visited[nb]) { visited[nb] = 1; queue[qTail++] = nb; }
        nb = idx + 1;
        if (cx < w - 1 && mask[nb] && !visited[nb]) { visited[nb] = 1; queue[qTail++] = nb; }
      }

      if (compCount >= minArea && compCount <= maxArea && compBoundary.length >= 8) {
        const hull = convexHull(compBoundary);
        if (hull.length >= 4) {
          hulls.push(hull);
        }
      }
    }
  }

  return hulls;
}

/**
 * Fast separable 1D morphological closing with independent horizontal & vertical radii.
 * Used to bridge the central vertical gutter in 2-page horizontal spreads or horizontal
 * gutters in stacked spreads.
 */
function morphCloseDirectional(mask: Uint8Array, w: number, h: number, rx: number, ry: number): Uint8Array {
  // 1. Dilation: horizontal then vertical
  const dH = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let count = 0;
    const initialR = Math.min(rx, w - 1);
    for (let x = 0; x <= initialR; x++) {
      if (mask[row + x]) count++;
    }
    for (let x = 0; x < w; x++) {
      const addX = x + rx;
      if (x > 0 && addX < w && mask[row + addX]) count++;
      const subX = x - rx - 1;
      if (subX >= 0 && mask[row + subX]) count--;
      if (count > 0) dH[row + x] = 1;
    }
  }

  const dilated = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let count = 0;
    const initialR = Math.min(ry, h - 1);
    for (let y = 0; y <= initialR; y++) {
      if (dH[y * w + x]) count++;
    }
    for (let y = 0; y < h; y++) {
      const addY = y + ry;
      if (y > 0 && addY < h && dH[addY * w + x]) count++;
      const subY = y - ry - 1;
      if (subY >= 0 && dH[subY * w + x]) count--;
      if (count > 0) dilated[y * w + x] = 1;
    }
  }

  // 2. Erosion: horizontal then vertical
  const eH = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let count = 0;
    const initialR = Math.min(rx, w - 1);
    for (let x = 0; x <= initialR; x++) {
      if (dilated[row + x]) count++;
    }
    for (let x = 0; x < w; x++) {
      const addX = x + rx;
      if (x > 0 && addX < w && dilated[row + addX]) count++;
      const subX = x - rx - 1;
      if (subX >= 0 && dilated[row + subX]) count--;
      const winSize = Math.min(w - 1, x + rx) - Math.max(0, x - rx) + 1;
      if (count >= winSize) eH[row + x] = 1;
    }
  }

  const eroded = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let count = 0;
    const initialR = Math.min(ry, h - 1);
    for (let y = 0; y <= initialR; y++) {
      if (eH[y * w + x]) count++;
    }
    for (let y = 0; y < h; y++) {
      const addY = y + ry;
      if (y > 0 && addY < h && eH[addY * w + x]) count++;
      const subY = y - ry - 1;
      if (subY >= 0 && eH[subY * w + x]) count--;
      const winSize = Math.min(h - 1, y + ry) - Math.max(0, y - ry) + 1;
      if (count >= winSize) eroded[y * w + x] = 1;
    }
  }

  return eroded;
}

export interface TwoPageDetails {
  isTwoPage: boolean;
  spreadAxis: 'horizontal' | 'vertical';
  fullQuad: ScanQuad;
  sideAQuad: ScanQuad; // Left page or Top page
  sideBQuad: ScanQuad; // Right page or Bottom page
}

export interface TwoPageHullPair {
  spreadAxis: 'horizontal' | 'vertical';
  sideAQuad: [Point, Point, Point, Point];
  sideBQuad: [Point, Point, Point, Point];
  fullQuadDirect: [Point, Point, Point, Point];
  combinedHull: Point[];
}

/**
 * Evaluates pairs of distinct convex hulls from document segmentation masks
 * to find pairs that form a 2-page spread (facing pages side-by-side or stacked).
 */
function detectTwoPagePairs(
  hulls: Point[][],
  w: number,
  h: number
): TwoPageHullPair[] {
  const pairs: TwoPageHullPair[] = [];
  const totalArea = w * h;

  for (let i = 0; i < hulls.length; i++) {
    for (let j = i + 1; j < hulls.length; j++) {
      const hullA = hulls[i];
      const hullB = hulls[j];
      const areaA = polygonArea(hullA);
      const areaB = polygonArea(hullB);

      // Both components must be substantial (at least 7% of frame, at most 68%)
      if (areaA < totalArea * 0.07 || areaB < totalArea * 0.07) continue;
      if (areaA > totalArea * 0.68 || areaB > totalArea * 0.68) continue;

      const areaRatio = areaA / Math.max(1, areaB);
      if (areaRatio < 0.28 || areaRatio > 3.6) continue;

      // Compute bounding boxes
      let minXA = Infinity, maxXA = -Infinity, minYA = Infinity, maxYA = -Infinity;
      for (const p of hullA) {
        if (p.x < minXA) minXA = p.x;
        if (p.x > maxXA) maxXA = p.x;
        if (p.y < minYA) minYA = p.y;
        if (p.y > maxYA) maxYA = p.y;
      }
      let minXB = Infinity, maxXB = -Infinity, minYB = Infinity, maxYB = -Infinity;
      for (const p of hullB) {
        if (p.x < minXB) minXB = p.x;
        if (p.x > maxXB) maxXB = p.x;
        if (p.y < minYB) minYB = p.y;
        if (p.y > maxYB) maxYB = p.y;
      }

      // Check Horizontal Spread (side-by-side pages)
      const [lHull, rHull] = minXA < minXB ? [hullA, hullB] : [hullB, hullA];
      const lMaxX = minXA < minXB ? maxXA : maxXB;
      const [lMinY, lMaxY] = minXA < minXB ? [minYA, maxYA] : [minYB, maxYB];
      const rMinX = minXA < minXB ? minXB : minXA;
      const [rMinY, rMaxY] = minXA < minXB ? [minYB, maxYB] : [maxYB, minYB];

      const overlapY = Math.min(lMaxY, rMaxY) - Math.max(lMinY, rMinY);
      const minH = Math.min(lMaxY - lMinY, rMaxY - rMinY);
      const gapX = rMinX - lMaxX;
      const hRatio = (lMaxY - lMinY) / Math.max(1, (rMaxY - rMinY));

      if (
        overlapY / Math.max(1, minH) > 0.40 &&
        gapX >= -w * 0.08 &&
        gapX <= w * 0.35 &&
        hRatio >= 0.45 &&
        hRatio <= 2.2
      ) {
        const sideAQuad = fitQuadToContourByLines(lHull) || reducePolygonToQuad(douglasPeucker(lHull, polygonPerimeter(lHull) * 0.025), areaA);
        const sideBQuad = fitQuadToContourByLines(rHull) || reducePolygonToQuad(douglasPeucker(rHull, polygonPerimeter(rHull) * 0.025), areaB);
        const combinedHull = convexHull([...lHull, ...rHull]);
        if (sideAQuad && sideBQuad) {
          const fullQuadDirect = orderQuadCorners([sideAQuad[0], sideBQuad[1], sideBQuad[2], sideAQuad[3]]);
          pairs.push({
            spreadAxis: 'horizontal',
            sideAQuad,
            sideBQuad,
            fullQuadDirect,
            combinedHull,
          });
        }
        continue;
      }

      // Check Vertical Spread (top-and-bottom stacked pages)
      const [tHull, bHull] = minYA < minYB ? [hullA, hullB] : [hullB, hullA];
      const [tMinX, tMaxX] = minYA < minYB ? [minXA, maxXA] : [minXB, maxXB];
      const tMaxY = minYA < minYB ? maxYA : maxYB;
      const bMinX = minYA < minYB ? minXB : minXA;
      const bMaxX = minYA < minYB ? maxXB : maxXA;
      const bMinY = minYA < minYB ? minYB : minYA;

      const overlapX = Math.min(tMaxX, bMaxX) - Math.max(tMinX, bMinX);
      const minW = Math.min(tMaxX - tMinX, bMaxX - bMinX);
      const gapY = bMinY - tMaxY;
      const wRatio = (tMaxX - tMinX) / Math.max(1, (bMaxX - bMinX));

      if (
        overlapX / Math.max(1, minW) > 0.40 &&
        gapY >= -h * 0.08 &&
        gapY <= h * 0.35 &&
        wRatio >= 0.45 &&
        wRatio <= 2.2
      ) {
        const sideAQuad = fitQuadToContourByLines(tHull) || reducePolygonToQuad(douglasPeucker(tHull, polygonPerimeter(tHull) * 0.025), areaA);
        const sideBQuad = fitQuadToContourByLines(bHull) || reducePolygonToQuad(douglasPeucker(bHull, polygonPerimeter(bHull) * 0.025), areaB);
        const combinedHull = convexHull([...tHull, ...bHull]);
        if (sideAQuad && sideBQuad) {
          const fullQuadDirect = orderQuadCorners([sideAQuad[0], sideAQuad[1], sideBQuad[2], sideBQuad[3]]);
          pairs.push({
            spreadAxis: 'vertical',
            sideAQuad,
            sideBQuad,
            fullQuadDirect,
            combinedHull,
          });
        }
      }
    }
  }

  return pairs;
}

// ---------------------------------------------------------------------------
// Otsu Automatic Thresholding
// ---------------------------------------------------------------------------

function calcOtsuThreshold(gray: Uint8Array): number {
  const hist = new Uint32Array(256);
  const total = gray.length;
  for (let i = 0; i < total; i++) hist[gray[i]]++;

  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];

  let sumB = 0;
  let wB = 0;
  let wF = 0;
  let varMax = 0;
  let threshold = 128;

  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    wF = total - wB;
    if (wF === 0) break;

    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const varBetween = wB * wF * (mB - mF) * (mB - mF);

    if (varBetween > varMax) {
      varMax = varBetween;
      threshold = t;
    }
  }

  return threshold;
}

// ---------------------------------------------------------------------------
// Candidate Scoring Engine
// ---------------------------------------------------------------------------

export function scoreQuadCandidate(
  q: [Point, Point, Point, Point],
  f: OrientedEdgeField,
  dbg?: { E: number; U: number; A: number; C: number; S: number; P: number; paperOutsideRatio: number; oobRatio: number }
): number {
  const { w, h, horizEdgeGrad, vertEdgeGrad, horizMagRef, vertMagRef, gray, borderBg } = f;
  const area = polygonArea(q);
  const totalArea = w * h;
  const areaFraction = area / totalArea;

  // Plausible document area: 5% to 98% of frame
  if (areaFraction < 0.05 || areaFraction > 0.98) return 0;

  // Geometry: convexity and corner angles
  if (!isConvexQuad(q)) return 0;
  const angleScore = quadAnglesScore(q);
  if (angleScore <= 0) return 0;

  // Side lengths
  const s0 = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y);
  const s1 = Math.hypot(q[2].x - q[1].x, q[2].y - q[1].y);
  const s2 = Math.hypot(q[3].x - q[2].x, q[3].y - q[2].y);
  const s3 = Math.hypot(q[0].x - q[3].x, q[0].y - q[3].y);

  if (Math.min(s0, s1, s2, s3) < 15) return 0;

  // Aspect ratio sanity
  const widthAvg = (s0 + s2) / 2;
  const heightAvg = (s1 + s3) / 2;
  const aspect = Math.max(widthAvg, heightAvg) / Math.max(1, Math.min(widthAvg, heightAvg));
  if (aspect > 4.5) return 0; // standard documents & receipts are <= 4.5

  // 1. Perimeter Edge Gradient & Exterior/Interior Step Contrast
  let totalNormEdgeMag = 0;
  let minNormEdgeMag = Infinity;
  let paperOutsideViolations = 0;
  let totalOuterSamples = 0;
  let bgInsideViolations = 0;
  let totalInnerSamples = 0;
  const numSamples = 24;

  const cx = Math.round((q[0].x + q[1].x + q[2].x + q[3].x) / 4);
  const cy = Math.round((q[0].y + q[1].y + q[2].y + q[3].y) / 4);

  // Multi-probe interior paper reference:
  // In 2-in-1 page documents, (cx, cy) can lie in the central book gutter/spine shadow.
  // Probing multiple interior points ensures genuine document paper luminance is captured
  // without gutter shadows or spine folds degrading paper contrast.
  const probePositions: Point[] = [
    { x: cx, y: cy },
    { x: Math.round(0.55 * (q[0].x + q[3].x) * 0.5 + 0.45 * cx), y: Math.round(0.55 * (q[0].y + q[3].y) * 0.5 + 0.45 * cy) }, // Left / Page A
    { x: Math.round(0.55 * (q[1].x + q[2].x) * 0.5 + 0.45 * cx), y: Math.round(0.55 * (q[1].y + q[2].y) * 0.5 + 0.45 * cy) }, // Right / Page B
    { x: Math.round(0.55 * (q[0].x + q[1].x) * 0.5 + 0.45 * cx), y: Math.round(0.55 * (q[0].y + q[1].y) * 0.5 + 0.45 * cy) }, // Top
    { x: Math.round(0.55 * (q[3].x + q[2].x) * 0.5 + 0.45 * cx), y: Math.round(0.55 * (q[3].y + q[2].y) * 0.5 + 0.45 * cy) }, // Bottom
  ];

  const probeLumas: number[] = [];
  for (const pos of probePositions) {
    let pSum = 0, pCnt = 0;
    for (let dy = -3; dy <= 3; dy += 2) {
      for (let dx = -3; dx <= 3; dx += 2) {
        const xx = Math.max(0, Math.min(w - 1, pos.x + dx));
        const yy = Math.max(0, Math.min(h - 1, pos.y + dy));
        pSum += gray[yy * w + xx];
        pCnt++;
      }
    }
    if (pCnt > 0) probeLumas.push(pSum / pCnt);
  }

  const borderLuma = (borderBg[0] * 77 + borderBg[1] * 150 + borderBg[2] * 29) >> 8;
  let centerLuma = probeLumas[0] ?? borderLuma;
  const maxProbe = Math.max(...probeLumas);
  const minProbe = Math.min(...probeLumas);
  if (maxProbe > borderLuma + 12) {
    centerLuma = maxProbe;
  } else if (minProbe < borderLuma - 12) {
    centerLuma = minProbe;
  }

  const deepD1 = Math.max(34, Math.round(Math.min(w, h) * 0.12));
  const deepD2 = Math.max(52, Math.round(Math.min(w, h) * 0.22));
  let hasInternalBoundaryRidge = false;

  for (let e = 0; e < 4; e++) {
    const p1 = q[e];
    const p2 = q[(e + 1) % 4];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy);
    let edgeSum = 0;

    // Outward unit normal
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    let outNx = -dy / (len || 1);
    let outNy = dx / (len || 1);
    if (
      (midX + outNx - cx) ** 2 + (midY + outNy - cy) ** 2 <
      (midX - outNx - cx) ** 2 + (midY - outNy - cy) ** 2
    ) {
      outNx = -outNx;
      outNy = -outNy;
    }

    // Directional gradient prioritization: horizontal edges (|dx| >= |dy|) use horizEdgeGrad,
    // vertical edges (|dx| < |dy|) use vertEdgeGrad.
    const isHorizontal = Math.abs(dx) >= Math.abs(dy);
    const edgeGrad = isHorizontal ? horizEdgeGrad : vertEdgeGrad;
    const refMag = isHorizontal ? horizMagRef : vertMagRef;

    for (let s = 1; s <= numSamples; s++) {
      const t = s / (numSamples + 1);
      const sx = Math.max(1, Math.min(w - 2, Math.round(p1.x + t * dx)));
      const sy = Math.max(1, Math.min(h - 2, Math.round(p1.y + t * dy)));

      // Search perpendicular to normal [-3, 3] px to accommodate subtle book spine curvature
      let maxG = edgeGrad[sy * w + sx];
      for (let k = -3; k <= 3; k++) {
        const kx = Math.max(1, Math.min(w - 2, Math.round(sx + outNx * k)));
        const ky = Math.max(1, Math.min(h - 2, Math.round(sy + outNy * k)));
        const g = edgeGrad[ky * w + kx];
        if (g > maxG) maxG = g;
      }
      edgeSum += maxG;

      // Paper-outside test at multi-scale depths beyond the edge.
      // A genuine page boundary has non-paper (desk/background) at every depth;
      // in 2-page spreads, a candidate cutting through the center has a massive companion page
      // extending beyond its edge. Deep probing decisively catches companion pages.
      for (const od of [8, 18, 30, deepD1, deepD2]) {
        const ox = Math.round(sx + outNx * od);
        const oy = Math.round(sy + outNy * od);
        if (ox >= 2 && ox < w - 2 && oy >= 2 && oy < h - 2) {
          totalOuterSamples++;
          const outerLuma = gray[oy * w + ox];
          if (
            outerLuma >= borderLuma + 14 &&
            Math.abs(outerLuma - centerLuma) < 38
          ) {
            paperOutsideViolations++;
          }
        }
      }

      // Background-inside test: compare region 8px inside against the local background outside this edge
      const ox8 = Math.round(sx + outNx * 8);
      const oy8 = Math.round(sy + outNy * 8);
      const ix8 = Math.round(sx - outNx * 8);
      const iy8 = Math.round(sy - outNy * 8);
      if (ix8 >= 2 && ix8 < w - 2 && iy8 >= 2 && iy8 < h - 2 && ox8 >= 2 && ox8 < w - 2 && oy8 >= 2 && oy8 < h - 2) {
        totalInnerSamples++;
        const innerLuma = gray[iy8 * w + ix8];
        const outerLuma = gray[oy8 * w + ox8];
        if (Math.abs(innerLuma - outerLuma) < 16 && Math.abs(innerLuma - centerLuma) > 26) {
          bgInsideViolations++;
        }
      }
    }

    // Desk-strip check: does this edge enclose a strong document boundary ridge inside the quad?
    // If an edge was placed out on the desk, there is a prominent parallel ridge running inside it.
    let internalRidgeHits = 0;
    const probeCount = 7;
    for (let ps = 1; ps <= probeCount; ps++) {
      const pt = ps / (probeCount + 1);
      const px = p1.x + pt * dx;
      const py = p1.y + pt * dy;
      let maxInnerG = 0;
      let maxInnerStep = 0;
      const maxProbeDist = Math.min(64, Math.round(Math.min(w, h) * 0.22));
      for (let id = 12; id <= maxProbeDist; id += 4) {
        const rx = Math.round(px - outNx * id);
        const ry = Math.round(py - outNy * id);
        if (rx >= 3 && rx < w - 3 && ry >= 3 && ry < h - 3) {
          const g = edgeGrad[ry * w + rx];
          if (g > maxInnerG) {
            maxInnerG = g;
            const rxOut = Math.round(rx + outNx * 5);
            const ryOut = Math.round(ry + outNy * 5);
            const rxIn = Math.round(rx - outNx * 5);
            const ryIn = Math.round(ry - outNy * 5);
            maxInnerStep = Math.abs(gray[ryIn * w + rxIn] - gray[ryOut * w + rxOut]);
          }
        }
      }
      if (maxInnerG >= Math.max(26, (edgeSum / numSamples) * 2.2) && maxInnerStep >= 18) {
        internalRidgeHits++;
      }
    }
    if (internalRidgeHits >= 4) {
      hasInternalBoundaryRidge = true;
    }

    const edgeAvg = edgeSum / numSamples;
    const normEdge = edgeAvg / Math.max(1, refMag);
    totalNormEdgeMag += normEdge;
    if (normEdge < minNormEdgeMag) minNormEdgeMag = normEdge;
  }

  const normEdgeMag = Math.min(1.5, totalNormEdgeMag / 4);
  const edgeUniformity = Math.min(1.0, (minNormEdgeMag + 0.15) / (normEdgeMag + 0.15));

  const paperOutsideRatio = totalOuterSamples > 0 ? paperOutsideViolations / totalOuterSamples : 0;
  const bgInsideRatio = totalInnerSamples > 0 ? bgInsideViolations / totalInnerSamples : 0;
  let boundaryPurity = Math.max(
    0.15,
    1.0 - (paperOutsideRatio + bgInsideRatio) * 1.7
  );

  // Severe penalties for fake edges on desk or enclosed background strips
  if (minNormEdgeMag < 0.35) {
    boundaryPurity *= Math.max(0.25, minNormEdgeMag / 0.35);
  }
  if (hasInternalBoundaryRidge) {
    boundaryPurity *= 0.35;
  }

  // 2. Interior vs Exterior Contrast
  const contrastDiff = Math.abs(centerLuma - borderLuma) / 255;

  // 3. Aspect ratio score (sweet spot 1.05 to 2.6 covers single pages and 2-page spreads)
  let aspectBonus = 1.0;
  if (aspect >= 1.05 && aspect <= 2.6) aspectBonus = 1.25;
  else if (aspect > 3.4) aspectBonus = 0.85;

  // 4. Area suitability: full document / 2-page spreads get top suitability
  let areaScore = 1.0;
  if (areaFraction >= 0.45 && areaFraction <= 0.96) areaScore = 1.30;
  else if (areaFraction >= 0.20 && areaFraction < 0.45) areaScore = 1.15;
  else if (areaFraction < 0.12) areaScore = 0.65;

  const finalScore =
    (normEdgeMag * 0.40 +
      edgeUniformity * 0.20 +
      angleScore * 0.15 +
      contrastDiff * 0.12 +
      (areaScore * aspectBonus) * 0.13) *
    boundaryPurity;

  if (dbg) {
    dbg.E = +normEdgeMag.toFixed(3);
    dbg.U = +edgeUniformity.toFixed(3);
    dbg.A = +angleScore.toFixed(3);
    dbg.C = +contrastDiff.toFixed(3);
    dbg.S = +(areaScore * aspectBonus).toFixed(3);
    dbg.P = +boundaryPurity.toFixed(3);
    dbg.paperOutsideRatio = +paperOutsideRatio.toFixed(3);
    dbg.oobRatio = 0;
  }
  return finalScore;
}

// ---------------------------------------------------------------------------
// Sub-Pixel Normal Gradient Refinement
// ---------------------------------------------------------------------------

export function refineQuadEdges(
  q: [Point, Point, Point, Point],
  f: OrientedEdgeField,
  sweepScale = 1
): [Point, Point, Point, Point] {
  const { w, h, horizEdgeGrad, vertEdgeGrad, horizMagRef, vertMagRef, gray } = f;
  const refinedLines: Line2D[] = [];

  // Page polarity gates ray hits: a genuine boundary has the page's brightness
  // on its inward side, which rejects shadow-edge and desk-texture peaks.
  const polarity = computePagePolarity(f);

  // Search range: +/- pixels along the perpendicular normal. sweepScale > 1
  // widens the band for the thin-margin rescue pass, where the true page
  // boundary can sit far inside a frame-hugging candidate.
  const sweepRange = Math.max(28, Math.round(Math.min(w, h) * 0.16 * sweepScale));
  // Sub-pixel inset applied to fitted lines: the gradient peak marks the
  // MIDDLE of the paper-to-background transition, so the exact peak position
  // still bleeds a sliver of background into the crop. Nudging each edge a
  // hair inward gives the tight, clean page-only crop.
  const insetPx = Math.min(2, Math.max(0.75, Math.min(w, h) * 0.0018));
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;

  const lumaAt = (x: number, y: number): number => {
    const xx = Math.max(1, Math.min(w - 2, Math.round(x)));
    const yy = Math.max(1, Math.min(h - 2, Math.round(y)));
    return gray[yy * w + xx];
  };

  for (let e = 0; e < 4; e++) {
    const p1 = q[e];
    const p2 = q[(e + 1) % 4];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy);

    if (len < 10) {
      const la = -dy / (len || 1);
      const lb = dx / (len || 1);
      const lc = -(la * p1.x + lb * p1.y);
      refinedLines.push({ a: la, b: lb, c: lc });
      continue;
    }

    // Inward unit normal (guaranteed pointing toward quad center)
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    let inNx = -dy / len;
    let inNy = dx / len;
    if (
      (midX + inNx - cx) ** 2 + (midY + inNy - cy) ** 2 >
      (midX - inNx - cx) ** 2 + (midY - inNy - cy) ** 2
    ) {
      inNx = -inNx;
      inNy = -inNy;
    }

    // Directional gradient prioritization: horizontal edges use horizEdgeGrad, vertical use vertEdgeGrad
    const isHorizontal = Math.abs(dx) >= Math.abs(dy);
    const edgeField = isHorizontal ? horizEdgeGrad : vertEdgeGrad;
    const edgeMagRef = isHorizontal ? horizMagRef : vertMagRef;

    const hits: Point[] = [];
    const numRays = 40;
    const profile = new Float64Array(2 * sweepRange + 1);

    for (let s = 1; s <= numRays; s++) {
      const t = s / (numRays + 1);
      const bx = p1.x + t * dx;
      const by = p1.y + t * dy;

      let bestScore = 0;
      let bestDist = 0;

      // Scan inward and outward across the edge normal
      for (let k = -sweepRange; k <= sweepRange; k++) {
        const sx = Math.max(1, Math.min(w - 2, Math.round(bx + inNx * k)));
        const sy = Math.max(1, Math.min(h - 2, Math.round(by + inNy * k)));
        const mag = edgeField[sy * w + sx];
        const stepContrast = Math.abs(
          lumaAt(sx + inNx * 4, sy + inNy * 4) - lumaAt(sx - inNx * 4, sy - inNy * 4)
        );
        const isTrueBoundary = stepContrast >= 14 || mag >= edgeMagRef * 1.1;
        const weight = (k <= 0 || isTrueBoundary) ? 1.0 : Math.exp(-k / (sweepRange * 0.45));
        const score = mag * (1.0 + Math.min(2.5, stepContrast / 18)) * weight;
        profile[k + sweepRange] = score;
        if (score > bestScore) {
          bestScore = score;
          bestDist = k;
        }
      }

      if (bestScore < edgeMagRef * 0.15) continue;

      // Sub-pixel peak position via parabolic interpolation of the profile
      let dist = bestDist;
      const i0 = bestDist + sweepRange;
      if (i0 > 0 && i0 < profile.length - 1) {
        const sm = profile[i0 - 1];
        const s0 = profile[i0];
        const sp = profile[i0 + 1];
        const denom = sm - 2 * s0 + sp;
        if (denom < -1e-9) {
          dist = bestDist + Math.max(-1, Math.min(1, (0.5 * (sm - sp)) / denom));
        }
      }

      const hx = bx + inNx * dist;
      const hy = by + inNy * dist;

      // Polarity check: just inside the hit must match the page's brightness
      if (polarity > 8 || polarity < -8) {
        const inside =
          (lumaAt(hx + inNx * 3, hy + inNy * 3) + lumaAt(hx + inNx * 6, hy + inNy * 6)) / 2;
        const outside =
          (lumaAt(hx - inNx * 3, hy - inNy * 3) + lumaAt(hx - inNx * 6, hy - inNy * 6)) / 2;
        const ok = polarity > 0 ? inside >= outside - 4 : inside <= outside + 4;
        if (!ok) continue;
      }

      hits.push({ x: hx, y: hy });
    }

    const fitted = fitLineRansac(hits, Math.abs(dx) > Math.abs(dy), 2.5) || fitLineLeastSquares(hits);
    if (fitted) {
      // Offset the fitted line inward.
      const dot = fitted.a * inNx + fitted.b * inNy;
      fitted.c -= dot >= 0 ? insetPx : -insetPx;
      refinedLines.push(fitted);
    } else {
      const la = inNx;
      const lb = inNy;
      const lc = -(la * p1.x + lb * p1.y);
      refinedLines.push({ a: la, b: lb, c: lc });
    }
  }

  // Intersect adjacent lines: (e+3)%4 (previous) with e (current)
  const newCorners: Point[] = [];
  for (let i = 0; i < 4; i++) {
    const l1 = refinedLines[(i + 3) % 4];
    const l2 = refinedLines[i];
    const pt = intersectLines(l1, l2);
    if (!pt) {
      newCorners.push(q[i]);
    } else {
      newCorners.push({
        x: Math.max(0, Math.min(w, pt.x)),
        y: Math.max(0, Math.min(h, pt.y)),
      });
    }
  }

  const refinedQuad = orderQuadCorners(newCorners);
  return isConvexQuad(refinedQuad) && quadAnglesScore(refinedQuad) > 0 ? refinedQuad : q;
}

/**
 * Snaps any quad candidate's edges onto dominant parallel gradient ridges in the image.
 * Ensures that if a candidate edge is placed out on the desk or background margin,
 * it snaps inward directly onto the true document page boundary.
 */
export function snapQuadToDominantRidges(
  q: [Point, Point, Point, Point],
  f: OrientedEdgeField,
  maxSearchRatio = 0.25
): [Point, Point, Point, Point] {
  const { w, h, horizEdgeGrad, vertEdgeGrad, horizMagRef, vertMagRef, gray } = f;
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  const lumaAt = (x: number, y: number): number => {
    const xx = Math.max(1, Math.min(w - 2, Math.round(x)));
    const yy = Math.max(1, Math.min(h - 2, Math.round(y)));
    return gray[yy * w + xx];
  };

  const snappedLines: Line2D[] = [];
  const maxSearchDist = Math.max(30, Math.round(Math.min(w, h) * maxSearchRatio));
  const polarity = computePagePolarity(f);

  for (let e = 0; e < 4; e++) {
    const p1 = q[e];
    const p2 = q[(e + 1) % 4];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy);

    if (len < 10) {
      const la = -dy / (len || 1);
      const lb = dx / (len || 1);
      const lc = -(la * p1.x + lb * p1.y);
      snappedLines.push({ a: la, b: lb, c: lc });
      continue;
    }

    // Inward normal towards quad center
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    let inNx = -dy / len;
    let inNy = dx / len;
    if (
      (midX + inNx - cx) ** 2 + (midY + inNy - cy) ** 2 >
      (midX - inNx - cx) ** 2 + (midY - inNy - cy) ** 2
    ) {
      inNx = -inNx;
      inNy = -inNy;
    }

    const isHorizontal = Math.abs(dx) >= Math.abs(dy);
    const edgeField = isHorizontal ? horizEdgeGrad : vertEdgeGrad;
    const refMag = isHorizontal ? horizMagRef : vertMagRef;

    const numRays = 35;
    const hits: Point[] = [];

    for (let s = 1; s <= numRays; s++) {
      const t = s / (numRays + 1);
      const bx = p1.x + t * dx;
      const by = p1.y + t * dy;

      let bestScore = 0;
      let bestX = bx;
      let bestY = by;

      // Scan inward along the normal from -12px (outward) up to maxSearchDist (inward)
      for (let k = -12; k <= maxSearchDist; k++) {
        const sx = Math.max(2, Math.min(w - 3, Math.round(bx + inNx * k)));
        const sy = Math.max(2, Math.min(h - 3, Math.round(by + inNy * k)));
        const mag = edgeField[sy * w + sx];
        if (mag < Math.max(12, refMag * 0.3)) continue;

        // Local maximum along ray
        const prevMag = edgeField[Math.max(1, Math.min(h - 2, Math.round(by + inNy * (k - 1)))) * w + Math.max(1, Math.min(w - 2, Math.round(bx + inNx * (k - 1))))];
        const nextMag = edgeField[Math.max(1, Math.min(h - 2, Math.round(by + inNy * (k + 1)))) * w + Math.max(1, Math.min(w - 2, Math.round(bx + inNx * (k + 1))))];
        if (mag < prevMag || mag < nextMag) continue;

        const outL = (lumaAt(sx - inNx * 4, sy - inNy * 4) + lumaAt(sx - inNx * 8, sy - inNy * 8)) / 2;
        const inL = (lumaAt(sx + inNx * 4, sy + inNy * 4) + lumaAt(sx + inNx * 8, sy + inNy * 8)) / 2;
        const step = Math.abs(inL - outL);

        if (polarity > 8 && inL < outL + 4) continue;
        if (polarity < -8 && inL > outL - 4) continue;

        const score = mag * (1.0 + Math.min(2.5, step / 16));
        if (score > bestScore) {
          bestScore = score;
          bestX = sx;
          bestY = sy;
        }
      }

      if (bestScore >= Math.max(16, refMag * 0.4)) {
        hits.push({ x: bestX, y: bestY });
      }
    }

    const fitted = hits.length >= 8
      ? (fitLineRansac(hits, isHorizontal, 3.0) || fitLineLeastSquares(hits))
      : null;

    if (fitted) {
      snappedLines.push(fitted);
    } else {
      const la = inNx;
      const lb = inNy;
      const lc = -(la * p1.x + lb * p1.y);
      snappedLines.push({ a: la, b: lb, c: lc });
    }
  }

  const newCorners: Point[] = [];
  for (let i = 0; i < 4; i++) {
    const l1 = snappedLines[(i + 3) % 4];
    const l2 = snappedLines[i];
    const pt = intersectLines(l1, l2);
    if (!pt) {
      newCorners.push(q[i]);
    } else {
      newCorners.push({
        x: Math.max(0, Math.min(w, pt.x)),
        y: Math.max(0, Math.min(h, pt.y)),
      });
    }
  }

  const snappedQuad = orderQuadCorners(newCorners);
  return isConvexQuad(snappedQuad) && quadAnglesScore(snappedQuad) > 0 ? snappedQuad : q;
}

// ---------------------------------------------------------------------------
// Main Document Edge Detection Pipeline
// ---------------------------------------------------------------------------

/**
 * State-of-the-art automatic document edge and 2-page spread detection.
 * Combines Directional Inward Radar (Ray Scan), Contour Boundary Line Partitioning,
 * Multi-Component 2-Page Spread Pairing, Directional Central Gutter Bridging,
 * Adaptive Douglas-Peucker Epsilon Sweep, Otsu Binarization, Local Background
 * Normalization, and Sub-Pixel Line Refinement.
 */
export function detectDocumentSpreadFromField(
  f: OrientedEdgeField,
  collect?: Array<{ source: string; score: number; pts: [Point, Point, Point, Point] }>,
  coarseOnly = false
): { fullQuad: ScanQuad; twoPageDetails: TwoPageDetails | null } {
  resetDetectionRng();
  const { w, h, gray, blurBg, borderDev } = f;
  const n = w * h;
  const candidates: CandidateQuad[] = [];

  const addCandidate = (cand: [Point, Point, Point, Point] | null, source: string, pair?: TwoPageHullPair) => {
    if (!cand) return;
    const score = scoreQuadCandidate(cand, f);
    if (collect) collect.push({ source, score, pts: cand });
    if (score > 0.08) {
      candidates.push({ pts: cand, score, source, twoPagePair: pair });
    }
  };

  // -------------------------------------------------------------------------
  // Path 1: Multi-Sensitivity Directional Inward Radar (Ray Scan)
  // Highest reliability on camera pictures with internal text/tables/graphics
  // -------------------------------------------------------------------------
  for (const minGradFraction of [0.55, 0.35, 0.20]) {
    const quadRadar = runDirectionalInwardScan(f, minGradFraction);
    if (quadRadar) {
      addCandidate(quadRadar, `radar_${minGradFraction}`);
    }
  }

  // -------------------------------------------------------------------------
  // Path 2: Adaptive Local Contrast Segmentation (White-on-White & Shadows)
  // -------------------------------------------------------------------------
  const diff = new Float32Array(n);
  for (let i = 0; i < n; i++) diff[i] = gray[i] - blurBg[i];

  const closeRadius = Math.max(3, Math.round(Math.min(w, h) / 75));
  const rxBridge = Math.max(12, Math.round(w * 0.08));
  const ryBridge = Math.max(12, Math.round(h * 0.08));

  // Bright document mask
  const brightMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (diff[i] > 3.5) brightMask[i] = 1;
  const closedBright = morphCloseMask(brightMask, w, h, closeRadius);
  const hullsBright = findMaskComponentHulls(closedBright, w, h, n * 0.06, n * 0.98);

  for (const hull of hullsBright) {
    const hullArea = polygonArea(hull);
    const p = polygonPerimeter(hull);
    addCandidate(fitQuadToContourByLines(hull), 'bright_line_fit');
    for (const epsRatio of [0.015, 0.025, 0.04]) {
      const simplified = douglasPeucker(hull, p * epsRatio);
      addCandidate(reducePolygonToQuad(simplified, hullArea), 'bright_rdp');
    }
  }

  // 2-page spread pairing on bright mask
  const brightPairs = detectTwoPagePairs(hullsBright, w, h);
  for (const pair of brightPairs) {
    addCandidate(pair.fullQuadDirect, 'bright_2page_direct', pair);
    addCandidate(fitQuadToContourByLines(pair.combinedHull), 'bright_2page_line', pair);
    addCandidate(
      reducePolygonToQuad(douglasPeucker(pair.combinedHull, polygonPerimeter(pair.combinedHull) * 0.025), polygonArea(pair.combinedHull)),
      'bright_2page_rdp',
      pair
    );
  }

  // Directional gutter bridging for bright spreads:
  // Bridges central vertical gutter shadow so 2 pages merge into one seamless candidate
  const closedBrightH = morphCloseDirectional(brightMask, w, h, rxBridge, 2);
  const hullsBrightH = findMaskComponentHulls(closedBrightH, w, h, n * 0.12, n * 0.98);
  for (const hull of hullsBrightH) {
    const hullArea = polygonArea(hull);
    const p = polygonPerimeter(hull);
    addCandidate(fitQuadToContourByLines(hull), 'bright_hbridge_line');
    addCandidate(reducePolygonToQuad(douglasPeucker(hull, p * 0.025), hullArea), 'bright_hbridge_rdp');
  }

  const closedBrightV = morphCloseDirectional(brightMask, w, h, 2, ryBridge);
  const hullsBrightV = findMaskComponentHulls(closedBrightV, w, h, n * 0.12, n * 0.98);
  for (const hull of hullsBrightV) {
    const hullArea = polygonArea(hull);
    const p = polygonPerimeter(hull);
    addCandidate(fitQuadToContourByLines(hull), 'bright_vbridge_line');
    addCandidate(reducePolygonToQuad(douglasPeucker(hull, p * 0.025), hullArea), 'bright_vbridge_rdp');
  }

  // Subtle contrast mask (faint document / white-on-light paper)
  const subtleMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (diff[i] > 1.6) subtleMask[i] = 1;
  const closedSubtle = morphCloseMask(subtleMask, w, h, closeRadius + 1);
  const hullsSubtle = findMaskComponentHulls(closedSubtle, w, h, n * 0.08, n * 0.98);

  for (const hull of hullsSubtle) {
    const hullArea = polygonArea(hull);
    const p = polygonPerimeter(hull);
    addCandidate(fitQuadToContourByLines(hull), 'subtle_line_fit');
    addCandidate(
      reducePolygonToQuad(douglasPeucker(hull, p * 0.025), hullArea),
      'subtle_rdp'
    );
  }

  const subtlePairs = detectTwoPagePairs(hullsSubtle, w, h);
  for (const pair of subtlePairs) {
    addCandidate(pair.fullQuadDirect, 'subtle_2page_direct', pair);
    addCandidate(fitQuadToContourByLines(pair.combinedHull), 'subtle_2page_line', pair);
  }

  const closedSubtleH = morphCloseDirectional(subtleMask, w, h, rxBridge, 2);
  const hullsSubtleH = findMaskComponentHulls(closedSubtleH, w, h, n * 0.12, n * 0.98);
  for (const hull of hullsSubtleH) {
    addCandidate(fitQuadToContourByLines(hull), 'subtle_hbridge_line');
  }

  // Dark document / dark card on lighter surface
  const darkMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (diff[i] < -3.5) darkMask[i] = 1;
  const closedDark = morphCloseMask(darkMask, w, h, closeRadius);
  const hullsDark = findMaskComponentHulls(closedDark, w, h, n * 0.06, n * 0.98);

  for (const hull of hullsDark) {
    const hullArea = polygonArea(hull);
    const p = polygonPerimeter(hull);
    addCandidate(fitQuadToContourByLines(hull), 'dark_line_fit');
    addCandidate(
      reducePolygonToQuad(douglasPeucker(hull, p * 0.025), hullArea),
      'dark_rdp'
    );
  }

  // -------------------------------------------------------------------------
  // Path 3: Multi-Level Otsu Binarization
  // -------------------------------------------------------------------------
  const otsu = calcOtsuThreshold(gray);
  for (const tOffset of [0, -18]) {
    const t = Math.max(20, Math.min(235, otsu + tOffset));
    const binMask = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (gray[i] >= t) binMask[i] = 1;
    const closedBin = morphCloseMask(binMask, w, h, closeRadius);
    const hullsBin = findMaskComponentHulls(closedBin, w, h, n * 0.07, n * 0.98);
    for (const hull of hullsBin) {
      const hullArea = polygonArea(hull);
      const p = polygonPerimeter(hull);
      addCandidate(fitQuadToContourByLines(hull), 'otsu_line_fit');
      addCandidate(
        reducePolygonToQuad(douglasPeucker(hull, p * 0.025), hullArea),
        'otsu_rdp'
      );
    }

    const binPairs = detectTwoPagePairs(hullsBin, w, h);
    for (const pair of binPairs) {
      addCandidate(pair.fullQuadDirect, 'otsu_2page_direct', pair);
      addCandidate(fitQuadToContourByLines(pair.combinedHull), 'otsu_2page_line', pair);
    }

    const closedBinH = morphCloseDirectional(binMask, w, h, rxBridge, 2);
    const hullsBinH = findMaskComponentHulls(closedBinH, w, h, n * 0.12, n * 0.98);
    for (const hull of hullsBinH) {
      addCandidate(fitQuadToContourByLines(hull), 'otsu_hbridge_line');
    }
  }

  // -------------------------------------------------------------------------
  // Path 4: Border Chroma Difference
  // -------------------------------------------------------------------------
  if (borderDev < 42) {
    const chromaMask = new Uint8Array(n);
    const minDiff = Math.max(16, borderDev * 2.0);
    const borderLuma = (f.borderBg[0] * 77 + f.borderBg[1] * 150 + f.borderBg[2] * 29) >> 8;
    for (let i = 0; i < n; i++) {
      if (Math.abs(gray[i] - borderLuma) > minDiff) chromaMask[i] = 1;
    }
    const closedChroma = morphCloseMask(chromaMask, w, h, closeRadius);
    const hullsChroma = findMaskComponentHulls(closedChroma, w, h, n * 0.08, n * 0.98);
    for (const hull of hullsChroma) {
      const hullArea = polygonArea(hull);
      const p = polygonPerimeter(hull);
      addCandidate(fitQuadToContourByLines(hull), 'chroma_line_fit');
      addCandidate(
        reducePolygonToQuad(douglasPeucker(hull, p * 0.025), hullArea),
        'chroma_rdp'
      );
    }

    const chromaPairs = detectTwoPagePairs(hullsChroma, w, h);
    for (const pair of chromaPairs) {
      addCandidate(pair.fullQuadDirect, 'chroma_2page_direct', pair);
    }
  }

  // -------------------------------------------------------------------------
  // Path 5: Full-Page and Near-Border Priors (Pre-Scanned Images)
  // -------------------------------------------------------------------------
  const fullPriors: Array<[Point, Point, Point, Point]> = [
    [
      { x: w * 0.01, y: h * 0.01 },
      { x: w * 0.99, y: h * 0.01 },
      { x: w * 0.99, y: h * 0.99 },
      { x: w * 0.01, y: h * 0.99 },
    ],
    [
      { x: w * 0.02, y: h * 0.02 },
      { x: w * 0.98, y: h * 0.02 },
      { x: w * 0.98, y: h * 0.98 },
      { x: w * 0.02, y: h * 0.98 },
    ],
    [
      { x: w * 0.035, y: h * 0.035 },
      { x: w * 0.965, y: h * 0.035 },
      { x: w * 0.965, y: h * 0.965 },
      { x: w * 0.035, y: h * 0.965 },
    ],
  ];
  for (const prior of coarseOnly ? [] : fullPriors) {
    addCandidate(prior, 'full_prior');
    const snappedPrior = snapQuadToDominantRidges(prior, f);
    if (snappedPrior !== prior) {
      addCandidate(snappedPrior, 'full_prior_snapped');
    }
  }

  // -------------------------------------------------------------------------
  // Selection and Sub-Pixel Refinement
  // -------------------------------------------------------------------------
  if (candidates.length === 0) {
    const fallbackQuad = {
      tl: { x: 0.015, y: 0.015 },
      tr: { x: 0.985, y: 0.015 },
      br: { x: 0.985, y: 0.985 },
      bl: { x: 0.015, y: 0.985 },
    };
    return { fullQuad: fallbackQuad, twoPageDetails: null };
  }

  // Sort candidates by score descending
  candidates.sort((a, b) => b.score - a.score);
  let bestCandidate = candidates[0];

  // 2-in-1 Spread Selection Logic:
  // If a 2-page pair candidate or bridged candidate was detected and scored competitively,
  // favor the full 2-page spread so the user's 2-page document isn't truncated to just one half.
  const top2PageCand = candidates.find(c => c.twoPagePair && c.score >= 0.58);
  if (top2PageCand && (!bestCandidate.twoPagePair)) {
    const bestAreaRatio = polygonArea(bestCandidate.pts) / (w * h);
    if (top2PageCand.score >= bestCandidate.score - 0.14 || bestAreaRatio < 0.46) {
      bestCandidate = top2PageCand;
    }
  }

  // Snap winning candidate to dominant ridges and apply multi-pass sub-pixel edge refinement
  let refined = coarseOnly ? bestCandidate.pts : snapQuadToDominantRidges(bestCandidate.pts, f);
  if (!coarseOnly) refined = refineQuadEdges(refineQuadEdges(refined, f), f);

  // Thin-margin rescue is retained only for legacy callers and baseline comparison.
  if (!coarseOnly && polygonArea(refined) / (w * h) > 0.80) {
    let cur = refined;
    let curScore = scoreQuadCandidate(cur, f);
    for (const scale of [1.5, 2.2, 3.0]) {
      const r = refineQuadEdges(cur, f, scale);
      const s = scoreQuadCandidate(r, f);
      if (s > curScore) {
        cur = r;
        curScore = s;
      }
    }
    refined = cur;
  }

  // Convert to normalized [0, 1] coordinates
  const fullQuad: ScanQuad = {
    tl: {
      x: Math.max(0, Math.min(1, refined[0].x / w)),
      y: Math.max(0, Math.min(1, refined[0].y / h)),
    },
    tr: {
      x: Math.max(0, Math.min(1, refined[1].x / w)),
      y: Math.max(0, Math.min(1, refined[1].y / h)),
    },
    br: {
      x: Math.max(0, Math.min(1, refined[2].x / w)),
      y: Math.max(0, Math.min(1, refined[2].y / h)),
    },
    bl: {
      x: Math.max(0, Math.min(1, refined[3].x / w)),
      y: Math.max(0, Math.min(1, refined[3].y / h)),
    },
  };

  // Determine 2-page spread details
  let twoPageDetails: TwoPageDetails | null = null;
  const pair = bestCandidate.twoPagePair || (top2PageCand && top2PageCand.score >= 0.60 ? top2PageCand.twoPagePair : undefined);

  if (pair) {
    const normSideA: ScanQuad = {
      tl: { x: Math.max(0, Math.min(1, pair.sideAQuad[0].x / w)), y: Math.max(0, Math.min(1, pair.sideAQuad[0].y / h)) },
      tr: { x: Math.max(0, Math.min(1, pair.sideAQuad[1].x / w)), y: Math.max(0, Math.min(1, pair.sideAQuad[1].y / h)) },
      br: { x: Math.max(0, Math.min(1, pair.sideAQuad[2].x / w)), y: Math.max(0, Math.min(1, pair.sideAQuad[2].y / h)) },
      bl: { x: Math.max(0, Math.min(1, pair.sideAQuad[3].x / w)), y: Math.max(0, Math.min(1, pair.sideAQuad[3].y / h)) },
    };
    const normSideB: ScanQuad = {
      tl: { x: Math.max(0, Math.min(1, pair.sideBQuad[0].x / w)), y: Math.max(0, Math.min(1, pair.sideBQuad[0].y / h)) },
      tr: { x: Math.max(0, Math.min(1, pair.sideBQuad[1].x / w)), y: Math.max(0, Math.min(1, pair.sideBQuad[1].y / h)) },
      br: { x: Math.max(0, Math.min(1, pair.sideBQuad[2].x / w)), y: Math.max(0, Math.min(1, pair.sideBQuad[2].y / h)) },
      bl: { x: Math.max(0, Math.min(1, pair.sideBQuad[3].x / w)), y: Math.max(0, Math.min(1, pair.sideBQuad[3].y / h)) },
    };
    twoPageDetails = {
      isTwoPage: true,
      spreadAxis: pair.spreadAxis,
      fullQuad,
      sideAQuad: normSideA,
      sideBQuad: normSideB,
    };
  } else if (
    bestCandidate.source.includes('bridge') ||
    bestCandidate.source.includes('2page') ||
    (bestCandidate.score >= 0.65 && polygonArea(refined) / (w * h) >= 0.40 && (Math.max(w, h) / Math.min(w, h)) >= 1.25)
  ) {
    const qW = (Math.hypot(refined[1].x - refined[0].x, refined[1].y - refined[0].y) + Math.hypot(refined[2].x - refined[3].x, refined[2].y - refined[3].y)) / 2;
    const qH = (Math.hypot(refined[3].x - refined[0].x, refined[3].y - refined[0].y) + Math.hypot(refined[2].x - refined[1].x, refined[2].y - refined[1].y)) / 2;
    const isHorizontal = qW >= qH * 1.15;
    if (isHorizontal) {
      const normSideA: ScanQuad = {
        tl: fullQuad.tl,
        tr: { x: (fullQuad.tl.x + fullQuad.tr.x) / 2, y: (fullQuad.tl.y + fullQuad.tr.y) / 2 },
        br: { x: (fullQuad.bl.x + fullQuad.br.x) / 2, y: (fullQuad.bl.y + fullQuad.br.y) / 2 },
        bl: fullQuad.bl,
      };
      const normSideB: ScanQuad = {
        tl: { x: (fullQuad.tl.x + fullQuad.tr.x) / 2, y: (fullQuad.tl.y + fullQuad.tr.y) / 2 },
        tr: fullQuad.tr,
        br: fullQuad.br,
        bl: { x: (fullQuad.bl.x + fullQuad.br.x) / 2, y: (fullQuad.bl.y + fullQuad.br.y) / 2 },
      };
      twoPageDetails = {
        isTwoPage: true,
        spreadAxis: 'horizontal',
        fullQuad,
        sideAQuad: normSideA,
        sideBQuad: normSideB,
      };
    }
  }

  const finalQuad = isSaneQuad(fullQuad)
    ? fullQuad
    : {
        tl: { x: 0.015, y: 0.015 },
        tr: { x: 0.985, y: 0.015 },
        br: { x: 0.985, y: 0.985 },
        bl: { x: 0.015, y: 0.985 },
      };

  return { fullQuad: finalQuad, twoPageDetails };
}

/**
 * State-of-the-art automatic document edge detection.
 * Returns the full document quadrilateral.
 */
export function detectDocumentQuadFromField(
  f: OrientedEdgeField,
  collect?: Array<{ source: string; score: number; pts: [Point, Point, Point, Point] }>
): ScanQuad | null {
  return detectDocumentSpreadFromField(f, collect).fullQuad;
}

/**
 * State-of-the-art automatic document edge detection.
 * Combines Directional Inward Radar (Ray Scan), Contour Boundary Line Partitioning,
 * Adaptive Douglas-Peucker Epsilon Sweep, Otsu Binarization, Local Background
 * Normalization, and Sub-Pixel Line Refinement.
 */
export function detectDocumentQuad(
  img: HTMLImageElement | HTMLCanvasElement,
  rotation: 0 | 90 | 180 | 270 = 0
): ScanQuad | null {
  const f = prepOrientedEdgeField(img, rotation);
  if (!f) return null;
  return detectDocumentQuadFromField(f);
}

export type QuadCorner = 'tl' | 'tr' | 'br' | 'bl';

export interface EdgeSnapResult {
  x: number;
  y: number;
  snapped: boolean;
  type?: 'corner' | 'edge' | 'ridge';
}

export interface EdgeSnapEngine {
  autoQuad: ScanQuad | null;
  twoPageSpread: TwoPageDetails | null;
  snapPoint(
    normPt: Point,
    corner: QuadCorner,
    containerW: number,
    containerH: number,
    snapRadiusPx?: number
  ): EdgeSnapResult;
  /**
   * Magnetic snap for the four EDGE (midpoint) handles: given the currently
   * dragged edge, snaps both endpoints onto the detected document boundary
   * (autoQuad line match) or onto the strongest directional gradient ridge
   * running parallel to the drag. Returns the (possibly moved) endpoints.
   */
  snapEdge(
    p1: Point,
    p2: Point,
    containerW: number,
    containerH: number,
    snapRadiusPx?: number
  ): { a: Point; b: Point; snapped: boolean; type?: 'line' | 'ridge' };
}

const QUAD_CORNERS_LIST: QuadCorner[] = ['tl', 'tr', 'br', 'bl'];

/**
 * Creates an intelligent EdgeSnapEngine for interactive boundary point dragging.
 * Evaluates high-contrast computer vision edge ridges, document perimeter lines,
 * and corner vertices to automatically align dragged points onto genuine page boundaries.
 */
export function createEdgeSnapEngine(
  source: HTMLImageElement | HTMLCanvasElement,
  rotation: 0 | 90 | 180 | 270 = 0
): EdgeSnapEngine {
  const f = prepOrientedEdgeField(source, rotation);
  const spreadResult = f ? detectDocumentSpreadFromField(f) : null;
  const autoQuad = spreadResult ? spreadResult.fullQuad : null;
  const twoPageSpread = spreadResult ? spreadResult.twoPageDetails : null;

  return {
    autoQuad,
    twoPageSpread,
    snapPoint(
      normPt: Point,
      corner: QuadCorner,
      containerW: number,
      containerH: number,
      snapRadiusPx = 22
    ): EdgeSnapResult {
      // 1. Magnetic snap to detected document corner
      if (autoQuad) {
        const target = autoQuad[corner];
        const distTarget = Math.hypot(
          (normPt.x - target.x) * containerW,
          (normPt.y - target.y) * containerH
        );
        if (distTarget <= snapRadiusPx) {
          return { x: target.x, y: target.y, snapped: true, type: 'corner' };
        }
        for (const k of QUAD_CORNERS_LIST) {
          const other = autoQuad[k];
          const d = Math.hypot(
            (normPt.x - other.x) * containerW,
            (normPt.y - other.y) * containerH
          );
          if (d <= snapRadiusPx * 0.85) {
            return { x: other.x, y: other.y, snapped: true, type: 'corner' };
          }
        }
      }

      // 2. Snap to high-contrast boundary lines of the detected document
      if (autoQuad) {
        const connectedEdges: Array<[Point, Point]> = [];
        if (corner === 'tl') {
          connectedEdges.push([autoQuad.tl, autoQuad.tr], [autoQuad.bl, autoQuad.tl]);
        } else if (corner === 'tr') {
          connectedEdges.push([autoQuad.tl, autoQuad.tr], [autoQuad.tr, autoQuad.br]);
        } else if (corner === 'br') {
          connectedEdges.push([autoQuad.bl, autoQuad.br], [autoQuad.tr, autoQuad.br]);
        } else {
          connectedEdges.push([autoQuad.bl, autoQuad.br], [autoQuad.bl, autoQuad.tl]);
        }

        for (const [p1, p2] of connectedEdges) {
          const vx = (p2.x - p1.x) * containerW;
          const vy = (p2.y - p1.y) * containerH;
          const l2 = vx * vx + vy * vy;
          if (l2 > 100) {
            const px = (normPt.x - p1.x) * containerW;
            const py = (normPt.y - p1.y) * containerH;
            const t = (px * vx + py * vy) / l2;
            if (t >= -0.05 && t <= 1.05) {
              const projX = (p1.x * containerW + t * vx) / containerW;
              const projY = (p1.y * containerH + t * vy) / containerH;
              const dist = Math.hypot(
                (normPt.x - projX) * containerW,
                (normPt.y - projY) * containerH
              );
              if (dist <= snapRadiusPx * 0.75) {
                return {
                  x: Math.max(0, Math.min(1, projX)),
                  y: Math.max(0, Math.min(1, projY)),
                  snapped: true,
                  type: 'edge',
                };
              }
            }
          }
        }
      }

      // 3. Snap to computer vision high-contrast gradient ridges
      if (f) {
        const { w, h, horizEdgeGrad, vertEdgeGrad, horizMagRef, vertMagRef } = f;
        const fx = normPt.x * w;
        const fy = normPt.y * h;
        const radiusX = Math.ceil(snapRadiusPx * w / Math.max(1, containerW));
        const radiusY = Math.ceil(snapRadiusPx * h / Math.max(1, containerH));
        const radiusSquared = snapRadiusPx * snapRadiusPx;
        const pixelW = containerW / w;
        const pixelH = containerH / h;
        const thresh = Math.max(12, Math.min(horizMagRef, vertMagRef) * 0.28);

        let bestScore = 0;
        let bestX = -1;
        let bestY = -1;

        for (let cy = Math.max(1, Math.floor(fy - radiusY)); cy <= Math.min(h - 2, Math.ceil(fy + radiusY)); cy++) {
          const dySquared = ((cy - fy) * pixelH) ** 2;
          if (dySquared > radiusSquared) continue;
          for (let cx = Math.max(1, Math.floor(fx - radiusX)); cx <= Math.min(w - 2, Math.ceil(fx + radiusX)); cx++) {
            const distanceSquared = ((cx - fx) * pixelW) ** 2 + dySquared;
            if (distanceSquared > radiusSquared) continue;

            // Directional edge response: prioritize directional horizontal and vertical gradients
            // over isotropic text noise
            const magH = horizEdgeGrad[cy * w + cx];
            const magV = vertEdgeGrad[cy * w + cx];
            const mag = Math.max(magH, magV);
            const score = mag / (1 + 4 * distanceSquared / radiusSquared);
            if (
              mag > thresh && score > bestScore &&
              mag >= Math.max(horizEdgeGrad[cy * w + cx - 1], vertEdgeGrad[cy * w + cx - 1]) &&
              mag >= Math.max(horizEdgeGrad[cy * w + cx + 1], vertEdgeGrad[cy * w + cx + 1]) &&
              mag >= Math.max(horizEdgeGrad[(cy - 1) * w + cx], vertEdgeGrad[(cy - 1) * w + cx]) &&
              mag >= Math.max(horizEdgeGrad[(cy + 1) * w + cx], vertEdgeGrad[(cy + 1) * w + cx])
            ) {
              bestScore = score;
              bestX = cx;
              bestY = cy;
            }
          }
        }

        if (bestX >= 0 && bestY >= 0) {
          return {
            x: Math.max(0, Math.min(1, bestX / w)),
            y: Math.max(0, Math.min(1, bestY / h)),
            snapped: true,
            type: 'ridge',
          };
        }
      }

      return { x: normPt.x, y: normPt.y, snapped: false };
    },

    snapEdge(
      p1: Point,
      p2: Point,
      containerW: number,
      containerH: number,
      snapRadiusPx = 22
    ): { a: Point; b: Point; snapped: boolean; type?: 'line' | 'ridge' } {
      const cl01 = (v: number) => Math.max(0, Math.min(1, v));
      const ax = p1.x * containerW;
      const ay = p1.y * containerH;
      const bx = p2.x * containerW;
      const by = p2.y * containerH;
      const vx = bx - ax;
      const vy = by - ay;
      const len = Math.hypot(vx, vy);
      if (len < 60) return { a: p1, b: p2, snapped: false };
      const ux = vx / len;
      const uy = vy / len;
      const nx = -uy;
      const ny = ux;

      // 1. Strongest prior: the auto-detected document boundary. A
      // near-parallel auto edge passing within range captures the drag — both
      // endpoints slide perpendicularly onto that boundary line.
      if (autoQuad) {
        const qEdges: Array<[Point, Point]> = [
          [autoQuad.tl, autoQuad.tr],
          [autoQuad.tr, autoQuad.br],
          [autoQuad.br, autoQuad.bl],
          [autoQuad.bl, autoQuad.tl],
        ];
        let best: { q1x: number; q1y: number; qux: number; quy: number; qnx: number; qny: number; dist: number } | null = null;
        for (const [q1, q2] of qEdges) {
          const qx = (q2.x - q1.x) * containerW;
          const qy = (q2.y - q1.y) * containerH;
          const ql = Math.hypot(qx, qy);
          if (ql < 40) continue;
          const qux = qx / ql;
          const quy = qy / ql;
          if (Math.abs(qux * ux + quy * uy) < 0.86) continue; // near-parallel only
          const mx = ax + vx * 0.5 - q1.x * containerW;
          const my = ay + vy * 0.5 - q1.y * containerH;
          const dist = Math.abs(mx * quy - my * qux);
          if (dist > snapRadiusPx) continue;
          const t = mx * qux + my * quy;
          if (t < -0.15 * ql || t > 1.15 * ql) continue; // must overlap segment
          if (!best || dist < best.dist) {
            best = { q1x: q1.x * containerW, q1y: q1.y * containerH, qux, quy, qnx: -quy, qny: qux, dist };
          }
        }
        if (best) {
          // Perpendicular foot of each endpoint on the boundary line: signed
          // distance along the line's normal, then slide back by it.
          const sd1 = (ax - best.q1x) * best.qnx + (ay - best.q1y) * best.qny;
          const sd2 = (bx - best.q1x) * best.qnx + (by - best.q1y) * best.qny;
          return {
            a: { x: cl01(p1.x - (best.qnx * sd1) / containerW), y: cl01(p1.y - (best.qny * sd1) / containerH) },
            b: { x: cl01(p2.x - (best.qnx * sd2) / containerW), y: cl01(p2.y - (best.qny * sd2) / containerH) },
            snapped: true,
            type: 'line',
          };
        }
      }

      // 2. Ridge scan: march perpendicular to the dragged edge and accumulate
      // directional gradient responses across samples along it — this locks
      // onto the true page edge even when auto-detection missed. Near-
      // horizontal edges read the |gy|-weighted field, near-vertical the |gx|
      // one, so text strokes inside the page cannot compete.
      if (f) {
        const { w, h, horizEdgeGrad, vertEdgeGrad, horizMagRef, vertMagRef } = f;
        const R = Math.max(6, Math.min(snapRadiusPx, 26));
        const S = Math.max(8, Math.min(16, Math.round(len / 20)));
        const thresh = Math.max(12, Math.min(horizMagRef, vertMagRef) * 0.28) * S * 0.45;
        const scores = new Float32Array(2 * R + 1);
        for (let si = 0; si < S; si++) {
          const t = 0.08 + (si / (S - 1)) * 0.84; // keep sample ends off corners
          const px0 = ax + vx * t;
          const py0 = ay + vy * t;
          for (let o = -R; o <= R; o++) {
            const fx = Math.round(((px0 + nx * o) / containerW) * w);
            const fy = Math.round(((py0 + ny * o) / containerH) * h);
            if (fx < 1 || fy < 1 || fx >= w - 1 || fy >= h - 1) continue;
            const idx = fy * w + fx;
            const mag =
              Math.abs(uy) >= 0.72
                ? horizEdgeGrad[idx]
                : Math.abs(uy) <= 0.28
                  ? vertEdgeGrad[idx]
                  : Math.max(horizEdgeGrad[idx], vertEdgeGrad[idx]);
            scores[o + R] += mag;
          }
        }
        let bestO: number | null = null;
        let bestScore = thresh;
        for (let o = -R; o <= R; o++) {
          if (scores[o + R] > bestScore) {
            bestScore = scores[o + R];
            bestO = o;
          }
        }
        if (bestO !== null) {
          const dnx = (nx * bestO) / containerW;
          const dny = (ny * bestO) / containerH;
          return {
            a: { x: cl01(p1.x + dnx), y: cl01(p1.y + dny) },
            b: { x: cl01(p2.x + dnx), y: cl01(p2.y + dny) },
            snapped: true,
            type: 'ridge',
          };
        }
      }

      return { a: p1, b: p2, snapped: false };
    },
  };
}
