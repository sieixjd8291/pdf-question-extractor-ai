import { isSaneQuad, warpQuadToCanvas, type ScanQuad } from './scannerFilters';
import { detectOrientationWithModel, isReliableOrientation } from './mlOrientation';

export interface DocumentOrientationResult {
  /** The suggested absolute rotation angle (0, 90, 180, 270) */
  suggestedRotation: 0 | 90 | 180 | 270;
  /** Relative rotation needed from the current orientation (0, 90, 180, or 270) */
  rotationDelta: 0 | 90 | 180 | 270;
  /** Parsed EXIF orientation tag from image metadata (1-8) if present */
  exifOrientationTag?: number;
  /** Human-readable EXIF orientation label */
  exifOrientationLabel?: string;
  /** Whether the fallback visual-analysis engine was used */
  usedVisualAnalysisFallback?: boolean;
  /** Whether horizontal flip is needed (strictly false - pure rotation only) */
  isMirroredHorizontally?: boolean;
  needsFlipHorizontal?: boolean;
  /** Confidence score between 0.0 and 1.0 */
  confidence: number;
  /** Primary text reading line orientation */
  textDirection: 'horizontal' | 'vertical' | 'ambiguous';
  /** Whether the document requires rotation to be upright */
  needsRotation: boolean;
  /** Detected document aspect ratio (width / height) */
  aspectRatio: number;
  /** Source of detection: on-device model, cloud AI, or heuristic CV */
  source?: 'ml' | 'ai' | 'cv';
  /** Explanation */
  reason?: string;
}

type RightAngle = 0 | 90 | 180 | 270;

const RIGHT_ANGLES: RightAngle[] = [0, 90, 180, 270];

/** Working resolution for high-precision local computer vision analysis (~15-20ms). */
const CV_WORK_MAX_DIM = 720;

function normalizeAngle(deg: number): RightAngle {
  return ((((deg % 360) + 360) % 360) as RightAngle);
}

/**
 * EXIF Orientation Tag Descriptions (TIFF Tag 0x0112).
 */
const EXIF_TAG_DESCRIPTIONS: Record<number, string> = {
  1: 'Top-Left (0° - Normal)',
  2: 'Top-Right (Mirrored horizontally)',
  3: 'Bottom-Right (180° - Upside Down)',
  4: 'Bottom-Left (Mirrored vertically)',
  5: 'Left-Top (90° CCW + Mirrored)',
  6: 'Right-Top (90° CW - Sideways Right)',
  7: 'Right-Bottom (90° CW + Mirrored)',
  8: 'Left-Bottom (270° CW / 90° CCW - Sideways Left)',
};

/**
 * Extracts the EXIF Orientation tag (1-8) from raw image binary data.
 */
export function extractExifOrientation(buffer: ArrayBuffer | Uint8Array): {
  tag: number;
  label: string;
  isAmbiguousOrNormal: boolean;
} {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 14) {
    return { tag: 1, label: EXIF_TAG_DESCRIPTIONS[1], isAmbiguousOrNormal: true };
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset < bytes.length - 4) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === 0xe1) {
        const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
        const exifHeader = offset + 4;
        if (
          bytes[exifHeader] === 0x45 &&
          bytes[exifHeader + 1] === 0x78 &&
          bytes[exifHeader + 2] === 0x69 &&
          bytes[exifHeader + 3] === 0x66 &&
          bytes[exifHeader + 4] === 0x00 &&
          bytes[exifHeader + 5] === 0x00
        ) {
          const tiffStart = exifHeader + 6;
          const isLittle = bytes[tiffStart] === 0x49 && bytes[tiffStart + 1] === 0x49;
          const read16 = (pos: number) =>
            isLittle
              ? bytes[pos] | (bytes[pos + 1] << 8)
              : (bytes[pos] << 8) | bytes[pos + 1];
          const read32 = (pos: number) =>
            isLittle
              ? bytes[pos] |
                (bytes[pos + 1] << 8) |
                (bytes[pos + 2] << 16) |
                (bytes[pos + 3] << 24)
              : (bytes[pos] << 24) |
                (bytes[pos + 1] << 16) |
                (bytes[pos + 2] << 8) |
                bytes[pos + 3];

          const ifdOffset = read32(tiffStart + 4);
          if (ifdOffset < bytes.length - tiffStart) {
            const ifdStart = tiffStart + ifdOffset;
            const entriesCount = read16(ifdStart);
            for (let i = 0; i < entriesCount; i++) {
              const entryPos = ifdStart + 2 + i * 12;
              if (entryPos + 12 > bytes.length) break;
              const tag = read16(entryPos);
              if (tag === 0x0112) {
                const val = read16(entryPos + 8);
                if (val >= 1 && val <= 8) {
                  return {
                    tag: val,
                    label: EXIF_TAG_DESCRIPTIONS[val] || `Tag ${val}`,
                    isAmbiguousOrNormal: val === 1,
                  };
                }
              }
            }
          }
        }
        offset += length + 2;
      } else if (marker === 0xd9 || marker === 0xda) {
        break;
      } else {
        const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
        offset += length + 2;
      }
    }
  }

  return { tag: 1, label: EXIF_TAG_DESCRIPTIONS[1], isAmbiguousOrNormal: true };
}

/**
 * Renders a source image onto an offscreen canvas at a specified clockwise rotation,
 * normalized to a bounding dimension for high-speed processing.
 * Strictly performs pure geometric rotation with zero flipping or mirroring.
 */
function renderRotatedBitmap(
  source: HTMLImageElement | HTMLCanvasElement,
  rotation: RightAngle,
  maxDim: number = 420
): HTMLCanvasElement | null {
  const origW = (source as HTMLImageElement).naturalWidth || source.width || 1;
  const origH = (source as HTMLImageElement).naturalHeight || source.height || 1;

  const is90or270 = rotation === 90 || rotation === 270;
  const targetW = is90or270 ? origH : origW;
  const targetH = is90or270 ? origW : origH;

  const scale = Math.min(1, maxDim / Math.max(targetW, targetH));
  const workW = Math.max(64, Math.round(targetW * scale));
  const workH = Math.max(64, Math.round(targetH * scale));

  const drawScaledW = Math.max(1, Math.round(origW * scale));
  const drawScaledH = Math.max(1, Math.round(origH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = workW;
  canvas.height = workH;
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!ctx) return null;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, workW, workH);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  ctx.save();
  ctx.translate(workW / 2, workH / 2);
  if (rotation !== 0) {
    ctx.rotate((rotation * Math.PI) / 180);
  }
  ctx.drawImage(source, -drawScaledW / 2, -drawScaledH / 2, drawScaledW, drawScaledH);
  ctx.restore();

  return canvas;
}

/**
 * Detects uniform solid letterbox/pillarbox bars commonly present in screenshots or screen captures
 * and returns the inner content bounding box [x0, y0, x1, y1].
 */
