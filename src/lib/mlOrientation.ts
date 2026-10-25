import type { InferenceSession } from 'onnxruntime-web';

/**
 * On-device document orientation classifier (PaddleOCR PP-LCNet_x1_0_doc_ori,
 * ONNX, ~6.8 MB). Runs entirely in the browser via onnxruntime-web WASM — the
 * page never leaves the device. Unlike hand-tuned projection heuristics it was
 * trained on real photographed documents, so it copes with handwriting,
 * two-page spreads, diagrams and background clutter.
 *
 * Model classes are the angle the content is turned clockwise (0/90/180/270);
 * the clockwise correction is therefore (360 - class) % 360.
 */

type RightAngle = 0 | 90 | 180 | 270;

const MODEL_URL = '/models/doc-orientation.onnx';
const INPUT = 224;
const RESIZE_SHORT = 256;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let sessionPromise: Promise<{ ort: typeof import('onnxruntime-web'); session: InferenceSession }> | null =
  null;

function loadSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const [ort, wasmUrl] = await Promise.all([
        import('onnxruntime-web/wasm'),
        import('onnxruntime-web/ort-wasm-simd-threaded.wasm?url').then((m) => m.default as string),
      ]);
      ort.env.wasm.wasmPaths = { wasm: wasmUrl };
      // Multi-threading needs cross-origin isolation, which the app doesn't set.
      ort.env.wasm.numThreads = 1;
      const session = await ort.InferenceSession.create(MODEL_URL, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      return { ort, session };
    })().catch((err) => {
      sessionPromise = null;
      throw err;
    });
  }
  return sessionPromise;
}

/** Start downloading/compiling the model early so the first upload is fast. */
export function warmUpOrientationModel(): void {
  if (typeof window === 'undefined') return;
  loadSession().catch(() => undefined);
}

/**
 * Draws `source` turned `rotationCw` degrees clockwise, scaled so the short
 * side is RESIZE_SHORT, then center-cropped to INPUT×INPUT (the model's
 * training preprocessing). Returns normalized CHW float data.
 */
function preprocess(source: HTMLImageElement | HTMLCanvasElement, rotationCw: RightAngle): Float32Array {
  const srcW = (source as HTMLImageElement).naturalWidth || source.width || 1;
  const srcH = (source as HTMLImageElement).naturalHeight || source.height || 1;
  const swap = rotationCw === 90 || rotationCw === 270;
  const viewW = swap ? srcH : srcW;
  const viewH = swap ? srcW : srcH;
  const scale = RESIZE_SHORT / Math.min(viewW, viewH);

  const canvas = document.createElement('canvas');
  canvas.width = INPUT;
  canvas.height = INPUT;
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, INPUT, INPUT);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(INPUT / 2, INPUT / 2);
  ctx.rotate((rotationCw * Math.PI) / 180);
  ctx.drawImage(source, (-srcW * scale) / 2, (-srcH * scale) / 2, srcW * scale, srcH * scale);

  const { data } = ctx.getImageData(0, 0, INPUT, INPUT);
  canvas.width = 0;
  canvas.height = 0;

  const plane = INPUT * INPUT;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    const p = i * 4;
    out[i] = (data[p] / 255 - MEAN[0]) / STD[0];
    out[plane + i] = (data[p + 1] / 255 - MEAN[1]) / STD[1];
    out[2 * plane + i] = (data[p + 2] / 255 - MEAN[2]) / STD[2];
  }
  return out;
}

export interface MlOrientationResult {
  /** Clockwise rotation to apply to make the page upright. */
  rotationDelta: RightAngle;
  /** Agreement-weighted probability of the winning orientation (0–1). */
  confidence: number;
  /** Per-correction scores, for diagnostics. */
  scores: Record<RightAngle, number>;
}

export function isReliableOrientation(result: MlOrientationResult): boolean {
  const values = Object.values(result.scores);
  if (values.length !== 4 || values.some(value => !Number.isFinite(value) || value < 0 || value > 1) ||
      !Number.isFinite(result.confidence)) return false;
  const winner = result.scores[result.rotationDelta];
  const runnerUp = Math.max(...Object.entries(result.scores)
    .filter(([angle]) => Number(angle) !== result.rotationDelta)
    .map(([, score]) => score));
  // An unnecessary half-turn destroys an already readable page; require stronger evidence.
  const minimum = result.rotationDelta === 180 ? 0.99 : 0.95;
  return result.confidence >= minimum && winner >= minimum && winner - runnerUp >= 0.8;
}

/**
 * Classifies the page as displayed. Test-time augmentation: the page is
 * scored at all four right-angle turns in one batch and the predictions are
 * re-aligned and averaged, so a single ambiguous view can't flip the answer.
 */
export async function detectOrientationWithModel(
  source: HTMLImageElement | HTMLCanvasElement
): Promise<MlOrientationResult> {
  const { ort, session } = await loadSession();
  const views: RightAngle[] = [0, 90, 180, 270];
  const plane = 3 * INPUT * INPUT;
  const batch = new Float32Array(views.length * plane);
  views.forEach((r, i) => batch.set(preprocess(source, r), i * plane));

  const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', batch, [views.length, 3, INPUT, INPUT]) };
  const output = await session.run(feeds);
  const probs = output[session.outputNames[0]].data as Float32Array;

  // Content turned θ clockwise, viewed after an extra r clockwise turn,
  // reads as class (θ + r).
  const cwScore = [0, 0, 0, 0];
  views.forEach((r, i) => {
    const ri = r / 90;
    for (let theta = 0; theta < 4; theta++) {
      cwScore[theta] += probs[i * 4 + ((theta + ri) % 4)] / views.length;
    }
  });

  let best = 0;
  for (let t = 1; t < 4; t++) if (cwScore[t] > cwScore[best]) best = t;

  const toCorrection = (theta: number) => (((4 - theta) % 4) * 90) as RightAngle;
  const scores = { 0: 0, 90: 0, 180: 0, 270: 0 } as Record<RightAngle, number>;
  for (let t = 0; t < 4; t++) scores[toCorrection(t)] = Math.round(cwScore[t] * 1000) / 1000;

  return { rotationDelta: toCorrection(best), confidence: cwScore[best], scores };
}
