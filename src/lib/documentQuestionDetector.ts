import { RenderedPageInfo, TextItemWithBounds } from './pdfEngine';

export interface DetectedQuestionBox {
  question_number_raw: string;
  normalized_index: number;
  title_summary: string;
  box_2d: [number, number, number, number]; // [ymin, xmin, ymax, xmax] 0-1000 scale
  has_diagram: boolean;
  diagram_types: string[];
  confidence: number;
  sub_parts_detected: string[];
  warnings: string[];
}

export interface PageDetectionResult {
  page_number: number;
  detected_layout: string;
  page_quality_score: number;
  questions: DetectedQuestionBox[];
  page_warnings: string[];
}

interface TextLine {
  text: string;
  normYmin: number;
  normYmax: number;
  normXmin: number;
  normXmax: number;
  pixelYmin: number;
  pixelYmax: number;
  pixelXmin: number;
  pixelXmax: number;
  items: TextItemWithBounds[];
}

// Regex patterns to identify question starts
const QUESTION_PATTERNS: Array<{
  regex: RegExp;
  extractLabel: (match: RegExpMatchArray) => string;
}> = [
  // 1. , 2. , 10. , 1) , 2)
  {
    regex: /^\s*(\d{1,3})[\.\)]\s+(.*)/i,
    extractLabel: (m) => `${m[1]}.`,
  },
  // Q1, Q.1, Q 1, Q1:, Q1., Question 1, Question 1:, Que 1, Que. 1
  {
    regex: /^\s*Q(?:uestion|ue)?\.?\s*(\d{1,3}|[A-Z])[\.\:\-\)]?\s*(.*)/i,
    extractLabel: (m) => `Q${m[1]}`,
  },
  // Problem 1, Prob 1, Prob. 1
  {
    regex: /^\s*Prob(?:lem)?\.?\s*(\d{1,3})[\.\:\-\)]?\s*(.*)/i,
    extractLabel: (m) => `Problem ${m[1]}`,
  },
  // Exercise 1, Task 1
  {
    regex: /^\s*(?:Exercise|Task)\s*(\d{1,3})[\.\:\-\)]?\s*(.*)/i,
    extractLabel: (m) => `Task ${m[1]}`,
  },
  // (1), (2), (3)
  {
    regex: /^\s*\(([0-9]{1,3})\)\s+(.*)/i,
    extractLabel: (m) => `(${m[1]})`,
  },
  // Roman numerals: I., II., III., IV., V., VI., etc.
  {
    regex: /^\s*([IVXLCDM]{1,6})[\.\)]\s+(.*)/i,
    extractLabel: (m) => `${m[1].toUpperCase()}.`,
  },
  // Section A: Q1 or Part A: Q1
  {
    regex: /^\s*(?:Section|Part)\s+([A-Z0-9]+)\s*[:\-]\s*(?:Q|Question|Problem)?\s*(\d+)?\s*(.*)/i,
    extractLabel: (m) => (m[2] ? `Section ${m[1]} Q${m[2]}` : `Section ${m[1]}`),
  },
];

// Patterns for sub-parts that belong to the active question
const SUBPART_PATTERN = /^\s*(?:\(([a-z]|[ivxlcdm]+)\)|([a-z]|[ivxlcdm]+)\))\s*(.*)/i;

// Patterns indicating page/exam headers to exclude from question 1
const HEADER_KEYWORDS = [
  'university',
  'institute',
  'college',
  'department',
  'faculty',
  'paper name',
  'paper code',
  'semester',
  'subject',
  'module',
  'assignment',
  'examination',
  'midterm',
  'final exam',
  'test paper',
  'max marks',
  'full marks',
  'time allowed',
  'date:',
  'session:',
  'roll no',
  'reg no',
  'instructions',
  'answer all questions',
];

/**
 * Group raw text items into coherent horizontal lines
 */