function detectLetterboxBounds(gray: Float32Array, w: number, h: number): { x0: number; x1: number; y0: number; y1: number } {
  let y0 = 0;
  let y1 = h;
  let x0 = 0;
  let x1 = w;

  const maxCropY = Math.floor(h * 0.22);
  const maxCropX = Math.floor(w * 0.22);

  // Top letterbox / status bar (solid black or near-uniform dark background < 12% brightness)
  for (let y = 0; y < maxCropY; y++) {
    let rowSum = 0;
    const rOffset = y * w;
    for (let x = 0; x < w; x++) rowSum += gray[rOffset + x];
    const mean = rowSum / w;
    if (mean < 0.12) y0 = y + 1;
    else break;
  }

  // Bottom letterbox
  for (let y = h - 1; y >= h - maxCropY; y--) {
    let rowSum = 0;
    const rOffset = y * w;
    for (let x = 0; x < w; x++) rowSum += gray[rOffset + x];
    const mean = rowSum / w;
    if (mean < 0.12) y1 = y;
    else break;
  }

  // Left pillarbox
  for (let x = 0; x < maxCropX; x++) {
    let colSum = 0;
    for (let y = y0; y < y1; y++) colSum += gray[y * w + x];
    const mean = colSum / Math.max(1, y1 - y0);
    if (mean < 0.12) x0 = x + 1;
    else break;
  }

  // Right pillarbox
  for (let x = w - 1; x >= w - maxCropX; x--) {
    let colSum = 0;
    for (let y = y0; y < y1; y++) colSum += gray[y * w + x];
    const mean = colSum / Math.max(1, y1 - y0);
    if (mean < 0.12) x1 = x;
    else break;
  }

  // Only apply if the cropped box contains at least 40% of the original area
  if ((x1 - x0) * (y1 - y0) >= w * h * 0.40) {
    return { x0, x1, y0, y1 };
  }
  return { x0: 0, x1: w, y0: 0, y1: h };
}

/**
 * Extracts ink binary mask using integral-image adaptive local thresholding.
 */
function extractInkMask(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number
): { ink: Uint8Array; totalInk: number } {
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;
  const n = w * h;

  const gray = new Float32Array(n);
  let lumaSum = 0;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const l = (data[j] * 0.299 + data[j + 1] * 0.587 + data[j + 2] * 0.114) / 255.0;
    gray[i] = l;
    lumaSum += l;
  }
  const meanLuma = lumaSum / n;

  // Detect and clip off solid outer letterbox bars (e.g. black bars in screenshots)
  const lb = detectLetterboxBounds(gray, w, h);

  const ink = new Uint8Array(n);
  const blockSize = Math.max(8, Math.round(w / 18));
  const halfBlock = Math.floor(blockSize / 2);

  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    const rOffset = y * w;
    const intOffset = (y + 1) * (w + 1);
    const intPrevOffset = y * (w + 1);
    for (let x = 0; x < w; x++) {
      rowSum += gray[rOffset + x];
      integral[intOffset + x + 1] = integral[intPrevOffset + x + 1] + rowSum;
    }
  }

  // Margin buffer inside content boundary to ignore outer frame artifacts
  const marginX = Math.max(2, Math.round((lb.x1 - lb.x0) * 0.025));
  const marginY = Math.max(2, Math.round((lb.y1 - lb.y0) * 0.025));

  const startY = Math.max(0, lb.y0 + marginY);
  const endY = Math.min(h, lb.y1 - marginY);
  const startX = Math.max(0, lb.x0 + marginX);
  const endX = Math.min(w, lb.x1 - marginX);

  let totalInk = 0;
  for (let y = startY; y < endY; y++) {
    const y0 = Math.max(0, y - halfBlock);
    const y1 = Math.min(h, y + halfBlock + 1);
    const rOffset = y * w;
    for (let x = startX; x < endX; x++) {
      const x0 = Math.max(0, x - halfBlock);
      const x1 = Math.min(w, x + halfBlock + 1);
      const area = (x1 - x0) * (y1 - y0);

      const sum =
        integral[y1 * (w + 1) + x1] -
        integral[y0 * (w + 1) + x1] -
        integral[y1 * (w + 1) + x0] +
        integral[y0 * (w + 1) + x0];
      const localMean = sum / area;

      if (
        gray[rOffset + x] < localMean * 0.90 ||
        (gray[rOffset + x] < meanLuma * 0.85 && gray[rOffset + x] < 0.70)
      ) {
        ink[rOffset + x] = 1;
        totalInk++;
      }
    }
  }

  return { ink, totalInk };
}

/**
 * Removes long straight strokes — notebook ruling, margin lines, table borders,
 * page edges and the book spine. They carry no up/down information but dominate
 * row/column projections and hide the real text-line shape.
 */
function removeRuledLines(ink: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(ink);
  const minH = Math.max(20, Math.round(w * 0.18));
  const minV = Math.max(20, Math.round(h * 0.18));

  for (let y = 0; y < h; y++) {
    const row = y * w;
    let runStart = -1;
    for (let x = 0; x <= w; x++) {
      const on = x < w && ink[row + x] === 1;
      if (on && runStart === -1) runStart = x;
      else if (!on && runStart !== -1) {
        if (x - runStart >= minH) out.fill(0, row + runStart, row + x);
        runStart = -1;
      }
    }
  }

  for (let x = 0; x < w; x++) {
    let runStart = -1;
    for (let y = 0; y <= h; y++) {
      const on = y < h && ink[y * w + x] === 1;
      if (on && runStart === -1) runStart = y;
      else if (!on && runStart !== -1) {
        if (y - runStart >= minV) {
          for (let yy = runStart; yy < y; yy++) out[yy * w + x] = 0;
        }
        runStart = -1;
      }
    }
  }

  return out;
}

const calcVariance = (arr: ArrayLike<number>) => {
  let mean = 0;
  for (let i = 0; i < arr.length; i++) mean += arr[i];
  mean /= Math.max(1, arr.length);
  let v = 0;
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i] - mean;
    v += d * d;
  }
  return v / Math.max(1, arr.length);
};

/**
 * Ascender vs descender polarity — the strongest local cue for 0° vs 180°.
 * In Latin script & digits, strokes rising above the x-height core (b d f h k l t,
 * capitals, digits, i-dots) are far more common than strokes dropping below the
 * baseline (g j p q y). Upright lines therefore carry more ink ABOVE their dense
 * core than below it; rotating 180° mirrors this exactly, so the sign flips.
 * Lines are measured in vertical strips so skew and two-page spreads don't merge
 * neighbouring lines together. Returns roughly −1…1 (positive = upright).
 */
