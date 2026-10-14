import { QuestionDetection } from '../types';

/**
 * Formats a question filename according to the selected naming convention
 */
export function formatQuestionFilename(
  index: number,
  extension: 'png' | 'jpg' | 'pdf',
  questionLabel?: string,
  pageNumber?: number,
  scheme: 'index' | 'label' | 'page_index' = 'index'
): string {
  const padded = String(index).padStart(3, '0');
  
  if (scheme === 'page_index' && pageNumber) {
    return `page_${pageNumber}_question_${padded}.${extension}`;
  }
  
  if (scheme === 'label' && questionLabel) {
    const cleanLabel = questionLabel.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 30);
    return `${cleanLabel}_${padded}.${extension}`;
  }

  return `question_${padded}.${extension}`;
}

/**
 * Creates a standalone, vector-crisp PDF document Blob containing the cropped question
 */
export async function createQuestionPdfBlob(pngDataUrl: string, cropWidth: number, cropHeight: number): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const widthPt = Math.max(20, cropWidth * 0.75);
  const heightPt = Math.max(20, cropHeight * 0.75);
  const orientation = widthPt > heightPt ? 'landscape' : 'portrait';

  const doc = new jsPDF({
    orientation,
    unit: 'pt',
    format: [widthPt, heightPt],
  });

  doc.addImage(pngDataUrl, 'PNG', 0, 0, widthPt, heightPt, undefined, 'FAST');
  return doc.output('blob');
}

/**
 * Triggers a browser download of an individual question crop.
 * The PDF is rebuilt on demand from the stored PNG when it was not generated upfront.
 */
export async function downloadSingleQuestion(
  question: QuestionDetection,
  format: 'png' | 'jpg' | 'pdf',
  scheme: 'index' | 'label' | 'page_index' = 'index'
): Promise<void> {
  const filename = formatQuestionFilename(
    question.questionIndex,
    format,
    question.questionNumberRaw,
    question.pageNumber,
    scheme
  );

  if (format === 'pdf') {
    const blob = question.pdfBlob ??
      (question.pngDataUrl
        ? await createQuestionPdfBlob(question.pngDataUrl, question.cropWidth || 600, question.cropHeight || 300)
        : null);
    if (!blob) return;
    const objectUrl = URL.createObjectURL(blob);
    try {
      await downloadFileMobileSafe(objectUrl, filename);
    } finally {
      revokeObjectUrlSafe(objectUrl);
    }
    return;
  }

  const dataUrl =
    format === 'png'
      ? question.pngDataUrl
      : question.jpgDataUrl;

  if (!dataUrl) return;
  await downloadFileMobileSafe(dataUrl, filename);
}

/**
 * Triggers sequential individual browser file downloads for a list of questions.
 * Note: iOS Safari blocks multi-file downloads — callers should offer ZIP export there instead.
 */
export async function downloadMultipleIndividualFiles(
  questions: QuestionDetection[],
  format: 'png' | 'jpg' | 'pdf',
  scheme: 'index' | 'label' | 'page_index' = 'index',
  delayMs: number = 250
): Promise<void> {
  for (let i = 0; i < questions.length; i++) {
    await downloadSingleQuestion(questions[i], format, scheme);
    // Small timeout to prevent browser popup block
    if (i < questions.length - 1) {
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }
}

export interface CropResult {
  pngDataUrl: string;
  jpgDataUrl: string;
  pdfDataUrl?: string;
  pdfBlob?: Blob;
  width: number;
  height: number;
}

/**
 * Automatically computes optimal question-adaptive padding based on question bounding box,
 * dimensions, aspect ratio, and canvas resolution so every question is cropped with perfect breathing room.
 */
export function calculateAutomaticQuestionPadding(
  cWidth: number,
  cHeight: number,
  box2D: [number, number, number, number] // [ymin, xmin, ymax, xmax] 0-1000 scale
): { padX: number; padY: number } {
  const boxHeight = Math.max(10, ((box2D[2] - box2D[0]) / 1000) * cHeight);
  const boxWidth = Math.max(10, ((box2D[3] - box2D[1]) / 1000) * cWidth);

  // Optical vertical padding: ~2% to 3.5% of question height, bounded between 10px and 28px
  const padY = Math.max(10, Math.min(28, Math.round(boxHeight * 0.025)));
  // Optical horizontal padding: ~1.5% to 2.5% of question width, bounded between 12px and 32px
  const padX = Math.max(12, Math.min(32, Math.round(boxWidth * 0.02)));

  return { padX, padY };
}

/**
 * Crops a question block from the page canvas with automatic question-adaptive edge padding.
 * PNG + JPG are generated eagerly (previews + exports); the standalone PDF is built
 * lazily on demand from the PNG to keep memory low on mobile devices.
 */
export function cropQuestionFromCanvas(
  sourceCanvas: HTMLCanvasElement,
  box2D: [number, number, number, number], // [ymin, xmin, ymax, xmax] 0-1000 scale
  _manualPadding?: number | 'auto'
): CropResult {
  const cWidth = sourceCanvas.width;
  const cHeight = sourceCanvas.height;

  // Convert 0-1000 scale to canvas coordinates
  let ymin = Math.floor((box2D[0] / 1000) * cHeight);
  let xmin = Math.floor((box2D[1] / 1000) * cWidth);
  let ymax = Math.ceil((box2D[2] / 1000) * cHeight);
  let xmax = Math.ceil((box2D[3] / 1000) * cWidth);

  // Compute automatic adaptive padding tailored specifically to this question's geometry
  const { padX, padY } = calculateAutomaticQuestionPadding(cWidth, cHeight, box2D);

  // Apply automatic padding while clamping strictly to canvas dimensions
  xmin = Math.max(0, xmin - padX);
  ymin = Math.max(0, ymin - padY);
  xmax = Math.min(cWidth, xmax + padX);
  ymax = Math.min(cHeight, ymax + padY);

  const cropWidth = Math.max(10, xmax - xmin);
  const cropHeight = Math.max(10, ymax - ymin);

  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = cropWidth;
  cropCanvas.height = cropHeight;

  const ctx = cropCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (ctx) {
    // Fill white background for clean transparency-free output
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, cropWidth, cropHeight);

    // Draw region from source canvas
    ctx.drawImage(
      sourceCanvas,
      xmin,
      ymin,
      cropWidth,
      cropHeight,
      0,
      0,
      cropWidth,
      cropHeight
    );
  }

  const pngDataUrl = cropCanvas.toDataURL('image/png');
  const jpgDataUrl = cropCanvas.toDataURL('image/jpeg', 0.95);

  // Release the crop canvas backing store right away
  cropCanvas.width = 0;
  cropCanvas.height = 0;

  return {
    pngDataUrl,
    jpgDataUrl,
    width: cropWidth,
    height: cropHeight,
  };
}

