import sharp from 'sharp';
import type { Request, Response, NextFunction } from 'express-serve-static-core';

/**
 * ============================================================================
 *  LOCAL DOCUMENT & HANDWRITING ORIENTATION ENGINE
 *  100% in-memory, zero network calls, Buffer-in / Buffer-out (sharp only).
 * ============================================================================
 *
 *  Failure mode this engine is built around: a smartphone photo of an OPEN
 *  NOTEBOOK shot in portrait — a two-page landscape spread where the written
 *  page is dense with handwriting, the neighbouring page is blank ruled paper,
 *  and the whole layout is rotated 90°. Global projection algorithms fail here
 *  because the blank half and the large white margins dilute the line-rhythm
 *  score, and structural bands (book spine, cover strip, page edges) pollute
 *  the mask.
 *
 *  Multi-step geometric validation flow:
 *    0. EXIF bake        – honour the camera Orientation tag before any CV.
 *    1. Binarize         – integral-image adaptive (Bradley) local threshold,
 *                          so uniform paper/shadows never become "ink".
 *    2. Structural strip – remove long thin ruling lines AND solid dark bands
 *                          (spine shadows, cover strips, borders) that would
 *                          otherwise bridge the two notebook pages.
 *    3. ROI DETECTION    – STEP 1 of the blueprint: a broad morphological
 *                          dilation merges words into large "content block
 *                          fields"; connected-component labelling picks the
 *                          SINGLE largest dense cluster (the written page).
 *                          Blank pages and margins never enter the ROI.
 *    4. ISOLATED LINE    – STEP 2 of the blueprint: horizontal/vertical
 *       MATCHING           projection profiles are computed STRICTLY inside
 *                          the cropped cluster, deciding whether the rhythmic
 *                          handwriting rows run vertically or horizontally.
 *    5. 4-WAY MATRIX     – STEP 3 of the blueprint: a vote score over
 *       TRANSLATION        {0, 90, 180, 270}. The ±90° sign is decided by
 *                          ascender/descender polarity measured on virtually
 *                          rotated masks (verified, not assumed), with the
 *                          dense-cluster quadrant as tie-breaker prior.
 *    6. PARENT ROTATION  – the winning angle is applied to the ENTIRE parent
 *                          high-resolution buffer via sharp's lossless 90°
 *                          transpose — never to the ROI crop alone.
 */

export type RightAngleRotation = 0 | 90 | 180 | 270;

export interface BoundingBoxROI {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Ratio of ROI area to total analysis-image area. */
  coverageRatio: number;
  /** Clean-ink density inside the ROI (0..1) — handwriting scores ~0.06-0.3. */
  inkDensity: number;
}

export interface OrientationVote {
  angle: RightAngleRotation;
  score: number;
  source: 'line-rhythm' | 'ascender-asymmetry' | 'quadrant-prior' | 'default';
}

export interface OrientationAnalysisResult {
  /** CW rotation that makes the document upright (0 = leave untouched). */
  detectedRotation: RightAngleRotation;
  /** 0.0 - 1.0. Honest evidence-weighted confidence (no artificial floor). */
  confidence: number;
  isSideways: boolean;
  textAxis: 'horizontal' | 'vertical' | 'unclear';
  /** Line-rhythm energy of the row projection inside the ROI. */
  horizontalPeriodicityScore: number;
  /** Line-rhythm energy of the column projection inside the ROI. */
  verticalPeriodicityScore: number;
  /** Legacy diagnostic: rowEnergy / colEnergy of the ORIGINAL frame's ROI.
   *  The routing itself uses the 4-rotation rhythm cross-check (axisMargin). */
  periodicityRatio: number;
  /** + = content-up toward image top (horizontal axis) / image left (vertical axis). */
  ascenderPolarityScore: number;
  roi: BoundingBoxROI;
  reason: string;
  /** Rotated FULL-RESOLUTION buffer (RAM only), when requested. */
  correctedBuffer?: Buffer;
  /** Diagnostic: per-angle votes considered by the translation matrix. */
  votes: OrientationVote[];
  /** True when an EXIF orientation tag was baked into the pipeline. */
  exifApplied: boolean;
  /** Global ink coverage of the binarized analysis frame (0..1). */
  inkCoverage: number;
  elapsedMs: number;
}