function computeAscenderPolarity(
  ink: Uint8Array,
  w: number,
  h: number,
  roi: { x: number; y: number; w: number; h: number }
): number {
  const marginX = Math.max(0, Math.min(roi.x, w - 1));
  const marginY = Math.max(0, Math.min(roi.y, h - 1));
  const innerW = Math.max(10, Math.min(roi.w, w - marginX));
  const innerH = Math.max(10, Math.min(roi.h, h - marginY));
  const strips = innerW > 600 ? 6 : 4;
  const stripW = Math.floor(innerW / strips);
  if (stripW < 20 || innerH < 40) return 0;

  const proj = new Float32Array(innerH);
  const maxBandH = Math.max(12, Math.round(innerH * 0.12));
  let upperTotal = 0;
  let lowerTotal = 0;
  let bands = 0;

  for (let s = 0; s < strips; s++) {
    const x0 = marginX + s * stripW;
    const x1 = x0 + stripW;
    for (let y = 0; y < innerH; y++) {
      const row = (marginY + y) * w;
      let sum = 0;
      for (let x = x0; x < x1; x++) sum += ink[row + x];
      proj[y] = sum;
    }

    const gapThreshold = Math.max(1, stripW * 0.01);
    let y = 0;
    while (y < innerH) {
      if (proj[y] <= gapThreshold) {
        y++;
        continue;
      }
      const start = y;
      while (y < innerH && proj[y] > gapThreshold) y++;
      const end = y; // exclusive
      const bandH = end - start;
      if (bandH < 5 || bandH > maxBandH) continue;

      let peak = 0;
      let bandInk = 0;
      for (let i = start; i < end; i++) {
        if (proj[i] > peak) peak = proj[i];
        bandInk += proj[i];
      }
      if (bandInk < stripW * 0.4) continue;

      const coreThreshold = peak * 0.5;
      let coreTop = start;
      while (coreTop < end && proj[coreTop] < coreThreshold) coreTop++;
      let coreBot = end - 1;
      while (coreBot > coreTop && proj[coreBot] < coreThreshold) coreBot--;

      let upper = 0;
      for (let i = start; i < coreTop; i++) upper += proj[i];
      let lower = 0;
      for (let i = coreBot + 1; i < end; i++) lower += proj[i];

      upperTotal += upper;
      lowerTotal += lower;
      bands++;
    }
  }

  if (bands < 4 || upperTotal + lowerTotal < 30) return 0;
  return (upperTotal - lowerTotal) / (upperTotal + lowerTotal);
}

/**
 * Character glyph vertical center-of-mass polarity.
 * Evaluates individual character connected components.
 * In Latin, digits, equations & punctuation, upper glyph halves carry top bars, serifs, dots,
 * and ascender structures. Center-of-mass sits above the vertical midpoint in upright text.
 */
function computeGlyphCentroidPolarity(
  textMask: Uint8Array,
  w: number,
  h: number
): number {
  const minSize = 6;
  const maxSize = Math.round(Math.max(w, h) * 0.14);
  const visited = new Uint8Array(w * h);
  let totalUpperWeight = 0;
  let totalLowerWeight = 0;
  let count = 0;

  const step = 2; // Fast grid scan
  for (let y = 10; y < h - 10; y += step) {
    const rOffset = y * w;
    for (let x = 10; x < w - 10; x += step) {
      const idx = rOffset + x;
      if (textMask[idx] === 1 && visited[idx] === 0) {
        let minX = x, maxX = x, minY = y, maxY = y;
        let pixelCount = 0;
        let sumY = 0;

        const queue: number[] = [idx];
        visited[idx] = 1;

        while (queue.length > 0 && queue.length < 1200) {
          const curr = queue.pop()!;
          const cy = Math.floor(curr / w);
          const cx = curr % w;

          pixelCount++;
          sumY += cy;

          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;

          if (cy > 0 && textMask[curr - w] === 1 && visited[curr - w] === 0) {
            visited[curr - w] = 1;
            queue.push(curr - w);
          }
          if (cy < h - 1 && textMask[curr + w] === 1 && visited[curr + w] === 0) {
            visited[curr + w] = 1;
            queue.push(curr + w);
          }
          if (cx > 0 && textMask[curr - 1] === 1 && visited[curr - 1] === 0) {
            visited[curr - 1] = 1;
            queue.push(curr - 1);
          }
          if (cx < w - 1 && textMask[curr + 1] === 1 && visited[curr + 1] === 0) {
            visited[curr + 1] = 1;
            queue.push(curr + 1);
          }
        }

        const compW = maxX - minX + 1;
        const compH = maxY - minY + 1;

        if (compW >= 3 && compH >= minSize && compH <= maxSize && pixelCount >= 8) {
          const yCom = sumY / pixelCount;
          const yMid = minY + compH / 2.0;
          const bias = (yMid - yCom) / compH;
          if (bias > 0) {
            totalUpperWeight += bias * pixelCount;
          } else {
            totalLowerWeight += -bias * pixelCount;
          }
          count++;
        }
      }
    }
  }

  if (count < 5 || totalUpperWeight + totalLowerWeight < 1e-4) return 0;
  return (totalUpperWeight - totalLowerWeight) / (totalUpperWeight + totalLowerWeight);
}

interface LayoutScores {
  /** > 1 means text lines run horizontally in this candidate */
  axisScore: number;
  /** Combined up/down polarity; positive = candidate looks upright */
  uprightPolarityScore: number;
  ltrMarginScore: number;
  headerDensityScore: number;
  ascenderMassScore: number;
  glyphCentroidScore: number;
  /** Normalized (0..1) center of the detected ROI within this candidate frame. */
  roiCenterX: number;
  roiCenterY: number;
}

function calcProjectionOscillation(proj: Float32Array): number {
  if (proj.length < 10) return 0;
  let diffSum = 0;
  for (let i = 1; i < proj.length; i++) {
    const d = proj[i] - proj[i - 1];
    diffSum += d * d;
  }
  return diffSum / (proj.length - 1);
}

/**
 * Removes SOLID dark bands: rows/columns whose ink fraction exceeds 50%.
 * Real text rows never exceed ~30% ink; book-spine shadows, cover strips and
 * page-edge borders do. Left in place they bridge the two pages of a notebook
 * spread into one giant "cluster" and destroy the ROI segmentation.
 */
function removeSolidBands(ink: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(ink);
  const limitW = Math.round(w * 0.5);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let count = 0;
    for (let x = 0; x < w; x++) count += out[row + x];
    if (count > limitW) out.fill(0, row, row + w);
  }
  const limitH = Math.round(h * 0.5);
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y < h; y++) count += out[y * w + x];
    if (count > limitH) {
      for (let y = 0; y < h; y++) out[y * w + x] = 0;
    }
  }
  return out;
}

/**
 * Splits a region at vertical gutters (near-empty column runs) and returns
 * the block with the most ink — the main text column.
 */
