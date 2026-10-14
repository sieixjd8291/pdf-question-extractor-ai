import JSZip from 'jszip';
import { QuestionDetection } from '../types';
import { formatQuestionFilename, createQuestionPdfBlob } from './cropper';

/**
 * Converts a data URL to Uint8Array for JSZip
 */
function dataUrlToBinary(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(',')[1];
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

export type ZipExportFormat = 'pdf' | 'png' | 'jpg' | 'all';

/**
 * Creates and downloads the questions archive (defaults to JPG format, without generating report files)
 */
export async function createQuestionsZip(
  questions: QuestionDetection[],
  format: ZipExportFormat = 'jpg',
  namingScheme: 'index' | 'label' | 'page_index' = 'index',
  onProgress?: (percent: number) => void
): Promise<Blob> {
  const zip = new JSZip();
  const total = questions.length;

  for (let i = 0; i < total; i++) {
    const q = questions[i];
    const index = q.questionIndex;

    // PDF Export (Default)
    if (format === 'pdf' || format === 'all') {
      const filename = formatQuestionFilename(index, 'pdf', q.questionNumberRaw, q.pageNumber, namingScheme);
      try {
        let pdfBlob = q.pdfBlob;
        if (!pdfBlob && q.pngDataUrl) {
          pdfBlob = await createQuestionPdfBlob(q.pngDataUrl, q.cropWidth || 600, q.cropHeight || 300);
        }
        if (pdfBlob) {
          const arrayBuffer = await pdfBlob.arrayBuffer();
          if (format === 'all') {
            zip.folder('PDF')?.file(filename, arrayBuffer);
          } else {
            zip.file(filename, arrayBuffer);
          }
        }
      } catch (err) {
        console.warn(`Failed to export PDF for question ${index}`, err);
      }
    }

    // PNG Export
    if ((format === 'png' || format === 'all') && q.pngDataUrl) {
      const filename = formatQuestionFilename(index, 'png', q.questionNumberRaw, q.pageNumber, namingScheme);
      const data = dataUrlToBinary(q.pngDataUrl);
      if (format === 'all') {
        zip.folder('PNG')?.file(filename, data);
      } else {
        zip.file(filename, data);
      }
    }

    // JPG Export
    if ((format === 'jpg' || format === 'all') && q.jpgDataUrl) {
      const filename = formatQuestionFilename(index, 'jpg', q.questionNumberRaw, q.pageNumber, namingScheme);
      const data = dataUrlToBinary(q.jpgDataUrl);
      if (format === 'all') {
        zip.folder('JPG')?.file(filename, data);
      } else {
        zip.file(filename, data);
      }
    }

    if (onProgress) {
      onProgress(Math.floor(((i + 1) / total) * 75));
    }
  }

  // Generate ZIP Blob directly without report files
  const zipBlob = await zip.generateAsync(
    {
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    },
    (metadata) => {
      if (onProgress) {
        onProgress(75 + Math.floor((metadata.percent / 100) * 25));
      }
    }
  );

  return zipBlob;
}

/**
 * Triggers a browser download of a Blob
 */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