export interface OrientationEngineOptions {
  /** Return the corrected full-resolution buffer (default true). */
  returnRotatedBuffer?: boolean;
  /** Skip detection and force this CW rotation. */
  forceRotation?: RightAngleRotation;
  /** Minimum confidence required before any rotation is applied (default 0.3). */
  minConfidence?: number;
  /**
   * Tie-breaker prior for the ±90° sign when ascender evidence is too weak.
   * "notebook" (default): dense cluster in the top/left quadrant of a
   * portrait photo => rotate 90° CW (matches a spread whose written page is
   * the RIGHT page — the common case for gutter-left notebooks).
   * "mirror" flips the prior for spreads written on the left page.
   */
  directionalPrior?: 'notebook' | 'mirror';
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ProjectionMetrics {
  rowEnergy: number;
  colEnergy: number;
  periodicityRatio: number;
  rowPeaks: number;
  colPeaks: number;
}

interface ComponentInfo {
  area: number;
  box: Rect;
}

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export class HandwrittenDocumentOrientationEngine {
  private static readonly TARGET_DIM = 720;
  private static readonly MIN_ANALYSIS_DIM = 80;
  /** Minimum clean-ink density for a cluster to count as handwriting. */
  private static readonly MIN_ROI_INK_DENSITY = 0.035;
  /** ROI must cover at least this fraction of the frame to drive rotation. */
  private static readonly MIN_ROI_COVERAGE = 0.04;

  // --------------------------------------------------------------------------
  // CV PRIMITIVES (pure, static, unit-testable — all O(n) or near-O(n))
  // --------------------------------------------------------------------------

  /** Integral image (summed-area table) with a leading zero row/column. */
  public static buildIntegralImage(gray: Uint8Array, w: number, h: number): Float64Array {
    const integral = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      const rowOffset = y * w;
      const intRow = (y + 1) * (w + 1);
      const intPrev = y * (w + 1);
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += gray[rowOffset + x];
        integral[intRow + x + 1] = integral[intPrev + x + 1] + rowSum;
      }
    }
    return integral;
  }

  /**
   * STEP 1a — Adaptive (Bradley/Wellner) binarization via integral image.
   * A pixel is ink when it is meaningfully darker than its LOCAL window mean,
   * which rejects uniform paper, soft shading and solid dark covers while
   * keeping faint pencil strokes.
   */
  public static adaptiveInkMask(
    gray: Uint8Array,
    w: number,
    h: number
  ): { mask: Uint8Array; inkCount: number } {
    const integral = HandwrittenDocumentOrientationEngine.buildIntegralImage(gray, w, h);
    const win = Math.max(15, Math.round(Math.min(w, h) * 0.05));
    const half = Math.floor(win / 2);
    const mask = new Uint8Array(w * h);
    let inkCount = 0;

    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - half);
      const y1 = Math.min(h, y + half + 1);
      const rowOffset = y * w;
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - half);
        const x1 = Math.min(w, x + half + 1);
        const area = (x1 - x0) * (y1 - y0);
        const sum =
          integral[y1 * (w + 1) + x1] -
          integral[y0 * (w + 1) + x1] -
          integral[y1 * (w + 1) + x0] +
          integral[y0 * (w + 1) + x0];
        const localMean = sum / area;
        const v = gray[rowOffset + x];
        if (v < localMean * 0.88 && v < 235) {
          mask[rowOffset + x] = 1;
          inkCount++;
        }
      }
    }
    return { mask, inkCount };
  }

  /**
   * STEP 2a — Remove SOLID dark bands: rows/columns whose ink fraction is
   * absurdly high (> 50%). Real text rows top out around 15-30% ink; solid
   * spine shadows, cover strips and page-edge borders hit 80-100%. Killing
   * them early prevents the book spine from bridging the two notebook pages
   * into one giant component.
   */
  public static removeSolidBands(mask: Uint8Array, w: number, h: number): void {
    const bandLimitW = Math.round(w * 0.5);
    for (let y = 0; y < h; y++) {
      const rowOffset = y * w;
      let count = 0;
      for (let x = 0; x < w; x++) count += mask[rowOffset + x];
      if (count > bandLimitW) mask.fill(0, rowOffset, rowOffset + w);
    }
    const bandLimitH = Math.round(h * 0.5);
    for (let x = 0; x < w; x++) {
      let count = 0;
      for (let y = 0; y < h; y++) count += mask[y * w + x];
      if (count > bandLimitH) {
        for (let y = 0; y < h; y++) mask[y * w + x] = 0;
      }
    }
  }

  /**
   * STEP 2b — Suppress long THIN ruling lines (notebook rules, table borders,
   * page edges). A long run is erased only when it is also thin (< 5px), so
   * genuine dense handwriting strokes are never removed.
   */
  public static suppressRulingLines(
    inkMask: Uint8Array,
    width: number,
    height: number
  ): Uint8Array {
    const cleanMask = new Uint8Array(inkMask.length);
    cleanMask.set(inkMask);

    const minLineLengthH = Math.max(20, Math.round(width * 0.12));
    const minLineLengthV = Math.max(20, Math.round(height * 0.12));

    // Horizontal thin ruling suppression (with thickness test)
    for (let y = 0; y < height; y++) {
      const rowOffset = y * width;
      let runStart = -1;
      for (let x = 0; x <= width; x++) {
        const on = x < width && inkMask[rowOffset + x] === 1;
        if (on && runStart === -1) {
          runStart = x;
        } else if (!on && runStart !== -1) {
          const runLen = x - runStart;
          if (runLen >= minLineLengthH) {
            let isThin = true;
            if (y > 2 && y < height - 3) {
              let thickCount = 0;
              let sampled = 0;
              for (let k = runStart; k < x; k += 5) {
                sampled++;
                if (
                  inkMask[(y - 2) * width + k] === 1 &&
                  inkMask[(y + 2) * width + k] === 1
                ) {
                  thickCount++;
                }
              }
              if (sampled > 0 && thickCount > sampled * 0.25) isThin = false;
            }
            if (isThin) cleanMask.fill(0, rowOffset + runStart, rowOffset + x);
          }
          runStart = -1;
        }
      }
    }

    // Vertical thin ruling suppression (with thickness test)
    for (let x = 0; x < width; x++) {
      let runStart = -1;
      for (let y = 0; y <= height; y++) {
        const on = y < height && inkMask[y * width + x] === 1;
        if (on && runStart === -1) {
          runStart = y;
        } else if (!on && runStart !== -1) {
          const runLen = y - runStart;
          if (runLen >= minLineLengthV) {
            let isThin = true;
            if (x > 2 && x < width - 3) {
              let thickCount = 0;
              let sampled = 0;
              for (let k = runStart; k < y; k += 5) {
                sampled++;
                if (
                  inkMask[k * width + x - 2] === 1 &&
                  inkMask[k * width + x + 2] === 1
                ) {
                  thickCount++;
                }
              }
              if (sampled > 0 && thickCount > sampled * 0.25) isThin = false;
            }
            if (isThin) {
              for (let k = runStart; k < y; k++) cleanMask[k * width + x] = 0;
            }
          }
          runStart = -1;
        }
      }
    }

    return cleanMask;
  }

  /**
   * STEP 3a — Broad morphological dilation (separable max filter).
   * Merges individual words into large "content block fields" so that a
   * paragraph becomes one connected region while page gutters (much larger
   * gaps) stay separate.
   */
  public static dilateMask(
    mask: Uint8Array,
    w: number,
    h: number,
    radiusX: number,
    radiusY: number
  ): Uint8Array {
    const tmp = new Uint8Array(w * h);
    // Horizontal pass
    for (let y = 0; y < h; y++) {
      const rowOffset = y * w;
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - radiusX);
        const x1 = Math.min(w - 1, x + radiusX);
        let v = 0;
        for (let k = x0; k <= x1; k++) {
          if (mask[rowOffset + k] === 1) {
            v = 1;
            break;
          }
        }
        tmp[rowOffset + x] = v;
      }
    }
    // Vertical pass
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - radiusY);
      const y1 = Math.min(h - 1, y + radiusY);
      const rowOffset = y * w;
      for (let x = 0; x < w; x++) {
        let v = 0;
        for (let k = y0; k <= y1; k++) {
          if (tmp[k * w + x] === 1) {
            v = 1;
            break;
          }
        }
        out[rowOffset + x] = v;
      }
    }
    return out;
  }

  /**
   * STEP 3b — Connected-component labelling (8-connectivity, BFS) over the
   * dilated content-block mask. Returns every component with its area and
   * bounding box, sorted by area (largest first).
   */
  public static findContentBlockComponents(
    dilated: Uint8Array,
    w: number,
    h: number
  ): ComponentInfo[] {
    const labels = new Int32Array(w * h).fill(-1);
    const stack = new Int32Array(w * h);
    const components: ComponentInfo[] = [];
    let nextLabel = 0;

    for (let start = 0; start < w * h; start++) {
      if (dilated[start] === 0 || labels[start] !== -1) continue;

      const label = nextLabel++;
      let sp = 0;
      stack[sp++] = start;
      labels[start] = label;

      let area = 0;
      let minX = w;
      let maxX = -1;
      let minY = h;
      let maxY = -1;

      while (sp > 0) {
        const idx = stack[--sp];
        const cy = (idx / w) | 0;
        const cx = idx - cy * w;
        area++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        for (let dy = -1; dy <= 1; dy++) {
          const ny = cy + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            if (nx < 0 || nx >= w) continue;
            const nIdx = ny * w + nx;
            if (dilated[nIdx] === 1 && labels[nIdx] === -1) {
              labels[nIdx] = label;
              stack[sp++] = nIdx;
            }
          }
        }
      }

      components.push({
        area,
        box: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
      });
    }

    components.sort((a, b) => b.area - a.area);
    return components;
  }

  /** Shrink a bounding box to the actual clean-ink extent inside it. */
  public static tightenBoxToInk(
    mask: Uint8Array,
    w: number,
    h: number,
    box: Rect
  ): Rect {
    const x0 = clamp(box.x, 0, w - 1);
    const y0 = clamp(box.y, 0, h - 1);
    const bw = clamp(box.w, 1, w - x0);
    const bh = clamp(box.h, 1, h - y0);

    const rowMin = new Int32Array(bh).fill(bw);
    const rowMax = new Int32Array(bh).fill(-1);
    for (let y = 0; y < bh; y++) {
      const rowOffset = (y0 + y) * w;
      for (let x = 0; x < bw; x++) {
        if (mask[rowOffset + x0 + x] === 1) {
          if (x < rowMin[y]) rowMin[y] = x;
          if (x > rowMax[y]) rowMax[y] = x;
        }
      }
    }

    let top = -1;
    let bottom = -1;
    let left = bw;
    let right = -1;
    for (let y = 0; y < bh; y++) {
      if (rowMax[y] === -1) continue;
      if (top === -1) top = y;
      bottom = y;
      if (rowMin[y] < left) left = rowMin[y];
      if (rowMax[y] > right) right = rowMax[y];
    }

    if (top === -1 || right === -1) {
      return { x: x0, y: y0, w: bw, h: bh };
    }

    const pad = 2;
    const nx = clamp(x0 + left - pad, 0, w - 1);
    const ny = clamp(y0 + top - pad, 0, h - 1);
    return {
      x: nx,
      y: ny,
      w: clamp(right - left + 1 + pad * 2, 1, w - nx),
      h: clamp(bottom - top + 1 + pad * 2, 1, h - ny),
    };
  }

  private static countInkInBox(mask: Uint8Array, w: number, box: Rect): number {
    let count = 0;
    const x0 = clamp(box.x, 0, w - 1);
    const y0 = clamp(box.y, 0, Math.max(0, (mask.length / w | 0) - 1));
    const bw = clamp(box.w, 0, w - x0);
    const bh = clamp(box.h, 0, Math.max(0, ((mask.length / w) | 0) - y0));
    for (let y = 0; y < bh; y++) {
      const rowOffset = (y0 + y) * w + x0;
      for (let x = 0; x < bw; x++) count += mask[rowOffset + x];
    }
    return count;
  }

  /**
   * STEP 3 (blueprint step 1) — INTENSITY-BASED TEXT CLUSTER BOUNDING.
   * Walks the largest dilated content-block components (largest first) and
   * returns the first one whose tightened bounding box actually contains dense
   * handwriting ink. Blank ruled pages and noise fields are skipped, so the
   * empty half of a notebook spread can never become the ROI.
   */
  public static detectTextClusterROI(
    cleanMask: Uint8Array,
    width: number,
    height: number
  ): { roi: BoundingBoxROI; fallback: boolean } {
    const totalPixels = width * height;
    const radius = clamp(Math.round(Math.min(width, height) * 0.03), 5, 24);
    const dilated = HandwrittenDocumentOrientationEngine.dilateMask(
      cleanMask,
      width,
      height,
      radius,
      radius
    );
    const components = HandwrittenDocumentOrientationEngine.findContentBlockComponents(
      dilated,
      width,
      height
    );

    const candidates = components.filter(
      (c) => c.area >= totalPixels * 0.012
    );

    for (let i = 0; i < Math.min(4, candidates.length); i++) {
      const tightened = HandwrittenDocumentOrientationEngine.tightenBoxToInk(
        cleanMask,
        width,
        height,
        candidates[i].box
      );
      const boxArea = tightened.w * tightened.h;
      if (boxArea < totalPixels * HandwrittenDocumentOrientationEngine.MIN_ROI_COVERAGE) {
        continue;
      }
      const ink = HandwrittenDocumentOrientationEngine.countInkInBox(
        cleanMask,
        width,
        tightened
      );
      const inkDensity = ink / boxArea;
      if (inkDensity < HandwrittenDocumentOrientationEngine.MIN_ROI_INK_DENSITY) {
        continue;
      }
      return {
        roi: {
          x: tightened.x,
          y: tightened.y,
          width: tightened.w,
          height: tightened.h,
          coverageRatio: boxArea / totalPixels,
          inkDensity,
        },
        fallback: false,
      };
    }

    // No trustworthy cluster — fall back to the frame inset by 4%.
    const marginX = Math.round(width * 0.04);
    const marginY = Math.round(height * 0.04);
    const box: Rect = {
      x: marginX,
      y: marginY,
      w: width - marginX * 2,
      h: height - marginY * 2,
    };
    const ink = HandwrittenDocumentOrientationEngine.countInkInBox(cleanMask, width, box);
    return {
      roi: {
        x: box.x,
        y: box.y,
        width: box.w,
        height: box.h,
        coverageRatio: (box.w * box.h) / totalPixels,
        inkDensity: ink / (box.w * box.h),
      },
      fallback: true,
    };
  }

  /** Box-blur a 1D profile in place (O(n) via prefix sums). */
  private static smoothProfile(profile: Float32Array): void {
    const n = profile.length;
    if (n < 5) return;
    // Keep the radius well under half a typical text-line period (~2% of the
    // axis at 15-30 lines/page) so the rhythmic waveform survives smoothing.
    const radius = Math.max(1, Math.round(n * 0.008));
    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + profile[i];
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - radius);
      const b = Math.min(n, i + radius + 1);
      profile[i] = (prefix[b] - prefix[a]) / (b - a);
    }
  }

  /** Count prominent local maxima (candidate text lines) in a profile. */
  private static countPeaks(profile: Float32Array, mean: number): number {
    const n = profile.length;
    const win = Math.max(2, Math.round(n * 0.015));
    const high = mean * 1.25;
    let peaks = 0;
    for (let i = 0; i < n; i++) {
      const v = profile[i];
      if (v <= high) continue;
      let isMax = true;
      for (let k = Math.max(0, i - win); k <= Math.min(n - 1, i + win); k++) {
        if (profile[k] > v) {
          isMax = false;
          break;
        }
      }
      if (isMax) peaks++;
    }
    return peaks;
  }

  /**
   * STEP 4 (blueprint step 2) — ISOLATED REGION PROJECTION ANALYSIS.
   * Row/column ink-density profiles computed STRICTLY inside the ROI. The
   * axis that carries the rhythmic text-line waveform wins; because the
   * profiles never leave the cropped cluster, the blank page cannot dilute
   * the score.
   */
  public static analyzeRoiProjections(
    mask: Uint8Array,
    width: number,
    _height: number,
    roi: BoundingBoxROI
  ): ProjectionMetrics {
    const rx = clamp(roi.x, 0, width - 1);
    const ry = clamp(roi.y, 0, _height - 1);
    const rw = clamp(roi.width, 1, width - rx);
    const rh = clamp(roi.height, 1, _height - ry);

    const rowProj = new Float32Array(rh);
    for (let y = 0; y < rh; y++) {
      const rowOffset = (ry + y) * width + rx;
      let sum = 0;
      for (let x = 0; x < rw; x++) sum += mask[rowOffset + x];
      rowProj[y] = sum / rw;
    }

    const colProj = new Float32Array(rw);
    for (let x = 0; x < rw; x++) {
      let sum = 0;
      for (let y = 0; y < rh; y++) sum += mask[(ry + y) * width + rx + x];
      colProj[x] = sum / rh;
    }

    HandwrittenDocumentOrientationEngine.smoothProfile(rowProj);
    HandwrittenDocumentOrientationEngine.smoothProfile(colProj);

    const energyOf = (proj: Float32Array): { energy: number; peaks: number } => {
      const n = proj.length;
      if (n < 8) return { energy: 0, peaks: 0 };
      let mean = 0;
      for (let i = 0; i < n; i++) mean += proj[i];
      mean /= n;
      if (mean < 1e-4) return { energy: 0, peaks: 0 };
      let variance = 0;
      for (let i = 0; i < n; i++) {
        const d = proj[i] - mean;
        variance += d * d;
      }
      variance /= n;
      const normVar = variance / (mean * mean);
      const peaks = HandwrittenDocumentOrientationEngine.countPeaks(proj, mean);
      // Rhythmic text lines => many prominent peaks AND a strongly modulated
      // profile. The product collapses when either signal is missing.
      const energy = Math.sqrt(normVar) * Math.min(peaks, 16);
      return { energy, peaks };
    };

    const row = energyOf(rowProj);
    const col = energyOf(colProj);
    return {
      rowEnergy: row.energy,
      colEnergy: col.energy,
      periodicityRatio: (row.energy + 1e-6) / (col.energy + 1e-6),
      rowPeaks: row.peaks,
      colPeaks: col.peaks,
    };
  }

  /**
   * STEP 5a — Ascender vs descender polarity INSIDE the ROI.
   *
   * Latin handwriting/print puts far more ink ABOVE a text line's dense
   * x-height core (ascenders, capitals, digits, t-bars) than BELOW it
   * (g j p q y). Measuring per text-line strip keeps skew and multi-page
   * layouts from merging neighbouring lines.
   *
   * Sign convention (returned value, roughly -1..1):
   *   axis 'horizontal': positive => content-up is toward image TOP (upright).
   *   axis 'vertical'  : positive => content-up is toward image LEFT, i.e. the
   *                      photo is the upright page rotated 90° CCW, so the
   *                      correcting rotation is 90° CW.
   */
  public static computeRoiAscenderPolarity(
    mask: Uint8Array,
    width: number,
    height: number,
    roi: BoundingBoxROI,
    axis: 'horizontal' | 'vertical'
  ): { polarity: number; bands: number } {
    const rx = clamp(roi.x, 0, width - 1);
    const ry = clamp(roi.y, 0, height - 1);
    const rw = clamp(roi.width, 1, width - rx);
    const rh = clamp(roi.height, 1, height - ry);

    let upperTotal = 0;
    let lowerTotal = 0;
    let bands = 0;

    if (axis === 'horizontal') {
      const stripCount = clamp(Math.round(rw / 90), 2, 8);
      const stripW = Math.floor(rw / stripCount);
      if (stripW < 24) return { polarity: 0, bands: 0 };
      const maxBandH = Math.max(10, Math.round(rh * 0.14));

      for (let s = 0; s < stripCount; s++) {
        const sx = rx + s * stripW;
        const proj = new Float32Array(rh);
        for (let y = 0; y < rh; y++) {
          const rowOffset = (ry + y) * width + sx;
          let sum = 0;
          for (let x = 0; x < stripW; x++) sum += mask[rowOffset + x];
          proj[y] = sum;
        }
        const res = HandwrittenDocumentOrientationEngine.measureBandAsymmetry(
          proj,
          stripW,
          maxBandH
        );
        upperTotal += res.upper;
        lowerTotal += res.lower;
        bands += res.bands;
      }
    } else {
      const stripCount = clamp(Math.round(rh / 90), 2, 8);
      const stripH = Math.floor(rh / stripCount);
      if (stripH < 24) return { polarity: 0, bands: 0 };
      const maxBandW = Math.max(10, Math.round(rw * 0.14));

      for (let s = 0; s < stripCount; s++) {
        const sy = ry + s * stripH;
        const proj = new Float32Array(rw);
        for (let x = 0; x < rw; x++) {
          let sum = 0;
          for (let y = 0; y < stripH; y++) sum += mask[(sy + y) * width + rx + x];
          proj[x] = sum;
        }
        const res = HandwrittenDocumentOrientationEngine.measureBandAsymmetry(
          proj,
          stripH,
          maxBandW
        );
        // Perpendicular profile index grows toward image RIGHT for vertical
        // text lines, so "upper" (before the core) is the LEFT side.
        upperTotal += res.upper;
        lowerTotal += res.lower;
        bands += res.bands;
      }
    }

    if (bands < 3 || upperTotal + lowerTotal < 1e-4) {
      return { polarity: 0, bands };
    }
    return {
      polarity: (upperTotal - lowerTotal) / (upperTotal + lowerTotal),
      bands,
    };
  }

  /**
   * Shared band scanner: splits one strip's perpendicular projection into
   * text-line bands and sums the sparse ink mass on each side of the dense
   * core (ascender zone vs descender zone).
   */
  private static measureBandAsymmetry(
    proj: Float32Array,
    stripSize: number,
    maxBandLen: number
  ): { upper: number; lower: number; bands: number } {
    const n = proj.length;
    const gapThreshold = Math.max(2, stripSize * 0.02);
    let upper = 0;
    let lower = 0;
    let bands = 0;

    let i = 0;
    while (i < n) {
      if (proj[i] <= gapThreshold) {
        i++;
        continue;
      }
      const start = i;
      while (i < n && proj[i] > gapThreshold) i++;
      const end = i; // exclusive
      const bandLen = end - start;
      if (bandLen < 4 || bandLen > maxBandLen) continue;

      let peakIdx = start;
      let bandInk = 0;
      for (let k = start; k < end; k++) {
        bandInk += proj[k];
        if (proj[k] > proj[peakIdx]) peakIdx = k;
      }
      if (bandInk < stripSize * 0.25) continue;

      const coreThreshold = proj[peakIdx] * 0.5;
      let coreStart = peakIdx;
      while (coreStart > start && proj[coreStart - 1] >= coreThreshold) coreStart--;
      let coreEnd = peakIdx;
      while (coreEnd < end - 1 && proj[coreEnd + 1] >= coreThreshold) coreEnd++;

      for (let k = start; k < coreStart; k++) upper += proj[k];
      for (let k = coreEnd + 1; k < end; k++) lower += proj[k];
      bands++;
    }

    return { upper, lower, bands };
  }

  /**
   * STEP 5b — LTR margin-raggedness cue (per candidate rotation).
   *
   * Upright left-to-right text has a comparatively STRAIGHT left margin
   * (writers align line starts) and a RAGGED right margin (lines end at
   * arbitrary words). This asymmetry survives handwriting far better than
   * ascender statistics and is independent of which notebook page carries
   * the writing. Measured on the candidate frame where text lines are
   * horizontal; returns roughly -1..1 (positive = looks upright LTR).
   */
  public static computeRoiLtrMarginScore(
    mask: Uint8Array,
    width: number,
    height: number,
    roi: BoundingBoxROI
  ): number {
    const roiX = clamp(roi.x, 0, width - 1);
    const ry = clamp(roi.y, 0, height - 1);
    const roiW = clamp(roi.width, 1, width - roiX);
    const rh = clamp(roi.height, 1, height - ry);
    if (roiW < 60 || rh < 60) return 0;

    // Margins are only meaningful inside ONE text column. When the ROI spans
    // a two-page spread (or a photo + text layout), line "starts" land on the
    // other page and the cue inverts — so restrict to the densest column.
    const column = HandwrittenDocumentOrientationEngine.findDominantTextColumn(
      mask,
      width,
      roiX,
      ry,
      roiW,
      rh
    );
    const rx = column.x;
    const rw = column.w;
    if (rw < 60) return 0;

    // Row projection (raw ink counts) inside the ROI.
    const rowProj = new Float32Array(rh);
    for (let y = 0; y < rh; y++) {
      const rowOffset = (ry + y) * width + rx;
      let sum = 0;
      for (let x = 0; x < rw; x++) sum += mask[rowOffset + x];
      rowProj[y] = sum;
    }
    HandwrittenDocumentOrientationEngine.smoothProfile(rowProj);

    // Per-row first/last ink column.
    const firstX = new Int32Array(rh).fill(-1);
    const lastX = new Int32Array(rh).fill(-1);
    for (let y = 0; y < rh; y++) {
      const rowOffset = (ry + y) * width + rx;
      for (let x = 0; x < rw; x++) {
        if (mask[rowOffset + x] === 1) {
          firstX[y] = x;
          break;
        }
      }
      for (let x = rw - 1; x >= 0; x--) {
        if (mask[rowOffset + x] === 1) {
          lastX[y] = x;
          break;
        }
      }
    }

    // Text-line bands from the row projection; one margin sample per band.
    const gapThreshold = Math.max(2, rw * 0.02);
    const maxBandH = Math.max(10, Math.round(rh * 0.14));
    const starts: number[] = [];
    const ends: number[] = [];

    let i = 0;
    while (i < rh) {
      if (rowProj[i] <= gapThreshold) {
        i++;
        continue;
      }
      const start = i;
      while (i < rh && rowProj[i] > gapThreshold) i++;
      const end = i;
      const bandLen = end - start;
      if (bandLen < 4 || bandLen > maxBandH) continue;

      let sSum = 0;
      let eSum = 0;
      let n = 0;
      for (let y = start; y < end; y++) {
        if (firstX[y] === -1) continue;
        sSum += firstX[y];
        eSum += lastX[y];
        n++;
      }
      if (n < 2) continue;
      const sMean = sSum / n;
      const eMean = eSum / n;
      // Ignore sliver bands that are mostly margin/edge artifacts.
      if (eMean - sMean < rw * 0.15) continue;
      starts.push(sMean);
      ends.push(eMean);
    }

    if (starts.length < 6) return 0;
    const varOf = (arr: number[]): number => {
      let mean = 0;
      for (let k = 0; k < arr.length; k++) mean += arr[k];
      mean /= arr.length;
      let v = 0;
      for (let k = 0; k < arr.length; k++) {
        const d = arr[k] - mean;
        v += d * d;
      }
      return v / arr.length;
    };
    const startVar = varOf(starts);
    const endVar = varOf(ends);
    if (startVar + endVar < 1e-4) return 0;
    return (endVar - startVar) / (endVar + startVar);
  }

  /**
   * Splits the ROI at vertical gutters (near-empty column runs) and returns
   * the block carrying the most ink — the main text column.
   */
  private static findDominantTextColumn(
    mask: Uint8Array,
    width: number,
    rx: number,
    ry: number,
    rw: number,
    rh: number
  ): { x: number; w: number } {
    const colProj = new Float32Array(rw);
    let total = 0;
    for (let y = 0; y < rh; y++) {
      const rowOffset = (ry + y) * width + rx;
      for (let x = 0; x < rw; x++) colProj[x] += mask[rowOffset + x];
    }
    for (let x = 0; x < rw; x++) total += colProj[x];
    if (total < 1) return { x: rx, w: rw };

    const smoothed = new Float32Array(rw);
    const r = Math.max(2, Math.round(rw * 0.006));
    for (let x = 0; x < rw; x++) {
      let s = 0;
      let n = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(rw - 1, x + r); k++) {
        s += colProj[k];
        n++;
      }
      smoothed[x] = s / n;
    }

    const mean = total / rw;
    const gutterLevel = mean * 0.18;
    const minGutter = Math.max(6, Math.round(rw * 0.03));

    const blocks: Array<{ x0: number; x1: number; ink: number }> = [];
    const pushBlock = (x0: number, x1: number) => {
      if (x1 <= x0) return;
      let ink = 0;
      for (let k = x0; k < x1; k++) ink += colProj[k];
      blocks.push({ x0, x1, ink });
    };
    let blockStart = 0;
    let x = 0;
    while (x < rw) {
      if (smoothed[x] > gutterLevel) {
        x++;
        continue;
      }
      const gapStart = x;
      while (x < rw && smoothed[x] <= gutterLevel) x++;
      if (x - gapStart >= minGutter) {
        pushBlock(blockStart, gapStart);
        blockStart = x;
      }
    }
    pushBlock(blockStart, rw);

    let best: { x0: number; x1: number; ink: number } | null = null;
    for (const b of blocks) {
      if (b.x1 - b.x0 < rw * 0.2) continue;
      if (!best || b.ink > best.ink) best = b;
    }
    if (!best || best.ink < total * 0.35) return { x: rx, w: rw };
    return { x: rx + best.x0, w: best.x1 - best.x0 };
  }

  // --------------------------------------------------------------------------
  // VIRTUAL GEOMETRY (verification without extra sharp passes)
  // --------------------------------------------------------------------------

  /** Rotate a binary mask by quarterTurns × 90° clockwise. */
  public static rotateMask90(
    mask: Uint8Array,
    w: number,
    h: number,
    quarterTurns: number
  ): { mask: Uint8Array; w: number; h: number } {
    const t = ((quarterTurns % 4) + 4) % 4;
    if (t === 0) {
      const copy = new Uint8Array(mask);
      return { mask: copy, w, h };
    }
    const dw = t % 2 === 0 ? w : h;
    const dh = t % 2 === 0 ? h : w;
    const out = new Uint8Array(dw * dh);
    for (let y = 0; y < h; y++) {
      const rowOffset = y * w;
      for (let x = 0; x < w; x++) {
        if (mask[rowOffset + x] === 0) continue;
        let dx: number;
        let dy: number;
        if (t === 1) {
          dx = h - 1 - y;
          dy = x;
        } else if (t === 2) {
          dx = w - 1 - x;
          dy = h - 1 - y;
        } else {
          dx = y;
          dy = w - 1 - x;
        }
        out[dy * dw + dx] = 1;
      }
    }
    return { mask: out, w: dw, h: dh };
  }

  /** Map a rectangle through the same quarter-turn as rotateMask90. */
  public static mapRect90(rect: Rect, w: number, h: number, quarterTurns: number): Rect {
    const t = ((quarterTurns % 4) + 4) % 4;
    if (t === 0) return { ...rect };
    if (t === 1) return { x: h - rect.y - rect.h, y: rect.x, w: rect.h, h: rect.w };
    if (t === 2) return { x: w - rect.x - rect.w, y: h - rect.y - rect.h, w: rect.w, h: rect.h };
    return { x: rect.y, y: w - rect.x - rect.w, w: rect.h, h: rect.w };
  }

  /**
   * Score how "upright" a candidate rotation looks: horizontal line rhythm
   * inside the mapped ROI plus the ascender polarity (positive = up).
   */
  private static evaluateUprightCandidate(
    cleanMask: Uint8Array,
    w: number,
    h: number,
    roi: BoundingBoxROI,
    quarterTurns: number
  ): { rhythm: number; polarity: number; ltrMargin: number; score: number } {
    const rotated = HandwrittenDocumentOrientationEngine.rotateMask90(
      cleanMask,
      w,
      h,
      quarterTurns
    );
    const mapped = HandwrittenDocumentOrientationEngine.mapRect90(
      { x: roi.x, y: roi.y, w: roi.width, h: roi.height },
      w,
      h,
      quarterTurns
    );
    const mappedRoi: BoundingBoxROI = {
      x: clamp(mapped.x, 0, Math.max(0, rotated.w - 1)),
      y: clamp(mapped.y, 0, Math.max(0, rotated.h - 1)),
      width: clamp(mapped.w, 1, rotated.w),
      height: clamp(mapped.h, 1, rotated.h),
      coverageRatio: roi.coverageRatio,
      inkDensity: roi.inkDensity,
    };

    const metrics = HandwrittenDocumentOrientationEngine.analyzeRoiProjections(
      rotated.mask,
      rotated.w,
      rotated.h,
      mappedRoi
    );
    const rhythm =
      metrics.rowEnergy / (metrics.rowEnergy + metrics.colEnergy + 1e-9);
    const polarity = HandwrittenDocumentOrientationEngine.computeRoiAscenderPolarity(
      rotated.mask,
      rotated.w,
      rotated.h,
      mappedRoi,
      'horizontal'
    ).polarity;
    const ltrMargin = HandwrittenDocumentOrientationEngine.computeRoiLtrMarginScore(
      rotated.mask,
      rotated.w,
      rotated.h,
      mappedRoi
    );

    // Weighted upright evidence: ascender asymmetry is the strongest cue for
    // print, LTR margin raggedness is the most reliable one for handwriting;
    // rhythm validates the axis choice. All three flip sign under a wrong
    // candidate rotation, so the ±90° sign is decided by MEASURED evidence —
    // the cluster-quadrant prior is only a last-resort tie-breaker.
    return {
      rhythm,
      polarity,
      ltrMargin,
      score: 0.25 * rhythm + 0.4 * polarity + 0.35 * ltrMargin,
    };
  }

  /**
   * Up/down evidence for one candidate. Ascender polarity is measured on
   * every text line and is the primary cue; the LTR margin cue is fragile on
   * spreads and mixed layouts, so when it contradicts a clear ascender
   * reading it is heavily down-weighted instead of cancelling it out.
   */
  private static directionalScore(c: { polarity: number; ltrMargin: number }): number {
    const disagree = c.polarity * c.ltrMargin < 0;
    const ltrWeight = disagree && Math.abs(c.polarity) >= 0.15 ? 0.1 : 0.4;
    return 0.6 * c.polarity + ltrWeight * c.ltrMargin;
  }

  // --------------------------------------------------------------------------
  // MAIN PIPELINE
  // --------------------------------------------------------------------------

  /**
   * Execute the full local pipeline on an input image buffer.
   * Buffer-in, Buffer-out; every intermediate stays in RAM.
   */
  public async analyzeAndCorrectBuffer(
    inputBuffer: Buffer,
    options: OrientationEngineOptions = {}
  ): Promise<OrientationAnalysisResult> {
    const started = Date.now();
    const minConfidence = options.minConfidence ?? 0.3;
    const votes: OrientationVote[] = [];

    const metadata = await sharp(inputBuffer).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error('Invalid image buffer: unable to decode metadata.');
    }

    // ---- STEP 0: EXIF bake -------------------------------------------------
    // sharp only auto-orients when .rotate() is called without an angle, and
    // an explicit .rotate(angle) does NOT apply the EXIF tag. Combine both
    // into a single lossless output pass for the pure-rotation tags.
    const exifTag = metadata.orientation ?? 1;
    const EXIF_CW: Record<number, number> = { 1: 0, 3: 180, 6: 90, 8: 270 };
    const exifIsPureRotation = exifTag in EXIF_CW;
    const exifCw = exifIsPureRotation ? EXIF_CW[exifTag] : 0;

    let baseBuffer: Buffer = inputBuffer;
    let needsMirrorBake = false;
    if (exifTag > 1 && !exifIsPureRotation) {
      // Tags 2/4/5/7 involve mirroring — bake via sharp auto-orient first.
      baseBuffer = await sharp(inputBuffer).rotate().png().toBuffer();
      needsMirrorBake = true;
    }
    const exifApplied = exifTag > 1;

    // ---- Analysis canvas ---------------------------------------------------
    const { data: rawPixels, info } = await sharp(baseBuffer)
      .resize({
        width: HandwrittenDocumentOrientationEngine.TARGET_DIM,
        height: HandwrittenDocumentOrientationEngine.TARGET_DIM,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const cvW = info.width;
    const cvH = info.height;

    const emptyResult = (reason: string): OrientationAnalysisResult => {
      const roi: BoundingBoxROI = {
        x: 0,
        y: 0,
        width: cvW,
        height: cvH,
        coverageRatio: 1,
        inkDensity: 0,
      };
      return {
        detectedRotation: 0,
        confidence: 0,
        isSideways: false,
        textAxis: 'unclear',
        horizontalPeriodicityScore: 0,
        verticalPeriodicityScore: 0,
        periodicityRatio: 1,
        ascenderPolarityScore: 0,
        roi,
        reason,
        correctedBuffer: options.returnRotatedBuffer === false ? undefined : inputBuffer,
        votes,
        exifApplied,
        inkCoverage: 0,
        elapsedMs: Date.now() - started,
      };
    };

    if (
      Math.max(cvW, cvH) < HandwrittenDocumentOrientationEngine.MIN_ANALYSIS_DIM
    ) {
      return emptyResult('Image too small for reliable orientation analysis; left untouched.');
    }

    // Normalize to single-channel 0..255 gray
    const channels = info.channels;
    const pixelCount = cvW * cvH;
    const gray = new Uint8Array(pixelCount);
    if (channels === 1) {
      gray.set(rawPixels.subarray(0, pixelCount));
    } else {
      for (let i = 0; i < pixelCount; i++) {
        const j = i * channels;
        if (channels >= 3) {
          gray[i] = (rawPixels[j] * 299 + rawPixels[j + 1] * 587 + rawPixels[j + 2] * 114) / 1000;
        } else {
          gray[i] = rawPixels[j];
        }
      }
    }

    // ---- STEP 1: adaptive binarization ------------------------------------
    const { mask: inkMask, inkCount } = HandwrittenDocumentOrientationEngine.adaptiveInkMask(
      gray,
      cvW,
      cvH
    );
    const inkCoverage = inkCount / pixelCount;
    if (inkCoverage < 0.002) {
      return emptyResult('Page is blank or nearly blank; no rotation applied.');
    }

    // ---- STEP 2: structural cleanup ---------------------------------------
    HandwrittenDocumentOrientationEngine.removeSolidBands(inkMask, cvW, cvH);
    const cleanMask = HandwrittenDocumentOrientationEngine.suppressRulingLines(
      inkMask,
      cvW,
      cvH
    );

    // ---- STEP 3 (blueprint 1): text-cluster ROI ---------------------------
    const { roi, fallback } = HandwrittenDocumentOrientationEngine.detectTextClusterROI(
      cleanMask,
      cvW,
      cvH
    );
    if (fallback) {
      return emptyResult(
        'No dense handwriting cluster found (ROI fallback); rotation skipped for safety.'
      );
    }

    if (options.forceRotation !== undefined) {
      const forced = options.forceRotation;
      const correctedBuffer = await this.applyRotation(
        inputBuffer,
        baseBuffer,
        needsMirrorBake,
        exifCw,
        forced
      );
      return {
        detectedRotation: forced,
        confidence: 1,
        isSideways: forced === 90 || forced === 270,
        textAxis: forced === 90 || forced === 270 ? 'vertical' : 'horizontal',
        horizontalPeriodicityScore: 0,
        verticalPeriodicityScore: 0,
        periodicityRatio: 1,
        ascenderPolarityScore: 0,
        roi,
        reason: `Rotation forced to ${forced}° CW by caller.`,
        correctedBuffer,
        votes: [{ angle: forced, score: 1, source: 'default' }],
        exifApplied,
        inkCoverage,
        elapsedMs: Date.now() - started,
      };
    }

    // ---- STEP 4 (blueprint 2): isolated projection analysis ---------------
    const metrics = HandwrittenDocumentOrientationEngine.analyzeRoiProjections(
      cleanMask,
      cvW,
      cvH,
      roi
    );
    const ratio = metrics.periodicityRatio; // legacy diagnostic (original frame)

    // Evaluate ALL FOUR candidate rotations with the identical ROI machinery
    // and CROSS-VALIDATE the axis: if turning the page ±90° produces clearly
    // more horizontal line rhythm than the current frame, the page IS
    // sideways — even when the original frame's own projections are polluted
    // by binding strips, form boxes or pasted photos. A 180° flip is only
    // reachable from the horizontal branch, so a sideways page can never be
    // "corrected" by an inversion.
    const cand0 = HandwrittenDocumentOrientationEngine.evaluateUprightCandidate(
      cleanMask,
      cvW,
      cvH,
      roi,
      0
    );
    const cand90 = HandwrittenDocumentOrientationEngine.evaluateUprightCandidate(
      cleanMask,
      cvW,
      cvH,
      roi,
      1
    );
    const cand180 = HandwrittenDocumentOrientationEngine.evaluateUprightCandidate(
      cleanMask,
      cvW,
      cvH,
      roi,
      2
    );
    const cand270 = HandwrittenDocumentOrientationEngine.evaluateUprightCandidate(
      cleanMask,
      cvW,
      cvH,
      roi,
      3
    );

    const sidewaysRhythm = (cand90.rhythm + cand270.rhythm) / 2;
    const uprightRhythm = (cand0.rhythm + cand180.rhythm) / 2;
    const axisMargin =
      (sidewaysRhythm - uprightRhythm) / (sidewaysRhythm + uprightRhythm + 1e-6);
    const axisStrength = Math.min(1, Math.abs(axisMargin) / 0.5);

    let detectedRotation: RightAngleRotation = 0;
    let textAxis: 'horizontal' | 'vertical' | 'unclear' = 'unclear';
    let confidence = 0;
    let reason = 'Ambiguous text layout in ROI; defaulting to 0° (no rotation).';
    let ascenderPolarityScore = 0;

    votes.push({ angle: 0, score: cand0.score, source: 'ascender-asymmetry' });
    votes.push({ angle: 90, score: cand90.score, source: 'ascender-asymmetry' });
    votes.push({ angle: 180, score: cand180.score, source: 'ascender-asymmetry' });
    votes.push({ angle: 270, score: cand270.score, source: 'ascender-asymmetry' });

    if (axisMargin > 0.08) {
      // ---- Cross-validated SIDEWAYS: the ±90° candidates restore horizontal
      // text lines, so only 90°/270° are reachable from here.
      textAxis = 'vertical';
      ascenderPolarityScore = Math.max(cand90.polarity, cand270.polarity);

      const diff =
        HandwrittenDocumentOrientationEngine.directionalScore(cand90) -
        HandwrittenDocumentOrientationEngine.directionalScore(cand270);
      let signMargin: number;
      if (Math.abs(diff) < 0.03) {
        // Directional evidence too weak — quadrant prior decides.
        const cx = (roi.x + roi.width / 2) / cvW;
        const cy = (roi.y + roi.height / 2) / cvH;
        let d = 0.5 - cy + (0.5 - cx) * 0.5;
        if ((options.directionalPrior ?? 'notebook') === 'mirror') d = -d;
        detectedRotation = d >= 0 ? 90 : 270;
        signMargin = 0.35;
        votes.push({
          angle: detectedRotation,
          score: 0.35,
          source: 'quadrant-prior',
        });
        reason =
          `Sideways page confirmed by rotation cross-check (rhythm ${sidewaysRhythm.toFixed(2)} vs ${uprightRhythm.toFixed(2)}); ` +
          `directional evidence weak, dense cluster sits in the ${d >= 0 ? 'top/left' : 'bottom/right'} quadrant ` +
          `=> ${detectedRotation}° CW rotation.`;
      } else {
        detectedRotation = diff > 0 ? 90 : 270;
        signMargin = Math.min(1, Math.abs(diff) / 0.45);
        reason =
          `Sideways page confirmed by rotation cross-check (rhythm ${sidewaysRhythm.toFixed(2)} vs ${uprightRhythm.toFixed(2)}); ` +
          `ascender polarity + LTR margin verified on rotated masks => ${detectedRotation}° CW rotation.`;
      }

      const winnerRhythm = detectedRotation === 90 ? cand90.rhythm : cand270.rhythm;
      confidence = 0.35 * axisStrength + 0.65 * signMargin;
      if (winnerRhythm < 0.35) {
        // Rotation did not actually produce horizontal lines — distrust it.
        confidence *= 0.5;
        reason += ' (weak post-rotation rhythm; confidence reduced)';
      }
    } else if (axisMargin < -0.08) {
      // ---- Cross-validated HORIZONTAL => upright or 180° flipped ----------
      textAxis = 'horizontal';
      ascenderPolarityScore = cand0.polarity;

      // A 180° flip requires BOTH directional cues to independently agree
      // that the page is upside down (descender-side up AND ragged-left
      // margins). Two independent negatives make an accidental inversion of
      // upright handwriting essentially impossible.
      const dir0 = HandwrittenDocumentOrientationEngine.directionalScore(cand0);
      const dir180 = HandwrittenDocumentOrientationEngine.directionalScore(cand180);
      // Inversion needs the ascender cue itself to read upside down AND the
      // fused evidence to clearly favour the flipped candidate. A strong
      // ascender reading may override a disagreeing LTR cue (spreads, photos,
      // numbered lists), but a weak one never flips the page on its own.
      const ltrAgrees = cand0.ltrMargin < -0.02;
      const strongPolarity = cand0.polarity < -0.2 && cand180.polarity > 0.2;
      if (
        cand0.polarity < -0.08 &&
        dir180 - dir0 > 0.12 &&
        (ltrAgrees || strongPolarity)
      ) {
        detectedRotation = 180;
        confidence = Math.min(0.95, 0.3 + 0.65 * Math.min(1, (dir180 - dir0) / 0.5));
        reason = ltrAgrees
          ? 'Horizontal text lines; ascender polarity AND LTR margin both inverted => 180° rotation.'
          : 'Horizontal text lines; strong inverted ascender polarity (verified on 180° candidate) => 180° rotation.';
      } else {
        detectedRotation = 0;
        confidence = Math.min(0.95, 0.3 + 0.65 * Math.min(1, Math.max(0, cand0.polarity) / 0.22));
        reason =
          'Horizontal text lines, directional cues read upright; document already upright.';
      }
    } else {
      textAxis = 'unclear';
      detectedRotation = 0;
      confidence = 0;
      reason = 'Text-line axis ambiguous across all four rotations; no rotation applied.';
    }

    // ---- Confidence gate: never rotate on a hunch -------------------------
    if (detectedRotation !== 0 && confidence < minConfidence) {
      reason = `${reason} (confidence ${confidence.toFixed(2)} below gate ${minConfidence}; skipped)`;
      detectedRotation = 0;
    }

    // ---- STEP 6 (blueprint 3): rotate the ENTIRE parent buffer ------------
    const correctedBuffer =
      options.returnRotatedBuffer === false
        ? undefined
        : await this.applyRotation(
            inputBuffer,
            baseBuffer,
            needsMirrorBake,
            exifCw,
            detectedRotation
          );

    return {
      detectedRotation,
      confidence: Math.round(confidence * 100) / 100,
      isSideways: detectedRotation === 90 || detectedRotation === 270,
      textAxis,
      horizontalPeriodicityScore: Math.round(metrics.rowEnergy * 1000) / 1000,
      verticalPeriodicityScore: Math.round(metrics.colEnergy * 1000) / 1000,
      periodicityRatio: Math.round(ratio * 1000) / 1000,
      ascenderPolarityScore: Math.round(ascenderPolarityScore * 1000) / 1000,
      roi,
      reason,
      correctedBuffer,
      votes,
      exifApplied,
      inkCoverage: Math.round(inkCoverage * 10000) / 10000,
      elapsedMs: Date.now() - started,
    };
  }

  /**
   * Apply the final rotation to the FULL-RESOLUTION parent buffer.
   * - Pure-rotation EXIF tags are combined with the content angle into ONE
   *   lossless sharp pass (90° multiples are pure transposes — no resampling).
   * - Mirror-tagged inputs (2/4/5/7) are baked first, then rotated.
   * - angle 0 with no EXIF returns the ORIGINAL buffer untouched (zero
   *   re-encode, zero quality loss).
   * EXIF is intentionally not preserved: the output geometry is already
   * upright, so a stale orientation tag would cause double rotation.
   */
  private async applyRotation(
    originalInput: Buffer,
    baseBuffer: Buffer,
    needsMirrorBake: boolean,
    exifCw: number,
    contentAngle: RightAngleRotation
  ): Promise<Buffer> {
    if (needsMirrorBake) {
      if (contentAngle === 0) return baseBuffer;
      return sharp(baseBuffer).rotate(contentAngle).toBuffer();
    }
    const totalAngle = ((((exifCw + contentAngle) % 360) + 360) % 360) as RightAngleRotation;
    if (totalAngle === 0) return originalInput;
    return sharp(originalInput).rotate(totalAngle).toBuffer();
  }
}

