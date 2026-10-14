/**
 * Client-side enhancement pipeline for the Cam Scanner mode.
 * Everything runs on canvas pixel data in the browser — nothing is uploaded.
 *
 * Filter presets, each a dedicated engine (see the "Pixel operations" section):
 *  - Original — strict passthrough: the untouched capture, zero-cost.
 *  - SuperScan — high-fidelity color enhancer: noise-floored unsharp mask and
 *    a soft regional illumination correction on the luma plane only; chroma
 *    channels are never touched, so color assets stay true to the capture.
 *  - Magic — CamScanner-style magic color engine: flat-field background
 *    shadow removal, balanced paper whitening, high-contrast pencil & ink
 *    stroke preservation, and vibrant mid-tone color saturation.
 *  - Grayscale — continuous monochrome document enhancer: flat-field shadow
 *    removal, clean white paper normalization, adaptive stroke/pencil darkening,
 *    and unsharp masking for crisp, smooth black-and-white tones.
 *
 * Manual brightness / contrast / sharpen / saturation adjustments apply on
 * top of every engine. Heavy blurs run at ¼ resolution, bilateral and
 * threshold passes are LUT- and sliding-window-driven, and there are no
 * per-pixel allocations — renders stay smooth at full capture resolution.
 */

import { applyEraseStrokes, type ScanEraseStroke } from './backgroundEraser';

export type ScanFilterId = 'original' | 'superscan' | 'magic' | 'gray';

/** JPEG quality presets in percent (PNG is lossless and ignores them). */
export const SCAN_QUALITY_PRESETS: Record<'small' | 'balanced' | 'best', number> = {
  small: 72,
  balanced: 86,
  best: 96,
};

export interface ScanAdjustments {
  brightness: number; // 0–100, 50 = neutral
  contrast: number; // 0–100, 50 = neutral
  sharpen: number; // 0–100, 0 = off
  saturation: number; // 0–100, 50 = neutral
}

export const NEUTRAL_ADJUSTMENTS: ScanAdjustments = {
  brightness: 50,
  contrast: 50,
  sharpen: 0,
  saturation: 50,
};

export const SCAN_FILTERS: Array<{ id: ScanFilterId; label: string; hint: string }> = [
  { id: 'original', label: 'Original', hint: 'Untouched capture' },
  { id: 'superscan', label: 'SuperScan', hint: 'True colors & natural clarity' },
  { id: 'magic', label: 'Magic', hint: 'Shadow-free white paper & vivid text' },
  { id: 'gray', label: 'Grayscale', hint: 'Clean black-and-white tones' },
];

/** A page outline: four corners, normalized 0–1 on the rotated image (TL, TR, BR, BL). */
export interface ScanQuad {
  tl: { x: number; y: number };
  tr: { x: number; y: number };
  br: { x: number; y: number };
  bl: { x: number; y: number };
}

/**
 * Captures/uploads are downscaled to this long edge before storage. 3072
 * keeps ~2.3× the pixel data of the old 2048 cap, so exports no longer read
 * as soft/compressed next to the original photo. Interactive renders are
 * unaffected — previews and thumbnails run at their own smaller caps.
 */
export const MAX_CAPTURE_EDGE = 3072;
/** Preview renders are further downscaled; exports always use the full capture. */
export const PREVIEW_MAX_EDGE = 1200;
/** Filter thumbnails in the editor panel. */
export const THUMB_MAX_EDGE = 170;

/** Decoded-image cache (LRU) so slider tweaks don't re-decode the JPEG. */
const MAX_IMAGE_CACHE = 4;
const imageCache = new Map<string, HTMLImageElement>();

export function clearImageCache(): void {
  for (const [, img] of imageCache) {
    try {
      img.onload = null;
      img.onerror = null;
      img.src = '';
    } catch {}
  }
  imageCache.clear();
}

export function loadImageFromUrl(url: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(url);
  if (cached) {
    // Refresh recency — Map preserves insertion order, so the oldest entry
    // is the eviction victim (a full clear would re-decode everything).
    imageCache.delete(url);
    imageCache.set(url, cached);
    return Promise.resolve(cached);
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      if (imageCache.size >= MAX_IMAGE_CACHE) {
        const oldestKey = imageCache.keys().next().value;
        if (oldestKey !== undefined) {
          const oldImg = imageCache.get(oldestKey);
          if (oldImg) {
            oldImg.onload = null;
            oldImg.onerror = null;
            oldImg.src = '';
          }
          imageCache.delete(oldestKey);
        }
      }
      imageCache.set(url, img);
      resolve(img);
    };
    img.onerror = () => reject(new Error('Image could not be decoded'));
    img.src = url;
  });
}

/**
 * Fast batch generator for all filter preview thumbnails:
 * Instead of decoding the full 3000px image 4 times and running 4 separate warps,
 * this downscales ONCE to thumbnail scale (~170px), warps the tiny canvas once (<0.5ms),
 * and executes filter passes on the 170px canvas. Runs in ~2ms instead of ~600ms!
 */
export async function renderFilterThumbnailsFast(
  sourceUrl: string,
  opts: {
    rotation?: 0 | 90 | 180 | 270;
    quad?: ScanQuad | null;
    hex?: ScanHexagon | null;
  } = {},
  thumbMaxEdge = THUMB_MAX_EDGE
): Promise<Partial<Record<ScanFilterId, string>>> {
  const img = await loadImageFromUrl(sourceUrl);
  const oriented = buildOrientedCanvas(img, opts.rotation ?? 0, thumbMaxEdge);
  const warped = opts.quad ? warpQuadToCanvas(oriented, opts.quad, opts.hex ?? null) : oriented;
  if (warped !== oriented) {
    oriented.width = 0;
    oriented.height = 0;
  }

  const results: Partial<Record<ScanFilterId, string>> = {};
  const workCanvas = document.createElement('canvas');
  workCanvas.width = warped.width;
  workCanvas.height = warped.height;
  const workCtx = workCanvas.getContext('2d', { alpha: false, willReadFrequently: true });

  if (workCtx) {
    for (const f of SCAN_FILTERS) {
      workCtx.drawImage(warped, 0, 0);
      enhanceImageData(workCtx, workCanvas.width, workCanvas.height, f.id, NEUTRAL_ADJUSTMENTS);
      results[f.id] = workCanvas.toDataURL('image/jpeg', 0.8);
    }
  }

  workCanvas.width = 0;
  workCanvas.height = 0;
  warped.width = 0;
  warped.height = 0;

  return results;
}

/** Compress a canvas/video frame to a JPEG data URL, downscaling to maxEdge first. */
export async function captureCanvasToDataUrl(
  source: HTMLCanvasElement | HTMLVideoElement | HTMLImageElement,
  srcWidth: number,
  srcHeight: number,
  maxEdge: number = MAX_CAPTURE_EDGE,
  quality = 0.95
): Promise<string> {
  const scale = Math.min(1, maxEdge / Math.max(srcWidth, srcHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(srcWidth * scale));
  canvas.height = Math.max(1, Math.round(srcHeight * scale));
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Canvas is not supported in this browser');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL('image/jpeg', quality);
  canvas.width = 0;
  canvas.height = 0;
  return url;
}

/* --------------------------------------------------------------------------
   Geometry: rotation + perspective warp + auto edge detection
   -------------------------------------------------------------------------- */

/**
 * Draws the source image rotated in 90° steps into a fresh canvas, optionally
 * downscaled to maxEdge IN THE SAME DRAW. Drawing at target scale avoids ever
 * allocating the full-resolution intermediate — previews, thumbnails and
 * interactive renders no longer pay full-capture geometry cost.
 */
export function buildOrientedCanvas(
  img: HTMLImageElement,
  rotation: 0 | 90 | 180 | 270,
  maxEdge = 0
): HTMLCanvasElement {
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  const swap = rotation === 90 || rotation === 270;
  const fullW = swap ? srcH : srcW;
  const fullH = swap ? srcW : srcH;
  const scale = maxEdge ? Math.min(1, maxEdge / Math.max(fullW, fullH)) : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(fullW * scale));
  canvas.height = Math.max(1, Math.round(fullH * scale));
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!ctx) return canvas;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(img, (-srcW * scale) / 2, (-srcH * scale) / 2, srcW * scale, srcH * scale);
  return canvas;
}

function quadToPixels(quad: ScanQuad, w: number, h: number) {
  const px = (p: { x: number; y: number }) => ({
    x: Math.max(0, Math.min(1, p.x)) * w,
    y: Math.max(0, Math.min(1, p.y)) * h,
  });
  return [px(quad.tl), px(quad.tr), px(quad.br), px(quad.bl)];
}

/** Solves the affine transform mapping source triangle (s0,s1,s2) → (d0,d1,d2). */
function solveAffine(
  s0: { x: number; y: number }, s1: { x: number; y: number }, s2: { x: number; y: number },
  d0: { x: number; y: number }, d1: { x: number; y: number }, d2: { x: number; y: number }
): { a: number; b: number; c: number; d: number; e: number; f: number } | null {
  // [a c e; b d f] applied as (x,y) → (a·x + c·y + e, b·x + d·y + f) must map
  // each sᵢ to dᵢ; solve the two 3×3 systems with the triangle matrix inverse.
  const det = s0.x * (s1.y - s2.y) - s1.x * (s0.y - s2.y) + s2.x * (s0.y - s1.y);
  if (Math.abs(det) < 1e-8) return null;
  const r0 = [s1.y - s2.y, s2.x - s1.x, s1.x * s2.y - s2.x * s1.y];
  const r1 = [s2.y - s0.y, s0.x - s2.x, s2.x * s0.y - s0.x * s2.y];
  const r2 = [s0.y - s1.y, s1.x - s0.x, s0.x * s1.y - s1.x * s0.y];
  const a = (d0.x * r0[0] + d1.x * r1[0] + d2.x * r2[0]) / det;
  const c = (d0.x * r0[1] + d1.x * r1[1] + d2.x * r2[1]) / det;
  const e = (d0.x * r0[2] + d1.x * r1[2] + d2.x * r2[2]) / det;
  const b = (d0.y * r0[0] + d1.y * r1[0] + d2.y * r2[0]) / det;
  const dd = (d0.y * r0[1] + d1.y * r1[1] + d2.y * r2[1]) / det;
  const f = (d0.y * r0[2] + d1.y * r1[2] + d2.y * r2[2]) / det;
  return { a, b, c, d: dd, e, f };
}

/**
 * Warps the quad region of `src` into an upright rectangle (perspective
 * correction). The quad is subdivided into a fine grid; each cell is drawn as
 * two affine-mapped triangles, which approximates a true homography closely
 * enough to be visually indistinguishable at scan resolutions.
 */
export function warpQuadToCanvas(src: HTMLCanvasElement, quad: ScanQuad, hex?: ScanHexagon | null): HTMLCanvasElement;
export function warpQuadToCanvas(src: OffscreenCanvas, quad: ScanQuad, hex?: ScanHexagon | null): OffscreenCanvas;
export function warpQuadToCanvas(
  src: HTMLCanvasElement | OffscreenCanvas,
  quad: ScanQuad,
  hex?: ScanHexagon | null
): HTMLCanvasElement | OffscreenCanvas {
  const [p0, p1, p2, p3] = quadToPixels(quad, src.width, src.height);
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);
  const outW = Math.max(8, Math.round(Math.max(dist(p0, p1), dist(p3, p2))));
  const outH = Math.max(8, Math.round(Math.max(dist(p0, p3), dist(p1, p2))));

  const canvas = typeof OffscreenCanvas !== 'undefined' && src instanceof OffscreenCanvas
    ? new OffscreenCanvas(outW, outH) : document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d', { alpha: false }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return canvas;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outW, outH);
  ctx.imageSmoothingQuality = 'high';

  // Bilinear map of the unit square onto the source quad.
  const srcAt = (u: number, v: number) => ({
    x: (1 - u) * (1 - v) * p0.x + u * (1 - v) * p1.x + u * v * p2.x + (1 - u) * v * p3.x,
    y: (1 - u) * (1 - v) * p0.y + u * (1 - v) * p1.y + u * v * p2.y + (1 - u) * v * p3.y,
  });

  const drawTriangle = (
    d0: { x: number; y: number }, d1: { x: number; y: number }, d2: { x: number; y: number },
    s0: { x: number; y: number }, s1: { x: number; y: number }, s2: { x: number; y: number }
  ) => {
    const m = solveAffine(s0, s1, s2, d0, d1, d2);
    if (!m) return;
    // Expand the destination triangle slightly outward from its centroid.
    // Without this, antialiased clip edges leave hairline gaps between
    // neighbouring triangles — a regular grid of faint lines that reads as a
    // watermark across the warped page. Overlapping is safe: the mapping is
    // continuous across shared edges, so overlapping draws composite invisibly.
    const cx = (d0.x + d1.x + d2.x) / 3;
    const cy = (d0.y + d1.y + d2.y) / 3;
    const EPS = 2; // ≈1px of perpendicular overlap per edge
    const expand = (p: { x: number; y: number }) => {
      const vx = p.x - cx;
      const vy = p.y - cy;
      const len = Math.hypot(vx, vy) || 1;
      const k = (len + EPS) / len;
      return { x: cx + vx * k, y: cy + vy * k };
    };
    const e0 = expand(d0);
    const e1 = expand(d1);
    const e2 = expand(d2);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(e0.x, e0.y);
    ctx.lineTo(e1.x, e1.y);
    ctx.lineTo(e2.x, e2.y);
    ctx.closePath();
    ctx.clip();
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.drawImage(src, 0, 0);
    ctx.restore();
  };

  // Six-point PIECEWISE-AFFINE de-warp. A quad's bilinear grid cannot
  // represent edges that bow (book gutters, curled pages) — a six-vertex
  // outline can. When the hexagon's center vertices genuinely deviate from
  // the corner chord, the hexagon is flattened by a four-triangle mesh:
  // corners map to the rectangle corners, the center vertices map onto the
  // rectangle's top/bottom edges at their ARC-LENGTH position, and the four
  // triangles (TL,TC,BR) (TC,TR,BR) (BR,BC,TL) (BC,BL,TL) tile both the
  // source hexagon and the destination rectangle without degeneracy. Each
  // triangle is flattened independently with the same overlap-protected
  // affine mapper, so the meshes stitch seamlessly. Straight-edged outlines
  // fall through to the (cheaper) quad grid below.
  if (hex) {
    const minDim = Math.min(src.width, src.height);
    const P = (p: HexPt) => ({ x: p.x * src.width, y: p.y * src.height });
    const deviates = (a: HexPt, m: HexPt, b: HexPt) =>
      pointLineDistance(P(m), P(a), P(b)) > Math.max(1.5, minDim * 0.004);
    if (deviates(hex.tl, hex.tc, hex.tr) || deviates(hex.bl, hex.bc, hex.br)) {
      const sTL = P(hex.tl);
      const sTC = P(hex.tc);
      const sTR = P(hex.tr);
      const sBR = P(hex.br);
      const sBC = P(hex.bc);
      const sBL = P(hex.bl);
      const topL = Math.hypot(sTC.x - sTL.x, sTC.y - sTL.y);
      const topR = Math.hypot(sTR.x - sTC.x, sTR.y - sTC.y);
      const botL = Math.hypot(sBC.x - sBL.x, sBC.y - sBL.y);
      const botR = Math.hypot(sBR.x - sBC.x, sBR.y - sBC.y);
      const dTL = { x: 0, y: 0 };
      const dTC = { x: outW * (topL / Math.max(1e-6, topL + topR)), y: 0 };
      const dTR = { x: outW, y: 0 };
      const dBR = { x: outW, y: outH };
      const dBC = { x: outW * (botL / Math.max(1e-6, botL + botR)), y: outH };
      const dBL = { x: 0, y: outH };
      drawTriangle(dTL, dTC, dBR, sTL, sTC, sBR);
      drawTriangle(dTC, dTR, dBR, sTC, sTR, sBR);
      drawTriangle(dBR, dBC, dTL, sBR, sBC, sTL);
      drawTriangle(dBC, dBL, dTL, sBC, sBL, sTL);
      return canvas;
    }
  }

  const N = 24;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const u0 = i / N, u1 = (i + 1) / N, v0 = j / N, v1 = (j + 1) / N;
      const dTL = { x: u0 * outW, y: v0 * outH };
      const dTR = { x: u1 * outW, y: v0 * outH };
      const dBR = { x: u1 * outW, y: v1 * outH };
      const dBL = { x: u0 * outW, y: v1 * outH };
      const sTL = srcAt(u0, v0), sTR = srcAt(u1, v0), sBR = srcAt(u1, v1), sBL = srcAt(u0, v1);
      drawTriangle(dTL, dTR, dBR, sTL, sTR, sBR);
      drawTriangle(dTL, dBR, dBL, sTL, sBR, sBL);
    }
  }
  return canvas;
}