function findDominantTextColumn(
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
  if (total < 1 || rw < 60) return { x: rx, w: rw };

  const r = Math.max(2, Math.round(rw * 0.006));
  const smoothed = new Float32Array(rw);
  for (let x = 0; x < rw; x++) {
    let s = 0;
    let n = 0;
    for (let k = Math.max(0, x - r); k <= Math.min(rw - 1, x + r); k++) {
      s += colProj[k];
      n++;
    }
    smoothed[x] = s / n;
  }

  const gutterLevel = (total / rw) * 0.18;
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

interface CellComponent {
  cells: number;
  minGx: number;
  maxGx: number;
  minGy: number;
  maxGy: number;
}

/**
 * Intensity-Based Text Cluster Bounding (ROI Detection).
 * Grid cells with dense ink are merged into "content block fields" by a
 * broad dilation of the cell grid, then connected-component labelling picks
 * the SINGLE largest dense cluster (the written page). Stray noise fields,
 * the blank neighbouring page and outer margins are ignored — the bounding
 * box can never silently grow to span the whole frame.
 */
function detectClientTextClusterROI(
  mask: Uint8Array,
  width: number,
  height: number
): { x: number; y: number; w: number; h: number } {
  const blockSize = Math.max(12, Math.round(Math.min(width, height) * 0.035));
  const gridW = Math.ceil(width / blockSize);
  const gridH = Math.ceil(height / blockSize);
  const densityGrid = new Float32Array(gridW * gridH);

  let maxDensity = 0;

  for (let gy = 0; gy < gridH; gy++) {
    const y0 = gy * blockSize;
    const y1 = Math.min(height, y0 + blockSize);
    const hBlock = y1 - y0;

    for (let gx = 0; gx < gridW; gx++) {
      const x0 = gx * blockSize;
      const x1 = Math.min(width, x0 + blockSize);
      const wBlock = x1 - x0;
      const area = wBlock * hBlock;

      let inkCount = 0;
      for (let y = y0; y < y1; y++) {
        const rowOffset = y * width;
        for (let x = x0; x < x1; x++) {
          inkCount += mask[rowOffset + x];
        }
      }

      const density = inkCount / area;
      densityGrid[gy * gridW + gx] = density;
      if (density > maxDensity) maxDensity = density;
    }
  }

  const activeThreshold = Math.max(0.015, maxDensity * 0.12);
  const active = new Uint8Array(gridW * gridH);
  let activeBlockCount = 0;
  for (let i = 0; i < gridW * gridH; i++) {
    if (densityGrid[i] >= activeThreshold) {
      active[i] = 1;
      activeBlockCount++;
    }
  }

  // No meaningful content — centered inset fallback (caller treats it as ROI).
  if (activeBlockCount < 4) {
    const marginX = Math.round(width * 0.035);
    const marginY = Math.round(height * 0.035);
    return {
      x: marginX,
      y: marginY,
      w: width - marginX * 2,
      h: height - marginY * 2,
    };
  }

  // Broad dilation of the CELL GRID (radius 1 cell ≈ 3.5% of the frame) to
  // merge neighbouring word blocks into content fields. Page gutters are much
  // wider than this and stay separate.
  const dilateRadius = 1;
  const dilated = new Uint8Array(gridW * gridH);
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      if (active[gy * gridW + gx] === 0) continue;
      for (let dy = -dilateRadius; dy <= dilateRadius; dy++) {
        const ny = gy + dy;
        if (ny < 0 || ny >= gridH) continue;
        for (let dx = -dilateRadius; dx <= dilateRadius; dx++) {
          const nx = gx + dx;
          if (nx < 0 || nx >= gridW) continue;
          dilated[ny * gridW + nx] = 1;
        }
      }
    }
  }

  // Connected-component labelling on the small cell grid (4-connectivity).
  const visited = new Uint8Array(gridW * gridH);
  const queue: number[] = [];
  const components: CellComponent[] = [];

  for (let start = 0; start < gridW * gridH; start++) {
    if (dilated[start] === 0 || visited[start] === 1) continue;
    queue.length = 0;
    queue.push(start);
    visited[start] = 1;

    const comp: CellComponent = { cells: 0, minGx: gridW, maxGx: -1, minGy: gridH, maxGy: -1 };
    while (queue.length > 0) {
      const idx = queue.pop()!;
      const cy = Math.floor(idx / gridW);
      const cx = idx - cy * gridW;
      comp.cells++;
      if (cx < comp.minGx) comp.minGx = cx;
      if (cx > comp.maxGx) comp.maxGx = cx;
      if (cy < comp.minGy) comp.minGy = cy;
      if (cy > comp.maxGy) comp.maxGy = cy;

      if (cx > 0 && dilated[idx - 1] === 1 && visited[idx - 1] === 0) {
        visited[idx - 1] = 1;
        queue.push(idx - 1);
      }
      if (cx < gridW - 1 && dilated[idx + 1] === 1 && visited[idx + 1] === 0) {
        visited[idx + 1] = 1;
        queue.push(idx + 1);
      }
      if (cy > 0 && dilated[idx - gridW] === 1 && visited[idx - gridW] === 0) {
        visited[idx - gridW] = 1;
        queue.push(idx - gridW);
      }
      if (cy < gridH - 1 && dilated[idx + gridW] === 1 && visited[idx + gridW] === 0) {
        visited[idx + gridW] = 1;
        queue.push(idx + gridW);
      }
    }
    components.push(comp);
  }

  components.sort((a, b) => b.cells - a.cells);

  // Walk the largest clusters (largest first); accept the first one whose
  // bounding box actually contains dense handwriting ink. This rejects the
  // blank ruled page and low-density noise fields.
  const totalPixels = width * height;
  for (let i = 0; i < Math.min(4, components.length); i++) {
    const comp = components[i];
    const gx0 = Math.max(0, comp.minGx - 1);
    const gy0 = Math.max(0, comp.minGy - 1);
    const gx1 = Math.min(gridW - 1, comp.maxGx + 1);
    const gy1 = Math.min(gridH - 1, comp.maxGy + 1);

    const roiX = gx0 * blockSize;
    const roiY = gy0 * blockSize;
    const roiW = Math.min(width - roiX, (gx1 + 1) * blockSize - roiX);
    const roiH = Math.min(height - roiY, (gy1 + 1) * blockSize - roiY);
    if (roiW <= 0 || roiH <= 0) continue;

    const boxArea = roiW * roiH;
    if (boxArea < totalPixels * 0.04) continue;

    // Density inside the candidate box must look like real writing.
    let inkInside = 0;
    for (let gy = gy0; gy <= gy1; gy++) {
      const y0 = gy * blockSize;
      const y1 = Math.min(height, y0 + blockSize);
      for (let gx = gx0; gx <= gx1; gx++) {
        const x0 = gx * blockSize;
        const x1 = Math.min(width, x0 + blockSize);
        const cellArea = (x1 - x0) * (y1 - y0);
        inkInside += densityGrid[gy * gridW + gx] * cellArea;
      }
    }
    const inkDensity = inkInside / boxArea;
    if (inkDensity < 0.035) continue;

    return { x: roiX, y: roiY, w: roiW, h: roiH };
  }

  // No trustworthy cluster — centered inset fallback.
  const marginX = Math.round(width * 0.035);
  const marginY = Math.round(height * 0.035);
  return {
    x: marginX,
    y: marginY,
    w: width - marginX * 2,
    h: height - marginY * 2,
  };
}

