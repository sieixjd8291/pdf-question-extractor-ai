export type AppMode = 'dashboard' | 'book-mapper' | 'question-extractor' | 'latex-studio' | 'cam-scanner' | 'assignment-maker';

/** One recorded run of a tool, shown on the dashboard activity feed. */
export interface ActivityEntry {
  id: string; // client-generated uuid — the dedupe key for cloud sync
  mode: Exclude<AppMode, 'dashboard'>;
  fileName: string;
  timestamp: number; // epoch ms
  pageCount?: number;
  /** questions detected (extractor) or chapters mapped (book mapper) */
  itemCount?: number;
  durationMs?: number;
  status: 'success' | 'error';
}

export interface BookChapter {
  chapter_index: number;
  chapter_title: string;
  start_page: number;
  end_page: number;
  pageCount?: number;
  firstPagePreview?: string;
  lastPagePreview?: string;
  source?: 'outline' | 'toc' | 'heading' | 'ai' | 'manual' | 'font';
}

export interface BookMappingResult {
  book_title: string;
  total_discovered_chapters: number;
  chapters: BookChapter[];
  totalPages?: number;
  detectionMethod?: 'outline' | 'hybrid-text' | 'ai-toc';
  executionTimeMs?: number;
}

export interface QuestionDetection {
  id: string; // e.g. "q_p1_1"
  pageIndex: number; // 0-indexed
  pageNumber: number; // 1-indexed
  questionIndex: number; // 1-indexed overall sequential (e.g. 1 -> question_001)
  questionNumberRaw: string; // e.g. "Q1", "Question 2", "3(a)"
  titleSummary: string;
  box2D: [number, number, number, number]; // [ymin, xmin, ymax, xmax] normalized (0-1000)
  hasDiagram: boolean;
  diagramTypes?: string[];
  confidence: number; // 0.0 - 1.0
  subParts?: string[];
  isContinuationFromPrevPage?: boolean;
  continuesToNextPage?: boolean;
  warnings?: string[];
  
  // Rendered asset data URLs
  pngDataUrl?: string;
  jpgDataUrl?: string;
  pdfDataUrl?: string;
  pdfBlob?: Blob;
  
  // Dimensions
  cropWidth?: number;
  cropHeight?: number;

  // Validation details
  validation?: {
    isValid: boolean;
    isTextTruncated: boolean;
    isQuestionNumberVisible: boolean;
    isDiagramIntact: boolean;
    isSingleQuestionOnly: boolean;
    readabilityScore: number;
    suggestions: string[];
  };
}

export interface PageData {
  pageNumber: number;
  width: number;
  height: number;
  canvasDataUrl: string; // High-res preview
  textFragment?: string;
  detectedLayout?: string;
  qualityScore?: number;
  status: 'pending' | 'rendering' | 'analyzing' | 'completed' | 'error';
  error?: string;
  questions: QuestionDetection[];
  warnings: string[];
}

export type ScanQualityPreset = 'small' | 'balanced' | 'best' | 'custom';
export type ScanPageSize = 'a4' | 'letter' | 'fit';
export type ScanMargin = 'none' | 'small' | 'normal';

export interface ExtractionSettings {
  renderScale: number; // 2 or 3 for DPI
  paddingMode?: 'auto'; // Fully automatic question-adaptive padding
  enablePdf: boolean;
  enableAiValidation: boolean;
  columnLayoutMode: 'auto' | 'single' | 'two-column';
  namingScheme?: 'index' | 'label' | 'page_index'; // e.g. question_001.png vs Q1_Title.png vs Page1_Q1.png
  defaultExportFormat?: 'png' | 'jpg' | 'pdf';
  latexAutoRepair?: boolean;
  // Cam Scanner export defaults
  scanQualityPreset?: ScanQualityPreset;
  scanQuality?: number; // 40–100, the effective JPEG quality percent
  scanPageSize?: ScanPageSize;
  scanMargin?: ScanMargin;
  scanAutoOrientOnImport?: boolean;
}