/* --------------------------------------------------------------------------
   Six-point scanning engine: dual-path preprocessing, contour extraction,
   cognitive fallbacks (all operating at the shared 400-px detection scale)
   -------------------------------------------------------------------------- */

/** A point in pixel or normalized space, depending on context. */
interface HexPt {
  x: number;
  y: number;
}

/**
 * Normalized six-point document outline, clockwise: top-left, top-center,
 * top-right, bottom-right, bottom-center, bottom-left. The two center
 * vertices let the outline follow edges that bow (book gutters, curled
 * pages) — geometry a four-corner quad cannot represent, which is why the
 * contour stage simplifies to exactly six dominant vertices, not four.
 */
export interface ScanHexagon {
  tl: HexPt;
  tc: HexPt;
  tr: HexPt;
  br: HexPt;
  bc: HexPt;
  bl: HexPt;
}

/**
 * Bilateral filter: averages each pixel over a small disc weighted by
 * spatial distance AND brightness similarity, so flat texture noise (carpet,
 * paper grain) melts away while strong luminance steps — the document
 * boundary — stay sharp. Range weights come from a 511-entry LUT and spatial
 * weights from a per-radius table, so the inner loop has no exponentials.
 */
function bilateralFilter(
  gray: Uint8Array,
  w: number,
  h: number,
  radius = 3,
  sigmaColor = 26
): Float32Array {
  const out = new Float32Array(w * h);
  const rangeLUT = new Float32Array(511);
  const sc = 2 * sigmaColor * sigmaColor;
  for (let d = -255; d <= 255; d++) rangeLUT[d + 255] = Math.exp(-(d * d) / sc);
  const spatialLUT = new Float32Array(radius * radius + 1);
  const sr2 = 2 * radius * radius;
  for (let d2 = 0; d2 <= radius * radius; d2++) spatialLUT[d2] = Math.exp(-d2 / sr2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const c = gray[i];
      let sum = 0;
      let wsum = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const sy = y + dy;
        if (sy < 0 || sy >= h) continue;
        const row = sy * w;
        for (let dx = -radius; dx <= radius; dx++) {
          const sx = x + dx;
          if (sx < 0 || sx >= w) continue;
          const d2 = dx * dx + dy * dy;
          if (d2 > radius * radius) continue;
          const v = gray[row + sx];
          const wt = spatialLUT[d2] * rangeLUT[v - c + 255];
          sum += wt * v;
          wsum += wt;
        }
      }
      out[i] = wsum > 0 ? sum / wsum : c;
    }
  }
  return out;
}

/**
 * Canny edge detector: gaussian smoothing (double box blur), Sobel
 * gradients, non-maximum suppression along the gradient direction, double
 * thresholding from a robust 98th-percentile reference and hysteresis
 * linking. Returns a binary edge map.
 */
function cannyEdges(gray: Float32Array, w: number, h: number): Uint8Array {
  const n = w * h;
  let sm = boxBlurChannel(Float32Array.from(gray), w, h, 2);
  sm = boxBlurChannel(sm, w, h, 2);
  const mag = new Float32Array(n);
  const gx = new Float32Array(n);
  const gy = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const sgx =
        -sm[i - w - 1] - 2 * sm[i - 1] - sm[i + w - 1] +
        sm[i - w + 1] + 2 * sm[i + 1] + sm[i + w + 1];
      const sgy =
        -sm[i - w - 1] - 2 * sm[i - w] - sm[i - w + 1] +
        sm[i + w - 1] + 2 * sm[i + w] + sm[i + w + 1];
      gx[i] = sgx;
      gy[i] = sgy;
      mag[i] = Math.abs(sgx) + Math.abs(sgy);
    }
  }
  // Non-maximum suppression: keep a pixel only if it is a local maximum
  // across the gradient direction (4-sector quantization).
  const nms = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m <= 0) continue;
      const ax = Math.abs(gx[i]);
      const ay = Math.abs(gy[i]);
      let n1: number;
      let n2: number;
      if (ax > ay) {
        n1 = mag[i - 1];
        n2 = mag[i + 1];
      } else if (ay > ax) {
        n1 = mag[i - w];
        n2 = mag[i + w];
      } else if (gx[i] * gy[i] >= 0) {
        n1 = mag[i - w - 1];
        n2 = mag[i + w + 1];
      } else {
        n1 = mag[i - w + 1];
        n2 = mag[i + w - 1];
      }
      if (m >= n1 && m >= n2) nms[i] = m;
    }
  }
  let maxM = 0;
  for (let i = 0; i < n; i++) if (nms[i] > maxM) maxM = nms[i];
  if (maxM < 1) return new Uint8Array(n);
  const bins = new Uint32Array(64);
  let nonzero = 0;
  for (let i = 0; i < n; i++) {
    if (nms[i] > 0) {
      bins[Math.min(63, ((nms[i] / maxM) * 63) | 0)]++;
      nonzero++;
    }
  }
  let cum = 0;
  let cutBin = 63;
  for (let b = 63; b >= 0; b--) {
    cum += bins[b];
    if (cum >= nonzero * 0.02) {
      cutBin = b;
      break;
    }
  }
  const high = Math.max(12, (cutBin / 63) * maxM * 0.5);
  const low = high * 0.4;
  const edges = new Uint8Array(n);
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    if (nms[i] >= high) {
      edges[i] = 1;
      stack.push(i);
    }
  }
  while (stack.length > 0) {
    const i = stack.pop() as number;
    const x = i % w;
    const y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const sy = y + dy;
      if (sy < 0 || sy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const sx = x + dx;
        if (sx < 0 || sx >= w) continue;
        const j = sy * w + sx;
        if (edges[j] === 0 && nms[j] >= low) {
          edges[j] = 1;
          stack.push(j);
        }
      }
    }
  }
  return edges;
}

/** Square dilation (used to bridge 1-px gaps in Canny maps before tracing). */
function dilateMask(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x] === 0) continue;
      for (let dy = -radius; dy <= radius; dy++) {
        const sy = y + dy;
        if (sy < 0 || sy >= h) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const sx = x + dx;
          if (sx < 0 || sx >= w) continue;
          out[sy * w + sx] = 1;
        }
      }
    }
  }
  return out;
}

/**
 * Heavy median blur via a sliding-window histogram (Huang's algorithm):
 * constant-time column updates per step, exact median per pixel — with the
 * median bin carried across columns and slid up/down instead of rescanning
 * the histogram from bin 0, so paper-white fields (median pinned at 255)
 * cost O(1) per pixel. Median filtering removes impulse/salt-and-pepper
 * noise while PRESERVING edges — the precondition for the adaptive
 * threshold in Path B to produce clean region boundaries.
 */
function medianBlur(gray: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const hist = new Uint32Array(256);
  const clampY = (y: number) => (y < 0 ? 0 : y >= h ? h - 1 : y);
  const half = (((2 * radius + 1) * (2 * radius + 1)) + 1) >> 1;
  for (let y = 0; y < h; y++) {
    hist.fill(0);
    for (let dx = -radius; dx <= radius - 1; dx++) {
      const sx = dx < 0 ? 0 : dx >= w ? w - 1 : dx;
      for (let dy = -radius; dy <= radius; dy++) hist[gray[clampY(y + dy) * w + sx]]++;
    }
    // Running median: `med` is the current median bin, cntLE the count of
    // samples ≤ med. After each window shift it is rebalanced with two walks,
    // which is amortized O(1) — a full histogram rescan was O(256)/pixel.
    let med = 0;
    let cntLE = 0;
    for (let x = 0; x < w; x++) {
      const ax = Math.min(w - 1, x + radius);
      for (let dy = -radius; dy <= radius; dy++) {
        const v = gray[clampY(y + dy) * w + ax];
        hist[v]++;
        if (v <= med) cntLE++;
      }
      while (cntLE < half) {
        med++;
        cntLE += hist[med];
      }
      while (cntLE - hist[med] >= half) {
        cntLE -= hist[med];
        med--;
      }
      out[y * w + x] = med;
      const rx = Math.max(0, x - radius);
      for (let dy = -radius; dy <= radius; dy++) {
        const v = gray[clampY(y + dy) * w + rx];
        hist[v]--;
        if (v <= med) cntLE--;
      }
    }
  }
  return out;
}

/**
 * Adaptive Gaussian threshold (block size ~11–21, C = 2): a pixel is "mass"
 * when it exceeds its local Gaussian mean minus C. Because the reference is
 * LOCAL, slow illumination gradients and heavy overhead shadows vanish — a
 * page under a shadow gradient still separates from its background, which
 * global Otsu cannot do.
 */
function adaptiveThreshold(
  gray: Uint8Array,
  w: number,
  h: number,
  blockSize = 15,
  C = 2
): Uint8Array {
  const r = Math.max(2, blockSize >> 1);
  let mean = boxBlurChannel(Float32Array.from(gray), w, h, r);
  mean = boxBlurChannel(mean, w, h, r); // two-pass box ≈ Gaussian window
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = gray[i] > mean[i] - C ? 1 : 0;
  return mask;
}

/**
 * Morphological closing (dilate then erode) with an ELLIPTICAL structuring
 * element: bridges small breaks in region/edge segments without the boxy
 * artifacts of a square kernel.
 */
function morphClose(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const offs: Array<[number, number]> = [];
  const r2 = radius * radius;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if ((dx * dx + dy * dy) / r2 <= 1.15) offs.push([dx, dy]);
    }
  }
  const dil = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x] === 0) continue;
      for (const [dx, dy] of offs) {
        const sx = x + dx;
        const sy = y + dy;
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        dil[sy * w + sx] = 1;
      }
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let all = 1;
      for (const [dx, dy] of offs) {
        const sx = x + dx;
        const sy = y + dy;
        if (sx < 0 || sy < 0 || sx >= w || sy >= h || dil[sy * w + sx] === 0) {
          all = 0;
          break;
        }
      }
      if (all) out[y * w + x] = 1;
    }
  }
  return out;
}

/** External-contour retrieval: flood-fill labels every 4-connected region. */
function largestComponents(
  mask: Uint8Array,
  w: number,
  h: number,
  keep: number,
  minFrac: number
): number[][] {
  const n = w * h;
  const labels = new Int32Array(n);
  const stack = new Int32Array(n);
  const comps: Array<{ id: number; size: number }> = [];
  let id = 0;
  for (let start = 0; start < n; start++) {
    if (mask[start] === 0 || labels[start] !== 0) continue;
    id++;
    let size = 0;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = id;
    while (sp > 0) {
      const i = stack[--sp];
      size++;
      const x = i % w;
      const y = (i / w) | 0;
      if (x > 0 && mask[i - 1] !== 0 && labels[i - 1] === 0) {
        labels[i - 1] = id;
        stack[sp++] = i - 1;
      }
      if (x < w - 1 && mask[i + 1] !== 0 && labels[i + 1] === 0) {
        labels[i + 1] = id;
        stack[sp++] = i + 1;
      }
      if (y > 0 && mask[i - w] !== 0 && labels[i - w] === 0) {
        labels[i - w] = id;
        stack[sp++] = i - w;
      }
      if (y < h - 1 && mask[i + w] !== 0 && labels[i + w] === 0) {
        labels[i + w] = id;
        stack[sp++] = i + w;
      }
    }
    comps.push({ id, size });
  }
  comps.sort((a, b) => b.size - a.size);
  const out: number[][] = [];
  for (const c of comps.slice(0, keep)) {
    if (c.size < n * minFrac) break;
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (labels[i] === c.id) idx.push(i);
    out.push(idx);
  }
  return out;
}

