import {pdfjsLib,pdfAssetOptions} from './pdfConfig';
import {geminiAuthHeaders} from './geminiSettings';
import { BookChapter, BookMappingResult } from '../types';

export interface BookScanProgress {
  phase: 'reading-outline' | 'scanning-toc' | 'analyzing-headings' | 'calculating-pagination' | 'rendering-previews' | 'complete';
  currentPage: number;
  totalPages: number;
  message: string;
  percent: number;
}

export interface ChapterHeadingCandidate {
  physicalPage: number;
  rawTitle: string;
  confidence: number;
  source: 'outline' | 'toc' | 'heading' | 'ai' | 'font' | 'manual';
  matchedPattern?: string;
}

// Comprehensive regexes for academic, engineering, science, and general book chapter openers
const CHAPTER_OPENER_REGEXES: Array<{ pattern: RegExp; type: string; confidence: number }> = [
  // "Chapter 1: Linear Algebra", "CHAPTER 1", "Chapter I", "Chapter One"
  {
    pattern: /^\s*CHAPTER\s+([0-9]{1,4}|[IVXLCDM]{1,8}|ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN|ELEVEN|TWELVE|THIRTEEN|FOURTEEN|FIFTEEN|SIXTEEN|SEVENTEEN|EIGHTEEN|NINETEEN|TWENTY|THIRTY|FORTY|FIFTY)(?:[\.\:\-\s—–]+(.*))?$/i,
    type: 'chapter_num',
    confidence: 0.98,
  },
  // "Ch. 1", "Ch 1 - Title", "Chap. 1"
  {
    pattern: /^\s*Ch(?:ap)?\.?\s*([0-9]{1,4}|[IVXLCDM]{1,8})(?:[\.\:\-\s—–]+(.*))?$/i,
    type: 'ch_abbr',
    confidence: 0.95,
  },
  // "UNIT I", "UNIT 1", "Unit 1: Title", "Unit - I: Matrices"
  {
    pattern: /^\s*UNIT\s*[\-\:]?\s*([0-9]{1,3}|[IVXLCDM]{1,8}|ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT)(?:[\.\:\-\s—–]+(.*))?$/i,
    type: 'unit_num',
    confidence: 0.96,
  },
  // "Part I: Title", "Part 1", "BOOK I", "SECTION 1", "MODULE 1", "MODULE I"
  {
    pattern: /^\s*(?:PART|BOOK|SECTION|MODULE|ACT|TOPIC|LESSON)\s+([0-9]{1,3}|[IVXLCDM]{1,8}|ONE|TWO|THREE|FOUR|FIVE|SIX)(?:[\.\:\-\s—–]+(.*))?$/i,
    type: 'part_num',
    confidence: 0.93,
  },
  // "1. Solution of Equations", "2. Linear Algebra", "3. Vector Algebra", "21. Laplace Transforms"
  // (Numbered chapters in Indian & international textbooks like B.S. Grewal)
  {
    pattern: /^\s*([0-9]{1,2})\.\s+([A-Z][A-Za-z0-9\s,\(\)–—\-]{3,80})$/,
    type: 'num_dot_title',
    confidence: 0.90,
  },
  // "1 Solution of Equations", "2 Linear Algebra"
  {
    pattern: /^\s*([0-9]{1,2})\s+([A-Z]{3,}[A-Za-z0-9\s,\(\)–—\-]{3,80})$/,
    type: 'num_spaced_title',
    confidence: 0.86,
  },
  // Special Book Divisions (Prologue, Preface, Introduction, Contents, etc.)
  {
    pattern: /^\s*(PROLOGUE|PREFACE|INTRODUCTION|FOREWORD|PRELUDE|PROLEGOMENA)(?:[\.\:\-\s—–]+(.*))?$/i,
    type: 'front_matter',
    confidence: 0.95,
  },
  {
    pattern: /^\s*(EPILOGUE|CONCLUSION|AFTERWORD|POSTSCRIPT|CODA|ENVOI)(?:[\.\:\-\s—–]+(.*))?$/i,
    type: 'back_matter',
    confidence: 0.95,
  },
  {
    pattern: /^\s*(APPENDIX(?:\s+[A-Z0-9]+)?|NOTES|BIBLIOGRAPHY|REFERENCES|GLOSSARY|INDEX|ANSWERS|HINTS)(?:[\.\:\-\s—–]+(.*))?$/i,
    type: 'appendix',
    confidence: 0.92,
  },
];

