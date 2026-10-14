import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';
import { BookChapter, BookMappingResult } from '../types';
import { formatBookMappingToJson } from './bookPaginationEngine';

/**
 * Trims and sanitizes a filename for cross-platform file saving
 */
function sanitizeFileName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 60);
}

/**
 * Extract an individual chapter's page range as a standalone PDF byte array using pdf-lib
 */
export async function extractChapterPdfBytes(
  originalPdfBuffer: ArrayBuffer | Uint8Array,
  chapter: BookChapter
): Promise<Uint8Array> {
  const bufferCopy = originalPdfBuffer instanceof Uint8Array
    ? originalPdfBuffer.slice()
    : new Uint8Array(originalPdfBuffer.slice(0));

  const srcDoc = await PDFDocument.load(bufferCopy);
  const subDoc = await PDFDocument.create();

  // Convert 1-indexed start_page & end_page to 0-indexed page indices
  const pageIndices: number[] = [];
  const startIdx = Math.max(0, chapter.start_page - 1);
  const endIdx = Math.min(srcDoc.getPageCount() - 1, chapter.end_page - 1);

  for (let i = startIdx; i <= endIdx; i++) {
    pageIndices.push(i);
  }

  const copiedPages = await subDoc.copyPages(srcDoc, pageIndices);
  for (const page of copiedPages) {
    subDoc.addPage(page);
  }

  subDoc.setTitle(chapter.chapter_title);
  return await subDoc.save();
}

/**
 * Download a single chapter as an individual PDF file
 */
export async function downloadSingleChapterPdf(
  originalPdfBuffer: ArrayBuffer | Uint8Array,
  chapter: BookChapter
): Promise<void> {
  const pdfBytes = await extractChapterPdfBytes(originalPdfBuffer, chapter);
  const blob = new Blob([pdfBytes as any], { type: 'application/pdf' });
  const fileName = `${String(chapter.chapter_index).padStart(2, '0')}_${sanitizeFileName(chapter.chapter_title)}_pages_${chapter.start_page}-${chapter.end_page}.pdf`;
  
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Generate a complete ZIP archive containing:
 * 1. chapter_map.json (exact strictly formatted schema)
 * 2. README_CHAPTERS.txt (summary of ranges)
 * 3. All individual split chapter PDFs
 */
export async function createChaptersZipArchive(
  originalPdfBuffer: ArrayBuffer | Uint8Array,
  mappingResult: BookMappingResult,
  onProgress?: (current: number, total: number) => void
): Promise<Blob> {
  const zip = new JSZip();
  const folderName = `${sanitizeFileName(mappingResult.book_title)}_chapters`;
  const folder = zip.folder(folderName) || zip;

  // 1. Add strictly formatted raw JSON
  const rawJson = formatBookMappingToJson(mappingResult);
  folder.file('book_chapters_map.json', rawJson);

  // 2. Add human-readable summary
  let summaryText = `BOOK CHAPTER PAGINATION & STRUCTURAL MAP\n`;
  summaryText += `==========================================\n`;
  summaryText += `Book Title: ${mappingResult.book_title}\n`;
  summaryText += `Total Discovered Chapters: ${mappingResult.total_discovered_chapters}\n`;
  summaryText += `Total Document Pages: ${mappingResult.totalPages || 'N/A'}\n\n`;
  summaryText += `CHAPTER BOUNDARIES & EXACT PAGE RANGES:\n`;
  summaryText += `------------------------------------------\n`;
  
  for (const ch of mappingResult.chapters) {
    const pageSpan = ch.end_page - ch.start_page + 1;
    summaryText += `[Chapter ${ch.chapter_index}] "${ch.chapter_title}"\n`;
    summaryText += `  • Physical Pages: ${ch.start_page} to ${ch.end_page} (${pageSpan} pages)\n`;
  }
  folder.file('SUMMARY_RANGES.txt', summaryText);

  // 3. Generate individual chapter PDFs efficiently
  const chapters = mappingResult.chapters;
  try {
    const bufferCopy = originalPdfBuffer instanceof Uint8Array
      ? originalPdfBuffer.slice()
      : new Uint8Array(originalPdfBuffer.slice(0));

    const srcDoc = await PDFDocument.load(bufferCopy);
    const totalPdfPages = srcDoc.getPageCount();

    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];
      onProgress?.(i + 1, chapters.length);

      try {
        const subDoc = await PDFDocument.create();
        const startIdx = Math.max(0, ch.start_page - 1);
        const endIdx = Math.min(totalPdfPages - 1, ch.end_page - 1);
        const pageIndices: number[] = [];
        for (let p = startIdx; p <= endIdx; p++) {
          pageIndices.push(p);
        }

        const copiedPages = await subDoc.copyPages(srcDoc, pageIndices);
        for (const page of copiedPages) {
          subDoc.addPage(page);
        }
        subDoc.setTitle(ch.chapter_title);
        const pdfBytes = await subDoc.save();

        const fileName = `${String(ch.chapter_index).padStart(2, '0')}_${sanitizeFileName(ch.chapter_title)}_p${ch.start_page}-p${ch.end_page}.pdf`;
        folder.file(fileName, pdfBytes);
      } catch (e) {
        console.warn(`Could not slice chapter ${ch.chapter_index}:`, e);
      }
    }
  } catch (loadErr) {
    console.error('Could not load master PDF for ZIP creation:', loadErr);
  }

  return await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

/**
 * Trigger download of raw JSON file
 */
export function downloadRawJsonFile(mappingResult: BookMappingResult): void {
  const rawJson = formatBookMappingToJson(mappingResult);
  const blob = new Blob([rawJson], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sanitizeFileName(mappingResult.book_title)}_chapter_map.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