/** Andrew's monotone-chain convex hull over component pixels. */
function convexHullOfIndices(idx: number[], w: number): HexPt[] {
  const pts = idx.map((i) => ({ x: i % w, y: (i / w) | 0 }));
  pts.sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: HexPt, a: HexPt, b: HexPt) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: HexPt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: HexPt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function polygonPerimeter(pts: HexPt[]): number {
  let per = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    per += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return per;
}

function polygonArea(pts: HexPt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

function pointLineDistance(p: HexPt, a: HexPt, b: HexPt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1e-9;
  return Math.abs(dx * (a.y - p.y) - (a.x - p.x) * dy) / len;
}

/** Iterative Douglas–Peucker polyline simplification (open chain). */
function douglasPeucker(pts: HexPt[], eps: number): HexPt[] {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length > 0) {
    const [s, e] = stack.pop() as [number, number];
    const p0 = pts[s];
    const p1 = pts[e];
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy) || 1e-9;
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs(dx * (p0.y - pts[i].y) - (p0.x - pts[i].x) * dy) / len;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > eps && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out: HexPt[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/**
 * Drops the least-significant vertices (smallest deviation from the chord of
 * its neighbours) until exactly six remain.
 */
function reduceToSix(pts: HexPt[]): HexPt[] {
  const cur = pts.slice();
  while (cur.length > 6) {
    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i < cur.length; i++) {
      const d = pointLineDistance(
        cur[i],
        cur[(i - 1 + cur.length) % cur.length],
        cur[(i + 1) % cur.length]
      );
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    cur.splice(bestI, 1);
  }
  return cur;
}

/** Splits the longest edges at their midpoints until exactly six remain. */
function expandToSix(pts: HexPt[]): HexPt[] {
  const cur = pts.slice();
  while (cur.length < 6 && cur.length >= 2) {
    let bi = 0;
    let bl = -1;
    for (let i = 0; i < cur.length; i++) {
      const q = cur[(i + 1) % cur.length];
      const L = Math.hypot(q.x - cur[i].x, q.y - cur[i].y);
      if (L > bl) {
        bl = L;
        bi = i;
      }
    }
    const a = cur[bi];
    const b = cur[(bi + 1) % cur.length];
    cur.splice(bi + 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  }
  return cur;
}

/**
 * Epsilon auto-tuning around the spec's 0.02·perimeter start: grows/shrinks
 * geometrically until Douglas–Peucker yields EXACTLY six vertices; if the
 * perimeter scale can't hit six, falls back to significance-based vertex
 * pruning / longest-edge splitting, which always lands on six.
 */
function simplifyToSix(hull: HexPt[]): HexPt[] | null {
  if (hull.length < 4) return null;
  const per = polygonPerimeter(hull);
  let eps = 0.02 * per;
  let simp = douglasPeucker(hull, eps);
  for (let guard = 0; simp.length !== 6 && guard < 30; guard++) {
    eps *= simp.length > 6 ? 1.3 : 0.7;
    if (eps > 0.5 * per || eps < 1e-3) break;
    simp = douglasPeucker(hull, eps);
  }
  if (simp.length > 6) simp = reduceToSix(simp);
  else if (simp.length < 6) simp = expandToSix(simp);
  return simp.length === 6 ? simp : null;
}

/**
 * Re-labels six free vertices into the canonical clockwise layout — top
 * half (by centroid) sorted left→right becomes TL, TC, TR; bottom half
 * sorted right→left becomes BR, BC, BL — merging surplus vertices into
 * their nearest neighbour and bridging deficits with segment midpoints.
 */
function canonicalHexagon(pts: HexPt[]): ScanHexagon | null {
  if (pts.length !== 6) return null;
  let cy = 0;
  for (const p of pts) cy += p.y;
  cy /= pts.length;
  const mergeNearest = (arr: HexPt[]) => {
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i];
      const b = arr[(i + 1) % arr.length];
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    const a = arr[bi];
    const b = arr[(bi + 1) % arr.length];
    arr.splice(bi, 2, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  };
  const top = pts.filter((p) => p.y <= cy).sort((a, b) => a.x - b.x);
  const bot = pts.filter((p) => p.y > cy).sort((a, b) => b.x - a.x);
  while (top.length > 3) mergeNearest(top);
  while (bot.length > 3) mergeNearest(bot);
  if (top.length === 2) {
    top.splice(1, 0, { x: (top[0].x + top[1].x) / 2, y: (top[0].y + top[1].y) / 2 });
  }
  if (bot.length === 2) {
    bot.splice(1, 0, { x: (bot[0].x + bot[1].x) / 2, y: (bot[0].y + bot[1].y) / 2 });
  }
  if (top.length !== 3 || bot.length !== 3) return null;
  return { tl: top[0], tc: top[1], tr: top[2], br: bot[0], bc: bot[1], bl: bot[2] };
}

/** Spec validation: strictly convex AND ≥ 20% of the frame area. */
function validateHexagonPx(hex: ScanHexagon, w: number, h: number): boolean {
  const pts = [hex.tl, hex.tc, hex.tr, hex.br, hex.bc, hex.bl];
  let sign = 0;
  for (let i = 0; i < 6; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 6];
    const c = pts[(i + 2) % 6];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const s = cross > 0 ? 1 : cross < 0 ? -1 : 0;
    if (s === 0) return false;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return polygonArea(pts) / (w * h) >= 0.2;
}

/** Perimeter edge support + coverage confidence (0–1 scale). */
function hexagonConfidence(hex: ScanHexagon, edgeRef: Uint8Array, w: number, h: number): number {
  const pts = [hex.tl, hex.tc, hex.tr, hex.br, hex.bc, hex.bl];
  let hits = 0;
  let total = 0;
  for (let e = 0; e < 6; e++) {
    const p = pts[e];
    const q = pts[(e + 1) % 6];
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    const k = Math.max(4, Math.round(len / 4));
    for (let s = 0; s < k; s++) {
      const t = (s + 0.5) / k;
      const x = Math.round(p.x + (q.x - p.x) * t);
      const y = Math.round(p.y + (q.y - p.y) * t);
      let hit = 0;
      for (let dy = -2; dy <= 2 && !hit; dy++) {
        const sy = y + dy;
        if (sy < 0 || sy >= h) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const sx = x + dx;
          if (sx < 0 || sx >= w) continue;
          if (edgeRef[sy * w + sx]) {
            hit = 1;
            break;
          }
        }
      }
      hits += hit;
      total++;
    }
  }
  const support = total > 0 ? hits / total : 0;
  const coverage = polygonArea(pts) / (w * h);
  return 0.55 * support + 0.45 * Math.min(1, coverage / 0.85);
}

/** Confidence floor for accepting a path's candidate at all. */
const HEX_CONF_FLOOR = 0.4;

/**
 * Contour extraction for one binary mass map: traces the largest external
 * regions, convex-hulls each, simplifies to six vertices, validates, and
 * returns the candidate with the largest hull area (for edge maps, text
 * clusters inside the page can out-count the outline ring in pixels — the
 * hull-area ranking is what keeps the document outline winning).
 */
function hexagonFromMass(
  mask: Uint8Array,
  w: number,
  h: number,
  edgeRef: Uint8Array
): { hex: ScanHexagon; conf: number } | null {
  const comps = largestComponents(mask, w, h, 4, 0.004);
  let best: { hex: ScanHexagon; conf: number } | null = null;
  let bestArea = 0;
  for (const idx of comps) {
    const hull = convexHullOfIndices(idx, w);
    if (hull.length < 4) continue;
    const six = simplifyToSix(hull);
    if (!six) continue;
    const hex = canonicalHexagon(six);
    if (!hex || !validateHexagonPx(hex, w, h)) continue;
    const area = polygonArea([hex.tl, hex.tc, hex.tr, hex.br, hex.bc, hex.bl]);
    const conf = hexagonConfidence(hex, edgeRef, w, h);
    if (area > bestArea) {
      bestArea = area;
      best = { hex, conf };
    }
  }
  return best && best.conf >= HEX_CONF_FLOOR ? best : null;
}

/**
 * DUAL-PATH PREPROCESSING ("best-of" selection). Both paths run on the same
 * grayscale field; the survivor with the higher confidence wins.
 *  - Path A (high-contrast / clean backgrounds): grayscale → bilateral
 *    filter → Otsu global binarization → Canny on the binary (the crisp
 *    region boundary), gap-linked by a 1-px dilation.
 *  - Path B (low-contrast / shadowed backgrounds, white-on-white): grayscale
 *    → heavy median blur → adaptive Gaussian threshold (block 15, C 2) →
 *    morphological closing with an elliptical kernel.
 */
function detectHexagonBestOf(
  f: EdgeField
): { hex: ScanHexagon; conf: number; cornersPx: HexPt[] } | null {
  const { w, h, luma8 } = f;
  const n = w * h;

  // Shared edge reference for confidence scoring (bilateral preserves edges).
  const bil = bilateralFilter(luma8, w, h, 3, 26);
  const edgeRef = cannyEdges(bil, w, h);

  // Path A.
  const tA = otsuThreshold(luma8);
  const binA = new Float32Array(n);
  for (let i = 0; i < n; i++) binA[i] = luma8[i] >= tA ? 255 : 0;
  const candA = hexagonFromMass(dilateMask(cannyEdges(binA, w, h), w, h, 1), w, h, edgeRef);

  // Path B.
  const med = medianBlur(luma8, w, h, Math.max(3, Math.round(Math.min(w, h) / 100)));
  const thrB = adaptiveThreshold(med, w, h, 15, 2);
  const closedB = morphClose(thrB, w, h, Math.max(2, Math.round(Math.min(w, h) / 160)));
  const candB = hexagonFromMass(closedB, w, h, edgeRef);

  let best = candA;
  if (candB && (!candA || candB.conf > candA.conf)) best = candB;
  if (!best) return null;
  const px = (p: HexPt) => ({ x: p.x * w, y: p.y * h });
  const norm = (p: HexPt) => ({ x: p.x / w, y: p.y / h });
  return {
    hex: {
      tl: norm(best.hex.tl),
      tc: norm(best.hex.tc),
      tr: norm(best.hex.tr),
      br: norm(best.hex.br),
      bc: norm(best.hex.bc),
      bl: norm(best.hex.bl),
    },
    conf: best.conf,
    cornersPx: [px(best.hex.tl), px(best.hex.tr), px(best.hex.br), px(best.hex.bl)],
  };
}

/**
 * Cognitive fallback tier: the previous multi-detector pipeline (Hough line
 * pairs, bright/dark segmentation, edge density, polarity-aware scoring,
 * blurred-field boundary sweep + anti-clip snap), kept intact for frames the
 * contour engine declines.
 */
function legacyDetectQuad(field: EdgeField, pol: 1 | -1): ScanQuad | null {
  const candidates: ScanQuad[] = [];
  const hough = detectQuadByHough(field, pol);
  if (hough) candidates.push(hough);
  const segmented = detectQuadBySegmentation(field);
  if (segmented) candidates.push(segmented);
  const dark = detectQuadByDarkSegmentation(field);
  if (dark) candidates.push(dark);
  const dense = detectQuadByDensity(field);
  if (dense) candidates.push(dense);
  if (candidates.length === 0) return null;
  let best = candidates[0];
  let bestScore = scoreQuad(quadToPixelsField(best, field), field, pol);
  for (let i = 1; i < candidates.length; i++) {
    const s = scoreQuad(quadToPixelsField(candidates[i], field), field, pol);
    if (s > bestScore) {
      bestScore = s;
      best = candidates[i];
    }
  }
  if (bestScore < 0.15) return null;
  let corners = tightenQuad(quadToPixelsField(best, field), field, pol);
  corners = snapQuadToContent(corners, field);
  const quad: ScanQuad = {
    tl: { x: corners[0].x / field.w, y: corners[0].y / field.h },
    tr: { x: corners[1].x / field.w, y: corners[1].y / field.h },
    br: { x: corners[2].x / field.w, y: corners[2].y / field.h },
    bl: { x: corners[3].x / field.w, y: corners[3].y / field.h },
  };
  return isSaneQuad(quad) ? quad : null;
}

/**
 * Smart Margin Fallback: when every detector declines the frame, the outline
 * becomes a perfectly centered six-point box inset 10% from each edge
 * (TL 0.1/0.1 · TC 0.5/0.1 · TR 0.9/0.1 · BR 0.9/0.9 · BC 0.5/0.9 · BL
 * 0.1/0.9) — a sane starting point for manual tweaking. Represented by its
 * four corner vertices in ScanQuad form.
 */
function marginQuadFallback(): ScanQuad {
  const m = 0.1;
  return {
    tl: { x: m, y: m },
    tr: { x: 1 - m, y: m },
    br: { x: 1 - m, y: 1 - m },
    bl: { x: m, y: 1 - m },
  };
}

/**
 * Robust automatic document-edge detection, orchestrated as a fallback
 * chain: (1) the six-point dual-path contour engine above; (2) the legacy
 * multi-detector pipeline; (3) the Smart Margin Fallback. The hexagon's
 * corner vertices are refined by the blurred-field boundary sweep and
 * anti-clip snap and returned in the standard four-corner ScanQuad contract,
 * so every consumer (crop editor, rotation remap, export) is untouched.
 */
export function detectDocumentQuad(img: HTMLImageElement): ScanQuad | null {
  const field = prepEdgeField(img);
  if (field) {
    const pol = documentPolarity(field);
    const best = detectHexagonBestOf(field);
    if (best) {
      let corners = tightenQuad(best.cornersPx, field, pol);
      corners = snapQuadToContent(corners, field);
      const quad: ScanQuad = {
        tl: { x: corners[0].x / field.w, y: corners[0].y / field.h },
        tr: { x: corners[1].x / field.w, y: corners[1].y / field.h },
        br: { x: corners[2].x / field.w, y: corners[2].y / field.h },
        bl: { x: corners[3].x / field.w, y: corners[3].y / field.h },
      };
      if (isSaneQuad(quad)) return quad;
    }
    const legacy = legacyDetectQuad(field, pol);
    if (legacy) return legacy;
  }
  return marginQuadFallback();
}

/** Shared detection data at working resolution. */
interface EdgeField {
  w: number;
  h: number;
  /**
   * RAW luma (NOT background-normalized). Detection MUST work on raw
   * luminance: normalizing divides each region by its own blurred
   * background, which brightens a dark carpet/table until it looks like
   * paper — erasing exactly the luminance contrast that separates document
   * from background. Real paper↔background steps live in the raw image.
   */
  luma8: Uint8Array;
  /**
   * Heavily blurred luma (double box blur, radius ≈ short side / 18) — the
   * BOUNDARY MEASUREMENT field. Blur wipes out text, print and carpet
   * texture (the interior detail that fakes "edges" and drags crops onto
   * text lines) while large-region luminance steps — page vs desk, card vs
   * table — survive as smooth ramps. Tightening, polarity and boundary
   * contrast all read THIS field; only gradient support uses the sharp
   * Sobel data.
   */
  blur: Float32Array;
  mag: Float32Array; // Sobel magnitude (on raw luma)
  gx: Float32Array;
  gy: Float32Array;
  /** Robust "strong gradient" reference (≈98th percentile, not the max). */
  magRef: number;
}

function prepEdgeField(img: HTMLImageElement): EdgeField | null {
  const W = img.naturalWidth || img.width;
  const H = img.naturalHeight || img.height;
  if (!W || !H) return null;
  const scale = Math.min(1, 400 / Math.max(W, H));
  const w = Math.max(64, Math.round(W * scale));
  const h = Math.max(64, Math.round(H * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;

  const n = w * h;
  const luma = new Float32Array(n);
  const luma8 = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const L = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    luma[i] = L;
    luma8[i] = L;
  }

  // Sobel on RAW luma — the paper↔background luminance step is the strongest,
  // most informative edge in the image. (Background-normalized luma would
  // flatten that step away on dark backgrounds.)
  const mag = new Float32Array(n);
  const gx = new Float32Array(n);
  const gy = new Float32Array(n);
  let maxMag = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const sgx =
        -luma[i - w - 1] - 2 * luma[i - 1] - luma[i + w - 1] +
        luma[i - w + 1] + 2 * luma[i + 1] + luma[i + w + 1];
      const sgy =
        -luma[i - w - 1] - 2 * luma[i - w] - luma[i - w + 1] +
        luma[i + w - 1] + 2 * luma[i + w] + luma[i + w + 1];
      const m = Math.abs(sgx) + Math.abs(sgy);
      mag[i] = m;
      gx[i] = sgx;
      gy[i] = sgy;
      if (m > maxMag) maxMag = m;
    }
  }
  if (maxMag < 10) return null;

  // ~98th-percentile magnitude: a robust "strong edge" reference that a
  // single noisy spike can't dominate (a raw max would break normalization).
  const bins = new Uint32Array(64);
  for (let i = 0; i < n; i++) bins[Math.min(63, ((mag[i] / maxMag) * 63) | 0)]++;
  let cum = 0;
  let cutBin = 63;
  for (let b = 63; b >= 0; b--) {
    cum += bins[b];
    if (cum >= n * 0.02) { cutBin = b; break; }
  }
  const magRef = Math.max((cutBin / 63) * maxMag, maxMag * 0.25);

  // Boundary-measurement field: heavy blur kills text and texture (the
  // interior detail that fakes edges) and keeps large-region luminance steps.
  const srcBlur = new Float32Array(n);
  for (let i = 0; i < n; i++) srcBlur[i] = luma8[i];
  const br = Math.max(5, Math.round(Math.min(w, h) / 18));
  let blur = boxBlurChannel(srcBlur, w, h, br);
  blur = boxBlurChannel(blur, w, h, Math.max(3, br >> 1));

  return { w, h, luma8, blur, mag, gx, gy, magRef };
}

function quadToPixelsField(q: ScanQuad, f: EdgeField): Array<{ x: number; y: number }> {
  const px = (p: { x: number; y: number }) => ({ x: p.x * f.w, y: p.y * f.h });
  return [px(q.tl), px(q.tr), px(q.br), px(q.bl)];
}

/** Shoelace area of a pixel-space quad. */
function quadAreaPx(c: Array<{ x: number; y: number }>): number {
  let area2 = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    area2 += c[i].x * c[j].y - c[j].x * c[i].y;
  }
  return Math.abs(area2) / 2;
}