// Table of Contents line matchers: e.g. "Chapter 1: The Gathering ........... 14"
const TOC_LINE_REGEXES = [
  /^(.*?)(?:\.{2,}|\s{3,}|\t+)\s*([0-9]{1,4}|[ivxlcdm]{1,8})\s*$/i,
  /^(.*?)\s+([0-9]{1,4})\s*$/i,
  /^([0-9]{1,2}\.?\s+[A-Za-z\s,\(\)\-]+?)\s+([0-9]{1,4})$/,
];

// Markers for detecting start of Table of Contents
const TOC_START_REGEX = /^\s*(?:TABLE\s+OF\s+CONTENTS|CONTENTS|BRIEF\s+CONTENTS|DETAILED\s+CONTENTS|COURSE\s+CONTENTS|INDEX\s+OF\s+CHAPTERS|SOMMAIRE|INHALT|CONTENTS\s+AT\s+A\s+GLANCE|SYLLABUS\s+&\s+CONTENTS|UNIT[\-\s]WISE\s+CONTENTS)\s*$/i;

/**
 * Format book mapping result to exact raw JSON string
 */
export function formatBookMappingToJson(result: BookMappingResult): string {
  const cleanObject = {
    book_title: result.book_title,
    total_discovered_chapters: result.chapters.length,
    chapters: result.chapters.map((ch) => ({
      chapter_index: ch.chapter_index,
      chapter_title: ch.chapter_title,
      start_page: typeof ch.start_page === 'number' && !isNaN(ch.start_page) && ch.start_page > 0 ? ch.start_page : null,
      end_page: typeof ch.end_page === 'number' && !isNaN(ch.end_page) && ch.end_page > 0 ? ch.end_page : null,
    })),
  };
  return JSON.stringify(cleanObject, null, 2);
}

/**
 * Extract outline bookmarks natively from PDF
 */
async function extractBookmarksFromPdf(
  pdfDoc: any,
  totalPages: number
): Promise<ChapterHeadingCandidate[]> {
  try {
    const outline = await pdfDoc.getOutline();
    if (!outline || !Array.isArray(outline) || outline.length === 0) {
      return [];
    }

    const candidates: ChapterHeadingCandidate[] = [];

    async function traverseItems(items: any[], depth: number) {
      for (const item of items) {
        if (!item.title) continue;

        let pageIndex: number | null = null;

        if (item.dest) {
          try {
            let destRef = item.dest;
            if (typeof destRef === 'string') {
              destRef = await pdfDoc.getDestination(destRef);
            }
            if (Array.isArray(destRef) && destRef[0]) {
              pageIndex = await pdfDoc.getPageIndex(destRef[0]);
            }
          } catch (e) {
            // fallback
          }
        }

        if (pageIndex !== null && pageIndex >= 0 && pageIndex < totalPages) {
          const physPage = pageIndex + 1; // 1-indexed
          const cleanTitle = item.title.trim().replace(/\r?\n+/g, ' ');

          // Check if this bookmark looks like a chapter or major section
          const isTopLevelOrChapter = depth <= 2 || CHAPTER_OPENER_REGEXES.some((r) => r.pattern.test(cleanTitle));
          
          if (isTopLevelOrChapter) {
            candidates.push({
              physicalPage: physPage,
              rawTitle: cleanTitle,
              confidence: 0.99,
              source: 'outline',
            });
          }
        }

        if (item.items && Array.isArray(item.items) && item.items.length > 0 && depth < 3) {
          await traverseItems(item.items, depth + 1);
        }
      }
    }

    await traverseItems(outline, 1);
    return candidates;
  } catch (err) {
    console.warn('PDF outline parsing not available:', err);
    return [];
  }
}

