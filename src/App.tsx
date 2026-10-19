import { useState, useMemo, useEffect, useRef, useCallback, useDeferredValue, lazy, Suspense, startTransition } from 'react';
import {
  FileText,
  Sparkles,
  Search,
  AlertCircle,
  Package,
} from 'lucide-react';
import { Header } from './components/Header';
import { UploadDropzone } from './components/UploadDropzone';
import { ProcessingProgress } from './components/ProcessingProgress';
import { QuestionCard } from './components/QuestionCard';
import { ConfirmDialog } from './components/ConfirmDialog';
import { OfflineBanner } from './components/OfflineBanner';
import { useToast } from './components/Toast';
import {
  AppMode,
  QuestionDetection,
  PageData,
  ExtractionSettings,
  BookMappingResult,
  ActivityEntry
} from './types';
import type { RenderedPageInfo } from './lib/pdfEngine';
import {
  cropQuestionFromDataUrl,
  cropQuestionsFromDataUrl,
  downloadMultipleIndividualFiles,
  isIosLikeBrowser,
} from './lib/cropper';
import { importMaxEdge } from './lib/devicePerf';
import { yieldToPaint } from './lib/stagedProgress';
import type { ZipExportFormat } from './lib/zipPackager';
import { detectQuestionsFromPage } from './lib/documentQuestionDetector';
import { autoFixImageOrientation } from './lib/orientationDetector';
import type { BookScanProgress } from './lib/bookPaginationEngine';
import { newActivityId } from './lib/activityTracker';
import { recordAndSyncActivity } from './lib/activityCloud';
import { AssignmentMaker } from './components/assignment/AssignmentMaker';
import { Dashboard } from './components/Dashboard';

function retryImport<T>(fn: () => Promise<T>, retries = 3, delayMs = 400): Promise<T> {
  return fn().catch((err) => {
    if (retries <= 0) throw err;
    return new Promise<T>((resolve) => setTimeout(resolve, delayMs)).then(() =>
      retryImport(fn, retries - 1, delayMs * 2),
    );
  });
}

const screenLoaders = {
  dashboard: () => Promise.resolve({ Dashboard }),
  latex: () => retryImport(() => import('./components/LaTeXStudio')),
  assignment: () => Promise.resolve({ AssignmentMaker }),
  scanner: () => retryImport(() => import('./components/CamScanner')),
  bookMapper: () => retryImport(() => import('./components/BookChapterMapperView')),
  settings: () => retryImport(() => import('./components/SettingsModal')),
  editor: () => retryImport(() => import('./components/BoundingBoxEditor')),
  fullscreen: () => retryImport(() => import('./components/FullscreenModal')),
};

const BoundingBoxEditor = lazy(() => screenLoaders.editor().then((m) => ({ default: m.BoundingBoxEditor })));
const SettingsModal = lazy(() => screenLoaders.settings().then((m) => ({ default: m.SettingsModal })));
const FullscreenModal = lazy(() => screenLoaders.fullscreen().then((m) => ({ default: m.FullscreenModal })));
const BookChapterMapperView = lazy(() => screenLoaders.bookMapper().then((m) => ({ default: m.BookChapterMapperView })));
const LaTeXStudio = lazy(() => screenLoaders.latex().then((m) => ({ default: m.LaTeXStudio })));
const CamScanner = lazy(() => screenLoaders.scanner().then((m) => ({ default: m.CamScanner })));

/**
 * Warm the other tool screens one at a time while the browser is idle, so
 * switching tools later is instant instead of flashing a loading state.
 * Skipped on data-saver / slow connections to avoid wasting battery and data.
 */
function prefetchScreensWhenIdle(): () => void {
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (conn?.saveData || /(^|-)2g$/.test(conn?.effectiveType ?? '')) return () => {};
  const queue = Object.values(screenLoaders);
  const idle: (cb: () => void) => number =
    window.requestIdleCallback?.bind(window) ?? ((cb) => window.setTimeout(cb, 300));
  const cancelIdle: (id: number) => void = window.cancelIdleCallback?.bind(window) ?? window.clearTimeout;
  let handle = 0;
  let stopped = false;
  const next = () => {
    if (stopped) return;
    const load = queue.shift();
    if (!load) return;
    load().catch(() => {}).finally(() => { if (!stopped) handle = idle(next); });
  };
  const start = window.setTimeout(() => { handle = idle(next); }, 1500);
  return () => { stopped = true; window.clearTimeout(start); cancelIdle(handle); };
}

/**
 * True when the app runs inside another app's embedded browser (Instagram /
 * Facebook / WhatsApp / generic Android WebView, …). Those webviews routinely
 * break Google/email sign-in redirects, file downloads and the share sheet,
 * so we warn users to open the app in their real browser instead.
 */
function detectInAppBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const inAppMarkers = [
    'FBAN/', 'FBAV/', 'FBBV/', 'Instagram', 'Snapchat', 'Line/', 'MicroMessenger',
    'LinkedInApp', 'Pinterest/', 'WhatsApp', 'Telegram/', 'GSA/', 'DuckDuckGo/',
    'Twitter/',
  ];
  if (inAppMarkers.some((marker) => ua.includes(marker))) return true;
  // Generic Android WebView: Chrome UA with the "; wv)" marker
  if (/;\s*wv\)/i.test(ua)) return true;
  return false;
}

export default function App() {
  const uploadInFlight = useRef(false);
  const toast = useToast();
  const [notice, setNotice] = useState<string | null>(null);
  const [isInAppBrowser] = useState<boolean>(() => detectInAppBrowser());
  // App Mode State: opens on the dashboard landing screen
  const [appMode, setAppModeNow] = useState<AppMode>('dashboard');
  // Switching tools as a transition keeps the current screen on display until
  // the next one is ready, instead of blanking to a "Loading…" placeholder.
  const setAppMode = useCallback((mode: AppMode) => startTransition(() => setAppModeNow(mode)), []);
  useEffect(() => prefetchScreensWhenIdle(), []);
  // Project opened from the dashboard browser — LaTeX Studio lands on it.
  const [openedProjectId, setOpenedProjectId] = useState<string | null>(null);

  /** Record a tool run for the dashboard (localStorage + best-effort cloud sync). */
  const logActivity = (entry: ActivityEntry) => {
    void recordAndSyncActivity(entry);
  };

  // Common File State
  const [fileName, setFileName] = useState<string | null>(null);
  const [originalPdfBuffer, setOriginalPdfBuffer] = useState<ArrayBuffer | Uint8Array | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [currentStep, setCurrentStep] = useState<string>('');
  const [progressPercent, setProgressPercent] = useState<number>(0);

  // Book Chapter Pagination State
  const [bookMappingResult, setBookMappingResult] = useState<BookMappingResult | null>(null);

  // Question Extractor State
  const [pages, setPages] = useState<PageData[]>([]);
  const [questions, setQuestions] = useState<QuestionDetection[]>([]);
  const [selectedQuestionIds, setSelectedQuestionIds] = useState<Set<string>>(new Set());
  const [zipFormat, setZipFormat] = useState<ZipExportFormat>('jpg');

  // Filter & Search State
  const [searchQuery, setSearchQuery] = useState('');
  const [filterPage, setFilterPage] = useState<number | 'all'>('all');
  const [filterOnlyDiagrams, setFilterOnlyDiagrams] = useState(false);

  // Settings State
  const [settings, setSettings] = useState<ExtractionSettings>(() => {
    const defaults: ExtractionSettings = {renderScale:2,paddingMode:'auto',enablePdf:true,enableAiValidation:false,columnLayoutMode:'auto',namingScheme:'index',defaultExportFormat:'jpg',scanQualityPreset:'balanced',scanQuality:80,scanPageSize:'fit',scanMargin:'none'};
    try {
      const saved=JSON.parse(localStorage.getItem('pdf-studio-settings')||'{}');
      // Mobile browsers crash on very high-resolution canvas buffers — cap render scale there
      const mobileCap = isIosLikeBrowser() || window.matchMedia('(pointer: coarse)').matches ? 2 : 3;
      return {...defaults,latexAutoRepair:saved.latexAutoRepair !== false,renderScale:Math.min(saved.renderScale===3?3:2, mobileCap),namingScheme:['index','label','page_index'].includes(saved.namingScheme)?saved.namingScheme:'index',defaultExportFormat:['jpg','png','pdf'].includes(saved.defaultExportFormat)?saved.defaultExportFormat:'jpg',scanQualityPreset:['small','balanced','best','custom'].includes(saved.scanQualityPreset)?saved.scanQualityPreset:(typeof saved.scanQuality==='number'?'custom':'balanced'),scanQuality:typeof saved.scanQuality==='number'&&saved.scanQuality>=40&&saved.scanQuality<=100?Math.round(saved.scanQuality):80,scanPageSize:['a4','letter','fit'].includes(saved.scanPageSize)?saved.scanPageSize:'fit',scanMargin:['none','small','normal'].includes(saved.scanMargin)?saved.scanMargin:'none'};
    } catch {return defaults;}
  });
  useEffect(()=>{try {localStorage.setItem('pdf-studio-settings',JSON.stringify(settings));}catch{}},[settings]);
  useEffect(()=>setZipFormat(settings.defaultExportFormat||'jpg'),[settings.defaultExportFormat]);
  useEffect(()=>{if(!isProcessing)return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[isProcessing]);

  // Modal states
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'general' | 'chapter-mapper' | 'question-extractor' | 'latex-studio' | 'cam-scanner'>('general');
  const [editingQuestion, setEditingQuestion] = useState<QuestionDetection | null>(null);
  const [fullscreenData, setFullscreenData] = useState<{
    question: QuestionDetection;
    format: 'png' | 'jpg' | 'pdf';
  } | null>(null);

  // Guarded destructive transitions (results are cleared)
  const [pendingMode, setPendingMode] = useState<AppMode | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  // Update Settings
  const handleUpdateSettings = (newSettings: Partial<ExtractionSettings>) => {
    setSettings((prev) => {
      const updated = { ...prev, ...newSettings };
      if (newSettings.defaultExportFormat) {
        setZipFormat(newSettings.defaultExportFormat);
      }
      return updated;
    });
  };

  /**
   * Reset application state to process another document
   */
  const handleReset = () => {
    setNotice(null); setSearchQuery(''); setFilterPage('all'); setFilterOnlyDiagrams(false); setCurrentPage(1); setTotalPages(1);
    setFileName(null);
    setOriginalPdfBuffer(null);
    setBookMappingResult(null);
    setPages([]);
    setQuestions([]);
    setSelectedQuestionIds(new Set());
    setIsProcessing(false);
    setProgressPercent(0);
    setCurrentStep('');
  };

  const hasResults = Boolean(bookMappingResult || questions.length > 0);

  const handleResetRequest = () => {
    if (isProcessing) return;
    if (hasResults) setConfirmReset(true);
    else handleReset();
  };

  const handleModeChangeRequest = (mode: AppMode) => {
    if (isProcessing || mode === appMode) return;
    setOpenedProjectId(null); // header navigation opens the generic studio
    if (hasResults) setPendingMode(mode);
    else { handleReset(); setAppMode(mode); }
  };

  /** Open a workspace project from the dashboard in LaTeX Studio. */
  const handleOpenProject = (projectId: string) => {
    if (isProcessing) return;
    handleReset();
    setOpenedProjectId(projectId);
    setAppMode('latex-studio');
  };

  /**
   * Selection helpers
   */
  const handleToggleSelect = useCallback((qId: string) => {
    setSelectedQuestionIds((prev) => {
      const next = new Set(prev);
      if (next.has(qId)) {
        next.delete(qId);
      } else {
        next.add(qId);
      }
      return next;
    });
  }, []);
  const handleEditBox = useCallback((q: QuestionDetection) => setEditingQuestion(q), []);
  const handleViewFullscreen = useCallback(
    (q: QuestionDetection, fmt: 'png' | 'jpg' | 'pdf') => setFullscreenData({ question: q, format: fmt }),
    []
  );

  const handleSelectAll = () => {
    setSelectedQuestionIds(new Set(questions.map((q) => q.id)));
  };

  const handleDeselectAll = () => {
    setSelectedQuestionIds(new Set());
  };

  /**
   * Pipeline for Book Chapter & Pagination Boundary Mapping
   * Ultra-efficient token usage (streams outline, TOC, & headings without sending entire book).
   */
  const runBookMappingPipeline = async (file: File, buffer: ArrayBuffer | Uint8Array) => {
    const startedAt = Date.now();
    try {
      setFileName(file.name);
      const safeBufferCopy = buffer instanceof Uint8Array ? buffer.slice() : new Uint8Array(buffer.slice(0));
      setOriginalPdfBuffer(safeBufferCopy);
      setIsProcessing(true);
      setProgressPercent(10);
      setCurrentStep('Finding chapters and page ranges…');

      const { analyzeBookPaginationStructure } = await import('./lib/bookPaginationEngine');
      const result = await analyzeBookPaginationStructure(
        safeBufferCopy.slice(),
        file.name,
        {
          useAiFallback: false,
          renderThumbnails: false,
        },
        (p: BookScanProgress) => {
          setCurrentStep(p.message);
          setProgressPercent(p.percent);
          if (p.totalPages > 0) {
            setTotalPages(p.totalPages);
            setCurrentPage(p.currentPage);
          }
        }
      );

      setBookMappingResult(result);
      setIsProcessing(false);
      logActivity({
        id: newActivityId(),
        mode: 'book-mapper',
        fileName: file.name,
        timestamp: Date.now(),
        itemCount: result.total_discovered_chapters,
        pageCount: result.totalPages,
        durationMs: Date.now() - startedAt,
        status: 'success',
      });
    } catch (err: any) {
      console.error('Book mapping error:', err);
      setNotice(`Book mapping failed: ${err.message || 'Unknown error'}`);
      setIsProcessing(false);
      logActivity({
        id: newActivityId(),
        mode: 'book-mapper',
        fileName: file.name,
        timestamp: Date.now(),
        durationMs: Date.now() - startedAt,
        status: 'error',
      });
    }
  };

  /**
   * Pipeline for Question Paper Boundary Extraction
   */
  const runQuestionExtractionPipeline = async (
    docName: string,
    renderedPages: RenderedPageInfo[],
    skipOrientationCheck: boolean = false
  ) => {
    const startedAt = Date.now();
    try {
      setFileName(docName);
      setTotalPages(renderedPages.length);
      setIsProcessing(true);
      setProgressPercent(8);
      setCurrentStep('Analyzing document orientation, text & diagrams…');

      // Auto-fix any rotated pages (270°, 90°, or 180°) into upright 0° orientation
      const uprightRenderedPages: RenderedPageInfo[] = [];
      let autoRotatedCount = 0;

      if (!skipOrientationCheck) {
        // One page at a time: running every page in parallel decoded the whole
        // document into memory at once and froze phones for the duration.
        for (let i = 0; i < renderedPages.length; i++) {
          const p = renderedPages[i];
          let upright = p;
          try {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            await new Promise<void>((resolve, reject) => {
              img.onload = () => resolve();
              img.onerror = () => reject(new Error('Failed to load page image for orientation check'));
              img.src = p.dataUrl;
            });
            const fixRes = await autoFixImageOrientation(img, 0.92);
            if (fixRes.wasRotated || fixRes.wasFlipped) {
              autoRotatedCount++;
              upright = {
                ...p,
                dataUrl: fixRes.dataUrl,
                width: fixRes.width,
                height: fixRes.height,
              };
            }
          } catch {
            // preserve original
          }
          uprightRenderedPages.push(upright);
          if (renderedPages.length > 1) {
            setCurrentPage(i + 1);
            setCurrentStep(`Checking orientation of page ${i + 1} of ${renderedPages.length}…`);
            setProgressPercent(8 + Math.floor(((i + 1) / renderedPages.length) * 4));
            await yieldToPaint();
          }
        }
      } else {
        uprightRenderedPages.push(...renderedPages);
      }

      setCurrentStep('Detecting questions in the PDF text layer…');
      setProgressPercent(12);

      const initialPages: PageData[] = uprightRenderedPages.map((p) => ({
        pageNumber: p.pageNumber,
        width: p.width,
        height: p.height,
        canvasDataUrl: p.dataUrl,
        questions: [],
        warnings: [],
        status: 'pending',
      }));
      setPages(initialPages);

      const extractedQuestions: QuestionDetection[] = [];
      let sequentialCounter = 1;

      // Process each page
      for (let pIdx = 0; pIdx < uprightRenderedPages.length; pIdx++) {
        const pageInfo = uprightRenderedPages[pIdx];
        setCurrentPage(pIdx + 1);
        setCurrentStep(`Analyzing page ${pIdx + 1} of ${uprightRenderedPages.length} for questions & diagrams...`);
        setProgressPercent(15 + Math.floor(((pIdx) / uprightRenderedPages.length) * 75));

        setPages((prev) =>
          prev.map((p, idx) => (idx === pIdx ? { ...p, status: 'analyzing' } : p))
        );

        const apiResult = await detectQuestionsFromPage(
          pageInfo,
          pageInfo.pageNumber
        );

        const pageQuestionsList: QuestionDetection[] = [];
        const pageBoxes = apiResult.questions.map(
          (rawQ) => (rawQ.box_2d || [100, 100, 400, 900]) as [number, number, number, number]
        );
        // Decode the page once for all of its questions instead of once per question.
        const pageCrops = await cropQuestionsFromDataUrl(pageInfo.dataUrl, pageBoxes);

        for (let qIdx = 0; qIdx < apiResult.questions.length; qIdx++) {
          const rawQ = apiResult.questions[qIdx];
          const qId = `q_p${pIdx + 1}_${sequentialCounter}`;
          const box2D = pageBoxes[qIdx];

          const cropRes = pageCrops[qIdx];
          if (!cropRes) continue;

          const qItem: QuestionDetection = {
            id: qId,
            pageIndex: pIdx,
            pageNumber: pageInfo.pageNumber,
            questionIndex: sequentialCounter,
            questionNumberRaw: rawQ.question_number_raw || `Q${sequentialCounter}`,
            titleSummary: rawQ.title_summary || `Question ${sequentialCounter}`,
            box2D: box2D,
            hasDiagram: !!rawQ.has_diagram,
            diagramTypes: rawQ.diagram_types || [],
            confidence: rawQ.confidence || 0.96,
            subParts: rawQ.sub_parts_detected || [],
            warnings: rawQ.warnings || [],
            pngDataUrl: cropRes.pngDataUrl,
            jpgDataUrl: cropRes.jpgDataUrl,
            cropWidth: cropRes.width,
            cropHeight: cropRes.height,
            validation: {
              isValid: true,
              isTextTruncated: false,
              isQuestionNumberVisible: true,
              isDiagramIntact: true,
              isSingleQuestionOnly: true,
              readabilityScore: 0.98,
              suggestions: [],
            },
          };

          pageQuestionsList.push(qItem);
          extractedQuestions.push(qItem);
          sequentialCounter++;
        }

        setPages((prev) =>
          prev.map((p, idx) =>
            idx === pIdx
              ? {
                  ...p,
                  status: 'completed',
                  questions: pageQuestionsList,
                  detectedLayout: apiResult.detected_layout || 'single-column',
                  qualityScore: apiResult.page_quality_score || 0.95,
                  warnings: apiResult.page_warnings || [],
                }
              : p
          )
        );
        await yieldToPaint();
      }

      setQuestions(extractedQuestions);
      setProgressPercent(100);
      setCurrentStep('Extraction completed! Displaying extracted questions.');
      setIsProcessing(false);
      logActivity({
        id: newActivityId(),
        mode: 'question-extractor',
        fileName: docName,
        timestamp: Date.now(),
        itemCount: extractedQuestions.length,
        pageCount: renderedPages.length,
        durationMs: Date.now() - startedAt,
        status: 'success',
      });
    } catch (err: any) {
      console.error('Pipeline extraction failure:', err);
      setNotice(`Extraction failed: ${err.message || 'Unknown error'}`);
      setIsProcessing(false);
      logActivity({
        id: newActivityId(),
        mode: 'question-extractor',
        fileName: docName,
        timestamp: Date.now(),
        durationMs: Date.now() - startedAt,
        status: 'error',
      });
    }
  };

  /**
   * Handle File Upload dispatching to active mode
   */
  const handleFileUpload = async (file: File) => {
    if (uploadInFlight.current) return;
    const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
    const isImg = /^image\//i.test(file.type) || /\.(jpe?g|png|webp|bmp)$/i.test(file.name);
    if ((!isPdf && !isImg) || !file.size) {
      setNotice('Please choose a valid PDF document or image file.');
      return;
    }
    uploadInFlight.current = true;
    setNotice(null);
    setFileName(file.name);
    setIsProcessing(true);
    setCurrentPage(1);
    setTotalPages(1);
    setProgressPercent(0);

    // Mobile browsers have a fraction of desktop canvas memory — warn before a likely failure
    if ((isIosLikeBrowser() || window.matchMedia('(pointer: coarse)').matches) && file.size > 30 * 1024 * 1024) {
      setNotice('This document is large for a mobile device. Processing may be slow or run out of memory — a desktop browser is recommended for very large files.');
    }
    try {
      if (isImg) {
        setCurrentStep('Loading document image & analyzing orientation…');
        setProgressPercent(5);
        const url = URL.createObjectURL(file);
        try {
          const [img, fileBytes] = await Promise.all([
            new Promise<HTMLImageElement>((resolve, reject) => {
              const image = new Image();
              image.crossOrigin = 'anonymous';
              image.onload = () => resolve(image);
              image.onerror = () => reject(new Error('Failed to decode document image'));
              image.src = url;
            }),
            file.arrayBuffer().catch(() => undefined),
          ]);
          const fixRes = await autoFixImageOrientation(img, 0.92, fileBytes, importMaxEdge());
          const pageInfo: RenderedPageInfo = {
            pageNumber: 1,
            dataUrl: fixRes.dataUrl,
            width: fixRes.width,
            height: fixRes.height,
            textContent: '',
            textItems: [],
          };
          await runQuestionExtractionPipeline(file.name, [pageInfo], true);
        } finally {
          URL.revokeObjectURL(url);
        }
      } else {
        const arrayBuffer = await file.arrayBuffer();
        const safeBuffer = new Uint8Array(arrayBuffer);
        setOriginalPdfBuffer(safeBuffer);

        if (appMode === 'book-mapper') {
          await runBookMappingPipeline(file, safeBuffer.slice());
        } else {
          setIsProcessing(true);
          setCurrentStep('Rendering high-resolution PDF pages...');
          setProgressPercent(5);
          const { loadAndRenderPdfPages } = await import('./lib/pdfEngine');
          const renderedPages = await loadAndRenderPdfPages(
            safeBuffer.slice(),
            settings.renderScale,
            (curr, tot) => {
              setCurrentPage(curr);
              setTotalPages(tot);
              setCurrentStep(`Rendering PDF page ${curr} of ${tot}...`);
            }
          );
          await runQuestionExtractionPipeline(file.name, renderedPages);
        }
      }
    } catch (error: any) {
      console.error('File parsing error:', error);
      setNotice(`Could not load document: ${error.message || 'Corrupt or unsupported format'}`);
      setIsProcessing(false);
    } finally {
      uploadInFlight.current = false;
    }
  };

  /**
   * Handle Bounding Box adjustments from interactive studio
   */
  const handleUpdateQuestion = (updatedQ: QuestionDetection) => {
    setQuestions((prev) =>
      prev.map((q) => (q.id === updatedQ.id ? updatedQ : q))
    );
    setPages((prev) =>
      prev.map((p, idx) => {
        if (idx === updatedQ.pageIndex) {
          return {
            ...p,
            questions: p.questions.map((q) =>
              q.id === updatedQ.id ? updatedQ : q
            ),
          };
        }
        return p;
      })
    );
  };

  /**
   * Delete a question item
   */
  const handleDeleteQuestion = (questionId: string) => {
    setQuestions((prev) => {
      const nextList = prev.filter((q) => q.id !== questionId);
      return nextList.map((q, idx) => ({ ...q, questionIndex: idx + 1 }));
    });
    setPages((prev) =>
      prev.map((p) => ({
        ...p,
        questions: p.questions.filter((q) => q.id !== questionId),
      }))
    );
    setSelectedQuestionIds((prev) => {
      const next = new Set(prev);
      next.delete(questionId);
      return next;
    });
  };

  /**
   * Add a manually drawn bounding box question
   */
  const handleAddQuestion = (pageIndex: number, box2D: [number, number, number, number]) => {
    const page = pages[pageIndex];
    if (!page) return;

    void (async () => {
      const cropRes = await cropQuestionFromDataUrl(page.canvasDataUrl, box2D);
      if (!cropRes) return;
      const nextIndex = questions.length + 1;
      const newQ: QuestionDetection = {
        id: `q_custom_${Date.now()}`,
        pageIndex: pageIndex,
        pageNumber: pageIndex + 1,
        questionIndex: nextIndex,
        questionNumberRaw: `Q${nextIndex}`,
        titleSummary: `Manual Question ${nextIndex}`,
        box2D: box2D,
        hasDiagram: false,
        confidence: 1.0,
        pngDataUrl: cropRes.pngDataUrl,
        jpgDataUrl: cropRes.jpgDataUrl,
        cropWidth: cropRes.width,
        cropHeight: cropRes.height,
      };

      setQuestions((prev) => [...prev, newQ]);
      setPages((prev) =>
        prev.map((p, idx) =>
          idx === pageIndex ? { ...p, questions: [...p.questions, newQ] } : p
        )
      );
    })();
  };

  /**
   * Export ZIP archive for Question Extractor
   */
  const handleDownloadZip = async (
    targetQuestions?: QuestionDetection[],
    overrideFormat?: ZipExportFormat
  ) => {
    const listToExport = targetQuestions || questions;
    if (listToExport.length === 0) return;
    const formatToUse = overrideFormat || zipFormat;

    try {
      const { createQuestionsZip, downloadBlob } = await import('./lib/zipPackager');
      const zipBlob = await createQuestionsZip(
        listToExport,
        formatToUse,
        settings.namingScheme || 'index'
      );
      const suffix = formatToUse === 'all' ? 'all_formats' : formatToUse;
      const zipName = targetQuestions
        ? `questions_selected_${listToExport.length}_${suffix}.zip`
        : `questions_extracted_${suffix}.zip`;
      downloadBlob(zipBlob, zipName);
      toast.success(`${listToExport.length} questions exported as ${suffix.toUpperCase()} ZIP.`);
    } catch (err: any) {
      console.error('Error generating zip:', err);
      toast.error('Failed to generate ZIP archive: ' + err.message);
    }
  };

  const handleDownloadIndividualBatch = async (
    format: 'png' | 'jpg' | 'pdf' = 'jpg',
    targetList?: QuestionDetection[]
  ) => {
    const list = targetList || questions;
    if (list.length === 0) return;

    // Mobile browsers (iOS Safari, Android Chrome) block or throttle sequential
    // multi-file downloads — silently fall back to a single ZIP there.
    if (list.length > 1 && (isIosLikeBrowser() || window.matchMedia('(pointer: coarse)').matches)) {
      await handleDownloadZip(list, format as ZipExportFormat);
      toast.success(`${list.length} files exported as ${format.toUpperCase()} ZIP (multi-download is restricted on mobile).`);
      return;
    }

    await downloadMultipleIndividualFiles(list, format, settings.namingScheme || 'index', 250);
    toast.success(`${list.length} files downloaded as ${format.toUpperCase()}.`);
  };

  const handleExportSelectedAs = (format: 'png' | 'jpg' | 'pdf') => {
    const selected = questions.filter((q) => selectedQuestionIds.has(q.id));
    if (selected.length === 0) return;
    handleDownloadIndividualBatch(format, selected);
  };

  // Filtered questions list — typing stays responsive while the grid catches up.
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const filteredQuestions = useMemo(() => {
    return questions.filter((q) => {
      if (filterPage !== 'all' && q.pageNumber !== filterPage) return false;
      if (filterOnlyDiagrams && !q.hasDiagram) return false;
      if (deferredSearchQuery.trim()) {
        const query = deferredSearchQuery.toLowerCase();
        const matchesTitle = q.titleSummary.toLowerCase().includes(query);
        const matchesNum = q.questionNumberRaw.toLowerCase().includes(query);
        if (!matchesTitle && !matchesNum) return false;
      }
      return true;
    });
  }, [questions, filterPage, filterOnlyDiagrams, deferredSearchQuery]);

  return (
    <div className="app-shell">
      {/* Top Application Header */}
      <Header
        fileName={fileName}
        appMode={appMode}
        onChangeAppMode={handleModeChangeRequest}
        isProcessing={isProcessing}
        onReset={handleResetRequest}
        onOpenSettings={() => {
          setSettingsTab(appMode === 'cam-scanner' ? 'cam-scanner' : appMode === 'latex-studio' ? 'latex-studio' : 'general');
          setIsSettingsOpen(true);
        }}
        hasExtracted={hasResults}
      />

      {/* Main Container: Full-Bleed & Maximized */}
      <main className="app-main">
        <Suspense fallback={<div className="app-screen-loading" role="status" aria-live="polite"><span className="sr-only">Loading…</span></div>}>
        <OfflineBanner appMode={appMode} />
        {notice && <div className="notice app-notice" role="alert"><AlertCircle size={17}/><span>{notice}</span><button aria-label="Dismiss message" onClick={()=>setNotice(null)}>×</button></div>}
        {isInAppBrowser && <div className="notice app-notice webview-warning" role="status"><AlertCircle size={17}/><span>You've opened PDF Studio inside another app's browser. Sign-in, downloads and sharing often fail here — tap the ⋮ / … menu and choose “Open in Chrome” (or Safari) for the full experience.</span></div>}
        {fileName && !isProcessing && !hasResults && appMode !== 'latex-studio' && appMode !== 'cam-scanner' && appMode !== 'assignment-maker' && appMode !== 'dashboard' && <section className="empty-results"><FileText size={34}/><h2>{notice ? 'We couldn’t process this document' : 'No questions found'}</h2><p>{notice ? 'Try another PDF, or check that the file is not damaged or password-protected.' : 'The current detector needs selectable, numbered question text. Run OCR on image-only scans before uploading.'}</p><button className="btn primary" onClick={handleReset}>Choose another PDF</button></section>}
        {/* State 1: Dashboard landing screen (LaTeX Studio replaces the upload flow entirely) */}
        {appMode === 'dashboard' ? (
          <Dashboard onOpenProject={handleOpenProject} onChangeAppMode={handleModeChangeRequest} />
        ) : appMode === 'latex-studio' ? (
          <LaTeXStudio initialProjectId={openedProjectId} autoRepair={settings.latexAutoRepair !== false} />
        ) : appMode === 'assignment-maker' ? (
          <AssignmentMaker />
        ) : appMode === 'cam-scanner' ? (
          <CamScanner
            qualityPreset={settings.scanQualityPreset}
            customQuality={settings.scanQuality}
            pageSize={settings.scanPageSize}
            margin={settings.scanMargin}
            onChangeAppMode={handleModeChangeRequest}
          />
        ) : (
          !fileName && (
            <div className="upload-page">
              <UploadDropzone
                appMode={appMode}
                onFileUpload={handleFileUpload}
                settings={settings}
                onUpdateSettings={handleUpdateSettings}
                isProcessing={isProcessing}
              />
            </div>
          )
        )}

        {/* State 2: Processing Progress Indicator */}
        {isProcessing && (
          <div className="flex-1 w-full max-w-4xl mx-auto p-4 sm:p-6 lg:p-8 flex flex-col justify-center overflow-y-auto">
            <ProcessingProgress
              currentPage={currentPage}
              totalPages={totalPages}
              currentStep={currentStep}
              percent={progressPercent}
              pages={pages}
            />
          </div>
        )}

        {/* State 3A: Book Chapter Pagination & Structural Mapping View (Zero wasted margins / edge-to-edge) */}
        {!isProcessing && bookMappingResult && (
          <div className="flex-1 w-full h-full min-h-0 flex flex-col overflow-hidden">
            <BookChapterMapperView
              mappingResult={bookMappingResult}
              originalPdfBuffer={originalPdfBuffer}
              onUpdateMappingResult={setBookMappingResult}
              onChangeAppMode={handleModeChangeRequest}
            />
          </div>
        )}

        {/* State 3B: Extracted Questions Results Gallery */}
        {!isProcessing && !bookMappingResult && questions.length > 0 && (
          <div className="question-results animate-fadeIn">
            {/* Gallery Control Bar */}
            <div className="gallery-toolbar">
              <div className="field-group">
                <div className="search-field">
                  <Search size={15} />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    aria-label="Search questions"
                    placeholder="Search questions…"
                  />
                </div>

                {totalPages > 1 && (
                  <select
                    aria-label="Filter questions by page"
                    value={filterPage}
                    onChange={(e) =>
                      setFilterPage(
                        e.target.value === 'all'
                          ? 'all'
                          : parseInt(e.target.value)
                      )
                    }
                  >
                    <option value="all">All pages ({totalPages})</option>
                    {Array.from({ length: totalPages }, (_, i) => (
                      <option key={i + 1} value={i + 1}>
                        Page {i + 1}
                      </option>
                    ))}
                  </select>
                )}

                <button
                  onClick={() => setFilterOnlyDiagrams(!filterOnlyDiagrams)}
                  aria-pressed={filterOnlyDiagrams}
                  className={'chip chip-btn ' + (filterOnlyDiagrams ? 'on' : '')}
                >
                  <Sparkles size={13} />
                  <span>Diagrams ({questions.filter((q) => q.hasDiagram).length})</span>
                </button>
              </div>

              <div className="field-group">
                {selectedQuestionIds.size === questions.length ? (
                  <button className="btn quiet btn-sm" onClick={handleDeselectAll}>Deselect all</button>
                ) : (
                  <button className="btn quiet btn-sm" onClick={handleSelectAll}>Select all ({questions.length})</button>
                )}
                <div className="segmented" role="group" aria-label="ZIP export format">
                  {(['jpg', 'png', 'pdf', 'all'] as ZipExportFormat[]).map((fmt) => (
                    <button
                      key={fmt}
                      aria-pressed={zipFormat === fmt}
                      onClick={() => setZipFormat(fmt)}
                    >
                      {fmt.toUpperCase()}
                    </button>
                  ))}
                </div>
                <button
                  id="btn-download-zip-toolbar"
                  onClick={() => handleDownloadZip()}
                  className="btn primary"
                  title={`Export all cropped questions as ${zipFormat.toUpperCase()} in a single ZIP`}
                >
                  <Package size={16} />
                  <span>Download ZIP</span>
                </button>
              </div>
            </div>

            {/* Selection & Batch Bar */}
            {selectedQuestionIds.size > 0 && (
              <div className="selection-bar">
                <span className="chip accent">{selectedQuestionIds.size} of {questions.length} selected</span>
                <div className="spacer" />
                <span className="text-[12.5px] text-secondary hidden sm:inline">Export selected as</span>
                {(['pdf', 'png', 'jpg'] as const).map((fmt) => (
                  <button
                    key={fmt}
                    onClick={() => handleExportSelectedAs(fmt)}
                    className="btn secondary btn-sm"
                    title={`Download the ${selectedQuestionIds.size} selected questions as individual ${fmt.toUpperCase()} files`}
                  >
                    {fmt.toUpperCase()}
                  </button>
                ))}
              </div>
            )}

            {/* Questions Grid Gallery */}
            {filteredQuestions.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {filteredQuestions.map((question) => (
                  <QuestionCard
                    key={question.id}
                    question={question}
                    isSelected={selectedQuestionIds.has(question.id)}
                    onToggleSelect={handleToggleSelect}
                    namingScheme={settings.namingScheme || 'index'}
                    defaultFormat={settings.defaultExportFormat || 'pdf'}
                    onEditBox={handleEditBox}
                    onViewFullscreen={handleViewFullscreen}
                  />
                ))}
              </div>
            ) : (
              <div className="empty-results" style={{ margin: '20px auto' }}>
                <AlertCircle size={30} />
                <h2>No matches</h2>
                <p>No questions match your current search or filter criteria.</p>
                <button
                  className="btn secondary"
                  onClick={() => {
                    setSearchQuery('');
                    setFilterPage('all');
                    setFilterOnlyDiagrams(false);
                  }}
                >
                  Reset all filters
                </button>
              </div>
            )}
          </div>
        )}
        </Suspense>
      </main>

      {/* Guarded transitions */}
      {pendingMode && (
        <ConfirmDialog
          title="Switch tools?"
          message="Export anything you need first; current results will be cleared when you switch."
          confirmLabel="Switch & clear"
          danger
          onConfirm={() => { handleReset(); setAppMode(pendingMode); }}
          onClose={() => setPendingMode(null)}
        />
      )}
      {confirmReset && (
        <ConfirmDialog
          title="Start a new document?"
          message="All current results will be cleared. Export anything you need first."
          confirmLabel="Clear & restart"
          danger
          onConfirm={handleReset}
          onClose={() => setConfirmReset(false)}
        />
      )}

      {/* Modals */}
      <Suspense fallback={null}>
      {isSettingsOpen && (
        <SettingsModal
          settings={settings}
          onUpdateSettings={handleUpdateSettings}
          onClose={() => setIsSettingsOpen(false)}
          initialTab={settingsTab}
        />
      )}

      {editingQuestion && (
        <BoundingBoxEditor
          question={editingQuestion}
          pages={pages}
          pageIndex={editingQuestion.pageIndex}
          onClose={() => setEditingQuestion(null)}
          onUpdateQuestion={handleUpdateQuestion}
          onDeleteQuestion={handleDeleteQuestion}
          onAddQuestion={handleAddQuestion}
          onUpdatePage={(pageIdx, updatedPage) => {
            setPages((prev) => prev.map((p, idx) => (idx === pageIdx ? updatedPage : p)));
            if (updatedPage.questions && updatedPage.questions.length > 0) {
              setQuestions((prev) =>
                prev.map((q) => {
                  const match = updatedPage.questions.find((uq) => uq.id === q.id);
                  return match || q;
                })
              );
            }
          }}
        />
      )}

      {fullscreenData && (
        <FullscreenModal
          question={fullscreenData.question}
          format={fullscreenData.format}
          onClose={() => setFullscreenData(null)}
        />
      )}
      </Suspense>
    </div>
  );
}