/** Clamp a rectangle so it lies fully inside a w×h frame (min size 1×1). */
function clampRect(
  r: { x: number; y: number; w: number; h: number },
  w: number,
  h: number
): { x: number; y: number; w: number; h: number } {
  const x = Math.max(0, Math.min(r.x, w - 1));
  const y = Math.max(0, Math.min(r.y, h - 1));
  return {
    x,
    y,
    w: Math.max(1, Math.min(r.w, w - x)),
    h: Math.max(1, Math.min(r.h, h - y)),
  };
}

/**
 * Maps a rectangle from the 0° frame through quarterTurns × 90° clockwise —
 * the exact transform renderRotatedBitmap applies between candidate frames —
 * so every rotation candidate can be scored on the SAME text cluster instead
 * of re-detecting (and possibly jumping to a different cluster) per frame.
 */
function mapRectThroughTurns(
  rect: { x: number; y: number; w: number; h: number },
  w: number,
  h: number,
  quarterTurns: 0 | 1 | 2 | 3
): { x: number; y: number; w: number; h: number } {
  const t = quarterTurns % 4;
  if (t === 0) return { ...rect };
  if (t === 1) return { x: h - rect.y - rect.h, y: rect.x, w: rect.h, h: rect.w };
  if (t === 2) return { x: w - rect.x - rect.w, y: h - rect.y - rect.h, w: rect.w, h: rect.h };
  return { x: rect.y, y: w - rect.x - rect.w, w: rect.h, h: rect.w };
}

/**
 * Optical Layout Alignment & Text Line Analysis.
 * Evaluates dimension-normalized horizontal/vertical projections, run-energies,
 * periodic line oscillations, ascender asymmetry, and glyph centroids within ROI.
 */
function analyzeOpticalLayoutAlignment(
  ink: Uint8Array,
  w: number,
  h: number,
  roiOverride?: { x: number; y: number; w: number; h: number }
): LayoutScores {
  // Polarity cues and axis striations work on clean text strokes only.
  // Solid bands (spine shadows / cover strips) go first, then ruling lines.
  const text = removeRuledLines(removeSolidBands(ink, w, h), w, h);

  // 1. Isolate Dense Text Cluster Region of Interest (ROI). When the caller
  // supplies a pre-mapped ROI (the same cluster in this candidate's frame),
  // use it verbatim so all four candidates are scored on the same region.
  const roi = roiOverride ? clampRect(roiOverride, w, h) : detectClientTextClusterROI(text, w, h);
  const innerW = roi.w;
  const innerH = roi.h;
  const marginX = roi.x;
  const marginY = roi.y;

  // 2. Normalized Horizontal vs Vertical Projections & Run Energies inside ROI
  const normRowProj = new Float32Array(innerH);
  for (let y = 0; y < innerH; y++) {
    const rOffset = (marginY + y) * w + marginX;
    let sum = 0;
    for (let x = 0; x < innerW; x++) sum += text[rOffset + x];
    normRowProj[y] = sum / innerW; // Density in [0, 1]
  }

  const normColProj = new Float32Array(innerW);
  for (let x = 0; x < innerW; x++) {
    let sum = 0;
    for (let y = 0; y < innerH; y++) sum += text[(marginY + y) * w + marginX + x];
    normColProj[x] = sum / innerH; // Density in [0, 1]
  }

  const rowVar = calcVariance(normRowProj);
  const colVar = calcVariance(normColProj);

  // Periodic waveform oscillation (text lines create periodic crests and troughs)
  const rowOscillation = calcProjectionOscillation(normRowProj);
  const colOscillation = calcProjectionOscillation(normColProj);

  // Horizontal vs Vertical run energies (normalized to stroke dimensions)
  const smearH = Math.max(3, Math.round(innerW * 0.02));
  const smearV = Math.max(3, Math.round(innerH * 0.02));

  let hRunEnergy = 0;
  for (let y = 0; y < innerH; y++) {
    const rOffset = (marginY + y) * w + marginX;
    let runLen = 0;
    for (let x = 0; x < innerW; x++) {
      if (text[rOffset + x]) {
        runLen++;
      } else {
        if (runLen >= smearH) hRunEnergy += runLen * runLen;
        runLen = 0;
      }
    }
    if (runLen >= smearH) hRunEnergy += runLen * runLen;
  }

  let vRunEnergy = 0;
  for (let x = 0; x < innerW; x++) {
    let runLen = 0;
    for (let y = 0; y < innerH; y++) {
      if (text[(marginY + y) * w + marginX + x]) {
        runLen++;
      } else {
        if (runLen >= smearV) vRunEnergy += runLen * runLen;
        runLen = 0;
      }
    }
    if (runLen >= smearV) vRunEnergy += runLen * runLen;
  }

  const normHRun = hRunEnergy / (innerH * innerW * innerW + 1e-4);
  const normVRun = vRunEnergy / (innerW * innerH * innerH + 1e-4);

  const hRunRatio = (normHRun + 1e-5) / (normVRun + 1e-5);
  const varRatio = (rowVar + 1e-5) / (colVar + 1e-5);
  const oscRatio = (rowOscillation + 1e-5) / (colOscillation + 1e-5);

  const axisScore = hRunRatio * 0.35 + varRatio * 0.35 + oscRatio * 0.30;

  // 2. Top header vs bottom margin distribution — measured INSIDE the ROI so
  // the blank half of a notebook spread cannot bias the score.
  const topH = Math.round(innerH * 0.22);
  const botH = Math.round(innerH * 0.22);
  let topInk = 0;
  let botInk = 0;
  for (let y = marginY; y < Math.min(h, marginY + topH); y++) {
    const rOffset = y * w;
    for (let x = marginX; x < Math.min(w, marginX + innerW); x++) topInk += text[rOffset + x];
  }
  for (let y = Math.max(0, marginY + innerH - botH); y < Math.min(h, marginY + innerH); y++) {
    const rOffset = y * w;
    for (let x = marginX; x < Math.min(w, marginX + innerW); x++) botInk += text[rOffset + x];
  }
  const headerDensityScore = (topInk - botInk) / (topInk + botInk + 1e-4);

  // 3. Straight left margin vs ragged right margin (LTR text flow), measured
  // inside the dominant text column only — across a two-page spread the line
  // "starts" would land on the other page and invert the cue.
  const column = findDominantTextColumn(text, w, marginX, marginY, innerW, innerH);
  const lineStarts: number[] = [];
  const lineEnds: number[] = [];
  for (let y = marginY; y < Math.min(h - 1, marginY + innerH); y += 3) {
    const rOffset = y * w;
    let firstX = -1;
    let lastX = -1;
    for (let x = column.x; x < Math.min(w - 1, column.x + column.w); x++) {
      if (text[rOffset + x]) {
        if (firstX === -1) firstX = x;
        lastX = x;
      }
    }
    if (firstX !== -1 && lastX - firstX > 15) {
      lineStarts.push(firstX);
      lineEnds.push(lastX);
    }
  }
  let ltrMarginScore = 0;
  if (lineStarts.length >= 6) {
    const startVar = calcVariance(lineStarts);
    const endVar = calcVariance(lineEnds);
    ltrMarginScore = (endVar - startVar) / (endVar + startVar + 1e-4);
  }

  // 4. Ascender vs descender mass & connected glyph center-of-mass
  const ascenderMassScore = computeAscenderPolarity(text, w, h, roi);
  const glyphCentroidScore = computeGlyphCentroidPolarity(text, w, h);

  // When the fragile LTR cue contradicts a clear ascender reading, down-weight
  // it instead of letting the two cancel out.
  const ltrDisagrees = ascenderMassScore * ltrMarginScore < 0 && Math.abs(ascenderMassScore) >= 0.15;
  const ltrWeight = ltrDisagrees ? 0.08 : 0.35;
  const uprightPolarityScore =
    ascenderMassScore * (0.35 + (0.35 - ltrWeight)) +
    ltrMarginScore * ltrWeight +
    glyphCentroidScore * 0.20 +
    headerDensityScore * 0.10;

  return {
    axisScore,
    uprightPolarityScore,
    ltrMarginScore,
    headerDensityScore,
    ascenderMassScore,
    glyphCentroidScore,
    roiCenterX: (roi.x + roi.w / 2) / w,
    roiCenterY: (roi.y + roi.h / 2) / h,
  };
}