/** Convexity, side length and area checks in pixel space. */
function validateCornersPx(c: Array<{ x: number; y: number }>, w: number, h: number): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = c[i];
    const b = c[(i + 1) % 4];
    const d = c[(i + 2) % 4];
    const cross = (b.x - a.x) * (d.y - b.y) - (b.y - a.y) * (d.x - b.x);
    const s = cross > 0 ? 1 : cross < 0 ? -1 : 0;
    if (s === 0) return false;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  let minSide = Infinity;
  for (let i = 0; i < 4; i++) {
    const a = c[i];
    const b = c[(i + 1) % 4];
    minSide = Math.min(minSide, Math.hypot(b.x - a.x, b.y - a.y));
  }
  if (minSide < Math.min(w, h) * 0.1) return false;
  const frac = quadAreaPx(c) / (w * h);
  return frac >= 0.08 && frac <= 1.02;
}

/**
 * Expected document polarity: is the document the BRIGHT thing in the frame
 * (+1) or the DARK thing (−1)? Judged by comparing the frame's border band
 * (background, almost always) with the central region on the blurred field.
 * Ambiguous cases — a page filling the whole frame, or a background matching
 * the document — default to the paper prior (+1). This expectation is what
 * keeps a band of dark TEXT on a scanned page from being scored as a "dark
 * document": its polarity contradicts the expectation, so it gets no
 * boundary-contrast credit and loses to the real (page-sized) candidate.
 */
function documentPolarity(f: EdgeField): 1 | -1 {
  const { w, h, blur } = f;
  const ring: number[] = [];
  const bw = Math.max(4, Math.round(w * 0.1));
  const bh = Math.max(4, Math.round(h * 0.1));
  for (let y = 0; y < h; y += 3) {
    for (let x = 0; x < w; x += 3) {
      if (x >= bw && x < w - bw && y >= bh && y < h - bh) continue;
      ring.push(blur[y * w + x]);
    }
  }
  const center: number[] = [];
  const cx0 = Math.round(w * 0.32);
  const cx1 = Math.round(w * 0.68);
  const cy0 = Math.round(h * 0.32);
  const cy1 = Math.round(h * 0.68);
  for (let y = cy0; y < cy1; y += 3) {
    for (let x = cx0; x < cx1; x += 3) center.push(blur[y * w + x]);
  }
  if (ring.length > 0 && center.length > 0) {
    const rm = medianOf(ring);
    const cm = medianOf(center);
    if (cm > rm + 4) return 1;
    if (rm > cm + 4) return -1;
  }
  return 1;
}

/**
 * Scores how well a candidate quad looks like THE document. Three signals:
 *  - Gradient support with polarity-correct direction: a true boundary has
 *    its Sobel gradients pointing consistently toward the bright side
 *    (inward for paper on a dark background, outward for a dark card on a
 *    bright table); text lines and clutter alternate directions and cancel.
 *  - Boundary contrast on the blurred field, in the EXPECTED polarity
 *    (`pol`): the inside must be the bright side for bright documents and
 *    the dark side for dark ones. A loose edge sitting on the background has
 *    inside ≈ outside (≈0 contrast), so tight boundaries win decisively —
 *    and text bands on scanned pages, whose polarity contradicts the
 *    expectation, get no credit at all.
 *  - An area prior: real documents fill a substantial part of the frame
 *    (photographed pages ≈ half or more, ID cards ≈ a sixth+), while false
 *    positives hug text lines and clutter at a few percent.
 */
function scoreQuad(c: Array<{ x: number; y: number }>, f: EdgeField, pol: 1 | -1): number {
  const { w, h, mag, gx, gy, magRef, blur } = f;
  const centroid = {
    x: (c[0].x + c[1].x + c[2].x + c[3].x) / 4,
    y: (c[0].y + c[1].y + c[2].y + c[3].y) / 4,
  };
  const supportThr = magRef * 0.35;
  let total = 0;
  let contrastSum = 0;
  let contrastSamples = 0;
  let samples = 0;
  for (let e = 0; e < 4; e++) {
    const p = c[e];
    const q = c[(e + 1) % 4];
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    if (len < 4) return 0;
    let nx = -(q.y - p.y) / len;
    let ny = (q.x - p.x) / len;
    const midX = (p.x + q.x) / 2;
    const midY = (p.y + q.y) / 2;
    // Orient the normal toward the quad interior.
    if (nx * (centroid.x - midX) + ny * (centroid.y - midY) < 0) {
      nx = -nx;
      ny = -ny;
    }
    const K = Math.max(8, Math.min(36, Math.round(len / 5)));
    for (let s = 0; s < K; s++) {
      const t = 0.06 + ((s + 0.5) / K) * 0.88;
      const x = p.x + (q.x - p.x) * t;
      const y = p.y + (q.y - p.y) * t;
      // Look ±2px across the edge for the strongest gradient.
      let bestM = 0;
      let bestGx = 0;
      let bestGy = 0;
      for (let o = -2; o <= 2; o++) {
        const sx = Math.round(x + nx * o);
        const sy = Math.round(y + ny * o);
        if (sx < 1 || sy < 1 || sx >= w - 1 || sy >= h - 1) continue;
        const i = sy * w + sx;
        if (mag[i] > bestM) {
          bestM = mag[i];
          bestGx = gx[i];
          bestGy = gy[i];
        }
      }
      if (bestM > supportThr) {
        // Alignment = gradient pointing toward the BRIGHT side (inward for
        // pol +1, outward for pol −1). Fragmented glyph rows and clutter
        // point every which way and score poorly.
        const align = Math.max(0, (pol * (bestGx * nx + bestGy * ny)) / bestM);
        total += Math.min(1, bestM / magRef) * (0.35 + 0.65 * align);
      }
      // Boundary contrast on the blurred field (text texture is gone there,
      // so only the true document���background step remains). The sampler
      // clamps at the frame borders, so no bounds test is needed.
      contrastSum +=
        pol *
        (sampleFieldBilinear(blur, w, h, x + nx * 4, y + ny * 4) -
          sampleFieldBilinear(blur, w, h, x - nx * 4, y - ny * 4));
      contrastSamples++;
      samples++;
    }
  }
  if (samples === 0) return 0;
  const edgeSupport = total / samples;
  const contrast = contrastSamples > 0 ? contrastSum / contrastSamples : 0;
  const contrastNorm = Math.max(0, Math.min(1, contrast / 80));
  const frac = quadAreaPx(c) / (w * h);
  let areaFactor: number;
  if (frac >= 0.55) areaFactor = 1;
  else if (frac >= 0.35) areaFactor = 0.85 + (0.15 * (frac - 0.35)) / 0.2;
  else if (frac >= 0.12) areaFactor = 0.45 + (0.4 * (frac - 0.12)) / 0.23;
  else areaFactor = 0;
  return (0.5 * edgeSupport + 0.5 * contrastNorm) * areaFactor;
}

/** A line in point-direction form. */
interface GeoLine {
  px: number;
  py: number;
  dx: number;
  dy: number;
}

/** A Hough accumulator peak: normal (cosT, sinT), signed distance ρ, vote weight. */
interface HoughLine {
  cosT: number;
  sinT: number;
  rho: number;
  weight: number;
}

/** Converts a Hough line (normal angle θ, signed distance ρ) to point-direction form. */
function houghToGeo(cosT: number, sinT: number, rho: number): GeoLine {
  return { px: cosT * rho, py: sinT * rho, dx: -sinT, dy: cosT };
}

/** Intersects two point-direction lines. */
function intersectLines(a: GeoLine, b: GeoLine): { x: number; y: number } | null {
  const cross = a.dx * b.dy - a.dy * b.dx;
  if (Math.abs(cross) < 1e-9) return null;
  const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / cross;
  return { x: a.px + a.dx * t, y: a.py + a.dy * t };
}

/**
 * Refines a boundary line by weighted total-least-squares over the strong
 * edge pixels near it (two iterations with a shrinking band). Returns null
 * when too few supporting pixels are found.
 */
function refineGeoLine(
  line: GeoLine,
  pts: Float32Array, // x, y interleaved
  wts: Float32Array,
  band: number
): GeoLine | null {
  let current = line;
  for (let iter = 0; iter < 2; iter++) {
    let sw = 0;
    let sx = 0;
    let sy = 0;
    const members: number[] = [];
    for (let i = 0; i < wts.length; i++) {
      const x = pts[2 * i];
      const y = pts[2 * i + 1];
      const dist = Math.abs((x - current.px) * current.dy - (y - current.py) * current.dx);
      if (dist <= band) {
        members.push(i);
        sw += wts[i];
        sx += wts[i] * x;
        sy += wts[i] * y;
      }
    }
    if (members.length < 12) return null;
    const cx = sx / sw;
    const cy = sy / sw;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (const i of members) {
      const x = pts[2 * i] - cx;
      const y = pts[2 * i + 1] - cy;
      const w = wts[i];
      sxx += w * x * x;
      sxy += w * x * y;
      syy += w * y * y;
    }
    // Principal direction of the weighted scatter = line direction.
    const phi = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    let dx = Math.cos(phi);
    let dy = Math.sin(phi);
    if (dx * current.dx + dy * current.dy < 0) {
      dx = -dx;
      dy = -dy;
    }
    current = { px: cx, py: cy, dx, dy };
    band = Math.max(1.5, band / 2);
  }
  return current;
}

