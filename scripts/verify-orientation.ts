/**
 * ============================================================================
 *  LOCAL ORIENTATION ENGINE VERIFICATION HARNESS
 *  Run with:  npm run test:orientation      (or: npx tsx scripts/verify-orientation.ts)
 * ============================================================================
 *
 *  Zero network, zero fixtures on disk: every test image is synthesized
 *  in-memory (raw grayscale pixel buffers wrapped into PNG via sharp).
 *
 *  It reproduces the exact failure scenario that broke the old pipeline —
 *  a smartphone photo of an OPEN NOTEBOOK shot in portrait: a two-page
 *  landscape spread, the right page densely handwritten, the left page blank
 *  ruled paper, a spine shadow between them and a dark cover strip at the
 *  bottom edge — plus single handwritten pages, each captured at all four
 *  right angles. The engine must return the exact compensating rotation.
 */

import sharp from 'sharp';
import { analyzeAndCorrectBufferOrientation } from '../server/handwrittenOrientationService';

// ---------------------------------------------------------------------------
// Deterministic RNG (mulberry32) so runs are reproducible.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Tiny pixel drawing helpers on 8-bit grayscale buffers.
// ---------------------------------------------------------------------------
function fillPaper(px: Uint8Array, w: number, h: number, base: number, rng: () => number): void {
  for (let i = 0; i < w * h; i++) {
    px[i] = Math.max(0, Math.min(255, Math.round(base + (rng() - 0.5) * 12)));
  }
}

function drawBlob(
  px: Uint8Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  value: number
): void {
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(w - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(h - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x - cx) / Math.max(1e-3, rx);
      const dy = (y - cy) / Math.max(1e-3, ry);
      if (dx * dx + dy * dy <= 1) {
        const i = y * w + x;
        if (value < px[i]) px[i] = value;
      }
    }
  }
}

function drawHLine(px: Uint8Array, w: number, h: number, y: number, x0: number, x1: number, value: number): void {
  if (y < 0 || y >= h) return;
  for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x++) {
    const i = y * w + x;
    if (value < px[i]) px[i] = value;
  }
}

function drawVLine(px: Uint8Array, w: number, h: number, x: number, y0: number, y1: number, value: number): void {
  if (x < 0 || x >= w) return;
  for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++) {
    const i = y * w + x;
    if (value < px[i]) px[i] = value;
  }
}