/**
 * Extract text lines, detect TOC pages, and identify printed page offsets
 * Instantaneous parallel scan of only the first 15 pages (under 50ms)
 */
async function extractTocAndPageHeadings(
  pdfDoc: any,
  totalPages: number,
  hasOutline: boolean = false
): Promise<{
  bookTitleHint: string;
  tocText: string;
  tocStartPage: number;
  tocEndPage: number;
  tocCandidates: ChapterHeadingCandidate[];
  headingCandidates: ChapterHeadingCandidate[];
  printedToPhysicalOffsets: Array<{ printed: number; physical: number; offset: number }>;
}> {
  let bookTitleHint = '';
  let tocText = '';
  let tocStartPage = -1;
  let tocEndPage = -1;
  const tocCandidates: ChapterHeadingCandidate[] = [];
  const headingCandidates: ChapterHeadingCandidate[] = [];
  const offsets: Array<{ printed: number; physical: number; offset: number }> = [];

  // If outline/bookmarks are present, return immediately in 0ms!
  if (hasOutline) {
    return {
      bookTitleHint,
      tocText,
      tocStartPage,
      tocEndPage,
      tocCandidates,
      headingCandidates,
      printedToPhysicalOffsets: [],
    };
  }

  // Fast single-batch scan of only first 15 pages (where TOC/front matter reside)
  const maxTocScanPages = Math.min(totalPages, 15);
  const earlyPages = Array.from({ length: maxTocScanPages }, (_, i) => i + 1);

  const pageResults = await Promise.all(
    earlyPages.map(async (i) => {
      try {
        const page = await pdfDoc.getPage(i);
        const textContent = await page.getTextContent();
        const rawItems = textContent.items || [];

        const lineStrings: string[] = [];
        let currentLine = '';
        let lastY: number | null = null;

        for (const item of rawItems as any[]) {
          if (!('str' in item) || !item.str) continue;
          const transform = item.transform;
          const y = transform ? transform[5] : null;

          if (lastY !== null && y !== null && Math.abs(lastY - y) > 6) {
            if (currentLine.trim()) {
              lineStrings.push(currentLine.trim());
            }
            currentLine = item.str;
          } else {
            currentLine += (currentLine ? ' ' : '') + item.str;
          }
          lastY = y;
        }
        if (currentLine.trim()) {
          lineStrings.push(currentLine.trim());
        }

        return { pageNum: i, lineStrings };
      } catch {
        return { pageNum: i, lineStrings: [] };
      }
    })
  );

  let isInsideToc = false;

  for (const { pageNum: i, lineStrings } of pageResults) {
    if (lineStrings.length === 0) continue;
    const pageText = lineStrings.join('\n');

    // Title extraction from early pages
    if ((i === 1 || i === 2 || i === 3) && !bookTitleHint) {
      for (const line of lineStrings.slice(0, 5)) {
        if (line.length > 4 && line.length < 90 && !/copyright|isbn|all rights|contents|edition|author|published/i.test(line)) {
          bookTitleHint = line;
          break;
        }
      }
    }

    // Printed page number offset
    if (i >= 2 && i <= 15) {
      const checkLines = [lineStrings[lineStrings.length - 1], lineStrings[0]];
      for (const l of checkLines) {
        const matchNum = l?.trim().match(/^(?:[-—–\s]*)([0-9]{1,4})(?:[-—–\s]*)$/);
        if (matchNum) {
          const printedVal = parseInt(matchNum[1], 10);
          if (printedVal > 0 && printedVal < i && i - printedVal > 0 && i - printedVal < 50) {
            offsets.push({
              printed: printedVal,
              physical: i,
              offset: i - printedVal,
            });
          }
        }
      }
    }

    // TOC detection
    const hasTocHeading = lineStrings.some((l) => TOC_START_REGEX.test(l.trim()));
    if (hasTocHeading) {
      isInsideToc = true;
      if (tocStartPage === -1) tocStartPage = i;
    }

    if (isInsideToc) {
      tocEndPage = i;
      tocText += `\n--- [Physical Page ${i}] ---\n` + pageText;

      for (const line of lineStrings) {
        for (const r of TOC_LINE_REGEXES) {
          const m = line.match(r);
          if (m) {
            const titlePart = m[1].trim().replace(/\.+$/, '').trim();
            const pageNumPart = parseInt(m[2], 10);
            if (titlePart.length > 2 && !isNaN(pageNumPart) && pageNumPart > 0) {
              const isChapter = CHAPTER_OPENER_REGEXES.some((rg) => rg.pattern.test(titlePart));
              const isUnitOrNumbered = /^(?:Unit|Chapter|Part|Module|[0-9]{1,2}\.)/i.test(titlePart);
              if (isChapter || isUnitOrNumbered || titlePart.length > 4) {
                tocCandidates.push({
                  physicalPage: pageNumPart,
                  rawTitle: titlePart,
                  confidence: 0.88,
                  source: 'toc',
                });
              }
            }
          }
        }
      }

      if (i > tocStartPage + 1 && lineStrings.some((l) => /^\s*(?:CHAPTER\s+1|UNIT\s+1|UNIT\s+I)\b/i.test(l))) {
        isInsideToc = false;
      }
    }

    // Headings on early pages
    for (let lineIdx = 0; lineIdx < Math.min(lineStrings.length, 6); lineIdx++) {
      const line = lineStrings[lineIdx];
      for (const opener of CHAPTER_OPENER_REGEXES) {
        const match = line.match(opener.pattern);
        if (match) {
          let fullTitle = line.trim();
          if (lineIdx + 1 < lineStrings.length && lineStrings[lineIdx + 1].length < 90) {
            const nextLine = lineStrings[lineIdx + 1].trim();
            if (!/^[0-9]+$/.test(nextLine) && !CHAPTER_OPENER_REGEXES.some((o) => o.pattern.test(nextLine))) {
              fullTitle += `: ${nextLine}`;
            }
          }

          headingCandidates.push({
            physicalPage: i,
            rawTitle: fullTitle,
            confidence: opener.confidence,
            source: 'heading',
            matchedPattern: opener.type,
          });
          break;
        }
      }
    }
  }

  return {
    bookTitleHint,
    tocText,
    tocStartPage,
    tocEndPage,
    tocCandidates,
    headingCandidates,
    printedToPhysicalOffsets: offsets,
  };
}