function detectQuadByHough(f: EdgeField, pol: 1 | -1): ScanQuad | null {
  const { w, h, mag, magRef } = f;
  const edgeThr = magRef * 0.35;
  const exs: number[] = [];
  const eys: number[] = [];
  const ews: number[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const m = mag[y * w + x];
      if (m >= edgeThr) {
        exs.push(x);
        eys.push(y);
        ews.push(m);
      }
    }
  }
  if (exs.length < 60) return null;

  // Weighted Hough vote: θ ∈ [0, π), ρ ∈ [−diag, diag], 1-px bins.
  const nT = 180;
  const diag = Math.ceil(Math.hypot(w, h));
  const nR = 2 * diag + 1;
  const cosT = new Float32Array(nT);
  const sinT = new Float32Array(nT);
  for (let t = 0; t < nT; t++) {
    const th = (t / nT) * Math.PI;
    cosT[t] = Math.cos(th);
    sinT[t] = Math.sin(th);
  }
  const acc = new Float32Array(nT * nR);
  for (let i = 0; i < exs.length; i++) {
    const x = exs[i];
    const y = eys[i];
    const wgt = ews[i];
    for (let t = 0; t < nT; t++) {
      const rIdx = Math.round(x * cosT[t] + y * sinT[t]) + diag;
      acc[t * nR + rIdx] += wgt;
    }
  }

  // Peak extraction with non-maximum suppression.
  const taken = new Uint8Array(nT * nR);
  const lines: HoughLine[] = [];
  let topWeight = 0;
  for (let k = 0; k < 36; k++) {
    let bi = -1;
    let bw = 0;
    for (let i = 0; i < acc.length; i++) {
      if (!taken[i] && acc[i] > bw) {
        bw = acc[i];
        bi = i;
      }
    }
    if (bi < 0 || bw <= 0) break;
    if (k === 0) topWeight = bw;
    if (bw < topWeight * 0.12) break;
    const tI = (bi / nR) | 0;
    const rI = (bi % nR) - diag;
    lines.push({ cosT: cosT[tI], sinT: sinT[tI], rho: rI, weight: bw });
    const rC = bi % nR;
    for (let dt = -5; dt <= 5; dt++) {
      const tt = tI + dt;
      if (tt < 0 || tt >= nT) continue;
      for (let dr = -9; dr <= 9; dr++) {
        const rr = rC + dr;
        if (rr < 0 || rr >= nR) continue;
        taken[tt * nR + rr] = 1;
      }
    }
  }
  if (lines.length < 2) return null;

  // Cluster by orientation: vertical lines have normals near the x-axis.
  const verticals: HoughLine[] = [];
  const horizontals: HoughLine[] = [];
  for (const l of lines) {
    if (l.cosT * l.cosT > 0.5) verticals.push(l);
    else horizontals.push(l);
  }
  if (verticals.length < 1 || horizontals.length < 1) return null;

  // Candidate boundary lines per cluster: the strongest Hough lines plus the
  // frame borders (a page cut off by the photo edge must crop at the border).
  const axisPos = (g: GeoLine, along: number, axis: 'x' | 'y'): number => {
    if (axis === 'x') {
      return Math.abs(g.dy) > 0.2 ? g.px + (g.dx * (along - g.py)) / g.dy : g.px;
    }
    return Math.abs(g.dx) > 0.2 ? g.py + (g.dy * (along - g.px)) / g.dx : g.py;
  };
  const buildCandidates = (arr: HoughLine[], axis: 'x' | 'y'): GeoLine[] => {
    const geos = [...arr]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 5)
      .map((l) => houghToGeo(l.cosT, l.sinT, l.rho));
    if (axis === 'x') {
      geos.push({ px: 0.5, py: 0.5, dx: 0, dy: 1 }); // left border
      geos.push({ px: w - 0.5, py: 0.5, dx: 0, dy: 1 }); // right border
    } else {
      geos.push({ px: 0.5, py: 0.5, dx: 1, dy: 0 }); // top border
      geos.push({ px: 0.5, py: h - 0.5, dx: 1, dy: 0 }); // bottom border
    }
    const pos = (g: GeoLine) => axisPos(g, axis === 'x' ? h / 2 : w / 2, axis);
    return geos.sort((a, b) => pos(a) - pos(b));
  };
  const candV = buildCandidates(verticals, 'x');
  const candH = buildCandidates(horizontals, 'y');

  // Enumerate every (left,right) × (top,bottom) pair combination and let the
  // edge-support scoring pick the winner — instead of guessing that the
  // outermost peaks are the page (which text lines and clutter defeat).
  let bestC: Array<{ x: number; y: number }> | null = null;
  let bestScore = 0;
  let bestLines: { v0: GeoLine; v1: GeoLine; h0: GeoLine; h1: GeoLine } | null = null;
  for (let i = 0; i < candV.length - 1; i++) {
    for (let j = i + 1; j < candV.length; j++) {
      if (axisPos(candV[j], h / 2, 'x') - axisPos(candV[i], h / 2, 'x') < w * 0.35) continue;
      for (let a = 0; a < candH.length - 1; a++) {
        for (let b = a + 1; b < candH.length; b++) {
          if (axisPos(candH[b], w / 2, 'y') - axisPos(candH[a], w / 2, 'y') < h * 0.35) continue;
          const cTL = intersectLines(candH[a], candV[i]);
          const cTR = intersectLines(candH[a], candV[j]);
          const cBR = intersectLines(candH[b], candV[j]);
          const cBL = intersectLines(candH[b], candV[i]);
          if (!cTL || !cTR || !cBR || !cBL) continue;
          const corners = [cTL, cTR, cBR, cBL];
          if (!validateCornersPx(corners, w, h)) continue;
          const s = scoreQuad(corners, f, pol);
          if (s > bestScore) {
            bestScore = s;
            bestC = corners;
            bestLines = { v0: candV[i], v1: candV[j], h0: candH[a], h1: candH[b] };
          }
        }
      }
    }
  }
  if (!bestC || !bestLines) return null;

  // Refine the winning boundary lines with total-least-squares over the raw
  // edge pixels; keep the refinement only if it scores better.
  const pts = new Float32Array(exs.length * 2);
  const wts = new Float32Array(exs.length);
  for (let i = 0; i < exs.length; i++) {
    pts[2 * i] = exs[i];
    pts[2 * i + 1] = eys[i];
    wts[i] = ews[i];
  }
  const refined = {
    v0: refineGeoLine(bestLines.v0, pts, wts, 5) ?? bestLines.v0,
    v1: refineGeoLine(bestLines.v1, pts, wts, 5) ?? bestLines.v1,
    h0: refineGeoLine(bestLines.h0, pts, wts, 5) ?? bestLines.h0,
    h1: refineGeoLine(bestLines.h1, pts, wts, 5) ?? bestLines.h1,
  };
  const rTL = intersectLines(refined.h0, refined.v0);
  const rTR = intersectLines(refined.h0, refined.v1);
  const rBR = intersectLines(refined.h1, refined.v1);
  const rBL = intersectLines(refined.h1, refined.v0);
  if (rTL && rTR && rBR && rBL) {
    const corners = [rTL, rTR, rBR, rBL];
    if (validateCornersPx(corners, w, h)) {
      const s = scoreQuad(corners, f, pol);
      if (s >= bestScore) {
        bestScore = s;
        bestC = corners;
      }
    }
  }
  if (!bestC || bestScore < 0.15) return null;

  const quad: ScanQuad = {
    tl: { x: bestC[0].x / w, y: bestC[0].y / h },
    tr: { x: bestC[1].x / w, y: bestC[1].y / h },
    br: { x: bestC[2].x / w, y: bestC[2].y / h },
    bl: { x: bestC[3].x / w, y: bestC[3].y / h },
  };
  return isSaneQuad(quad) ? quad : null;
}

/** Bilinear sample of a Float32 field, clamped at the frame borders. */
function sampleFieldBilinear(
  field: Float32Array,
  w: number,
  h: number,
  x: number,
  y: number
): number {
  const cx = x < 0 ? 0 : x > w - 1 ? w - 1 : x;
  const cy = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
  const x0 = cx | 0;
  const y0 = cy | 0;
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const tx = cx - x0;
  const ty = cy - y0;
  const a = field[y0 * w + x0];
  const b = field[y0 * w + x1];
  const c = field[y1 * w + x0];
  const e = field[y1 * w + x1];
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + e) * tx * ty;
}

function medianOf(vals: number[]): number {
  if (vals.length === 0) return 0;
  const s = [...vals].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/**
 * Sweeps the blurred field along one perpendicular ray and returns the
 * position where two equal strips on either side are MOST separated in the
 * expected polarity — the boundary of a large uniform region. Text and
 * carpet texture are blurred away in this field, so interior detail cannot
 * compete; and because the measurement compares strip MEANS rather than
 * absolute levels, the answer is independent of how bright the document or
 * the background happens to be. Returns the signed offset (positive = the
 * boundary lies further INside) and its strength, or null when the profile
 * is flat or no correctly-polarized step exists within the window.
 */
function rayBoundarySweep(
  f: EdgeField,
  bx: number,
  by: number,
  nx: number,
  ny: number, // inward unit normal
  win: number,
  strip: number,
  pol: 1 | -1,
  prof: Float32Array,
  sm: Float32Array
): { offset: number; strength: number } | null {
  const S = 2 * Math.round(win) + 1;
  const half = (S - 1) / 2;
  for (let k = 0; k < S; k++) {
    prof[k] = sampleFieldBilinear(f.blur, f.w, f.h, bx + nx * (k - half), by + ny * (k - half));
  }
  for (let k = 0; k < S; k++) {
    const a = prof[Math.max(0, k - 1)];
    const b = prof[k];
    const c = prof[Math.min(S - 1, k + 1)];
    sm[k] = (a + 2 * b + c) / 4;
  }
  let lo = 255;
  let hi = 0;
  for (let k = 0; k < S; k++) {
    if (sm[k] < lo) lo = sm[k];
    if (sm[k] > hi) hi = sm[k];
  }
  const range = hi - lo;
  if (range < 12) return null; // flat profile — no boundary within reach
  // Strip means via prefix sums: for each candidate boundary k, outside
  // strip = samples [k−2w, k), inside strip = [k, k+2w). The separation
  // peaks exactly where the luminance ramp is steepest.
  const w = Math.max(2, Math.min(10, Math.round(strip)));
  const pre = new Float64Array(S + 1);
  for (let k = 0; k < S; k++) pre[k + 1] = pre[k] + sm[k];
  const sepAt = (k: number) => {
    const outAvg = (pre[k] - pre[k - 2 * w]) / (2 * w);
    const inAvg = (pre[k + 2 * w] - pre[k]) / (2 * w);
    return pol * (inAvg - outAvg);
  };
  let bestK = -1;
  let bestSep = 0;
  for (let k = 2 * w; k <= S - 1 - 2 * w; k++) {
    const sep = sepAt(k);
    if (sep > bestSep) {
      bestSep = sep;
      bestK = k;
    }
  }
  if (bestK < 0 || bestSep < range * 0.3) return null; // ambiguous or wrong polarity
  // Sub-pixel parabola through the neighboring separations.
  let delta = 0;
  if (bestK > 2 * w && bestK < S - 1 - 2 * w) {
    const s0 = sepAt(bestK - 1);
    const s2 = sepAt(bestK + 1);
    const denom = s0 - 2 * bestSep + s2;
    if (denom < -1e-6) delta = Math.max(-1, Math.min(1, (0.5 * (s0 - s2)) / denom));
  }
  return { offset: bestK + delta - half, strength: bestSep };
}

/**
 * Weighted least-squares fit d(t) = a + b·t over the ray hits of one edge.
 * When `seed` is given, hits whose residual exceeds 2.5× the median absolute
 * deviation are dropped (one robust pass), so a spine shadow or a bright
 * carpet tuft can't tilt the fit.
 */
function fitLineOffset(
  ts: number[],
  offs: number[],
  wts: number[],
  seed?: { a: number; b: number }
): { a: number; b: number } | null {
  if (ts.length < 3) return null;
  let use: number[] = [];
  for (let i = 0; i < ts.length; i++) use.push(i);
  if (seed) {
    const res = ts.map((t, i) => Math.abs(offs[i] - (seed.a + seed.b * t)));
    const limit = medianOf(res) * 2.5 + 0.75;
    use = use.filter((i) => res[i] <= limit);
    if (use.length < Math.max(3, ts.length >> 1)) return null; // too scattered
  }
  let sw = 0;
  let st = 0;
  let sd = 0;
  let stt = 0;
  let std = 0;
  for (const i of use) {
    const w = wts[i];
    sw += w;
    st += w * ts[i];
    sd += w * offs[i];
    stt += w * ts[i] * ts[i];
    std += w * ts[i] * offs[i];
  }
  const det = sw * stt - st * st;
  if (Math.abs(det) < 1e-9) return { a: sd / Math.max(sw, 1e-9), b: 0 };
  const b = (sw * std - st * sd) / det;
  return { a: (sd - b * st) / sw, b };
}

/**
 * Boundary tightening on the blurred field. The older approaches each failed
 * in a specific way: threshold walking misread textured carpets as "paper"
 * and pushed edges OUTWARD (a crop ending up outside the document), and
 * gradient-step rays on the sharp image latched onto text lines, whose
 * contrast rivals the page boundary's. Here per edge: cast perpendicular
 * rays, sweep each blurred profile and take the maximum two-strip separation
 * in the expected polarity (rayBoundarySweep — text simply does not exist in
 * this field); reject ambiguous rays; fit a per-edge LINEAR offset so each
 * corner moves by its own amount (tilted/perspective boundaries converge
 * too); run a second, narrower pass to polish. Edges with a confident lock
 * are finally biased a hair INSIDE the boundary: a background sliver in the
 * crop is far more visible than the symmetric page sliver it trades for.
 * Edges with too few ray hits (e.g. the page is cut off by the photo frame)
 * keep their position.
 */
function tightenQuad(
  c: Array<{ x: number; y: number }>,
  f: EdgeField,
  pol: 1 | -1
): Array<{ x: number; y: number }> {
  const corners = c.map((p) => ({ x: p.x, y: p.y }));
  const span = Math.min(f.w, f.h);
  const RAYS = 28;
  const hitCount = [0, 0, 0, 0];
  const maxWin = Math.max(8, Math.min(80, span * 0.15));
  const strip = Math.max(2, Math.round(span * 0.015));
  const prof = new Float32Array(2 * Math.round(maxWin) + 1);
  const sm = new Float32Array(2 * Math.round(maxWin) + 1);

  const inwardNormal = (e: number) => {
    const p = corners[e];
    const q = corners[(e + 1) % 4];
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    const nx = -(q.y - p.y) / len;
    const ny = (q.x - p.x) / len;
    const cx = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4;
    const cy = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4;
    if (nx * (cx - (p.x + q.x) / 2) + ny * (cy - (p.y + q.y) / 2) < 0) {
      return { nx: -nx, ny: -ny };
    }
    return { nx, ny };
  };

  for (let pass = 0; pass < 2; pass++) {
    const win = pass === 0 ? maxWin : Math.max(6, maxWin * 0.45);
    for (let e = 0; e < 4; e++) {
      const p = corners[e];
      const q = corners[(e + 1) % 4];
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      if (len < 8) continue;
      const { nx, ny } = inwardNormal(e);
      const ts: number[] = [];
      const offs: number[] = [];
      const wts: number[] = [];
      for (let s = 0; s < RAYS; s++) {
        const t = 0.06 + (s / (RAYS - 1)) * 0.88;
        const bx = p.x + (q.x - p.x) * t;
        const by = p.y + (q.y - p.y) * t;
        const hit = rayBoundarySweep(f, bx, by, nx, ny, win, strip, pol, prof, sm);
        if (hit) {
          ts.push(t);
          offs.push(hit.offset);
          wts.push(hit.strength);
        }
      }
      hitCount[e] = Math.max(hitCount[e], offs.length);
      if (offs.length < 5) continue; // no consensus — leave this edge alone
      let fit = fitLineOffset(ts, offs, wts);
      if (fit) fit = fitLineOffset(ts, offs, wts, fit);
      if (!fit) continue;
      let move0 = Math.max(-win, Math.min(win, fit.a));
      let move1 = Math.max(-win, Math.min(win, fit.a + fit.b));
      if (Math.abs(move1 - move0) > len * 0.5) {
        // Degenerate tilt — the fit latched onto clutter; collapse to the median.
        const med = Math.max(-win, Math.min(win, medianOf(offs)));
        move0 = med;
        move1 = med;
      }
      const cand = corners.map((pt, i) =>
        i === e || i === (e + 1) % 4
          ? {
              x: pt.x + nx * (i === e ? move0 : move1),
              y: pt.y + ny * (i === e ? move0 : move1),
            }
          : pt
      );
      if (validateCornersPx(cand, f.w, f.h)) {
        corners[e] = cand[e];
        corners[(e + 1) % 4] = cand[(e + 1) % 4];
      }
    }
  }

  // Hair-inside bias — only edges the localization actually locked onto earn
  // it; uncertain edges (page cut by the frame, low-contrast boundary) stay.
  const inset = Math.max(2, Math.min(4, span * 0.005));
  for (let e = 0; e < 4; e++) {
    if (hitCount[e] < 5) continue;
    const p = corners[e];
    const q = corners[(e + 1) % 4];
    if (Math.hypot(q.x - p.x, q.y - p.y) < 8) continue;
    const { nx, ny } = inwardNormal(e);
    const cand = corners.map((pt, i) =>
      i === e || i === (e + 1) % 4 ? { x: pt.x + nx * inset, y: pt.y + ny * inset } : pt
    );
    if (validateCornersPx(cand, f.w, f.h)) {
      corners[e] = cand[e];
      corners[(e + 1) % 4] = cand[(e + 1) % 4];
    }
  }
  return corners;
}

/**
 * Content-aware anti-clipping snap. The boundary detectors pick the document
 * outline, but an imperfect edge can slice through print. This nudges each
 * edge outward just enough that no "ink" pixel is clipped — ink meaning
 * dark-on-locally-bright (text, ruled lines, card print, photo detail). The
 * local-surround test is what keeps dark TABLES/backdrops from counting as
 * ink: a desk pixel is dark, but its neighborhood is dark too, so it fails.
 * The push per edge is bounded, so a stray mark can't inflate the crop.
 */
function snapQuadToContent(
  c: Array<{ x: number; y: number }>,
  f: EdgeField
): Array<{ x: number; y: number }> {
  const { w, h, luma8 } = f;
  const n = w * h;
  const minDim = Math.min(w, h);

  const otsu = otsuThreshold(luma8);
  const inkThr = Math.max(30, otsu * 0.75);
  const nf = new Float32Array(n);
  for (let i = 0; i < n; i++) nf[i] = luma8[i];
  const localMean = boxBlurChannel(nf, w, h, Math.max(4, Math.round(minDim / 20)));

  // Ink mask, dilated by ~2% of the short side for anti-aliasing tolerance.
  const ink = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (luma8[i] < inkThr && luma8[i] < localMean[i] - 18) ink[i] = 1;
  }
  const r = Math.max(2, Math.round(minDim * 0.02));
  const dil = boxBlurChannel(ink, w, h, r);
  const dilThr = 0.8 / ((2 * r + 1) * (2 * r + 1));

  // Per-edge inward normals and anchors (line geometry from the quad edges).
  const centroid = {
    x: (c[0].x + c[1].x + c[2].x + c[3].x) / 4,
    y: (c[0].y + c[1].y + c[2].y + c[3].y) / 4,
  };
  const ax = new Array<number>(4);
  const ay = new Array<number>(4);
  const nx = new Array<number>(4);
  const ny = new Array<number>(4);
  for (let e = 0; e < 4; e++) {
    const p = c[e];
    const q = c[(e + 1) % 4];
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    if (len < 4) return c;
    let ex = -(q.y - p.y) / len;
    let ey = (q.x - p.x) / len;
    const midX = (p.x + q.x) / 2;
    const midY = (p.y + q.y) / 2;
    if (ex * (centroid.x - midX) + ey * (centroid.y - midY) < 0) {
      ex = -ex;
      ey = -ey;
    }
    ax[e] = p.x;
    ay[e] = p.y;
    nx[e] = ex;
    ny[e] = ey;
  }

  // One pass: furthest dilated-ink pixel beyond each edge (outward distance),
  // bounded tightly (5% of the short side) so distant dark background can
  // never re-inflate a freshly tightened crop.
  const cap = minDim * 0.05;
  const maxOut = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    if (dil[i] < dilThr) continue;
    const x = i % w;
    const y = (i / w) | 0;
    for (let e = 0; e < 4; e++) {
      const out = (ax[e] - x) * nx[e] + (ay[e] - y) * ny[e];
      if (out > maxOut[e] && out <= cap) maxOut[e] = out;
    }
  }

  // Push each edge anchor outward by its measured overshoot (+1px pad).
  const lines: GeoLine[] = [];
  for (let e = 0; e < 4; e++) {
    const push = maxOut[e] > 0.5 ? Math.min(cap, maxOut[e] + 1) : 0;
    lines.push({ px: ax[e] - nx[e] * push, py: ay[e] - ny[e] * push, dx: -ny[e], dy: nx[e] });
  }

  // New corners from the adjusted lines (TL, TR, BR, BL).
  const r0 = intersectLines(lines[3], lines[0]);
  const r1 = intersectLines(lines[0], lines[1]);
  const r2 = intersectLines(lines[1], lines[2]);
  const r3 = intersectLines(lines[2], lines[3]);
  if (!r0 || !r1 || !r2 || !r3) return c;
  const out = [r0, r1, r2, r3];
  if (!validateCornersPx(out, w, h)) return c;
  return out;
}