function drawRect(px: Uint8Array, w: number, h: number, x0: number, y0: number, x1: number, y1: number, value: number): void {
  for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x++) {
      px[y * w + x] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Synthetic "handwritten" page: ruled paper plus rows of ink blobs whose
// ascender strokes are deliberately far more frequent than descenders —
// the same statistical asymmetry real Latin handwriting has, which is what
// the engine's polarity cue measures.
// ---------------------------------------------------------------------------
function makeWrittenPage(w: number, h: number, rng: () => number): Uint8Array {
  const px = new Uint8Array(w * h);
  fillPaper(px, w, h, 244, rng);

  const lineGap = 34;
  const baseline0 = Math.round(h * 0.12);
  const marginLeft = Math.round(w * 0.09);

  // Faint ruled lines + margin line (the engine must suppress these).
  for (let y = baseline0; y < h * 0.96; y += lineGap) {
    drawHLine(px, w, h, y, marginLeft - 6, w - 20, 220);
  }
  drawVLine(px, w, h, marginLeft - 10, 10, h - 10, 214);

  // Writing on each rule.
  for (let y = baseline0; y < h * 0.94; y += lineGap) {
    const baseline = y - 5;
    let x = marginLeft + 6;
    while (x < w - 36) {
      const wordLen = 3 + Math.floor(rng() * 6);
      for (let c = 0; c < wordLen && x < w - 36; c++) {
        const charW = 5 + rng() * 4;
        const ink = 70 + rng() * 60;
        const rx = 2.4 + rng() * 1.6;
        const ry = 2.2 + rng() * 1.4;
        drawBlob(px, w, h, x + rx, baseline - ry, rx, ry, ink);
        if (rng() < 0.3) {
          // Ascender (tall stroke above the x-height core).
          drawBlob(px, w, h, x + rx, baseline - 10 - rng() * 3, 1.6, 4.5, ink);
        }
        if (rng() < 0.1) {
          // Descender (short tail below the baseline).
          drawBlob(px, w, h, x + rx, baseline + 5, 1.6, 3.2, ink);
        }
        x += charW + 1.5;
      }
      x += 10 + rng() * 8; // word gap
    }
  }
  return px;
}

// Blank ruled page with a couple of faint smudges (must NEVER win the ROI
// competition against the dense written page).
function makeBlankRuledPage(w: number, h: number, rng: () => number): Uint8Array {
  const px = new Uint8Array(w * h);
  fillPaper(px, w, h, 245, rng);

  const lineGap = 34;
  const baseline0 = Math.round(h * 0.12);
  const marginLeft = Math.round(w * 0.09);
  for (let y = baseline0; y < h * 0.96; y += lineGap) {
    drawHLine(px, w, h, y, marginLeft - 6, w - 20, 221);
  }
  drawVLine(px, w, h, marginLeft - 10, 10, h - 10, 215);

  for (let i = 0; i < 3; i++) {
    drawBlob(px, w, h, marginLeft + rng() * (w * 0.6), baseline0 + rng() * (h * 0.7), 4, 2.5, 185);
  }
  return px;
}

/**
 * Upright two-page notebook spread (landscape): one blank ruled page, one
 * densely written page, spine shadow in the gutter, dark cover strip along
 * the bottom edge. `writtenSide` selects which page carries the writing —
 * the engine must handle both, because real notebooks vary.
 */
function composeSpread(writtenSide: 'left' | 'right'): { px: Uint8Array; w: number; h: number } {
  const w = 1240;
  const h = 920;
  const px = new Uint8Array(w * h);
  const rng = mulberry32(20260926);
  fillPaper(px, w, h, 238, rng); // desk / paper around the notebook

  const pageTop = 10;
  const pageBottom = h - 46;

  const blank = makeBlankRuledPage(576, pageBottom - pageTop, mulberry32(11));
  const written = makeWrittenPage(576, pageBottom - pageTop, mulberry32(77));

  const blankX = writtenSide === 'left' ? 656 : 8;
  const writtenX = writtenSide === 'left' ? 8 : 656;

  for (let y = 0; y < pageBottom - pageTop; y++) {
    for (let x = 0; x < 576; x++) px[(pageTop + y) * w + blankX + x] = blank[y * 576 + x];
  }
  for (let y = 0; y < pageBottom - pageTop; y++) {
    for (let x = 0; x < 576; x++) px[(pageTop + y) * w + writtenX + x] = written[y * 576 + x];
  }

  // Spine shadow in the gutter (thin dark line the engine must strip).
  drawRect(px, w, h, 620, pageTop + 4, 626, pageBottom - 4, 150);

  // Dark cover strip along the bottom edge.
  drawRect(px, w, h, 0, h - 36, w - 1, h - 1, 95);

  return { px, w, h };
}

/** Rotate a grayscale buffer by quarterTurns × 90° clockwise. */
function rotateGray90(
  px: Uint8Array,
  w: number,
  h: number,
  quarterTurns: number
): { px: Uint8Array; w: number; h: number } {
  const t = ((quarterTurns % 4) + 4) % 4;
  if (t === 0) return { px, w, h };
  const dw = t % 2 === 0 ? w : h;
  const dh = t % 2 === 0 ? h : w;
  const out = new Uint8Array(dw * dh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = px[y * w + x];
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
      out[dy * dw + dx] = v;
    }
  }
  return { px: out, w: dw, h: dh };
}

async function toPng(px: Uint8Array, w: number, h: number): Promise<Buffer> {
  return sharp(px, { raw: { width: w, height: h, channels: 1 } })
    .png()
    .toBuffer();
}