/**
 * Calibrate printed page numbers to physical page numbers
 */
function calibrateTocOffsets(
  tocCandidates: ChapterHeadingCandidate[],
  headingCandidates: ChapterHeadingCandidate[],
  printedToPhysicalOffsets: Array<{ printed: number; physical: number; offset: number }>,
  totalPages: number
): ChapterHeadingCandidate[] {
  if (tocCandidates.length === 0) return [];

  // Strategy 1: Calculate offset from detected page number markers
  let bestOffset = 0;
  if (printedToPhysicalOffsets.length > 0) {
    const offsets = printedToPhysicalOffsets.map((o) => o.offset).sort((a, b) => a - b);
    bestOffset = offsets[Math.floor(offsets.length / 2)];
  }

  // Strategy 2: Cross-match titles between TOC and Heading candidates
  if (bestOffset === 0 && headingCandidates.length > 0) {
    const matchedDiffs: number[] = [];
    for (const toc of tocCandidates) {
      const match = headingCandidates.find((h) => {
        const cleanT = toc.rawTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
        const cleanH = h.rawTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
        return cleanT.includes(cleanH) || cleanH.includes(cleanT);
      });
      if (match) {
        const diff = match.physicalPage - toc.physicalPage;
        if (diff >= 0 && diff < 60) {
          matchedDiffs.push(diff);
        }
      }
    }
    if (matchedDiffs.length > 0) {
      matchedDiffs.sort((a, b) => a - b);
      bestOffset = matchedDiffs[Math.floor(matchedDiffs.length / 2)];
    }
  }

  // Strategy 3: Check if chapter 1 was found in headings
  if (bestOffset === 0) {
    const ch1Heading = headingCandidates.find((h) => /^(?:Chapter\s+1|Unit\s+1|Unit\s+I|1\.)/i.test(h.rawTitle));
    const ch1Toc = tocCandidates.find((t) => /^(?:Chapter\s+1|Unit\s+1|Unit\s+I|1\.)/i.test(t.rawTitle));
    if (ch1Heading && ch1Toc) {
      bestOffset = Math.max(0, ch1Heading.physicalPage - ch1Toc.physicalPage);
    }
  }

  return tocCandidates.map((c) => {
    const calibratedPage = Math.min(totalPages, Math.max(1, c.physicalPage + bestOffset));
    return {
      ...c,
      physicalPage: calibratedPage,
    };
  });
}