/**
 * Local (offline) document orientation engine.
 * Renders the page at each right angle, evaluates normalized axis and glyph polarity distributions,
 * and selects the true upright orientation.
 */
export function detectDocumentOrientationLocal(
  source: HTMLImageElement | HTMLCanvasElement,
  currentRotation: RightAngle = 0
): DocumentOrientationResult {
  const origW = (source as HTMLImageElement).naturalWidth || source.width || 1;
  const origH = (source as HTMLImageElement).naturalHeight || source.height || 1;

  const isRotated90or270 = currentRotation === 90 || currentRotation === 270;
  const currW = isRotated90or270 ? origH : origW;
  const currH = isRotated90or270 ? origW : origH;

  const candidateScores: Record<RightAngle, LayoutScores | null> = {
    0: null,
    90: null,
    180: null,
    270: null,
  };

  // Pass 1: render and extract ink for all four candidates.
  const frames: Array<{ w: number; h: number; ink: Uint8Array } | null> = [];
  for (const delta of RIGHT_ANGLES) {
    const absAngle = normalizeAngle(currentRotation + delta);
    const canvas = renderRotatedBitmap(source, absAngle, CV_WORK_MAX_DIM);
    if (!canvas) {
      frames.push(null);
      continue;
    }

    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!ctx) {
      frames.push(null);
      canvas.width = 0;
      canvas.height = 0;
      continue;
    }

    const { ink, totalInk } = extractInkMask(ctx, canvas.width, canvas.height);
    frames.push(
      totalInk >= 30 ? { w: canvas.width, h: canvas.height, ink } : null
    );
    canvas.width = 0;
    canvas.height = 0;
  }

  // Pass 2 — ROI CONSISTENCY: detect the text cluster ONCE on the un-rotated
  // frame and map it geometrically into every candidate frame. Re-detecting
  // per candidate let the segmentation jump between the handwriting, the
  // blank page and the notebook cover on real photos, which flattened the
  // axis comparison and made sideways pages read as "upright".
  const baseFrame = frames[0];
  let sharedRoi: { x: number; y: number; w: number; h: number } | null = null;
  if (baseFrame) {
    const baseText = removeRuledLines(
      removeSolidBands(baseFrame.ink, baseFrame.w, baseFrame.h),
      baseFrame.w,
      baseFrame.h
    );
    sharedRoi = detectClientTextClusterROI(baseText, baseFrame.w, baseFrame.h);
  }

  for (let i = 0; i < RIGHT_ANGLES.length; i++) {
    const delta = RIGHT_ANGLES[i];
    const frame = frames[i];
    if (!frame) continue;
    // sharedRoi is null when the base frame was blank — in that case each
    // candidate falls back to its own ROI detection (old behavior).
    const mappedRoi =
      sharedRoi && baseFrame
        ? mapRectThroughTurns(sharedRoi, baseFrame.w, baseFrame.h, (delta / 90) as 0 | 1 | 2 | 3)
        : undefined;
    candidateScores[delta] = analyzeOpticalLayoutAlignment(frame.ink, frame.w, frame.h, mappedRoi);
  }

  const cand0 = candidateScores[0];
  const cand90 = candidateScores[90];
  const cand180 = candidateScores[180];
  const cand270 = candidateScores[270];

  if (!cand0) {
    return {
      suggestedRotation: currentRotation,
      rotationDelta: 0,
      usedVisualAnalysisFallback: true,
      isMirroredHorizontally: false,
      needsFlipHorizontal: false,
      confidence: 0.5,
      textDirection: 'horizontal',
      needsRotation: false,
      aspectRatio: Math.round((currW / currH) * 100) / 100,
      source: 'cv',
      reason: 'Blank or minimal ink page',
    };
  }

  // 1. Axis determination (Horizontal {0°, 180°} vs Vertical {90°, 270°}).
  // axisScore is a weighted sum of ratios and can spike by orders of magnitude
  // on noisy ROIs; bounding each candidate to (0,1) via a/(a+1) keeps the
  // four-angle comparison stable.
  const boundedAxis = (c: LayoutScores | null): number =>
    c ? c.axisScore / (c.axisScore + 1) : 0;
  const meanH0_180 = (boundedAxis(cand0) + boundedAxis(cand180)) / 2;
  const meanH90_270 = (boundedAxis(cand90) + boundedAxis(cand270)) / 2;

  let chosenDelta: RightAngle = 0;
  let margin = 0;
  let reason = '';
  let textDirection: 'horizontal' | 'vertical' | 'ambiguous' = 'horizontal';

  if (meanH90_270 > meanH0_180 * 1.02) {
    textDirection = 'vertical';
    const score90 = cand90 ? cand90.uprightPolarityScore : -999;
    const score270 = cand270 ? cand270.uprightPolarityScore : -999;
    margin = Math.abs(score90 - score270);
    if (margin < 0.03 && cand0) {
      // Ascender evidence too weak to pick the ±90° sign — fall back to the
      // dense-cluster quadrant prior: a written page sitting in the top/left
      // of a portrait frame is the common "right notebook page" spread, which
      // needs a 90° CW correction.
      const d = (0.5 - cand0.roiCenterY) + (0.5 - cand0.roiCenterX) * 0.5;
      margin = 0.03;
      if (d >= 0) {
        chosenDelta = 90;
        reason = 'Sideways document: weak polarity, dense cluster in top/left quadrant => 90° clockwise';
      } else {
        chosenDelta = 270;
        reason = 'Sideways document: weak polarity, dense cluster in bottom/right quadrant => 90° counter-clockwise';
      }
    } else if (score90 >= score270) {
      chosenDelta = 90;
      reason = 'Sideways document rotated 90° clockwise to upright';
    } else {
      chosenDelta = 270;
      reason = 'Sideways document rotated 90° counter-clockwise to upright';
    }
  } else {
    const score0 = cand0 ? cand0.uprightPolarityScore : 0;
    const score180 = cand180 ? cand180.uprightPolarityScore : -999;
    margin = Math.abs(score180 - score0);
    // A 180° flip requires the LTR margin cue to independently agree with the
    // polarity cue (both must read inverted) — upright handwriting with noisy
    // polarity can then never be accidentally inverted.
    const ltrAgrees = !!cand0 && cand0.ltrMarginScore < -0.01;
    const strongAscender =
      !!cand0 && !!cand180 && cand0.ascenderMassScore < -0.2 && cand180.ascenderMassScore > 0.2;
    if (cand180 && cand0 && (ltrAgrees || strongAscender) && score180 > score0 + (ltrAgrees ? 0.015 : 0.08)) {
      chosenDelta = 180;
      reason = ltrAgrees
        ? 'Inverted document rotated 180° to upright'
        : 'Inverted document (strong ascender polarity) rotated 180° to upright';
    } else {
      chosenDelta = 0;
      reason = 'Document is upright';
    }
  }

  const suggestedRotation = normalizeAngle(currentRotation + chosenDelta);
  const isRot = suggestedRotation === 90 || suggestedRotation === 270;
  const finalAspect = isRot ? origH / origW : origW / origH;

  // Diagnostics: if auto-orientation misbehaves on a real photo, this dump
  // shows exactly which candidate/stage disagreed.
  const dumpCandidate = (c: LayoutScores | null) =>
    c
      ? {
          axis: Math.round(c.axisScore * 1000) / 1000,
          polarity: Math.round(c.uprightPolarityScore * 1000) / 1000,
          ascender: Math.round(c.ascenderMassScore * 1000) / 1000,
          ltrMargin: Math.round(c.ltrMarginScore * 1000) / 1000,
          roiCenter: [
            Math.round(c.roiCenterX * 100) / 100,
            Math.round(c.roiCenterY * 100) / 100,
          ],
        }
      : null;
  console.info('[AutoOrient:cv]', {
    currentRotation,
    chosenDelta,
    meanH0_180: Math.round(meanH0_180 * 1000) / 1000,
    meanH90_270: Math.round(meanH90_270 * 1000) / 1000,
    candidates: {
      '0': dumpCandidate(cand0),
      '90': dumpCandidate(cand90),
      '180': dumpCandidate(cand180),
      '270': dumpCandidate(cand270),
    },
  });

  return {
    suggestedRotation,
    rotationDelta: chosenDelta,
    usedVisualAnalysisFallback: true,
    isMirroredHorizontally: false,
    needsFlipHorizontal: false,
    confidence: Math.min(0.95, 0.55 + margin),
    textDirection,
    needsRotation: chosenDelta !== 0,
    aspectRatio: Math.round(finalAspect * 100) / 100,
    source: 'cv',
    reason,
  };
}