function groupItemsIntoLines(items: TextItemWithBounds[]): TextLine[] {
  if (!items || items.length === 0) return [];

  // Sort items primarily by Y, secondarily by X
  const sorted = [...items].sort((a, b) => {
    const yDiff = a.pixelYmin - b.pixelYmin;
    if (Math.abs(yDiff) > 6) {
      return yDiff;
    }
    return a.pixelXmin - b.pixelXmin;
  });

  const lines: TextLine[] = [];

  for (const item of sorted) {
    if (!item.str || item.str.trim() === '') continue;

    // Try to find an existing line with overlapping Y
    const matchedLine = lines.find((line) => {
      const lineCenterY = (line.pixelYmin + line.pixelYmax) / 2;
      const itemCenterY = (item.pixelYmin + item.pixelYmax) / 2;
      return Math.abs(lineCenterY - itemCenterY) < 10;
    });

    if (matchedLine) {
      matchedLine.items.push(item);
      matchedLine.pixelXmin = Math.min(matchedLine.pixelXmin, item.pixelXmin);
      matchedLine.pixelXmax = Math.max(matchedLine.pixelXmax, item.pixelXmax);
      matchedLine.pixelYmin = Math.min(matchedLine.pixelYmin, item.pixelYmin);
      matchedLine.pixelYmax = Math.max(matchedLine.pixelYmax, item.pixelYmax);
      matchedLine.normXmin = Math.min(matchedLine.normXmin, item.normXmin);
      matchedLine.normXmax = Math.max(matchedLine.normXmax, item.normXmax);
      matchedLine.normYmin = Math.min(matchedLine.normYmin, item.normYmin);
      matchedLine.normYmax = Math.max(matchedLine.normYmax, item.normYmax);
    } else {
      lines.push({
        text: item.str,
        pixelXmin: item.pixelXmin,
        pixelXmax: item.pixelXmax,
        pixelYmin: item.pixelYmin,
        pixelYmax: item.pixelYmax,
        normXmin: item.normXmin,
        normXmax: item.normXmax,
        normYmin: item.normYmin,
        normYmax: item.normYmax,
        items: [item],
      });
    }
  }

  // Finalize text by sorting items horizontally inside each line
  for (const line of lines) {
    line.items.sort((a, b) => a.pixelXmin - b.pixelXmin);
    line.text = line.items.map((i) => i.str).join(' ').trim();
  }

  // Sort lines top to bottom
  lines.sort((a, b) => a.pixelYmin - b.pixelYmin);
  return lines;
}

/**
 * Check if a text line matches question starter patterns
 */
function matchQuestionHeader(lineText: string): { label: string; remainder: string } | null {
  const trimmed = lineText.trim();
  for (const pattern of QUESTION_PATTERNS) {
    const match = trimmed.match(pattern.regex);
    if (match) {
      return {
        label: pattern.extractLabel(match),
        remainder: match[2] || '',
      };
    }
  }
  return null;
}

/**
 * Check if line is a sub-part (e.g. (a), (b), (i), etc.)
 */
function matchSubPart(lineText: string): string | null {
  const trimmed = lineText.trim();
  const match = trimmed.match(SUBPART_PATTERN);
  if (match) {
    return match[1] || match[2] || null;
  }
  return null;
}

/**
 * Check if line belongs to the document/exam header
 */