/**
 * Reconcile chapter candidates into strictly continuous zero-gap chapters
 */
export function reconcileChapterBoundaries(
  candidates: ChapterHeadingCandidate[],
  totalPages: number,
  bookTitle: string
): BookMappingResult {
  if (candidates.length === 0) {
    return {
      book_title: bookTitle || 'Document',
      total_discovered_chapters: 0,
      chapters: [],
      totalPages,
    };
  }

  // Sort by physical page ascending
  const sorted = [...candidates].sort((a, b) => a.physicalPage - b.physicalPage);

  // Deduplicate on same page
  const uniqueByPage: ChapterHeadingCandidate[] = [];
  for (const c of sorted) {
    const existing = uniqueByPage.find((u) => u.physicalPage === c.physicalPage);
    if (!existing) {
      uniqueByPage.push(c);
    } else if (c.confidence > existing.confidence) {
      const idx = uniqueByPage.indexOf(existing);
      uniqueByPage[idx] = c;
    }
  }

  // Filter out candidates suspiciously close (< 2 pages apart) unless distinct
  const filtered: ChapterHeadingCandidate[] = [];
  for (let i = 0; i < uniqueByPage.length; i++) {
    const curr = uniqueByPage[i];
    if (filtered.length === 0) {
      filtered.push(curr);
    } else {
      const prev = filtered[filtered.length - 1];
      if (curr.physicalPage - prev.physicalPage >= 2 || i === uniqueByPage.length - 1) {
        filtered.push(curr);
      }
    }
  }

  const chapters: BookChapter[] = [];
  let currentIndex = 1;

  // If first chapter starts > 1, create Front Matter
  if (filtered[0].physicalPage > 1) {
    const firstStart = filtered[0].physicalPage;
    chapters.push({
      chapter_index: 0,
      chapter_title: 'Front Matter & Contents',
      start_page: 1,
      end_page: firstStart - 1,
      pageCount: firstStart - 1,
      source: 'heading',
    });
  }

  for (let i = 0; i < filtered.length; i++) {
    const curr = filtered[i];
    const startPage = curr.physicalPage;
    let endPage: number;

    if (i < filtered.length - 1) {
      endPage = filtered[i + 1].physicalPage - 1;
    } else {
      endPage = totalPages;
    }

    if (endPage < startPage) {
      endPage = startPage;
    }

    const isPrologue = /prologue|preface|foreword|introduction/i.test(curr.rawTitle) && i === 0 && chapters.length === 0;
    const assignedIndex = isPrologue ? 0 : currentIndex++;

    chapters.push({
      chapter_index: assignedIndex,
      chapter_title: curr.rawTitle.trim(),
      start_page: startPage,
      end_page: endPage,
      pageCount: endPage - startPage + 1,
      source: curr.source,
    });
  }

  // Enforce zero gaps
  for (let i = 0; i < chapters.length - 1; i++) {
    chapters[i].end_page = chapters[i + 1].start_page - 1;
    chapters[i].pageCount = chapters[i].end_page - chapters[i].start_page + 1;
  }
  if (chapters.length > 0) {
    chapters[chapters.length - 1].end_page = totalPages;
    chapters[chapters.length - 1].pageCount = totalPages - chapters[chapters.length - 1].start_page + 1;
  }

  return {
    book_title: bookTitle || 'Document',
    total_discovered_chapters: chapters.length,
    chapters,
    totalPages,
  };
}