/**
 * Primary engine: trained on-device classifier (see mlOrientation.ts).
 * Returns null if the model can't load (e.g. very old browser) so the CV
 * engines take over.
 */
async function detectOrientationViaModel(
  source: HTMLImageElement | HTMLCanvasElement,
  currentRotation: RightAngle
): Promise<DocumentOrientationResult | null> {
  if (typeof document === 'undefined') return null;
  try {
    const view =
      currentRotation === 0 ? source : renderRotatedBitmap(source, currentRotation, 1024);
    if (!view) return null;
    const prediction = await detectOrientationWithModel(view);
    const reliable = isReliableOrientation(prediction);
    const res = { ...prediction, rotationDelta: reliable ? prediction.rotationDelta : 0 as RightAngle };
    if (view !== source) {
      (view as HTMLCanvasElement).width = 0;
      (view as HTMLCanvasElement).height = 0;
    }

    const origW = (source as HTMLImageElement).naturalWidth || source.width || 1;
    const origH = (source as HTMLImageElement).naturalHeight || source.height || 1;
    const suggestedRotation = normalizeAngle(currentRotation + res.rotationDelta);
    const isRot = suggestedRotation === 90 || suggestedRotation === 270;
    const confidence = Math.round(res.confidence * 100) / 100;

    console.info('[AutoOrient:model]', { currentRotation, ...res });

    return {
      suggestedRotation,
      rotationDelta: res.rotationDelta,
      usedVisualAnalysisFallback: false,
      isMirroredHorizontally: false,
      needsFlipHorizontal: false,
      confidence,
      textDirection: res.rotationDelta === 90 || res.rotationDelta === 270 ? 'vertical' : 'horizontal',
      needsRotation: res.rotationDelta !== 0,
      aspectRatio: Math.round((isRot ? origH / origW : origW / origH) * 100) / 100,
      source: 'ml',
      reason: !reliable
        ? 'Orientation uncertain — kept the current orientation. Use manual rotation if needed.'
        : res.rotationDelta !== 0
          ? `On-device model: page was turned; rotated ${res.rotationDelta}° to upright`
          : 'On-device model: page is upright',
    };
  } catch (err) {
    console.warn('[AutoOrient] on-device model unavailable; using CV engines.', err);
    return null;
  }
}

/**
 * Main Document Orientation Detector. Runs entirely in the browser: the bundled
 * on-device model first, then the in-browser CV engine when the model is unsure
 * or unavailable. No page image ever leaves the device.
 */