/**
 * Shared connected-component outline: labels 4-connected regions of a binary
 * mask, takes the largest, and returns its diagonal-extreme quad. Used by the
 * bright-paper segmentation and the edge-density detectors.
 */
function largestComponentQuad(
  mask: Uint8Array, // binary 0/1
  w: number,
  h: number,
  minFrac: number,
  maxFrac: number
): ScanQuad | null {
  const n = w * h;
  const labels = new Int32Array(n); // 0 = unvisited
  const stack = new Int32Array(n);
  let bestId = 0;
  let bestSize = 0;
  let id = 0;
  for (let start = 0; start < n; start++) {
    if (mask[start] === 0 || labels[start] !== 0) continue;
    id++;
    let size = 0;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = id;
    while (sp > 0) {
      const i = stack[--sp];
      size++;
      const x = i % w;
      const y = (i / w) | 0;
      if (x > 0 && mask[i - 1] !== 0 && labels[i - 1] === 0) {
        labels[i - 1] = id;
        stack[sp++] = i - 1;
      }
      if (x < w - 1 && mask[i + 1] !== 0 && labels[i + 1] === 0) {
        labels[i + 1] = id;
        stack[sp++] = i + 1;
      }
      if (y > 0 && mask[i - w] !== 0 && labels[i - w] === 0) {
        labels[i - w] = id;
        stack[sp++] = i - w;
      }
      if (y < h - 1 && mask[i + w] !== 0 && labels[i + w] === 0) {
        labels[i + w] = id;
        stack[sp++] = i + w;
      }
    }
    if (size > bestSize) {
      bestSize = size;
      bestId = id;
    }
  }
  const frac = bestSize / n;
  if (bestId === 0 || frac < minFrac || frac > maxFrac) return null;

  // Outline corners: extreme component pixels along the two diagonals.
  let tl = { x: 0, y: 0 };
  let tr = { x: 0, y: 0 };
  let br = { x: 0, y: 0 };
  let bl = { x: 0, y: 0 };
  let vTL = Infinity;
  let vBR = -Infinity;
  let vTR = -Infinity;
  let vBL = Infinity;
  let found = false;
  for (let i = 0; i < n; i++) {
    if (labels[i] !== bestId) continue;
    found = true;
    const x = i % w;
    const y = (i / w) | 0;
    const s = x + y;
    const d = x - y;
    if (s < vTL) { vTL = s; tl = { x, y }; }
    if (s > vBR) { vBR = s; br = { x, y }; }
    if (d > vTR) { vTR = d; tr = { x, y }; }
    if (d < vBL) { vBL = d; bl = { x, y }; }
  }
  if (!found) return null;
  const quad: ScanQuad = {
    tl: { x: tl.x / w, y: tl.y / h },
    tr: { x: tr.x / w, y: tr.y / h },
    br: { x: br.x / w, y: br.y / h },
    bl: { x: bl.x / w, y: bl.y / h },
  };
  return isSaneQuad(quad) ? quad : null;
}

/**
 * Segmentation detector (bright): on raw luminance, bright paper is the
 * large connected region — works for pages on dark/colored backgrounds.
 */
function detectQuadBySegmentation(f: EdgeField): ScanQuad | null {
  const { w, h, luma8 } = f;
  const t = otsuThreshold(luma8);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = luma8[i] >= t ? 1 : 0;
  return largestComponentQuad(mask, w, h, 0.12, 0.97);
}

/**
 * Segmentation detector (dark): the mirror case — dark documents (ID cards,
 * dark covers) are the large connected DARK region on a bright background.
 */
function detectQuadByDarkSegmentation(f: EdgeField): ScanQuad | null {
  const { w, h, luma8 } = f;
  const t = otsuThreshold(luma8);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = luma8[i] <= t ? 1 : 0;
  return largestComponentQuad(mask, w, h, 0.06, 0.9);
}

/**
 * Edge-density detector: ANY document — ID cards, dark cards, receipts — has
 * a textured interior and/or a strong boundary, while flat background has
 * almost no gradient energy. Blurring the gradient magnitude produces a
 * density field whose high region IS the document, independent of whether the
 * document is brighter or darker than its background. This is what makes
 * detection work for cards and non-paper documents.
 */
function detectQuadByDensity(f: EdgeField): ScanQuad | null {
  const { w, h, mag } = f;
  const n = w * h;
  const r = Math.max(6, Math.round(Math.min(w, h) / 24));
  let density = boxBlurChannel(mag, w, h, r);
  density = boxBlurChannel(density, w, h, r);
  let maxD = 0;
  for (let i = 0; i < n; i++) if (density[i] > maxD) maxD = density[i];
  if (maxD < 8) return null;
  const scale = 255 / maxD;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = density[i] * scale;
    mask[i] = v >= 1 ? Math.min(255, Math.round(v)) : 0;
  }
  return largestComponentQuad(mask, w, h, 0.1, 0.97);
}

/** Rejects degenerate auto-detections (thin slivers, non-convex outlines). */
export function isSaneQuad(quad: ScanQuad): boolean {
  const p = [quad.tl, quad.tr, quad.br, quad.bl];
  // Convexity: cross product of successive edges must keep the same sign.
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = p[i];
    const b = p[(i + 1) % 4];
    const c = p[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const s = cross > 0 ? 1 : cross < 0 ? -1 : 0;
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
  return Math.min(...sides) >= 0.15;
}

/* --------------------------------------------------------------------------
   Interactive edge snapping (CamScanner-style magnetic corner handles)
   -------------------------------------------------------------------------- */

export {
  createEdgeSnapEngine,
  type EdgeSnapEngine,
  type EdgeSnapResult,
  type QuadCorner,
} from './edgeDetector';

/* --------------------------------------------------------------------------
   Full render pipeline
   -------------------------------------------------------------------------- */

/**
 * Manual "clean up" eraser strokes (Adobe Scan–style): brushed marks are
 * filled with the nearest surrounding color. Applied AFTER the filters, so
 * the eraser works on exactly the image the user sees (WYSIWYG) — see
 * lib/backgroundEraser.
 */
export type { ScanEraseStroke, ErasePoint } from './backgroundEraser';

export interface ScanRenderOptions {
  rotation?: 0 | 90 | 180 | 270;
  quad?: ScanQuad | null;
  /** Optional six-point outline (normalized like the quad) for bowed pages. */
  hex?: ScanHexagon | null;
  filter?: ScanFilterId;
  adj?: ScanAdjustments;
  /** Manual clean-up eraser strokes, normalized to the warped page. */
  eraserStrokes?: ScanEraseStroke[] | null;
}

/**
 * Full pipeline: load → rotate+warp AT TARGET RESOLUTION → enhance → erase
 * strokes. Quad coordinates are normalized, so warping a downscaled canvas
 * produces the same geometry at a fraction of the cost; only exports (maxEdge
 * 0) run geometry at full capture resolution. Strokes run after the filters
 * so erased areas are repaired on the final look, exactly as brushed.
 */
export async function renderScanCanvas(
  sourceUrl: string,
  opts: ScanRenderOptions = {},
  maxEdge = 0
): Promise<HTMLCanvasElement> {
  const img = await loadImageFromUrl(sourceUrl);
  const oriented = buildOrientedCanvas(img, opts.rotation ?? 0, maxEdge);
  const warped = opts.quad ? warpQuadToCanvas(oriented, opts.quad, opts.hex ?? null) : oriented;
  if (warped !== oriented) {
    oriented.width = 0;
    oriented.height = 0;
  }
  const ctx = warped.getContext('2d', { alpha: false, willReadFrequently: true });
  if (ctx) {
    enhanceImageData(ctx, warped.width, warped.height, opts.filter ?? 'original', opts.adj ?? NEUTRAL_ADJUSTMENTS);
  }
  if (opts.eraserStrokes && opts.eraserStrokes.length > 0) {
    // Keep the filtered/cropped image before clean-up so restore strokes can
    // selectively paint its pixels back over earlier eraser strokes.
    const original = document.createElement('canvas');
    original.width = warped.width;
    original.height = warped.height;
    original.getContext('2d', { alpha: false })?.drawImage(warped, 0, 0);
    applyEraseStrokes(warped, opts.eraserStrokes, original);
    original.width = 0;
    original.height = 0;
  }
  return warped;
}

/* --------------------------------------------------------------------------
   Pixel operations
   -------------------------------------------------------------------------- */

/** Standard multi-box sizes that approximate a Gaussian of `sigma` (3 passes). */
function boxesForGauss(sigma: number, boxes: number): number[] {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / boxes + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round(
    (12 * sigma * sigma - boxes * wl * wl - 4 * boxes * wl - 3 * boxes) / (-4 * wl - 4)
  );
  const sizes: number[] = [];
  for (let i = 0; i < boxes; i++) sizes.push(i < m ? wl : wu);
  return sizes;
}

/**
 * Gaussian blur of a single Float32 channel via three sliding-window box
 * passes — visually indistinguishable from a true Gaussian, and O(1) work per
 * pixel at ANY sigma. The illumination maps need sigma 40–100, where a real
 * kernel (or FFT) would be far too slow.
 */
function gaussBlurChannel(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma < 0.4) return Float32Array.from(src);
  let cur = src;
  for (const size of boxesForGauss(sigma, 3)) {
    cur = boxBlurChannel(cur, w, h, Math.max(1, (size - 1) >> 1));
  }
  return cur;
}