/**
 * Loads a page's JPEG dataURL into a temporary canvas (the full-resolution
 * canvas is no longer retained in memory, so crops are built from the dataURL).
 */
export function buildTempCanvasFromDataUrl(dataUrl: string): Promise<HTMLCanvasElement | null> {
  if (!dataUrl) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) {
        resolve(null);
        return;
      }
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      resolve(canvas);
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/**
 * Crops a question directly from a page's JPEG dataURL
 */
export async function cropQuestionFromDataUrl(
  pageDataUrl: string,
  box2D: [number, number, number, number]
): Promise<CropResult | null> {
  const canvas = await buildTempCanvasFromDataUrl(pageDataUrl);
  if (!canvas) return null;
  try {
    return cropQuestionFromCanvas(canvas, box2D);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * Crops many questions from one page, decoding the page image only once.
 * Yields between crops so the encodes don't lock the UI on slower phones.
 */
export async function cropQuestionsFromDataUrl(
  pageDataUrl: string,
  boxes: Array<[number, number, number, number]>
): Promise<Array<CropResult | null>> {
  if (boxes.length === 0) return [];
  const canvas = await buildTempCanvasFromDataUrl(pageDataUrl);
  if (!canvas) return boxes.map(() => null);
  try {
    const results: Array<CropResult | null> = [];
    for (let i = 0; i < boxes.length; i++) {
      results.push(cropQuestionFromCanvas(canvas, boxes[i]));
      if (i < boxes.length - 1) await new Promise((r) => setTimeout(r, 0));
    }
    return results;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * Revokes a question's object URL (no-ops for plain data URLs)
 */
export function revokeObjectUrlSafe(url: string | undefined | null): void {
  if (url && url.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* already revoked */
    }
  }
}

/**
 * True when running in iOS Safari / iOS webview, where browsers block
 * multi-file sequential downloads and only reliably download a single file.
 */
export function isIosLikeBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && (navigator as any).maxTouchPoints > 1);
  return isIOS;
}

/**
 * Downloads a single file directly to the device: data URL → blob → object
 * URL → synthetic anchor click. (This previously tried the Web Share API
 * first, which on systems with a share sheet sent exports to "shared"
 * destinations instead of saving them — it must always be a plain download.)
 */
export async function downloadFileMobileSafe(
  dataUrl: string,
  filename: string
): Promise<void> {
  let objectUrl: string | null = null;
  try {
    const blob = await (await fetch(dataUrl)).blob();
    objectUrl = URL.createObjectURL(blob);
  } catch {
    objectUrl = null; // blob conversion failed — fall back to the data URL
  }
  const a = document.createElement('a');
  a.href = objectUrl ?? dataUrl;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  if (objectUrl) {
    // Keep the URL alive briefly; some browsers cancel the download if the
    // URL is revoked in the same tick as the click.
    window.setTimeout(() => revokeObjectUrlSafe(objectUrl), 4000);
  }
}