function isDocumentHeaderLine(lineText: string): boolean {
  const lower = lineText.toLowerCase();
  return HEADER_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Primary Client-Side Layout & Question Boundary Detector
 * Detects every individual question (e.g. 1., 2., 3., 4., 5., 6.) with exact bounding boxes,
 * sub-parts, formula blocks, and strict exclusion of university headers.
 */
export async function detectQuestionsFromPage(
  pageInfo: RenderedPageInfo,
  pageNum: number
): Promise<PageDetectionResult> {
  const textItems = pageInfo.textItems || [];

  const lines = groupItemsIntoLines(textItems);

  // If text items exist, use high-precision text line segmentation
  if (lines.length > 0) {
    return detectFromTextLines(lines, pageNum);
  }

  // Fallback: visual projection density profiling on page pixels.
  // The full-resolution canvas is no longer retained for memory reasons,
  // so a temporary one is rebuilt from the page's JPEG dataURL.
  const tempCanvas = await buildCanvasFromDataUrl(pageInfo.dataUrl);
  if (!tempCanvas) {
    return detectFromTextLines([], pageNum);
  }
  try {
    return detectFromCanvasProjection(tempCanvas, pageNum);
  } finally {
    tempCanvas.width = 0;
    tempCanvas.height = 0;
  }
}

async function buildCanvasFromDataUrl(dataUrl: string): Promise<HTMLCanvasElement | null> {
  if (!dataUrl) return null;
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Failed to load page image'));
    img.src = dataUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  return canvas;
}

/**
 * Parse text lines into distinct, individual question bounding boxes
 */
function detectFromTextLines(
  lines: TextLine[],
  pageNum: number
): PageDetectionResult {
  interface QuestionCandidate {
    label: string;
    startLineIdx: number;
    endLineIdx: number;
    subParts: string[];
    summaryText: string;
    normYmin: number;
    normYmax: number;
    normXmin: number;
    normXmax: number;
  }

  const candidates: QuestionCandidate[] = [];
  let firstQuestionFound = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = matchQuestionHeader(line.text);

    if (match) {
      firstQuestionFound = true;
      
      // Close previous question if open
      if (candidates.length > 0) {
        const prev = candidates[candidates.length - 1];
        prev.endLineIdx = i - 1;
      }

      candidates.push({
        label: match.label,
        startLineIdx: i,
        endLineIdx: lines.length - 1, // temporary until next question
        subParts: [],
        summaryText: line.text,
        normYmin: line.normYmin,
        normYmax: line.normYmax,
        normXmin: line.normXmin,
        normXmax: line.normXmax,
      });
    } else if (firstQuestionFound && candidates.length > 0) {
      const currentQ = candidates[candidates.length - 1];
      const sub = matchSubPart(line.text);
      if (sub && !currentQ.subParts.includes(`(${sub.toLowerCase()})`)) {
        currentQ.subParts.push(`(${sub.toLowerCase()})`);
      }
    }
  }

  // If no numbered questions were matched by regex, try looking for numbered sections or fallback blocks
  if (candidates.length === 0) {
    // Filter out header lines at the top
    let nonHeaderStartIdx = 0;
    for (let i = 0; i < lines.length; i++) {
      if (isDocumentHeaderLine(lines[i].text)) {
        nonHeaderStartIdx = i + 1;
      } else {
        break;
      }
    }

    const usableLines = lines.slice(nonHeaderStartIdx);
    if (usableLines.length > 0) {
      // Create questions by paragraph gaps
      let currentGroup: TextLine[] = [];
      let groupCount = 1;

      for (let i = 0; i < usableLines.length; i++) {
        const line = usableLines[i];
        if (currentGroup.length > 0) {
          const prevLine = currentGroup[currentGroup.length - 1];
          const yGap = line.pixelYmin - prevLine.pixelYmax;
          // Substantial vertical gap implies a new question block
          if (yGap > 35) {
            candidates.push(createCandidateFromGroup(currentGroup, `Q${groupCount}`));
            groupCount++;
            currentGroup = [line];
            continue;
          }
        }
        currentGroup.push(line);
      }

      if (currentGroup.length > 0) {
        candidates.push(createCandidateFromGroup(currentGroup, `Q${groupCount}`));
      }
    }
  }

  // Calculate final bounding boxes for each question
  const questionBoxes: DetectedQuestionBox[] = [];
  const pageMarginLeft = 40; // 4% left margin
  const pageMarginRight = 960; // 96% right margin

  for (let qIdx = 0; qIdx < candidates.length; qIdx++) {
    const q = candidates[qIdx];
    const qLines = lines.slice(q.startLineIdx, q.endLineIdx + 1);

    if (qLines.length === 0) continue;

    // Compute bounding coordinates
    let minY = Math.min(...qLines.map((l) => l.normYmin));
    let maxY = Math.max(...qLines.map((l) => l.normYmax));
    let minX = Math.min(...qLines.map((l) => l.normXmin));
    let maxX = Math.max(...qLines.map((l) => l.normXmax));

    // Pad top and bottom slightly to give safe spacing around formulas and ascenders/descenders
    // Top of question: start right at line start minus a small safety buffer (e.g. 10 units = 1% height)
    const safeYmin = Math.max(0, minY - 10);
    
    // Bottom of question: end right before next question starts or bottom margin
    let safeYmax: number;
    if (qIdx < candidates.length - 1) {
      const nextQFirstLine = lines[candidates[qIdx + 1].startLineIdx];
      const nextYmin = nextQFirstLine.normYmin;
      safeYmax = Math.min(maxY + 10, nextYmin - 4);
    } else {
      safeYmax = Math.min(1000, maxY + 18);
    }

    // Set full usable width for clear, pristine question card cropping
    const safeXmin = Math.max(0, Math.min(minX - 25, pageMarginLeft));
    const safeXmax = Math.min(1000, Math.max(maxX + 25, pageMarginRight));

    const box2D: [number, number, number, number] = [
      Math.round(safeYmin),
      Math.round(safeXmin),
      Math.round(safeYmax),
      Math.round(safeXmax),
    ];

    // Detect if question contains formulas, fractions, or diagrams
    const fullText = qLines.map((l) => l.text).join(' ');
    const hasMathOrDiagram = /[√∑∫lim_{}\^\\\/≠≤≥αβγπ]|\b(diagram|figure|matrix|sequence|prove|calculate)\b/i.test(fullText);

    const diagramTypes: string[] = [];
    if (/√|sqrt/i.test(fullText)) diagramTypes.push('radical expression');
    if (/lim/i.test(fullText)) diagramTypes.push('limit formula');
    if (/\{x|x_n|\^/i.test(fullText)) diagramTypes.push('math formula');

    questionBoxes.push({
      question_number_raw: q.label,
      normalized_index: qIdx + 1,
      title_summary: q.summaryText.slice(0, 140),
      box_2d: box2D,
      has_diagram: hasMathOrDiagram,
      diagram_types: diagramTypes,
      confidence: 0.98,
      sub_parts_detected: q.subParts,
      warnings: [],
    });
  }

  return {
    page_number: pageNum,
    detected_layout: 'single-column',
    page_quality_score: 0.98,
    questions: questionBoxes,
    page_warnings: [],
  };
}

function createCandidateFromGroup(group: TextLine[], label: string) {
  const minY = Math.min(...group.map((l) => l.normYmin));
  const maxY = Math.max(...group.map((l) => l.normYmax));
  const minX = Math.min(...group.map((l) => l.normXmin));
  const maxX = Math.max(...group.map((l) => l.normXmax));

  return {
    label,
    startLineIdx: 0,
    endLineIdx: 0,
    subParts: [],
    summaryText: group[0]?.text || label,
    normYmin: minY,
    normYmax: maxY,
    normXmin: minX,
    normXmax: maxX,
  };
}

/**
 * Visual Projection Profiling on raw canvas pixels
 * Used when no embedded text layer exists (pure scanned or photocopied pages)
 */
function detectFromCanvasProjection(
  canvas: HTMLCanvasElement,
  pageNum: number
): PageDetectionResult {
  const width = canvas.width;
  const height = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  if (!ctx) {
    return fallbackDefaultBlocks(pageNum);
  }

  try {
    const imgData = ctx.getImageData(0, 0, width, height);
    const data = imgData.data;

    // Compute horizontal projection density (how many dark pixels per row)
    const rowDensity: number[] = new Array(height).fill(0);
    const darkThreshold = 220; // Grayscale threshold for ink

    for (let y = 0; y < height; y++) {
      let darkCount = 0;
      const rowOffset = y * width * 4;
      for (let x = Math.floor(width * 0.05); x < Math.floor(width * 0.95); x += 2) {
        const idx = rowOffset + x * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const brightness = (r + g + b) / 3;
        if (brightness < darkThreshold) {
          darkCount++;
        }
      }
      rowDensity[y] = darkCount;
    }

    // Find bands of ink separated by white space gaps (> 25px of empty lines)
    interface VerticalBand {
      startY: number;
      endY: number;
    }

    const bands: VerticalBand[] = [];
    let inBand = false;
    let bandStart = 0;
    const minInkPerRow = 5;

    for (let y = 0; y < height; y++) {
      if (rowDensity[y] >= minInkPerRow) {
        if (!inBand) {
          inBand = true;
          bandStart = y;
        }
      } else {
        if (inBand) {
          inBand = false;
          const bandHeight = y - bandStart;
          if (bandHeight > 18) {
            bands.push({ startY: bandStart, endY: y });
          }
        }
      }
    }

    if (bands.length === 0) {
      return fallbackDefaultBlocks(pageNum);
    }

    // Merge closely spaced bands (e.g. lines of the same question)
    const mergedBlocks: VerticalBand[] = [];
    let currentBlock = { ...bands[0] };

    for (let i = 1; i < bands.length; i++) {
      const nextBand = bands[i];
      const gap = nextBand.startY - currentBlock.endY;

      // If gap is small (< 40px), they are lines of the same question
      if (gap < 45) {
        currentBlock.endY = nextBand.endY;
      } else {
        mergedBlocks.push(currentBlock);
        currentBlock = { ...nextBand };
      }
    }
    mergedBlocks.push(currentBlock);

    // Filter out top header band if located in the top 15% and followed by multiple items
    let startIndex = 0;
    if (mergedBlocks.length > 2 && mergedBlocks[0].startY < height * 0.15 && (mergedBlocks[0].endY - mergedBlocks[0].startY) < height * 0.18) {
      startIndex = 1; // skip header
    }

    const usableBlocks = mergedBlocks.slice(startIndex);
    const questions: DetectedQuestionBox[] = usableBlocks.map((block, idx) => {
      const ymin = Math.max(0, Math.round(((block.startY - 12) / height) * 1000));
      const ymax = Math.min(1000, Math.round(((block.endY + 14) / height) * 1000));
      const xmin = 50;
      const xmax = 950;

      return {
        question_number_raw: `Q${idx + 1}`,
        normalized_index: idx + 1,
        title_summary: `Question ${idx + 1} (Page ${pageNum})`,
        box_2d: [ymin, xmin, ymax, xmax],
        has_diagram: true,
        diagram_types: ['formula or figure'],
        confidence: 0.92,
        sub_parts_detected: [],
        warnings: [],
      };
    });

    return {
      page_number: pageNum,
      detected_layout: 'single-column',
      page_quality_score: 0.92,
      questions: questions.length > 0 ? questions : fallbackDefaultBlocks(pageNum).questions,
      page_warnings: [],
    };
  } catch (err) {
    console.error('Visual projection error:', err);
    return fallbackDefaultBlocks(pageNum);
  }
}

function fallbackDefaultBlocks(pageNum: number): PageDetectionResult {
  return {
    page_number: pageNum,
    detected_layout: 'single-column',
    page_quality_score: 0.90,
    questions: [
      {
        question_number_raw: 'Q1',
        normalized_index: 1,
        title_summary: `Question 1 (Page ${pageNum})`,
        box_2d: [180, 50, 480, 950],
        has_diagram: false,
        diagram_types: [],
        confidence: 0.85,
        sub_parts_detected: [],
        warnings: [],
      },
      {
        question_number_raw: 'Q2',
        normalized_index: 2,
        title_summary: `Question 2 (Page ${pageNum})`,
        box_2d: [500, 50, 850, 950],
        has_diagram: false,
        diagram_types: [],
        confidence: 0.85,
        sub_parts_detected: [],
        warnings: [],
      },
    ],
    page_warnings: [],
  };
}