// Shared engine instance — the class is stateless, so concurrent requests are safe.
const engine = new HandwrittenDocumentOrientationEngine();

export async function analyzeAndCorrectBufferOrientation(
  inputBuffer: Buffer,
  options: OrientationEngineOptions = { returnRotatedBuffer: true }
): Promise<OrientationAnalysisResult> {
  return engine.analyzeAndCorrectBuffer(inputBuffer, options);
}

export async function handleAutoOrientRoute(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    let imageBuffer: Buffer | null = null;

    if (req.file && req.file.buffer) {
      imageBuffer = req.file.buffer;
    } else if (req.body && req.body.imageBase64) {
      const base64Data = req.body.imageBase64.replace(/^data:image\/\w+;base64,/, '');
      imageBuffer = Buffer.from(base64Data, 'base64');
    }

    if (!imageBuffer) {
      res.status(400).json({
        success: false,
        error: 'No image buffer provided. Send multipart form-data "image" or JSON "imageBase64".',
      });
      return;
    }

    // Callers that only need the detected angle (e.g. the web UI applies the
    // rotation itself) can skip the expensive full-resolution re-encode.
    const skipRotatedBuffer =
      req.body?.rotatedBuffer === 'false' ||
      req.body?.rotatedBuffer === false ||
      req.body?.returnRotatedBuffer === false;

    const result = await analyzeAndCorrectBufferOrientation(imageBuffer, {
      returnRotatedBuffer: !skipRotatedBuffer,
    });

    res.json({
      success: true,
      detectedRotation: result.detectedRotation,
      confidence: result.confidence,
      isSideways: result.isSideways,
      textAxis: result.textAxis,
      periodicityRatio: result.periodicityRatio,
      horizontalPeriodicityScore: result.horizontalPeriodicityScore,
      verticalPeriodicityScore: result.verticalPeriodicityScore,
      ascenderPolarityScore: result.ascenderPolarityScore,
      roi: result.roi,
      reason: result.reason,
      votes: result.votes,
      exifApplied: result.exifApplied,
      inkCoverage: result.inkCoverage,
      elapsedMs: result.elapsedMs,
      needsRotation: result.detectedRotation !== 0,
      correctedBase64: result.correctedBuffer
        ? `data:image/jpeg;base64,${result.correctedBuffer.toString('base64')}`
        : null,
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Failed to process document orientation.';
    res.status(500).json({
      success: false,
      error: message,
    });
  }
}