/**
 * O(n) sliding-window max/min along one axis of a w×h plane (monotonic
 * deque, clamped borders). Used by the morphological close so a
 * content-relative radius stays cheap even at full export resolution,
 * where the old brute-force O(n·r) version would have crawled.
 */
function slidingExtreme(
  src: Float32Array,
  dst: Float32Array,
  w: number,
  h: number,
  r: number,
  vertical: boolean,
  max: boolean
): void {
  const lines = vertical ? w : h;
  const len = vertical ? h : w;
  const stride = vertical ? w : 1;
  // Ring-buffer monotonic deque. Capacity must hold the centered window
  // (2r+1 entries) plus the transient entry pushed before the next eviction
  // (2r+2). The deque index WRAPS: a flat array would overflow after the
  // first 2r+2 pushes and silently corrupt the whole map.
  const cap = 2 * r + 2;
  const dq = new Int32Array(cap);
  for (let line = 0; line < lines; line++) {
    const base = vertical ? line : line * w;
    let head = 0;
    let tail = 0;
    let count = 0;
    for (let k = 0; k < len + r; k++) {
      if (k < len) {
        const v = src[base + k * stride];
        if (max) {
          while (
            count > 0 &&
            src[base + dq[tail === 0 ? cap - 1 : tail - 1] * stride] <= v
          ) {
            tail = tail === 0 ? cap - 1 : tail - 1;
            count--;
          }
        } else {
          while (
            count > 0 &&
            src[base + dq[tail === 0 ? cap - 1 : tail - 1] * stride] >= v
          ) {
            tail = tail === 0 ? cap - 1 : tail - 1;
            count--;
          }
        }
        dq[tail] = k;
        tail = tail + 1 === cap ? 0 : tail + 1;
        count++;
      }
      const p = k - r; // output position whose centered window is complete
      if (p < 0) continue;
      if (p >= len) break;
      const low = p - r;
      while (count > 0 && dq[head] < low) {
        head = head + 1 === cap ? 0 : head + 1;
        count--;
      }
      dst[base + p * stride] = src[base + dq[head] * stride];
    }
  }
}

/**
 * Morphological grey closing (dilate then erode) of a small Float32 plane,
 * separable — cheap at ¼ scale. Closing fills dark dips that are
 * narrower than the structuring element: ink strokes and text become flat at
 * the surrounding paper level, while the overall lighting gradient is a
 * "background" too broad to be affected. This is the classic illumination
 * estimator for shadow-free document processing.
 */
function greyCloseField(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  // Dilate (max), horizontal then vertical.
  slidingExtreme(src, tmp, w, h, r, false, true);
  slidingExtreme(tmp, out, w, h, r, true, true);
  // Erode (min), horizontal then vertical.
  slidingExtreme(out, tmp, w, h, r, false, false);
  slidingExtreme(tmp, out, w, h, r, true, false);
  return out;
}

/**
 * Illumination (background) map of a luminance plane: DS×DS blocks are
 * averaged, closed morphologically (dark ink/text dips are filled up to the
 * local paper level — the map tracks PAPER, not content), and Gaussian-blurred
 * with the sigma scaled to the reduced resolution; sampleIllumination
 * bilinearly upsamples it later. Block averaging also cuts noise variance
 * 16×, so the map has no max-of-noise bias, and everything runs 16× cheaper
 * than at full resolution.
 */
function illuminationMap(
  gray: Float32Array,
  w: number,
  h: number,
  sigma: number,
  DS = 4
): { sw: number; sh: number; map: Float32Array; inv: number } {
  const sw = Math.max(8, Math.floor(w / DS));
  const sh = Math.max(8, Math.floor(h / DS));
  const small = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    const y1 = Math.min(h, (y + 1) * DS);
    for (let x = 0; x < sw; x++) {
      const x1 = Math.min(w, (x + 1) * DS);
      let sum = 0;
      for (let yy = y * DS; yy < y1; yy++) {
        const row = yy * w;
        for (let xx = x * DS; xx < x1; xx++) sum += gray[row + xx];
      }
      small[y * sw + x] = sum / (DS * DS);
    }
  }
  // Pre-blur so the closing's max phase cannot lock onto noise peaks (which
  // would bias the whole map high and under-correct bright regions).
  const denoisedSmall = boxBlurChannel(small, sw, sh, 1);
  // Closing radius scales with the render size: it must bridge a full
  // text-line band (~3.5% of the frame) at ANY resolution. A fixed radius let
  // the map dip along text rows at export resolution, so whitening then
  // banded along those rows (horizontal streaks on Magic/Grayscale).
  const closeR = Math.max(3, Math.round(Math.min(w, h) / DS / 22));
  const closed = greyCloseField(denoisedSmall, sw, sh, closeR);
  // Content-aware normalized convolution: samples well below the closed level
  // are CONTENT (stamps, drawings, dense ink), not paper — they are excluded
  // from the average so nearby artwork cannot drag the map (and the
  // correction gain) around. Paper-only weighted mean, triangular-smoothed.
  const wmask = new Float32Array(sw * sh);
  for (let i = 0; i < wmask.length; i++) wmask[i] = denoisedSmall[i] > closed[i] - 24 ? 1 : 0;
  const rN = Math.max(2, Math.round(sigma / DS / 2));
  let wsum = boxBlurChannel(wmask, sw, sh, rN);
  const ym = new Float32Array(sw * sh);
  for (let i = 0; i < ym.length; i++) ym[i] = wmask[i] * denoisedSmall[i];
  let ysum = boxBlurChannel(ym, sw, sh, rN);
  wsum = boxBlurChannel(wsum, sw, sh, rN);
  ysum = boxBlurChannel(ysum, sw, sh, rN);
  const map = new Float32Array(sw * sh);
  for (let i = 0; i < map.length; i++) map[i] = wsum[i] > 0.15 ? ysum[i] / wsum[i] : closed[i];
  return { sw, sh, map, inv: 1 / DS };
}

/** Bilinear upsample of an illumination map, clamped at the frame borders. */
function sampleIllumination(
  m: { sw: number; sh: number; map: Float32Array },
  fx: number,
  fy: number
): number {
  const x0 = fx < 0 ? 0 : Math.min(m.sw - 1, Math.floor(fx));
  const y0 = fy < 0 ? 0 : Math.min(m.sh - 1, Math.floor(fy));
  const x1 = Math.min(m.sw - 1, x0 + 1);
  const y1 = Math.min(m.sh - 1, y0 + 1);
  const tx = Math.min(1, Math.max(0, fx - x0));
  const ty = Math.min(1, Math.max(0, fy - y0));
  const top = m.map[y0 * m.sw + x0] * (1 - tx) + m.map[y0 * m.sw + x1] * tx;
  const bot = m.map[y1 * m.sw + x0] * (1 - tx) + m.map[y1 * m.sw + x1] * tx;
  return top * (1 - ty) + bot * ty;
}

/** Rec.601 luma plane of an RGBA buffer. */
function lumaPlane(d: Uint8ClampedArray): Float32Array {
  const n = d.length >> 2;
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    y[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  }
  return y;
}

/**
 * Unsharp mask on a Float32 luminance plane: out = in + amount·(in − blur).
 * A noise floor keeps paper grain from being amplified along with real edges.
 */
