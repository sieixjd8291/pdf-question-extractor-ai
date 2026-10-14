import { buildOrientedCanvas, loadImageFromUrl, renderScanCanvas, type ScanRenderOptions } from './scannerFilters';

type Job = {
  id: number;
  bitmap: ImageBitmap;
  maxEdge: number;
  opts: ScanRenderOptions;
  current: () => boolean;
  resolve: (bitmap: ImageBitmap | null) => void;
  reject: (error: Error) => void;
};
let worker: Worker | null = null;
let failed = false;
let sequence = 0;
let active: Job | null = null;
let queued: Job | null = null;
let timeout: ReturnType<typeof setTimeout> | null = null;

function stop() {
  worker?.terminate();
  worker = null;
  failed = true;
  if (timeout) clearTimeout(timeout);
  timeout = null;
  active?.reject(new Error('Preview worker unavailable'));
  queued?.bitmap.close();
  queued?.reject(new Error('Preview worker unavailable'));
  active = queued = null;
}
function dispatch(job: Job) {
  if (!job.current()) { job.bitmap.close(); job.resolve(null); return; }
  try {
    if (!worker) {
      worker = new Worker(new URL('./scannerPreview.worker.ts', import.meta.url), { type: 'module' });
      worker.onerror = stop;
      worker.onmessageerror = stop;
      worker.onmessage = ({ data }) => {
        if (!active || data.id !== active.id) { data.bitmap?.close(); return; }
        if (timeout) clearTimeout(timeout);
        timeout = null;
        const done = active;
        active = null;
        if (data.error) done.reject(new Error(data.error));
        else if (done.current()) done.resolve(data.bitmap);
        else { data.bitmap.close(); done.resolve(null); }
        const next = queued;
        queued = null;
        if (next) dispatch(next);
      };
    }
    active = job;
    timeout = setTimeout(stop, 15000);
    worker.postMessage({ id: job.id, bitmap: job.bitmap, maxEdge: job.maxEdge, opts: job.opts }, [job.bitmap]);
  } catch { job.bitmap.close(); stop(); job.reject(new Error('Preview worker unavailable')); }
}
export function clearScannerPreviews() {
  stop();
  failed = false;
}

export async function renderScanPreviewCanvas(sourceUrl: string, opts: ScanRenderOptions, maxEdge: number, current: () => boolean): Promise<HTMLCanvasElement | null> {
  const img = await loadImageFromUrl(sourceUrl);
  if (!current()) return null;
  if (failed || typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function') {
    await new Promise(resolve => setTimeout(resolve, 0));
    if (!current()) return null;
    const canvas = await renderScanCanvas(sourceUrl, opts, Math.min(maxEdge, 540));
    if (!current()) { canvas.width = canvas.height = 0; return null; }
    return canvas;
  }
  let result: ImageBitmap | null = null;
  try {
    const oriented = buildOrientedCanvas(img, opts.rotation ?? 0, maxEdge);
    let bitmap: ImageBitmap;
    try { bitmap = await createImageBitmap(oriented); }
    finally { oriented.width = oriented.height = 0; }
    if (!current()) { bitmap.close(); return null; }
    result = await new Promise<ImageBitmap | null>((resolve, reject) => {
      const job: Job = { id: ++sequence, bitmap, maxEdge, opts, current, resolve, reject };
      if (active) { queued?.bitmap.close(); queued?.resolve(null); queued = job; }
      else dispatch(job);
    });
    if (!result) return null;
    if (!current()) { result.close(); return null; }
    const canvas = document.createElement('canvas');
    canvas.width = result.width;
    canvas.height = result.height;
    canvas.getContext('2d', { alpha: false })?.drawImage(result, 0, 0);
    result.close();
    return canvas;
  } catch (error) {
    result?.close();
    if (!current()) return null;
    if (!failed) stop();
    return renderScanPreviewCanvas(sourceUrl, opts, Math.min(maxEdge, 540), current);
  }
}
