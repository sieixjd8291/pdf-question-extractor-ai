import { enhancePixels, warpQuadToCanvas, NEUTRAL_ADJUSTMENTS, type ScanRenderOptions } from './scannerFilters';

type PreviewJob = { id: number; bitmap: ImageBitmap; maxEdge: number; opts: ScanRenderOptions };
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PreviewJob>) => void) | null;
  postMessage: (value: unknown, transfer?: Transferable[]) => void;
};
scope.onmessage = ({ data: job }) => {
  let oriented: OffscreenCanvas | null = null;
  let warped: OffscreenCanvas | null = null;
  try {
    const { bitmap, opts } = job;
    oriented = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = oriented.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!ctx) throw new Error('Canvas unavailable');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, oriented.width, oriented.height);
    ctx.drawImage(bitmap, 0, 0);
    warped = opts.quad ? warpQuadToCanvas(oriented, opts.quad, opts.hex ?? null) : oriented;
    const output = warped.getContext('2d', { willReadFrequently: true });
    if (!output) throw new Error('Canvas unavailable');
    if (opts.filter !== 'original') {
      const image = output.getImageData(0, 0, warped.width, warped.height);
      enhancePixels(image.data, image.width, image.height, opts.filter ?? 'original', opts.adj ?? NEUTRAL_ADJUSTMENTS);
      output.putImageData(image, 0, 0);
    }
    const result = warped.transferToImageBitmap();
    scope.postMessage({ id: job.id, bitmap: result }, [result]);
  } catch {
    scope.postMessage({ id: job.id, error: 'Preview processing failed' });
  } finally {
    job.bitmap.close();
    if (oriented) oriented.width = oriented.height = 0;
    if (warped && warped !== oriented) warped.width = warped.height = 0;
  }
};