function unsharpPlane(
  plane: Float32Array,
  w: number,
  h: number,
  amount: number,
  sigma = 1.5,
  noiseFloor = 3
): void {
  if (amount <= 0) return;
  const blur = gaussBlurChannel(plane, w, h, sigma);
  for (let i = 0; i < plane.length; i++) {
    let delta = plane[i] - blur[i];
    if (delta > noiseFloor) delta -= noiseFloor;
    else if (delta < -noiseFloor) delta += noiseFloor;
    else continue;
    const v = plane[i] + delta * amount;
    plane[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
}

/** Sliding-window separable box blur of a single channel. */
function boxBlurChannel(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + Math.max(0, Math.min(w - 1, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / (2 * r + 1);
      sum += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[Math.max(0, Math.min(h - 1, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / (2 * r + 1);
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/**
 * GRAYSCALE — "Continuous Monochrome Document Enhancer":
 * Converts capture to 8-bit continuous monochrome with background shadow
 * correction. Flat-field paper normalization levels shadows and uneven lighting
 * to pure white (#FFFFFF), while ink, pencil marks, and drawings are darkened
 * and contrast-enhanced. Smooth continuous gradients, pencil shading, and
 * fine details are preserved without jagged binary threshold artifacts.
 */
function applyGrayFilter(d: Uint8ClampedArray, w: number, h: number, userSharpen: number): void {
  const n = w * h;
  const Y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    Y[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  }

  // Pre-unsharp on luminance to bring out faint pencil strokes and fine text
  if (userSharpen > 0) {
    unsharpPlane(Y, w, h, userSharpen * 0.4);
  }

  const bg = illuminationMap(
    Y,
    w,
    h,
    Math.max(30, Math.min(80, Math.min(w, h) / 8))
  );

  const inv = bg.inv;
  const clampByte = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

  for (let y = 0; y < h; y++) {
    const fy = (y + 0.5) * inv - 0.5;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const i4 = i * 4;
      const m = Math.max(24, sampleIllumination(bg, (x + 0.5) * inv - 0.5, fy));
      const rho = Y[i] / m;

      let yOut: number;
      if (rho >= 0.91) {
        // Paper background: smooth ramp to pristine white
        const u = Math.min(1, (rho - 0.91) / 0.09);
        yOut = 248 + u * 7;
      } else {
        // Text, pencil handwriting, and artwork: non-linear stroke darkening
        const t = Math.max(0, rho / 0.91);
        const tDark = Math.pow(t, 1.52);
        let val = tDark * 248;
        // Deep black contrast enhancement for print & dark ink
        if (val < 65) {
          val = Math.pow(val / 65, 1.25) * 65;
        }
        yOut = val;
      }

      const byteVal = clampByte(yOut);
      d[i4] = byteVal;
      d[i4 + 1] = byteVal;
      d[i4 + 2] = byteVal;
    }
  }

  // Final unsharp mask pass for razor-sharp text and pencil edges
  sharpenPass(d, w, h, Math.min(1, 0.42 + userSharpen * 0.45));
}

/**
 * SUPERSCAN — "High-Fidelity Document Enhancer" (color documents,
 * certificates, book covers): RGB → YCbCr, ALL correction on the Y plane
 * only, chroma recombined untouched — hue and saturation of stamps, logos
 * and photos are preserved by construction.
 *   1. Two-scale noise-floored clarity on Y: mid-radius local contrast plus a
 *      tight edge mask (the manual sharpen slider folds into both).
 *   2. Regional illumination correction: a large-radius background map drives
 *      a clamped per-pixel gain that evens out ambient shadows across the
 *      page — softer than Magic's full flat-field bleach on purpose, so the
 *      render stays realistic.
 *   3. Gentle ink-density curve below paper level plus a final light
 *      luminance crisp pass, so text and fine detail read clear and prominent.
 */
function applySuperScanFilter(d: Uint8ClampedArray, w: number, h: number, userSharpen: number): void {
  const n = w * h;
  const Y = new Float32Array(n);
  const cb = new Float32Array(n); // Cb − 128
  const cr = new Float32Array(n); // Cr − 128
  for (let i = 0; i < n; i++) {
    const r = d[i * 4];
    const g = d[i * 4 + 1];
    const b = d[i * 4 + 2];
    Y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    cb[i] = -0.168736 * r - 0.331264 * g + 0.5 * b;
    cr[i] = 0.5 * r - 0.418688 * g - 0.081312 * b;
  }
  // The illumination map is estimated from the unsharpened luma so edge
  // overshoot can't leak into the lighting model.
  const bg = illuminationMap(Y, w, h, Math.max(30, Math.min(w, h) / 10));

  // Two-scale clarity on luma only (chroma untouched → no color fringing):
  // a mid-radius local-contrast pass makes strokes, lines and details read
  // bolder against the paper, then a tight-radius pass snaps their edges.
  // A single wide σ1.5 mask alone left text looking soft next to Magic.
  unsharpPlane(Y, w, h, 0.32 + userSharpen * 0.2, 3.2, 4);
  unsharpPlane(Y, w, h, 0.85 + userSharpen * 0.5, 0.9, 2.5);

  const BG_REF = 242; // target paper level after correction
  const inv = bg.inv;
  for (let y = 0; y < h; y++) {
    const fy = (y + 0.5) * inv - 0.5;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const m = sampleIllumination(bg, (x + 0.5) * inv - 0.5, fy);
      // Gain clamps keep dark covers and deep shadows from graying toward
      // paper — correction beyond ×1.6 stops being "realistic".
      let gain = BG_REF / Math.max(48, m);
      gain = gain < 0.85 ? 0.85 : gain > 1.6 ? 1.6 : gain;
      let yv = Y[i] * gain;
      // Gentle ink-density curve: content darker than the paper is deepened
      // a little (max ≈ −9 levels in the midtones) so text and fine lines
      // stand out, while paper and highlights pass through unchanged.
      if (yv < BG_REF) {
        const t = yv < 0 ? 0 : yv / BG_REF;
        yv = BG_REF * Math.pow(t, 1.12);
      }
      // Brightening Y dilutes chroma (same Cb/Cr over more luma); rescaling
      // chroma by √gain keeps stamps and logos as saturated after correction
      // as they were in the capture.
      const cg = Math.sqrt(gain);
      const i4 = i * 4;
      d[i4] = yv + 1.402 * cr[i] * cg;
      d[i4 + 1] = yv - 0.344136 * cb[i] * cg - 0.714136 * cr[i] * cg;
      d[i4 + 2] = yv + 1.772 * cb[i] * cg;
    }
  }

  // Final light luminance-only crisp pass after the gain, so edges that the
  // illumination correction brightened stay pixel-sharp in the export.
  sharpenPass(d, w, h, Math.min(1, 0.3 + userSharpen * 0.4));
}

/** Clamped smoothstep: 0 below x=0, 1 above x=1, smooth S-curve between. */
function smooth01(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

const CHROMA_LIN = 32; // chroma offsets up to this pass through untouched
const CHROMA_MAX = 52; // asymptotic ceiling for amplified chroma offsets

/**
 * Soft-knee limiter for recombined chroma offsets: linear through the small
 * offsets where text fringes and paper tint live, saturating for large ones
 * so an amplified cast can never slam into vivid saturated streaks.
 */
function softChroma(v: number): number {
  const a = v < 0 ? -v : v;
  if (a <= CHROMA_LIN) return v;
  const extra = a - CHROMA_LIN;
  const room = CHROMA_MAX - CHROMA_LIN;
  return (v < 0 ? -1 : 1) * (CHROMA_LIN + (room * extra) / (extra + room));
}

/**
 * MAGIC — CamScanner-Style "Magic Color" Engine:
 *   1. Denoises channels gently with 3×3 median filter to eliminate sensor noise.
 *   2. Global paper white-balance: the tint of the brightest pixels is divided
 *      out BEFORE any saturation work, so casts (warm lamplight, blue pen
 *      pressure shadows) are removed instead of amplified.
 *   3. Background illumination map (heavy Gaussian + morphological closing)
 *      models lighting gradients and ambient shadows across the page.
 *   4. Balanced paper normalization: smoothly elevates paper to clean white
 *      without blowing out light pencil text or fine handwriting.
 *   5. Non-linear stroke darkening: enhances contrast for pencil, ballpoint
 *      pen, and faint marks so they remain bold and legible.
 *   6. Vibrant mid-tone saturation: boosts colored stamps, signatures,
 *      highlighters, and diagrams while keeping paper clean and neutral —
 *      near-neutral pixels are NOT amplified, so chromatic fringes around
 *      strokes can never bloom into colored streaks.
 *   7. Adaptive unsharp mask for razor-sharp document clarity.
 */
function applyMagicFilter(d: Uint8ClampedArray, w: number, h: number, userSharpen: number): void {
  const n = w * h;
  const ch = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
  for (let i = 0; i < n; i++) {
    ch[0][i] = d[i * 4];
    ch[1][i] = d[i * 4 + 1];
    ch[2][i] = d[i * 4 + 2];
  }
  // Median-denoise only the chroma: a per-channel median also rounds off
  // luminance edges, which is what made text look soft. The original luma
  // is restored so stroke edges stay pixel-exact.
  const med = [medianBlur(ch[0], w, h, 1), medianBlur(ch[1], w, h, 1), medianBlur(ch[2], w, h, 1)];
  for (let i = 0; i < n; i++) {
    const yOrig = 0.299 * ch[0][i] + 0.587 * ch[1][i] + 0.114 * ch[2][i];
    const yMed = 0.299 * med[0][i] + 0.587 * med[1][i] + 0.114 * med[2][i];
    const off = yOrig - yMed;
    for (let c = 0; c < 3; c++) {
      const v = med[c][i] + off;
      ch[c][i] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
    d[i * 4] = ch[0][i];
    d[i * 4 + 1] = ch[1][i];
    d[i * 4 + 2] = ch[2][i];
  }

  // --- Global paper white-balance ---------------------------------------
  // Phone photos of paper are rarely neutral (warm lamplight, bluish shadow
  // regions near the binding). Estimate the tint from the brightest pixels
  // and divide it out BEFORE the chroma path — otherwise the saturation
  // boost below amplifies the cast into colored streaks along text rows.
  // Gains are clamped to ±10% so a heavily tinted scene can never invert.
  {
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) {
      const y = (0.299 * ch[0][i] + 0.587 * ch[1][i] + 0.114 * ch[2][i]) | 0;
      hist[y < 0 ? 0 : y > 255 ? 255 : y]++;
    }
    // Paper candidates: the brightest ~8% of pixels, never darker than 150.
    let acc = 0;
    let paperLevel = 150;
    for (let v = 255; v >= 150; v--) {
      acc += hist[v];
      if (acc >= n * 0.08) {
        paperLevel = v;
        break;
      }
    }
    let rSum = 0;
    let gSum = 0;
    let bSum = 0;
    let nPaper = 0;
    for (let i = 0; i < n; i++) {
      const r = ch[0][i];
      const g = ch[1][i];
      const b = ch[2][i];
      if (0.299 * r + 0.587 * g + 0.114 * b >= paperLevel) {
        rSum += r;
        gSum += g;
        bSum += b;
        nPaper++;
      }
    }
    if (nPaper > n * 0.01) {
      const rMean = rSum / nPaper;
      const gMean = gSum / nPaper;
      const bMean = bSum / nPaper;
      const yPaper = 0.299 * rMean + 0.587 * gMean + 0.114 * bMean;
      const gainR = Math.min(1.1, Math.max(0.9, yPaper / Math.max(1, rMean)));
      const gainG = Math.min(1.1, Math.max(0.9, yPaper / Math.max(1, gMean)));
      const gainB = Math.min(1.1, Math.max(0.9, yPaper / Math.max(1, bMean)));
      const needsBalance =
        Math.abs(gainR - 1) > 0.004 ||
        Math.abs(gainG - 1) > 0.004 ||
        Math.abs(gainB - 1) > 0.004;
      if (needsBalance) {
        for (let i = 0; i < n; i++) {
          let r = ch[0][i] * gainR;
          let g = ch[1][i] * gainG;
          let b = ch[2][i] * gainB;
          r = r < 0 ? 0 : r > 255 ? 255 : Math.round(r);
          g = g < 0 ? 0 : g > 255 ? 255 : Math.round(g);
          b = b < 0 ? 0 : b > 255 ? 255 : Math.round(b);
          ch[0][i] = r;
          ch[1][i] = g;
          ch[2][i] = b;
          d[i * 4] = r;
          d[i * 4 + 1] = g;
          d[i * 4 + 2] = b;
        }
      }
    }
  }

  const Y = lumaPlane(d);
  const bg = illuminationMap(
    Y,
    w,
    h,
    Math.max(35, Math.min(90, Math.min(w, h) / 8))
  );

  // Tight-radius luma sharpening BEFORE the tone curve, so the curve snaps
  // crisp edges (not soft ramps) to ink/paper. Chroma still uses the
  // unsharpened Y, so no color fringing is introduced.
  const Ys = new Float32Array(Y);
  unsharpPlane(Ys, w, h, 0.7 + userSharpen * 0.5, 1.0, 2.5);

  const inv = bg.inv;
  const clampByte = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

  for (let y = 0; y < h; y++) {
    const fy = (y + 0.5) * inv - 0.5;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const i4 = i * 4;
      const rIn = d[i4];
      const gIn = d[i4 + 1];
      const bIn = d[i4 + 2];
      const yVal = Y[i];
      const m = Math.max(24, sampleIllumination(bg, (x + 0.5) * inv - 0.5, fy));
      const rho = Ys[i] / m;

      // Tone curves for paper (clean to white) and content (stroke
      // darkening), crossfaded over rho ≈ 0.88–0.96. The old hard switch at
      // 0.92 made pixels flip discontinuously between two curves, banding
      // the output along the illumination map's contours.
      const t = Math.max(0, rho / 0.92);
      let yContent = Math.pow(t, 1.42) * 246;
      if (yContent < 60) {
        yContent = Math.pow(yContent / 60, 1.2) * 60;
      }
      const u = Math.min(1, Math.max(0, (rho - 0.92) / 0.08));
      const yPaper = 246 + u * 9;
      const wPaper = smooth01((rho - 0.88) / 0.08);
      const yNorm = yContent * (1 - wPaper) + yPaper * wPaper;

      // Color saturation handling
      const diffR = rIn - yVal;
      const diffG = gIn - yVal;
      const diffB = bIn - yVal;

      const gainY = yNorm / Math.max(1, yVal);
      // Paper fade (removes color noise/tint on paper)
      const paperFade = Math.max(0, Math.min(1, (255 - yNorm) / 22));
      // Saturation boost for stamps, signatures, colored ink — applied only
      // to pixels that carry REAL color to begin with. Amplifying near-
      // neutral pixels (pen-pressure shadows, lens chromatic-aberration
      // fringes hugging the strokes) is what painted cyan streaks along the
      // text rows.
      const origChroma = Math.max(
        diffR < 0 ? -diffR : diffR,
        diffG < 0 ? -diffG : diffG,
        diffB < 0 ? -diffB : diffB
      );
      const chromaFactor =
        Math.min(1.25, 1.35 * Math.min(1.4, Math.max(0.85, Math.sqrt(gainY))) * paperFade) *
        (0.15 + 0.85 * smooth01((origChroma - 5) / 13));

      d[i4] = clampByte(yNorm + softChroma(diffR * chromaFactor));
      d[i4 + 1] = clampByte(yNorm + softChroma(diffG * chromaFactor));
      d[i4 + 2] = clampByte(yNorm + softChroma(diffB * chromaFactor));
    }
  }

  sharpenPass(d, w, h, Math.min(1, 0.45 + userSharpen * 0.55));
}

/**
 * Unsharp-mask sharpening applied to luminance only (no color fringing),
 * with a noise floor so grain isn't amplified. Amount 0–1.
 */
function sharpenPass(d: Uint8ClampedArray, w: number, h: number, amount: number): void {
  if (amount <= 0 || w < 3 || h < 3) return;
  const n = w * h;
  const luma = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    luma[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  }
  const blurred = boxBlurChannel(luma, w, h, 1);
  const gain = amount * 1.8;
  const NOISE_FLOOR = 3.5; // deltas below this are grain, not detail
  for (let i = 0; i < n; i++) {
    let delta = luma[i] - blurred[i];
    if (delta > NOISE_FLOOR) delta -= NOISE_FLOOR;
    else if (delta < -NOISE_FLOOR) delta += NOISE_FLOOR;
    else continue;
    const add = delta * gain;
    d[i * 4] += add;
    d[i * 4 + 1] += add;
    d[i * 4 + 2] += add;
  }
}

/** Otsu's global threshold over a luma buffer — stable, no local blowouts. */
function otsuThreshold(luma: Uint8Array): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < luma.length; i++) hist[luma[i]]++;
  const total = luma.length;
  let sumAll = 0;
  for (let v = 0; v < 256; v++) sumAll += v * hist[v];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;
  for (let v = 0; v < 256; v++) {
    wB += hist[v];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += v * hist[v];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = v;
    }
  }
  return best;
}

/** Brightness / contrast / saturation from the manual sliders. */
function toneAdjust(d: Uint8ClampedArray, adj: ScanAdjustments): void {
  const bright = (adj.brightness - 50) * 1.4; // ±70 levels
  const contrast = 1 + (adj.contrast - 50) * 0.014; // ×0.3 – ×1.7
  const sat = 1 + (adj.saturation - 50) * 0.02; // ×0 – ×2
  const useSat = Math.abs(sat - 1) > 0.01;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i];
    let g = d[i + 1];
    let b = d[i + 2];
    if (useSat) {
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      r = l + (r - l) * sat;
      g = l + (g - l) * sat;
      b = l + (b - l) * sat;
    }
    r = (r - 128) * contrast + 128 + bright;
    g = (g - 128) * contrast + 128 + bright;
    b = (b - 128) * contrast + 128 + bright;
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
  }
}

/**
 * Applies the selected filter engine plus manual adjustments in place.
 * ORIGINAL is a strict passthrough — the canvas already holds the untouched
 * capture (native colors, brightness and contrast curves), so it returns
 * without touching a single pixel; every other preset runs its engine and
 * then applies the manual sliders on top of the result.
 */
export function enhanceImageData(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  filter: ScanFilterId,
  adj: ScanAdjustments
): void {
  if (w < 2 || h < 2) return;
  if (filter === 'original') return; // untouched capture — zero-cost passthrough

  const image = ctx.getImageData(0, 0, w, h);
  enhancePixels(image.data, w, h, filter, adj);
  ctx.putImageData(image, 0, 0);
}

export function enhancePixels(d: Uint8ClampedArray, w: number, h: number, filter: ScanFilterId, adj: ScanAdjustments): void {
  if (w < 2 || h < 2 || filter === 'original') return;
  const userSharpen = adj.sharpen / 100;

  switch (filter) {
    case 'superscan':
      applySuperScanFilter(d, w, h, userSharpen);
      toneAdjust(d, adj);
      break;

    case 'magic':
      applyMagicFilter(d, w, h, userSharpen);
      toneAdjust(d, adj);
      break;

    case 'gray':
      // Saturation is mathematically a no-op on R=G=B output; the slider is
      // normalized anyway so the editor behaves identically across presets.
      applyGrayFilter(d, w, h, userSharpen);
      toneAdjust(d, { ...adj, saturation: 50 });
      break;
  }
}