/**
 * Render quick lightweight preview thumbnails for chapter boundaries
 */
export async function renderChapterThumbnails(
  pdfDoc: any,
  chapters: BookChapter[],
  scale: number = 0.5
): Promise<BookChapter[]> {
  const updated = [...chapters];

  for (let i = 0; i < updated.length; i++) {
    const ch = updated[i];
    try {
      if (ch.start_page >= 1 && ch.start_page <= pdfDoc.numPages) {
        const page1 = await pdfDoc.getPage(ch.start_page);
        const vp1 = page1.getViewport({ scale });
        const canvas1 = document.createElement('canvas');
        canvas1.width = Math.floor(vp1.width);
        canvas1.height = Math.floor(vp1.height);
        const ctx1 = canvas1.getContext('2d');
        if (ctx1) {
          await page1.render({ canvasContext: ctx1, viewport: vp1 } as any).promise;
          ch.firstPagePreview = canvas1.toDataURL('image/jpeg', 0.8);
        }
      }

      if (ch.end_page >= 1 && ch.end_page <= pdfDoc.numPages && ch.end_page !== ch.start_page) {
        const page2 = await pdfDoc.getPage(ch.end_page);
        const vp2 = page2.getViewport({ scale });
        const canvas2 = document.createElement('canvas');
        canvas2.width = Math.floor(vp2.width);
        canvas2.height = Math.floor(vp2.height);
        const ctx2 = canvas2.getContext('2d');
        if (ctx2) {
          await page2.render({ canvasContext: ctx2, viewport: vp2 } as any).promise;
          ch.lastPagePreview = canvas2.toDataURL('image/jpeg', 0.8);
        }
      }
    } catch (e) {
      console.warn(`Error generating thumbnail for chapter ${ch.chapter_title}:`, e);
    }
  }

  return updated;
}

/**
 * Master Book Structural Mapper Engine:
 * Analyzes a long-form PDF document (even 1300+ pages) without exceeding token limits,
 * combining PDF outline bookmarks, fast text & TOC scanning, and Gemini 3.7 Flash AI.
 */
