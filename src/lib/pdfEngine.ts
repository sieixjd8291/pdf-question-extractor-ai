import {pdfjsLib,pdfAssetOptions} from './pdfConfig';

export interface TextItemWithBounds {
  str: string;
  pixelXmin: number;
  pixelXmax: number;
  pixelYmin: number;
  pixelYmax: number;
  normXmin: number;
  normXmax: number;
  normYmin: number;
  normYmax: number;
}

export interface RenderedPageInfo {
  pageNumber: number;
  dataUrl: string;
  width: number;
  height: number;
  textContent: string;
  textItems: TextItemWithBounds[];
}

export interface StreamPdfOptions {
  scale?: number;
  quality?: number;
  extractText?: boolean;
  generateThumbnail?: boolean;
  thumbnailMaxEdge?: number;
  onProgress?: (page: number, total: number) => void;
  onPage: (page: RenderedPageInfo, thumbUrl?: string) => Promise<void> | void;
}

/**
 * Streams PDF pages one-by-one to avoid holding dozens or hundreds of high-res
 * canvases in RAM simultaneously. Each canvas is immediately discarded (width=0, height=0)
 * after rendering and encoding, yielding to the browser event loop between pages.
 */
export async function streamRenderPdfPages(
  fileData: ArrayBuffer | Uint8Array,
  options: StreamPdfOptions
): Promise<number> {
  const loadingTask = pdfjsLib.getDocument({
    data: fileData,
    ...pdfAssetOptions,
  });

  const pdfDoc = await loadingTask.promise;
  const numPages = pdfDoc.numPages;
  const scale = options.scale ?? 1.8;
  const quality = options.quality ?? 0.88;
  const extractText = options.extractText ?? false;
  const thumbEdge = options.thumbnailMaxEdge ?? 160;

  for (let i = 1; i <= numPages; i++) {
    if (options.onProgress) {
      options.onProgress(i, numPages);
    }

    const page = await pdfDoc.getPage(i);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });

    if (context) {
      context.fillStyle = '#FFFFFF';
      context.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({
        canvasContext: context,
        canvas,
        viewport,
        background: '#FFFFFF',
      } as any).promise;
    }

    let thumbUrl: string | undefined;
    if (options.generateThumbnail) {
      const thumbScale = Math.min(1, thumbEdge / Math.max(canvas.width, canvas.height));
      const tCanvas = document.createElement('canvas');
      tCanvas.width = Math.max(1, Math.round(canvas.width * thumbScale));
      tCanvas.height = Math.max(1, Math.round(canvas.height * thumbScale));
      const tCtx = tCanvas.getContext('2d', { alpha: false });
      if (tCtx) {
        tCtx.imageSmoothingQuality = 'medium';
        tCtx.drawImage(canvas, 0, 0, tCanvas.width, tCanvas.height);
        thumbUrl = tCanvas.toDataURL('image/jpeg', 0.7);
      }
      tCanvas.width = 0;
      tCanvas.height = 0;
    }

    let textContent = '';
    const textItems: TextItemWithBounds[] = [];
    if (extractText) {
      try {
        const text = await page.getTextContent();
        const rawItems = text.items || [];
        textContent = rawItems
          .map((item: any) => ('str' in item ? item.str : ''))
          .join(' ');

        for (const item of rawItems as any[]) {
          if (!('str' in item) || !item.str) continue;
          const transform = item.transform;
          if (!transform) continue;

          const tx = transform[4];
          const ty = transform[5];
          const fontHeight = Math.max(item.height || 0, Math.abs(transform[3] || 10));
          const itemWidth = Math.max(item.width || 0, 5);

          const [pixelX, pixelYBaseline] = viewport.convertToViewportPoint(tx, ty);
          const pixelHeight = Math.max(fontHeight * scale, 12);
          const pixelWidth = Math.max(itemWidth * scale, 8);

          const pixelYmin = Math.max(0, pixelYBaseline - pixelHeight);
          const pixelYmax = Math.min(canvas.height, pixelYBaseline + 4);
          const pixelXmin = Math.max(0, pixelX);
          const pixelXmax = Math.min(canvas.width, pixelX + pixelWidth);

          textItems.push({
            str: item.str,
            pixelXmin,
            pixelXmax,
            pixelYmin,
            pixelYmax,
            normXmin: Math.round((pixelXmin / canvas.width) * 1000),
            normXmax: Math.round((pixelXmax / canvas.width) * 1000),
            normYmin: Math.round((pixelYmin / canvas.height) * 1000),
            normYmax: Math.round((pixelYmax / canvas.height) * 1000),
          });
        }
      } catch (err) {
        console.warn('Could not extract PDF text items:', err);
        textContent = '';
      }
    }

    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const width = Math.floor(viewport.width);
    const height = Math.floor(viewport.height);

    // Immediately recycle canvas backing store before dispatching
    canvas.width = 0;
    canvas.height = 0;

    await options.onPage(
      {
        pageNumber: i,
        dataUrl,
        width,
        height,
        textContent,
        textItems,
      },
      thumbUrl
    );

    // Yield to the browser main thread between pages to prevent lockups & keep UI snappy
    await new Promise((r) => setTimeout(r, 0));
  }

  return numPages;
}

/**
 * Loads a PDF from an ArrayBuffer or Blob and extracts all pages as high-resolution canvases
 */
export async function loadAndRenderPdfPages(
  fileData: ArrayBuffer | Uint8Array,
  scale: number = 2.0,
  onProgress?: (page: number, total: number) => void
): Promise<RenderedPageInfo[]> {
  const pages: RenderedPageInfo[] = [];

  await streamRenderPdfPages(fileData, {
    scale,
    extractText: true,
    onProgress,
    onPage: (page) => {
      pages.push(page);
    },
  });

  return pages;
}
