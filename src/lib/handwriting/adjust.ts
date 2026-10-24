import type { ImageAdjust } from './catalog';

let blurScratch: Uint16Array | null = null;

function buildToneLut(brightness: number, contrast: number): Uint8ClampedArray {
  const offset = brightness * 1.1;
  const factor = contrast >= 0 ? 1 + (contrast / 100) * 1.5 : 1 + (contrast / 100) * 0.9;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = (v + offset - 128) * factor + 128;
  return lut;
}

/**
 * Unsharp mask with a 3x3 box blur. Positive `amount` sharpens, negative
 * blends towards the blurred copy (softens).
 */
function applySharpness(img: ImageData, amount: number) {
  const { width: w, height: h, data } = img;
  const k = amount > 0 ? (amount / 100) * 1.6 : amount / 100;
  const size = w * h * 3;
  if (!blurScratch || blurScratch.length < size) blurScratch = new Uint16Array(size);
  const rowSum = blurScratch;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = (y * w + Math.max(0, x - 1)) * 4;
      const c = (y * w + x) * 4;
      const r = (y * w + Math.min(w - 1, x + 1)) * 4;
      const o = (y * w + x) * 3;
      rowSum[o] = data[l] + data[c] + data[r];
      rowSum[o + 1] = data[l + 1] + data[c + 1] + data[r + 1];
      rowSum[o + 2] = data[l + 2] + data[c + 2] + data[r + 2];
    }
  }

  for (let y = 0; y < h; y++) {
    const up = Math.max(0, y - 1) * w;
    const mid = y * w;
    const down = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++) {
      const a = (up + x) * 3;
      const b = (mid + x) * 3;
      const d = (down + x) * 3;
      const p = (mid + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const blur = (rowSum[a + ch] + rowSum[b + ch] + rowSum[d + ch]) / 9;
        const v = data[p + ch];
        data[p + ch] = v + k * (v - blur);
      }
    }
  }
}

/** Applies brightness, contrast, saturation and (optionally) sharpness in place. */
export function applyImageAdjust(img: ImageData, adj: ImageAdjust, includeSharpness = true) {
  const { data } = img;
  const tone = adj.brightness !== 0 || adj.contrast !== 0;
  const lut = tone ? buildToneLut(adj.brightness, adj.contrast) : null;
  const sat = 1 + adj.saturation / 100;

  if (lut || sat !== 1) {
    for (let i = 0; i < data.length; i += 4) {
      let r = data[i];
      let g = data[i + 1];
      let b = data[i + 2];
      if (lut) {
        r = lut[r];
        g = lut[g];
        b = lut[b];
      }
      if (sat !== 1) {
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        r = gray + (r - gray) * sat;
        g = gray + (g - gray) * sat;
        b = gray + (b - gray) * sat;
      }
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
  }

  if (includeSharpness && adj.sharpness !== 0) applySharpness(img, adj.sharpness);
}