export async function analyzeBookPaginationStructure(
  fileData: ArrayBuffer | Uint8Array,
  fileName: string,
  options: {
    useAiFallback?: boolean;
    renderThumbnails?: boolean;
  } = {},
  onProgress?: (progress: BookScanProgress) => void
): Promise<BookMappingResult> {
  const startTime = Date.now();

  onProgress?.({
    phase: 'reading-outline',
    currentPage: 0,
    totalPages: 0,
    message: 'Loading PDF document & reading bookmarks...',
    percent: 10,
  });

  const dataCopy = fileData instanceof Uint8Array
    ? fileData.slice()
    : new Uint8Array(fileData.slice(0));

  const loadingTask = pdfjsLib.getDocument({
    data: dataCopy,
    ...pdfAssetOptions,
  });

  const pdfDoc = await loadingTask.promise;
  const totalPages = pdfDoc.numPages;

  // 1. Try reading native PDF Outline / Bookmarks (instantaneous)
  const outlineCandidates = await extractBookmarksFromPdf(pdfDoc, totalPages);
  
  // Extract document metadata for book title
  let bookTitle = fileName.replace(/\.[^/.]+$/, '').replace(/[_\-+]/g, ' ');
  try {
    const meta = await pdfDoc.getMetadata();
    const info = meta?.info as Record<string, any> | undefined;
    if (info?.Title && typeof info.Title === 'string' && info.Title.trim().length > 2) {
      bookTitle = info.Title.trim();
    }
  } catch (e) {
    // fallback
  }

  // 2. Fast scan early pages only if outline is not available
  const {
    bookTitleHint,
    tocCandidates,
    headingCandidates,
    printedToPhysicalOffsets,
  } = await extractTocAndPageHeadings(pdfDoc, totalPages, outlineCandidates.length >= 2);

  if (bookTitleHint && (!bookTitle || bookTitle === fileName)) {
    bookTitle = bookTitleHint;
  }

  // 3. Calibrate TOC offsets if any
  const calibratedToc = calibrateTocOffsets(
    tocCandidates,
    headingCandidates,
    printedToPhysicalOffsets,
    totalPages
  );

  // Combine discovered candidate signals
  let allCandidates: ChapterHeadingCandidate[] = [
    ...outlineCandidates,
    ...headingCandidates,
    ...calibratedToc,
  ];

  let detectionMethod: 'outline' | 'hybrid-text' | 'ai-toc' = outlineCandidates.length > 2
    ? 'outline'
    : 'hybrid-text';

  // 4. AI fallback ONLY if explicitly requested by options (default is false for instant load)
  if (options.useAiFallback === true) {
    try {
      onProgress?.({
        phase: 'calculating-pagination',
        currentPage: totalPages,
        totalPages: totalPages,
        message: 'Segregating document chapters with Gemini AI...',
        percent: 75,
      });

      const response = await fetch('/api/map-book-chapters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...geminiAuthHeaders() },
        body: JSON.stringify({
          candidateChapters: allCandidates.slice(0, 100),
          firstPageOffsets: printedToPhysicalOffsets.slice(0, 10),
          totalPages,
          bookTitleHint: bookTitle,
        }),
      });

      if (response.ok) {
        const aiData = await response.json();
        if (aiData.chapters && Array.isArray(aiData.chapters) && aiData.chapters.length > 0) {
          allCandidates = aiData.chapters.map((ch: any) => ({
            physicalPage: ch.start_page,
            rawTitle: ch.chapter_title,
            confidence: 0.99,
            source: 'ai',
          }));
          if (aiData.book_title) {
            bookTitle = aiData.book_title;
          }
          detectionMethod = 'ai-toc';
        }
      }
    } catch (err) {
      console.warn('AI chapter mapping fallback encountered error:', err);
    }
  }

  // 5. Reconcile boundaries with continuous zero-gap execution rules
  const mappingResult = reconcileChapterBoundaries(allCandidates, totalPages, bookTitle);
  mappingResult.detectionMethod = detectionMethod;
  mappingResult.executionTimeMs = Date.now() - startTime;

  // 6. Optional thumbnail pre-rendering (default false because thumbnails render on-demand via virtualized canvas)
  if (options.renderThumbnails === true) {
    mappingResult.chapters = await renderChapterThumbnails(pdfDoc, mappingResult.chapters);
  }

  onProgress?.({
    phase: 'complete',
    currentPage: totalPages,
    totalPages: totalPages,
    message: `Loaded ${totalPages} pages and mapped chapters instantaneously.`,
    percent: 100,
  });

  return mappingResult;
}

/**
 * Automatically inspect a specific page's text layer and typography
 * to detect if a chapter heading opener or major title exists on that page.
 */
