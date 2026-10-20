import type { PageLayout } from './catalog';

export interface DetectedRuling {
  lineHeight: number;
  /** First ruled line usable as a baseline, in page units. */
  firstLine: number;
  /** Last ruled line, in page units. */
  lastLine: number;
  /** Vertical margin rule (usually red), in page units, if found. */
  marginRule: number | null;
}

const SAMPLE_W = 620;

function sampleAt(p: Float32Array, y: number): number {
  const i = Math.floor(y);
  if (i < 0 || i >= p.length - 1) return 0;
  const t = y - i;
  return p[i] * (1 - t) + p[i + 1] * t;
}

/**
 * Finds the horizontal ruling of a paper photo as it is drawn on the page
 * (cover-fitted, centred), so text baselines can be snapped onto it.
 */
export function detectRuling(img: HTMLImageElement, pageW: number, pageH: number): DetectedRuling | null {
  const cw = SAMPLE_W;
  const ch = Math.round((SAMPLE_W * pageH) / pageW);
  const f = pageW / cw;
  const c = document.createElement('canvas');
  c.width = cw;
  c.height = ch;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const r = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
  const dw = img.naturalWidth * r;
  const dh = img.naturalHeight * r;
  ctx.drawImage(img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, cw, ch).data;
  } catch {
    return null;
  }

  // Row darkness over the writing area (skips spiral binding and margin).
  const x0 = Math.round(cw * 0.32);
  const x1 = Math.round(cw * 0.95);
  const lum = new Float32Array(ch);
  for (let y = 0; y < ch; y++) {
    let sum = 0;
    for (let x = x0; x < x1; x++) {
      const i = (y * cw + x) * 4;
      sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    }
    lum[y] = sum / (x1 - x0);
  }
  const win = 6;
  const profile = new Float32Array(ch);
  for (let y = 0; y < ch; y++) {
    let s = 0;
    let n = 0;
    for (let k = -win; k <= win; k++) {
      const yy = y + k;
      if (yy < 0 || yy >= ch) continue;
      s += lum[yy];
      n++;
    }
    profile[y] = Math.max(0, s / n - lum[y]);
  }

  // Coarse period from autocorrelation; prefer the smallest strong lag to avoid harmonics.
  const minLag = Math.max(6, Math.round(20 / f));
  const maxLag = Math.min(Math.floor(ch / 4), Math.round(150 / f));
  const ac = new Float32Array(maxLag + 1);
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let y = 0; y + lag < ch; y++) s += profile[y] * profile[y + lag];
    ac[lag] = s / (ch - lag);
    if (ac[lag] > best) best = ac[lag];
  }
  if (best <= 0) return null;
  let lag0 = 0;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (ac[lag] >= best * 0.75 && ac[lag] >= ac[lag - 1] && ac[lag] >= ac[lag + 1]) {
      lag0 = lag;
      break;
    }
  }
  if (!lag0) return null;

  // Sub-pixel period + phase via comb matching.
  let bestScore = -1;
  let period = lag0;
  let phase = 0;
  for (let p = lag0 - 1.5; p <= lag0 + 1.5; p += 0.02) {
    for (let ph = 0; ph < p; ph += 0.25) {
      let s = 0;
      let n = 0;
      for (let y = ph; y < ch; y += p) {
        s += sampleAt(profile, y);
        n++;
      }
      const score = s / n;
      if (score > bestScore) {
        bestScore = score;
        period = p;
        phase = ph;
      }
    }
  }
  let mean = 0;
  for (let y = 0; y < ch; y++) mean += profile[y];
  mean /= ch;
  if (mean <= 0 || bestScore / mean < 2.2) return null;

  // Keep the contiguous run of lines that are actually printed.
  const lines: Array<{ y: number; v: number }> = [];
  for (let y = phase; y < ch; y += period) {
    let v = 0;
    for (let k = -1; k <= 1; k++) v = Math.max(v, sampleAt(profile, y + k));
    lines.push({ y, v });
  }
  const sorted = lines.map((l) => l.v).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const strong = lines.filter((l) => l.v >= median * 0.4 && l.y > ch * 0.04 && l.y < ch * 0.985);
  if (strong.length < 4) return null;

  // Vertical margin rule: the reddest column in the left part of the page.
  const mx0 = Math.round(cw * 0.06);
  const mx1 = Math.round(cw * 0.42);
  let redBest = 0;
  let redX = -1;
  let redMean = 0;
  for (let x = mx0; x < mx1; x++) {
    let s = 0;
    for (let y = Math.round(ch * 0.2); y < Math.round(ch * 0.8); y++) {
      const i = (y * cw + x) * 4;
      s += data[i] - (data[i + 1] + data[i + 2]) / 2;
    }
    const v = s / (ch * 0.6);
    redMean += v;
    if (v > redBest) {
      redBest = v;
      redX = x;
    }
  }
  redMean /= mx1 - mx0;
  const marginRule = redX >= 0 && redBest > 14 && redBest > redMean + 10 ? redX * f : null;

  return {
    lineHeight: Number((period * f).toFixed(2)),
    firstLine: strong[0].y * f,
    lastLine: strong[strong.length - 1].y * f,
    marginRule,
  };
}

/** Converts detected ruling into a page layout that writes on the printed lines. */
export function layoutFromRuling(ruling: DetectedRuling, current: PageLayout, pageH: number): PageLayout {
  const marginTop = ruling.firstLine;
  return {
    marginLeft: ruling.marginRule !== null ? Math.round(ruling.marginRule + 14) : current.marginLeft,
    marginRight: current.marginRight,
    marginTop: Math.round(marginTop * 10) / 10,
    marginBottom: Math.max(10, Math.floor(pageH - ruling.lastLine - 1)),
    lineHeight: ruling.lineHeight,
  };
}