// ---------------------------------------------------------------------------
// Test matrix
// ---------------------------------------------------------------------------
interface TestCase {
  name: string;
  buffer: Buffer;
  outWidth: number;
  outHeight: number;
  expected: 0 | 90 | 180 | 270;
}

async function buildTestCases(): Promise<TestCase[]> {
  const cases: TestCase[] = [];
  const pageRng = mulberry32(4242);
  const singlePage = makeWrittenPage(760, 1000, pageRng);

  // Notebook spread photographed at all four right angles, for BOTH layouts:
  // written page on the right AND on the left. The left-written captures are
  // the hard case — their correct rotation CONTRADICTS the cluster-quadrant
  // prior, so they can only pass through measured directional evidence.
  for (const side of ['right', 'left'] as const) {
    const spread = composeSpread(side);
    const spreadAngles: Array<0 | 1 | 2 | 3> = [0, 1, 2, 3];
    for (const turns of spreadAngles) {
      const theta = (turns * 90) as 0 | 90 | 180 | 270;
      const rotated = rotateGray90(spread.px, spread.w, spread.h, turns);
      cases.push({
        name: `notebook-spread(${side}) photo-rot-${theta}deg`,
        buffer: await toPng(rotated.px, rotated.w, rotated.h),
        outWidth: rotated.w,
        outHeight: rotated.h,
        expected: (((360 - theta) % 360) as 0 | 90 | 180 | 270),
      });
    }
  }

  // Single handwritten page at all four right angles.
  for (const turns of [0, 1, 2, 3] as Array<0 | 1 | 2 | 3>) {
    const theta = (turns * 90) as 0 | 90 | 180 | 270;
    const rotated = rotateGray90(singlePage, 760, 1000, turns);
    cases.push({
      name: `single-page photo-rot-${theta}deg`,
      buffer: await toPng(rotated.px, rotated.w, rotated.h),
      outWidth: rotated.w,
      outHeight: rotated.h,
      expected: (((360 - theta) % 360) as 0 | 90 | 180 | 270),
    });
  }

  return cases;
}

async function main(): Promise<void> {
  console.log('Synthesizing test images (100% in-memory)…\n');
  const cases = await buildTestCases();

  let failures = 0;
  const rows: string[] = [];

  for (const tc of cases) {
    const result = await analyzeAndCorrectBufferOrientation(tc.buffer, {
      returnRotatedBuffer: true,
    });

    let pass = result.detectedRotation === tc.expected;

    // Verify the corrected buffer really is the full-resolution parent,
    // rotated to upright dimensions.
    if (pass && result.correctedBuffer) {
      const meta = await sharp(result.correctedBuffer).metadata();
      const uprightW = tc.expected === 90 || tc.expected === 270 ? tc.outHeight : tc.outWidth;
      const uprightH = tc.expected === 90 || tc.expected === 270 ? tc.outWidth : tc.outHeight;
      if (meta.width !== uprightW || meta.height !== uprightH) {
        pass = false;
      }
    }

    if (!pass) failures++;
    rows.push(
      `${pass ? 'PASS' : 'FAIL'}  ${tc.name.padEnd(38)} ` +
        `expected=${String(tc.expected).padStart(3)}° got=${String(result.detectedRotation).padStart(3)}° ` +
        `conf=${result.confidence.toFixed(2)} axis=${result.textAxis.padEnd(10)} ` +
        `ratio=${result.periodicityRatio.toFixed(2)} pol=${result.ascenderPolarityScore.toFixed(2)} ` +
        `roi=${result.roi.coverageRatio.toFixed(2)} ${result.elapsedMs}ms`
    );
    if (!pass) {
      rows.push(`      reason: ${result.reason}`);
      rows.push(`      votes: ${JSON.stringify(result.votes)}`);
    }
  }

  console.log(rows.join('\n'));
  console.log(
    failures === 0
      ? `\nAll ${cases.length} orientation cases passed.`
      : `\n${failures}/${cases.length} orientation cases FAILED.`
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