export async function detectChapterTitleOnPage(
  pdfDocOrBuffer: any,
  pageNumber: number
): Promise<{
  title: string;
  isOpener: boolean;
  confidence: number;
  snippet: string;
}> {
  try {
    let pdfDoc = pdfDocOrBuffer;
    if (pdfDocOrBuffer instanceof ArrayBuffer || pdfDocOrBuffer instanceof Uint8Array) {
      const loadingTask = pdfjsLib.getDocument({
        data: pdfDocOrBuffer,
        ...pdfAssetOptions,
      });
      pdfDoc = await loadingTask.promise;
    }

    if (!pdfDoc || pageNumber < 1 || pageNumber > pdfDoc.numPages) {
      return { title: `Chapter at Page ${pageNumber}`, isOpener: false, confidence: 0, snippet: '' };
    }

    const page = await pdfDoc.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const rawItems = textContent.items || [];

    const lineStrings: string[] = [];
    const lineFontSizes: number[] = [];
    let currentLine = '';
    let maxFontSizeInLine = 0;
    let lastY: number | null = null;

    for (const item of rawItems as any[]) {
      if (!('str' in item) || !item.str) continue;
      const transform = item.transform;
      const y = transform ? transform[5] : null;
      const fontSize = transform ? Math.abs(transform[0]) : 10;

      if (lastY !== null && y !== null && Math.abs(lastY - y) > 6) {
        if (currentLine.trim()) {
          lineStrings.push(currentLine.trim());
          lineFontSizes.push(maxFontSizeInLine);
        }
        currentLine = item.str;
        maxFontSizeInLine = fontSize;
      } else {
        currentLine += (currentLine ? ' ' : '') + item.str;
        if (fontSize > maxFontSizeInLine) {
          maxFontSizeInLine = fontSize;
        }
      }
      lastY = y;
    }
    if (currentLine.trim()) {
      lineStrings.push(currentLine.trim());
      lineFontSizes.push(maxFontSizeInLine);
    }

    const snippet = lineStrings.slice(0, 5).join(' | ');

    // 1. Primary: Use Gemini Flash Lite AI Vision & Structural Analysis on this specific opening page
    try {
      let imageData = '';
      if (typeof document !== 'undefined') {
        const viewport = page.getViewport({ scale: 0.9 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          await page.render({ canvasContext: ctx, viewport }).promise;
          imageData = canvas.toDataURL('image/jpeg', 0.82);
        }
      }

      const response = await fetch('/api/detect-chapter-title', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...geminiAuthHeaders() },
        body: JSON.stringify({
          pageNumber,
          imageData,
          pageText: lineStrings.slice(0, 30).join('\n'),
        }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.chapter_title && data.chapter_title.trim().length > 0) {
          return {
            title: data.chapter_title.trim(),
            isOpener: Boolean(data.is_chapter_opener),
            confidence: data.confidence || 0.95,
            snippet,
          };
        }
      }
    } catch (aiErr) {
      console.warn(`Gemini Lite API title detection failed for page ${pageNumber}, falling back to font extraction:`, aiErr);
    }

    // 2. Secondary Fallback: Regex Patterns for Standard Chapter Headings
    for (let idx = 0; idx < Math.min(lineStrings.length, 8); idx++) {
      const line = lineStrings[idx];
      for (const opener of CHAPTER_OPENER_REGEXES) {
        if (opener.pattern.test(line)) {
          let fullTitle = line.trim();
          if (idx + 1 < lineStrings.length && lineStrings[idx + 1].length < 80) {
            const nextL = lineStrings[idx + 1].trim();
            if (!/^[0-9]+$/.test(nextL) && !CHAPTER_OPENER_REGEXES.some((o) => o.pattern.test(nextL))) {
              fullTitle += `: ${nextL}`;
            }
          }
          return {
            title: fullTitle,
            isOpener: true,
            confidence: opener.confidence,
            snippet,
          };
        }
      }
    }

    // Check largest font size in top half
    let bestLine = '';
    let maxFont = 0;
    for (let idx = 0; idx < Math.min(lineStrings.length, 8); idx++) {
      const font = lineFontSizes[idx] || 10;
      const line = lineStrings[idx];
      if (font > maxFont && line.length > 3 && line.length < 90 && !/page|edition|copyright|all rights/i.test(line)) {
        maxFont = font;
        bestLine = line;
      }
    }

    if (maxFont >= 16 && bestLine) {
      return {
        title: bestLine.trim(),
        isOpener: true,
        confidence: 0.82,
        snippet,
      };
    }

    // Fallback first substantial line
    for (const l of lineStrings.slice(0, 4)) {
      if (l.length > 4 && l.length < 80 && !/^[0-9\s\.\-]+$/.test(l)) {
        return {
          title: l.trim(),
          isOpener: false,
          confidence: 0.6,
          snippet,
        };
      }
    }

    return {
      title: `Page ${pageNumber} Section`,
      isOpener: false,
      confidence: 0.3,
      snippet,
    };
  } catch (err) {
    console.warn(`Error auto-detecting title for page ${pageNumber}:`, err);
    return {
      title: `Page ${pageNumber}`,
      isOpener: false,
      confidence: 0,
      snippet: '',
    };
  }
}