export async function detectDocumentOrientation(
  source: HTMLImageElement | HTMLCanvasElement,
  currentRotation: RightAngle = 0,
  preDetectedQuad?: ScanQuad | null,
  _options?: { forceLocal?: boolean }
): Promise<DocumentOrientationResult> {
  let viaModel: DocumentOrientationResult | null;
  if (preDetectedQuad && isSaneQuad(preDetectedQuad)) {
    const oriented = renderRotatedBitmap(source, currentRotation, 1024);
    let pageView: HTMLCanvasElement | null = null;
    try {
      pageView = oriented ? warpQuadToCanvas(oriented, preDetectedQuad) : null;
      viaModel = await detectOrientationViaModel(pageView ?? source, pageView ? 0 : currentRotation);
      if (viaModel && pageView) {
        viaModel = { ...viaModel, suggestedRotation: normalizeAngle(currentRotation + viaModel.rotationDelta) };
      }
    } finally {
      if (pageView) { pageView.width = 0; pageView.height = 0; }
      if (oriented) { oriented.width = 0; oriented.height = 0; }
    }
  } else {
    viaModel = await detectOrientationViaModel(source, currentRotation);
  }
  if (viaModel && viaModel.rotationDelta !== 180) return viaModel;

  const local = detectDocumentOrientationLocal(source, currentRotation);
  if (viaModel && local.rotationDelta === 180 && local.confidence >= 0.7) return viaModel;

  // Layout heuristics cannot reliably distinguish upright handwriting, tables or diagrams.
  // Never let a fallback guess silently change the decoded (EXIF-corrected) orientation.
  const currentIsSideways = currentRotation === 90 || currentRotation === 270;
  const width = (source as HTMLImageElement).naturalWidth || source.width || 1;
  const height = (source as HTMLImageElement).naturalHeight || source.height || 1;
  return {
    ...(viaModel ?? local),
    suggestedRotation: currentRotation,
    rotationDelta: 0,
    needsRotation: false,
    textDirection: 'ambiguous',
    aspectRatio: currentIsSideways ? height / width : width / height,
    reason: 'Orientation uncertain — kept the current orientation. Use manual rotation if needed.',
  };
}

/**
 * Rotates an offscreen canvas or image clockwise by 90, 180, or 270 degrees.
 * Strictly performs pure geometric rotation with zero horizontal or vertical flipping.
 */
export function rotateCanvasBitmap(
  source: HTMLImageElement | HTMLCanvasElement,
  delta: RightAngle,
  quality: number = 0.92
): { dataUrl: string; width: number; height: number; canvas: HTMLCanvasElement } {
  const origW = (source as HTMLImageElement).naturalWidth || source.width || 1;
  const origH = (source as HTMLImageElement).naturalHeight || source.height || 1;

  const swapDims = delta === 90 || delta === 270;
  const targetW = swapDims ? origH : origW;
  const targetH = swapDims ? origW : origH;

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetW, targetH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    ctx.save();
    ctx.translate(targetW / 2, targetH / 2);
    if (delta !== 0) {
      ctx.rotate((delta * Math.PI) / 180);
    }
    ctx.drawImage(source, -origW / 2, -origH / 2, origW, origH);
    ctx.restore();
  }

  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  return { dataUrl, width: targetW, height: targetH, canvas };
}

function downscaleSourceToCanvas(
  source: HTMLImageElement | HTMLCanvasElement,
  maxEdge: number
): HTMLImageElement | HTMLCanvasElement {
  const w = (source as HTMLImageElement).naturalWidth || source.width || 1;
  const h = (source as HTMLImageElement).naturalHeight || source.height || 1;
  const longest = Math.max(w, h);
  if (longest <= maxEdge) return source;
  const scale = maxEdge / longest;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return source;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Analyzes an uploaded/captured page and, if it is sideways (90°/270°) or
 * upside down (180°), bakes the correcting rotation into the bitmap.
 * Note: browsers already apply EXIF orientation when decoding, so `source`
 * is analyzed exactly as displayed.
 */
export async function autoFixImageOrientation(
  inputSource: HTMLImageElement | HTMLCanvasElement,
  quality: number = 0.92,
  rawFileBytes?: ArrayBuffer | Uint8Array,
  maxEdge?: number,
  quad?: ScanQuad | null,
  detectOrientation = true
): Promise<{
  dataUrl: string;
  width: number;
  height: number;
  wasRotated: boolean;
  wasFlipped: boolean;
  appliedDelta: RightAngle;
  exifTag?: number;
  exifLabel?: string;
  reason: string;
  canvas?: HTMLCanvasElement;
}> {
  // Normalize oversized photos ONCE up front so detection, rotation and the
  // JPEG encode all run on a bounded bitmap instead of the raw camera frame.
  const source = maxEdge ? downscaleSourceToCanvas(inputSource, maxEdge) : inputSource;
  const origW = (source as HTMLImageElement).naturalWidth || source.width || 1;
  const origH = (source as HTMLImageElement).naturalHeight || source.height || 1;

  let exifInfo = { tag: 1, label: EXIF_TAG_DESCRIPTIONS[1], isAmbiguousOrNormal: true };
  if (rawFileBytes) {
    exifInfo = extractExifOrientation(rawFileBytes);
  }

  if (detectOrientation) try {
    const orientRes = await detectDocumentOrientation(source, 0, quad);
    const delta = orientRes.rotationDelta || 0;

    if (orientRes.needsRotation && delta !== 0) {
      const rotated = rotateCanvasBitmap(source, delta, quality);
      return {
        dataUrl: rotated.dataUrl,
        width: rotated.width,
        height: rotated.height,
        wasRotated: true,
        wasFlipped: false,
        appliedDelta: delta,
        exifTag: exifInfo.tag,
        exifLabel: exifInfo.label,
        reason: orientRes.reason || `Auto-rotated ${delta}° to 0° upright orientation`,
        canvas: rotated.canvas,
      };
    }
  } catch (err) {
    console.warn('[AutoFix] Orientation evaluation failed:', err);
  }

  // data: sources (PDF pages rendered in-app) are already persistent and
  // EXIF-free — reuse them as-is and skip a full-size JPEG re-encode.
  if (source instanceof HTMLImageElement && source.src.startsWith('data:')) {
    return {
      dataUrl: source.src,
      width: origW,
      height: origH,
      wasRotated: false,
      wasFlipped: false,
      appliedDelta: 0,
      exifTag: exifInfo.tag,
      exifLabel: exifInfo.label,
      reason: 'Document is in upright 0° orientation',
    };
  }

  let dataUrl = '';
  let canvas: HTMLCanvasElement | undefined;
  if (source instanceof HTMLCanvasElement) {
    canvas = source;
    dataUrl = source.toDataURL('image/jpeg', quality);
  } else {
    canvas = document.createElement('canvas');
    canvas.width = origW;
    canvas.height = origH;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(source, 0, 0);
    }
    dataUrl = canvas.toDataURL('image/jpeg', quality);
  }

  return {
    dataUrl,
    width: origW,
    height: origH,
    wasRotated: false,
    wasFlipped: false,
    appliedDelta: 0,
    exifTag: exifInfo.tag,
    exifLabel: exifInfo.label,
    reason: 'Document is in upright 0° orientation',
    canvas,
  };
}
