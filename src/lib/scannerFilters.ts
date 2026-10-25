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
export type { EdgeSnapEngine, EdgeSnapResult, QuadCorner } from './edgeDetector';

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
   Six-point outlines and shared filter geometry
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
 * Heavy median blur via a sliding-window histogram (Huang's algorithm):
 * constant-time column updates per step, exact median per pixel — with the
 * median bin carried across columns and slid up/down instead of rescanning
 * the histogram from bin 0, so paper-white fields (median pinned at 255)
 * cost O(1) per pixel. Median filtering removes impulse/salt-and-pepper
 * noise while preserving edges in the filter illumination estimate.
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

function pointLineDistance(p: HexPt, a: HexPt, b: HexPt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1e-9;
  return Math.abs(dx * (a.y - p.y) - (a.x - p.x) * dy) / len;
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
