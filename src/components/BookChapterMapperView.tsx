import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { pdfjsLib, pdfAssetOptions } from '../lib/pdfConfig';
import {
  BookOpen,
  Table,
  Grid,
  Download,
  FileJson,
  Copy,
  Check,
  Plus,
  Trash2,
  Eye,
  ArrowRight,
  RefreshCw,
  Sparkles,
  Flag,
  ChevronLeft,
  ChevronRight,
  Sliders,
  PanelRightClose,
  PanelRightOpen,
  GripVertical,
  ArrowLeft,
} from 'lucide-react';
import { BookChapter, BookMappingResult, AppMode } from '../types';
import { Modal } from './Modal';
import { useToast } from './Toast';
import {
  formatBookMappingToJson,
  detectChapterTitleOnPage,
} from '../lib/bookPaginationEngine';
import {
  downloadSingleChapterPdf,
  createChaptersZipArchive,
  downloadRawJsonFile,
} from '../lib/chapterPdfSplitter';

// Safe worker initialization
interface BookChapterMapperViewProps {
  mappingResult: BookMappingResult;
  originalPdfBuffer: ArrayBuffer | Uint8Array | null;
  onUpdateMappingResult: (updated: BookMappingResult) => void;
  onChangeAppMode?: (mode: AppMode) => void;
}

// Visual color palette for chapter segregation (theme-aware tokens from ui.css)
const CHAPTER_COLORS = Array.from({ length: 8 }, (_, i) => {
  const n = i + 1;
  return {
    badge: { background: `var(--ch-${n}-bg)`, color: `var(--ch-${n}-ink)` } as React.CSSProperties,
    tint: { background: `var(--ch-${n}-bg)`, borderColor: `var(--ch-${n}-border)` } as React.CSSProperties,
    tag: { color: `var(--ch-${n}-ink)`, borderColor: `var(--ch-${n}-border)` } as React.CSSProperties,
  };
});

/**
 * Ultra-fast Virtualized Canvas Page Thumbnail
 * Only renders when visible on screen; safely cancels in-flight renders
 */
const PageCanvas: React.FC<{
  pdfDoc: any;
  pageNumber: number;
  scale?: number;
}> = ({ pdfDoc, pageNumber, scale = 0.28 }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isRendered, setIsRendered] = useState(false);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setIsVisible(true);
        }
      },
      { rootMargin: '300px' }
    );
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isVisible || !pdfDoc || !canvasRef.current) return;
    let renderTask: any = null;
    let isCancelled = false;

    const render = async () => {
      try {
        const page = await pdfDoc.getPage(pageNumber);
        if (isCancelled || !canvasRef.current) return;

        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);

        renderTask = page.render({
          canvasContext: ctx,
          viewport,
        });
        await renderTask.promise;
        if (!isCancelled) {
          setIsRendered(true);
        }
      } catch (err: any) {
        if (err?.name !== 'RenderingCancelledException') {
          console.warn(`Render notice on page ${pageNumber}:`, err);
        }
      }
    };

    render();

    return () => {
      isCancelled = true;
      if (renderTask) {
        try {
          renderTask.cancel();
        } catch {}
      }
    };
  }, [isVisible, pdfDoc, pageNumber, scale]);

  return (
    <div ref={containerRef} className="w-full aspect-[1/1.3] relative bg-surface flex items-center justify-center overflow-hidden rounded">
      <canvas
        ref={canvasRef}
        className={`w-full h-full object-contain ${isRendered ? 'opacity-100' : 'opacity-0'} transition-opacity duration-150`}
      />
      {!isRendered && (
        <div className="thumb-skeleton absolute inset-0 flex items-center justify-center text-secondary text-[12px]">
          p.{pageNumber}
        </div>
      )}
    </div>
  );
};

export const BookChapterMapperView: React.FC<BookChapterMapperViewProps> = ({
  mappingResult,
  originalPdfBuffer,
  onUpdateMappingResult,
  onChangeAppMode,
}) => {
  const toast = useToast();
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [copiedJson, setCopiedJson] = useState(false);
  const [isExportingZip, setIsExportingZip] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ current: number; total: number } | null>(null);

  // Inspector / Viewer Modal
  const [inspectedPageNum, setInspectedPageNum] = useState<number | null>(null);

  // Highlighted / Filtered
  const [highlightedChapterIndex, setHighlightedChapterIndex] = useState<number | null>(null);
  const [jumpPageInput, setJumpPageInput] = useState<string>('');
  const [isAutoDetectingAll, setIsAutoDetectingAll] = useState(false);
  const [detectingChapterIndex, setDetectingChapterIndex] = useState<number | null>(null);

  // Thumbnail Size & Columns Control (Strictly 8 or 10 columns toggle)
  const [columnCount, setColumnCount] = useState<8 | 10>(10);

  // Draggable Splitter & Collapsible Panel
  const [sidebarWidth, setSidebarWidth] = useState<number>(460);
  const [isTableCollapsed, setIsTableCollapsed] = useState<boolean>(false);
  const [isDraggingDivider, setIsDraggingDivider] = useState<boolean>(false);

  // Mobile (<1024px) shows one pane at a time via a segmented tab bar
  const [mobilePane, setMobilePane] = useState<'pages' | 'chapters'>('pages');

  const totalPages = mappingResult.totalPages || (mappingResult.chapters.length > 0 ? mappingResult.chapters[mappingResult.chapters.length - 1].end_page : 1);

  // Pointer Drag Handler for Slideable Divider (mouse + touch)
  const handleDividerPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    setIsDraggingDivider(true);
  }, []);

  useEffect(() => {
    if (!isDraggingDivider) return;
    const handlePointerMove = (e: PointerEvent) => {
      const newWidth = window.innerWidth - e.clientX;
      const minW = 280;
      const maxW = Math.min(800, window.innerWidth * 0.7);
      if (newWidth < 180) {
        setIsTableCollapsed(true);
      } else {
        setIsTableCollapsed(false);
        setSidebarWidth(Math.max(minW, Math.min(maxW, newWidth)));
      }
    };
    const handlePointerUp = () => {
      setIsDraggingDivider(false);
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [isDraggingDivider]);

  // Load PDF Document
  useEffect(() => {
    if (!originalPdfBuffer) return;
    let isCancelled = false;

    const loadDoc = async () => {
      try {
        if (originalPdfBuffer.byteLength === 0) {
          console.warn('PDF buffer is empty');
          return;
        }

        const dataCopy = originalPdfBuffer instanceof Uint8Array
          ? originalPdfBuffer.slice()
          : new Uint8Array(originalPdfBuffer.slice(0));

        const loadingTask = pdfjsLib.getDocument({
          data: dataCopy,
          ...pdfAssetOptions,
        });
        const doc = await loadingTask.promise;
        if (!isCancelled) {
          setPdfDoc(doc);
        }
      } catch (err) {
        console.error('Failed to load PDF document for preview:', err);
      }
    };

    loadDoc();
    return () => {
      isCancelled = true;
    };
  }, [originalPdfBuffer]);

  // Map each page to its chapter info
  const pageToChapterMap = useMemo(() => {
    const map = new Map<number, { chapter: BookChapter; colorIndex: number; isStart: boolean; isEnd: boolean }>();
    mappingResult.chapters.forEach((ch, idx) => {
      const s = Number(ch.start_page);
      const e = Number(ch.end_page);
      if (!isNaN(s) && !isNaN(e) && s > 0 && e >= s) {
        for (let p = s; p <= e; p++) {
          map.set(p, {
            chapter: ch,
            colorIndex: idx % CHAPTER_COLORS.length,
            isStart: p === s,
            isEnd: p === e,
          });
        }
      }
    });
    return map;
  }, [mappingResult.chapters]);

  // Copy raw JSON
  const rawJsonString = useMemo(() => {
    return formatBookMappingToJson(mappingResult);
  }, [mappingResult]);

  const handleCopyJson = async () => {
    try {
      await navigator.clipboard.writeText(rawJsonString);
      setCopiedJson(true);
      setTimeout(() => setCopiedJson(false), 2500);
    } catch (err) {
      console.error('Failed to copy JSON:', err);
      toast.error('Could not copy JSON to the clipboard.');
    }
  };

  // Export ZIP
  const handleDownloadZip = async () => {
    if (!originalPdfBuffer) return;
    const validChapters = mappingResult.chapters.filter(
      (c) => Number(c.start_page) > 0 && Number(c.end_page) >= Number(c.start_page)
    );
    if (validChapters.length === 0) {
      toast.error('Add at least one valid chapter range with start and end pages before exporting.');
      return;
    }
    try {
      setIsExportingZip(true);
      setExportProgress({ current: 0, total: validChapters.length });
      const zipBlob = await createChaptersZipArchive(
        originalPdfBuffer,
        { ...mappingResult, chapters: validChapters },
        (curr, tot) => setExportProgress({ current: curr, total: tot })
      );
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${mappingResult.book_title.replace(/\s+/g, '_')}_chapters_split.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success(`${validChapters.length} chapter PDFs exported as ZIP.`);
    } catch (err: any) {
      console.error('ZIP export failure:', err);
      toast.error(`Could not export ZIP: ${err.message || 'Unknown error'}`);
    } finally {
      setIsExportingZip(false);
      setExportProgress(null);
    }
  };

  // Download single chapter PDF
  const handleDownloadChapter = async (chapter: BookChapter) => {
    if (!originalPdfBuffer) return;
    const s = Number(chapter.start_page);
    const e = Number(chapter.end_page);
    if (!s || !e || isNaN(s) || isNaN(e) || e < s) {
      toast.error('Enter valid start and end pages before downloading this chapter.');
      return;
    }
    try {
      await downloadSingleChapterPdf(originalPdfBuffer, chapter);
    } catch (err: any) {
      console.error('Failed to download chapter PDF:', err);
      toast.error('Could not extract chapter PDF: ' + err.message);
    }
  };

  // Update a single chapter's fields
  const handleUpdateChapter = (index: number, updates: Partial<BookChapter>) => {
    const updated = [...mappingResult.chapters];
    const target = { ...updated[index], ...updates };
    const s = typeof target.start_page === 'number' ? target.start_page : parseInt(String(target.start_page), 10);
    const e = typeof target.end_page === 'number' ? target.end_page : parseInt(String(target.end_page), 10);
    if (!isNaN(s) && !isNaN(e) && s > 0 && e >= s) {
      target.pageCount = e - s + 1;
    } else {
      target.pageCount = 0;
    }
    updated[index] = target;
    onUpdateMappingResult({
      ...mappingResult,
      chapters: updated,
      total_discovered_chapters: updated.length,
    });
  };

  // Add a new chapter row with empty start and end page
  const handleAddChapter = () => {
    const chapters = [...mappingResult.chapters];
    const newIndex = chapters.length > 0
      ? Math.max(...chapters.map((c) => c.chapter_index || 0)) + 1
      : 1;

    chapters.push({
      chapter_index: newIndex,
      chapter_title: `Chapter ${newIndex}`,
      start_page: '' as any,
      end_page: '' as any,
      pageCount: 0,
      source: 'manual',
    });

    onUpdateMappingResult({
      ...mappingResult,
      chapters,
      total_discovered_chapters: chapters.length,
    });
  };

  // Remove a chapter row
  const handleDeleteChapter = (index: number) => {
    const chapters = mappingResult.chapters.filter((_, i) => i !== index);
    onUpdateMappingResult({
      ...mappingResult,
      chapters,
      total_discovered_chapters: chapters.length,
    });
  };

  // Auto-Balance zero-gap ranges
  const handleAutoBalanceRanges = () => {
    const validChapters = mappingResult.chapters.filter((c) => Number(c.start_page) > 0);
    if (validChapters.length === 0) {
      toast.error('Set at least one start page first.');
      return;
    }

    const chapters = [...mappingResult.chapters].sort(
      (a, b) => (Number(a.start_page) || 0) - (Number(b.start_page) || 0)
    );
    for (let i = 0; i < chapters.length - 1; i++) {
      const nextStart = Number(chapters[i + 1].start_page);
      const currStart = Number(chapters[i].start_page);
      if (nextStart > 0 && currStart > 0) {
        chapters[i].end_page = nextStart - 1;
        chapters[i].pageCount = Math.max(1, chapters[i].end_page - currStart + 1);
      }
    }
    if (chapters.length > 0 && Number(chapters[chapters.length - 1].start_page) > 0) {
      const lastStart = Number(chapters[chapters.length - 1].start_page);
      chapters[chapters.length - 1].end_page = totalPages;
      chapters[chapters.length - 1].pageCount = totalPages - lastStart + 1;
    }
    onUpdateMappingResult({
      ...mappingResult,
      chapters,
      total_discovered_chapters: chapters.length,
    });
    toast.success('Chapter ranges balanced with zero gaps.');
  };

  // Detect chapter title for a single chapter opening page (e.g. Page 15) using Gemini Flash Lite
  const handleDetectTitle = async (index: number) => {
    if (!pdfDoc) return;
    const ch = mappingResult.chapters[index];
    const s = Number(ch.start_page);
    if (!s || isNaN(s) || s < 1) {
      toast.error('Enter a start page first so the title can be detected.');
      return;
    }
    setDetectingChapterIndex(index);
    try {
      const res = await detectChapterTitleOnPage(pdfDoc, s);
      if (res.title) {
        handleUpdateChapter(index, { chapter_title: res.title });
      } else {
        toast.error('No title could be detected on that page.');
      }
    } catch (e) {
      console.warn('Could not auto-detect title:', e);
      toast.error('Title detection failed. Try again.');
    } finally {
      setDetectingChapterIndex(null);
    }
  };

  // Auto detect titles for all chapters in fast concurrent batches of 3
  const handleDetectAllTitles = async () => {
    if (!pdfDoc || mappingResult.chapters.length === 0) return;
    const validWithStart = mappingResult.chapters
      .map((ch, idx) => ({ ch, idx }))
      .filter(({ ch }) => Boolean(ch.start_page && Number(ch.start_page) >= 1));

    if (validWithStart.length === 0) {
      toast.error('Fill in the start pages before detecting titles.');
      return;
    }

    setIsAutoDetectingAll(true);
    try {
      const updated = [...mappingResult.chapters];
      const batchSize = 3;
      for (let i = 0; i < validWithStart.length; i += batchSize) {
        const batch = validWithStart.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async ({ ch, idx }) => {
            try {
              const res = await detectChapterTitleOnPage(pdfDoc, Number(ch.start_page));
              if (res.title) {
                updated[idx] = { ...updated[idx], chapter_title: res.title };
              }
            } catch (err) {
              console.warn(`Failed title detection on page ${ch.start_page}:`, err);
            }
          })
        );
        onUpdateMappingResult({
          ...mappingResult,
          chapters: [...updated],
        });
      }
      toast.success('Finished detecting chapter titles.');
    } catch (e) {
      console.warn('Error in auto-detecting all titles:', e);
    } finally {
      setIsAutoDetectingAll(false);
    }
  };

  // Quick jump to page
  const handleJumpToPage = (e: React.FormEvent) => {
    e.preventDefault();
    const p = parseInt(jumpPageInput, 10);
    if (!isNaN(p) && p >= 1 && p <= totalPages) {
      setInspectedPageNum(p);
      const el = document.getElementById(`page-thumb-${p}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  };

  // Add chapter starting at inspected page
  const handleCreateChapterAtInspectedPage = () => {
    if (!inspectedPageNum) return;
    const chapters = [...mappingResult.chapters];
    const newIdx = chapters.length > 0
      ? Math.max(...chapters.map((c) => c.chapter_index || 0)) + 1
      : 1;
    chapters.push({
      chapter_index: newIdx,
      chapter_title: `Chapter ${newIdx}`,
      start_page: inspectedPageNum,
      end_page: '' as any,
      pageCount: 0,
      source: 'manual',
    });
    chapters.sort((a, b) => (Number(a.start_page) || 0) - (Number(b.start_page) || 0));
    onUpdateMappingResult({
      ...mappingResult,
      chapters,
      total_discovered_chapters: chapters.length,
    });
    toast.success(`Chapter started on page ${inspectedPageNum}.`);
  };

  // The most recently started chapter that is still missing a valid end page
  const openChapterIndex = useMemo(() => {
    let best: number | null = null;
    let bestStart = -Infinity;
    mappingResult.chapters.forEach((ch, idx) => {
      const s = Number(ch.start_page);
      const e = ch.end_page === undefined || ch.end_page === null || (ch.end_page as any) === ''
        ? NaN
        : Number(ch.end_page);
      if (!isNaN(s) && s > 0 && (isNaN(e) || e < s) && s >= bestStart) {
        bestStart = s;
        best = idx;
      }
    });
    return best;
  }, [mappingResult.chapters]);

  const inspectedChapterInfo = inspectedPageNum ? pageToChapterMap.get(inspectedPageNum) : undefined;

  // End the open chapter on the inspected page
  const canEndChapterAtInspectedPage =
    openChapterIndex !== null &&
    inspectedPageNum !== null &&
    inspectedPageNum >= Number(mappingResult.chapters[openChapterIndex].start_page);

  const handleEndChapterAtInspectedPage = () => {
    if (openChapterIndex === null || !inspectedPageNum) return;
    const ch = mappingResult.chapters[openChapterIndex];
    handleUpdateChapter(openChapterIndex, { end_page: inspectedPageNum });
    toast.success(`Ended Ch.${ch.chapter_index}: ${ch.chapter_title} on page ${inspectedPageNum}.`);
  };

  return (
    <div className="chapter-workspace">
      {/* Top Bar Header */}
      <header className="ws-toolbar">
        <div className="ws-title">
          <span className="ws-title-icon"><BookOpen size={17} /></span>
          <div className="min-w-0">
            <div className="ws-title-meta">
              <h1 className="ws-book-title" title={mappingResult.book_title}>{mappingResult.book_title}</h1>
              <span className="chip accent">{mappingResult.total_discovered_chapters} chapters</span>
              <span className="chip">{totalPages} pages</span>
            </div>
            <p className="ws-subtitle">Review pages, adjust chapter ranges, and export.</p>
          </div>
        </div>

        {/* Action Controls */}
        <div className="ws-actions">
          {/* Jump to Page input */}
          <form onSubmit={handleJumpToPage} className="jump-form">
            <input
              type="number"
              min={1}
              max={totalPages}
              aria-label="Jump to page number"
              placeholder="Page #"
              value={jumpPageInput}
              onChange={(e) => setJumpPageInput(e.target.value)}
            />
            <button type="submit" className="btn secondary btn-sm">Go</button>
          </form>

          {/* Toggle Chapter Ranges Panel Button */}
          <button
            onClick={() => setIsTableCollapsed(!isTableCollapsed)}
            aria-pressed={!isTableCollapsed}
            className="btn secondary btn-sm"
            title={isTableCollapsed ? 'Open the chapter ranges panel' : 'Collapse the chapter ranges panel'}
          >
            {isTableCollapsed ? <PanelRightOpen size={14} /> : <PanelRightClose size={14} />}
            <span>Chapter ranges ({mappingResult.chapters.length})</span>
          </button>

          {/* Copy JSON */}
          <button
            id="copy-json-btn"
            onClick={handleCopyJson}
            className="btn secondary btn-sm"
            title="Copy the raw chapter JSON to the clipboard"
          >
            {copiedJson ? <Check size={14} className="text-positive" /> : <Copy size={14} />}
            {copiedJson ? 'Copied' : 'Copy JSON'}
          </button>

          {/* Download JSON file */}
          <button
            onClick={() => downloadRawJsonFile(mappingResult)}
            className="btn secondary btn-sm"
            title="Download the chapter JSON as a file"
          >
            <FileJson size={14} />
            Save JSON
          </button>

          {/* Export chapters */}
          <button
            id="export-zip-btn"
            onClick={handleDownloadZip}
            disabled={isExportingZip}
            className="btn primary btn-sm"
            title="Split the book into one PDF per chapter and download as ZIP"
          >
            {isExportingZip ? <RefreshCw size={14} className="animate-spin" /> : <Download size={14} />}
            {isExportingZip
              ? exportProgress
                ? `Splitting ${exportProgress.current}/${exportProgress.total}…`
                : 'Extracting…'
              : 'Export chapters'}
          </button>
        </div>
      </header>

      {/* Main Workspace: Split into Page Grid (Left) and Chapter Table (Right) with Draggable Divider */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden relative">
        {/* Mobile pane switcher (hidden ≥1024px) */}
        <div className="ws-mobile-tabs" role="tablist" aria-label="Workspace panes">
          <button
            type="button"
            className="ws-mobile-back-btn"
            onClick={() => {
              if (inspectedPageNum !== null) {
                setInspectedPageNum(null);
              } else if (mobilePane === 'chapters') {
                setMobilePane('pages');
              } else if (onChangeAppMode) {
                onChangeAppMode('dashboard');
              }
            }}
            title="Back"
          >
            <ArrowLeft size={16} />
            <span>Back</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mobilePane === 'pages'}
            className={mobilePane === 'pages' ? 'active' : ''}
            onClick={() => setMobilePane('pages')}
          >
            <Grid size={14} />
            Pages
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mobilePane === 'chapters'}
            className={mobilePane === 'chapters' ? 'active' : ''}
            onClick={() => setMobilePane('chapters')}
          >
            <Table size={14} />
            Chapters
          </button>
        </div>

        {/* Left Section: Page Grid Viewer */}
        <div className={`ws-pane-pages flex-1 flex flex-col min-w-0 min-h-0 ${mobilePane === 'pages' ? 'pane-active' : ''}`}>
          {/* Grid Toolbar Header */}
          <div className="grid-toolbar">
            <div className="grid-toolbar-label">
              <Grid size={15} />
              <span>Page previews</span>
              <small>({totalPages} pages)</small>
            </div>

            {/* Thumbnail Size Selector */}
            <div className="grid-toolbar-tools">
              <div className="segmented" role="group" aria-label="Thumbnail size">
                <button
                  type="button"
                  aria-pressed={columnCount === 8}
                  onClick={() => setColumnCount(8)}
                  title="8 columns — larger, clearer thumbnails"
                >
                  8 cols
                </button>
                <button
                  type="button"
                  aria-pressed={columnCount === 10}
                  onClick={() => setColumnCount(10)}
                  title="10 columns — compact overview"
                >
                  10 cols
                </button>
              </div>

              <div className="legend-hint">
                <span />
                <span>Click a page to inspect</span>
              </div>
            </div>
          </div>

          {/* Dynamic Grid Container */}
          <div className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-4">
            <div
              className={`grid ${
                columnCount === 8
                  ? 'grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3'
                  : 'grid-cols-2 sm:grid-cols-5 md:grid-cols-8 lg:grid-cols-10 gap-2'
              }`}
            >
              {Array.from({ length: totalPages }, (_, idx) => {
                const pageNum = idx + 1;
                const chInfo = pageToChapterMap.get(pageNum);
                const color = chInfo ? CHAPTER_COLORS[chInfo.colorIndex] : null;
                const isSelected = inspectedPageNum === pageNum;
                const isFilteredChapter = highlightedChapterIndex !== null && chInfo?.chapter.chapter_index === highlightedChapterIndex;

                const thumbnailScale = columnCount === 8 ? 0.42 : 0.32;

                return (
                  <div
                    key={pageNum}
                    id={`page-thumb-${pageNum}`}
                    onClick={() => setInspectedPageNum(pageNum)}
                    className={`page-thumb ${isSelected ? 'selected' : ''} ${isFilteredChapter ? 'filtered' : ''}`}
                    style={!isSelected && !isFilteredChapter && color ? color.tint : undefined}
                  >
                    {/* Visual Page Canvas with dynamic high-clarity scale */}
                    <PageCanvas pdfDoc={pdfDoc} pageNumber={pageNum} scale={thumbnailScale} />

                    {/* Page & Chapter Tag */}
                    <div className="page-thumb-meta">
                      <span className="page-num">p.{pageNum}</span>
                      {chInfo && color && (
                        <span
                          className="page-thumb-tag"
                          style={
                            chInfo.isStart
                              ? { background: 'var(--accent-solid)', borderColor: 'transparent', color: '#fff' }
                              : { background: 'transparent', border: `1px solid ${color.tag.borderColor}`, color: color.tag.color }
                          }
                          title={`Ch.${chInfo.chapter.chapter_index}: ${chInfo.chapter.chapter_title}`}
                        >
                          {chInfo.isStart ? `Ch.${chInfo.chapter.chapter_index} ▸` : `Ch.${chInfo.chapter.chapter_index}`}
                        </span>
                      )}
                    </div>

                    {/* Hover Overlay with Inspect Icon */}
                    <div className="page-thumb-overlay">
                      <span><Eye size={14} /></span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Slideable / Draggable Resizer Divider */}
        {!isTableCollapsed && (
          <div
            onPointerDown={handleDividerPointerDown}
            onDoubleClick={() => setIsTableCollapsed(true)}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize chapter panel"
            className={`ws-divider ${isDraggingDivider ? 'dragging' : ''}`}
            title="Drag to resize the chapter panel · Double-click to collapse"
          >
            <GripVertical size={13} />
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setIsTableCollapsed(true);
              }}
              className="divider-collapse"
              aria-label="Collapse chapter panel"
              title="Collapse chapter panel"
            >
              <ChevronRight size={12} />
            </button>
          </div>
        )}

        {/* Right Section: Chapter Ranges Panel (Slideable & Collapsible) */}
        <div
          style={{ width: isTableCollapsed ? 0 : `${sidebarWidth}px` }}
          className={`chapter-sidebar ws-pane-chapters ${isTableCollapsed ? 'collapsed' : ''} ${mobilePane === 'chapters' ? 'pane-active' : ''}`}
        >
          {/* Chapter Panel Header */}
          <div className="sidebar-head">
            <div className="sidebar-head-label">
              <Table size={15} />
              <span>Chapters</span>
            </div>
            <div className="sidebar-head-actions">
              <button
                onClick={handleDetectAllTitles}
                disabled={isAutoDetectingAll}
                className="btn secondary btn-sm"
                title="Analyze each chapter's start page to auto-detect chapter names"
              >
                <Sparkles size={13} className={isAutoDetectingAll ? 'animate-spin' : ''} />
                {isAutoDetectingAll ? 'Detecting…' : 'Detect titles'}
              </button>
              <button
                onClick={handleAutoBalanceRanges}
                className="btn secondary btn-sm"
                title="Ensure zero gaps between all chapters"
              >
                <Sliders size={13} />
                Zero gaps
              </button>
              <button onClick={handleAddChapter} className="btn primary btn-sm">
                <Plus size={13} />
                Add chapter
              </button>
              <button
                onClick={() => setIsTableCollapsed(true)}
                className="icon-btn-sm"
                aria-label="Collapse chapter panel"
                title="Collapse chapter panel"
              >
                <PanelRightClose size={15} />
              </button>
            </div>
          </div>

          {/* Chapter Rows */}
          <div className="chapter-rows">
            {mappingResult.chapters.length === 0 ? (
              <div className="sidebar-empty">
                <div className="icon"><Plus size={18} /></div>
                <h4>No chapter ranges</h4>
                <p>Add a chapter with custom start and end pages.</p>
                <button onClick={handleAddChapter} className="btn primary btn-sm">
                  <Plus size={13} />
                  Add chapter
                </button>
              </div>
            ) : (
              mappingResult.chapters.map((ch, idx) => {
                const color = CHAPTER_COLORS[idx % CHAPTER_COLORS.length];
                const isFiltered = highlightedChapterIndex === ch.chapter_index;

                const startVal =
                  ch.start_page !== undefined && ch.start_page !== null && !isNaN(ch.start_page as any) && (ch.start_page as any) !== ''
                    ? ch.start_page
                    : '';
                const endVal =
                  ch.end_page !== undefined && ch.end_page !== null && !isNaN(ch.end_page as any) && (ch.end_page as any) !== ''
                    ? ch.end_page
                    : '';

                return (
                  <div key={idx} className={`chapter-row ${isFiltered ? 'filtered' : ''}`}>
                    <div className="chapter-row-top">
                      {/* Chapter Index Badge */}
                      <span className="chapter-badge" style={color.badge}>#{ch.chapter_index}</span>

                      {/* Chapter Title Input */}
                      <input
                        type="text"
                        value={ch.chapter_title}
                        onChange={(e) => handleUpdateChapter(idx, { chapter_title: e.target.value })}
                        className="chapter-title-input"
                        aria-label={`Title of chapter ${ch.chapter_index}`}
                        placeholder="Chapter title…"
                      />

                      {/* Auto detect single title */}
                      <button
                        onClick={() => handleDetectTitle(idx)}
                        disabled={detectingChapterIndex === idx || isAutoDetectingAll}
                        className="icon-btn-sm warning"
                        aria-label={`Auto-detect title for chapter ${ch.chapter_index}`}
                        title={
                          ch.start_page
                            ? `Auto-detect the title from opening page ${ch.start_page}`
                            : 'Enter a start page first to auto-detect the title'
                        }
                      >
                        <Sparkles size={14} className={detectingChapterIndex === idx ? 'animate-spin' : ''} />
                      </button>

                      {/* Highlight in Grid */}
                      <button
                        onClick={() =>
                          setHighlightedChapterIndex(isFiltered ? null : ch.chapter_index)
                        }
                        className={`icon-btn-sm ${isFiltered ? 'active' : ''}`}
                        aria-label={`${isFiltered ? 'Remove highlight from' : 'Highlight'} chapter ${ch.chapter_index} in the page grid`}
                        title="Highlight this chapter in the page grid"
                      >
                        <Eye size={14} />
                      </button>

                      {/* Download single PDF */}
                      <button
                        onClick={() => handleDownloadChapter(ch)}
                        className="icon-btn-sm accent"
                        aria-label={`Download chapter ${ch.chapter_index} as PDF`}
                        title="Download this chapter as a PDF"
                      >
                        <Download size={14} />
                      </button>

                      {/* Delete */}
                      <button
                        onClick={() => handleDeleteChapter(idx)}
                        className="icon-btn-sm danger"
                        aria-label={`Delete chapter ${ch.chapter_index}`}
                        title="Delete this chapter row"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>

                    {/* Page Range Row */}
                    <div className="chapter-row-bottom">
                      <label>
                        <span>Start</span>
                        <input
                          type="number"
                          min={1}
                          max={totalPages}
                          value={startVal}
                          onChange={(e) => {
                            const raw = e.target.value.trim();
                            const val = raw === '' ? ('' as any) : parseInt(raw, 10);
                            handleUpdateChapter(idx, { start_page: isNaN(val) ? ('' as any) : val });
                          }}
                          aria-label={`Start page of chapter ${ch.chapter_index}`}
                          placeholder="—"
                          className="page-field"
                        />
                      </label>

                      <ArrowRight size={12} />

                      <label>
                        <span>End</span>
                        <input
                          type="number"
                          min={typeof ch.start_page === 'number' && ch.start_page > 0 ? ch.start_page : 1}
                          max={totalPages}
                          value={endVal}
                          onChange={(e) => {
                            const raw = e.target.value.trim();
                            const val = raw === '' ? ('' as any) : parseInt(raw, 10);
                            handleUpdateChapter(idx, { end_page: isNaN(val) ? ('' as any) : val });
                          }}
                          aria-label={`End page of chapter ${ch.chapter_index}`}
                          placeholder="—"
                          className="page-field"
                        />
                      </label>

                      <span className="page-count-pill">
                        {ch.start_page && ch.end_page && Number(ch.end_page) >= Number(ch.start_page)
                          ? `${Number(ch.end_page) - Number(ch.start_page) + 1} pages`
                          : '— pages'}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Floating Quick-Open Tab when the Panel is Collapsed */}
        {isTableCollapsed && (
          <button
            onClick={() => setIsTableCollapsed(false)}
            className="sidebar-tab"
            title="Open the chapter ranges panel"
            aria-label={`Open chapter ranges panel (${mappingResult.chapters.length} chapters)`}
          >
            <PanelRightOpen size={15} />
            <span>Chapters ({mappingResult.chapters.length})</span>
          </button>
        )}
      </div>

      {/* High-Resolution Page Inspector Modal */}
      {inspectedPageNum !== null && (
        <Modal
          eyebrow={`Page ${inspectedPageNum} of ${totalPages}`}
          title="Page inspector"
          closeLabel="Close page inspector"
          onClose={() => setInspectedPageNum(null)}
          width="lg"
          bodyClassName="inspector-body"
          headerActions={<>
            <button
              disabled={inspectedPageNum <= 1}
              onClick={() => setInspectedPageNum((p) => (p ? Math.max(1, p - 1) : 1))}
              className="icon-button bordered"
              aria-label="Previous page"
              title="Previous page"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              disabled={inspectedPageNum >= totalPages}
              onClick={() => setInspectedPageNum((p) => (p ? Math.min(totalPages, p + 1) : totalPages))}
              className="icon-button bordered"
              aria-label="Next page"
              title="Next page"
            >
              <ChevronRight size={16} />
            </button>
          </>}
        >
          <div className="inspector-canvas">
            <div className="page-frame">
              <PageCanvas pdfDoc={pdfDoc} pageNumber={inspectedPageNum} scale={1.2} />
            </div>
          </div>

          {/* Text & Chapter Action Sidebar */}
          <aside className="inspector-rail">
            <h3 className="rail-heading">Chapter mapping</h3>
            {inspectedChapterInfo ? (
              <p className="chapter-ref">
                Belongs to <strong>Ch.{inspectedChapterInfo.chapter.chapter_index}: {inspectedChapterInfo.chapter.chapter_title}</strong>
              </p>
            ) : (
              <p className="chapter-ref">This page is not part of any chapter range yet.</p>
            )}
            <button onClick={handleCreateChapterAtInspectedPage} className="btn primary">
              <Plus size={15} />
              Start chapter on page {inspectedPageNum}
            </button>
            <button
              onClick={handleEndChapterAtInspectedPage}
              disabled={!canEndChapterAtInspectedPage}
              className="btn secondary"
              title={
                openChapterIndex === null
                  ? 'Start a chapter first — ending a chapter needs an open chapter with a start page but no end page yet'
                  : inspectedPageNum !== null && inspectedPageNum < Number(mappingResult.chapters[openChapterIndex].start_page)
                    ? `This page is before the start page of Ch.${mappingResult.chapters[openChapterIndex].chapter_index}`
                    : `Set Ch.${mappingResult.chapters[openChapterIndex].chapter_index} to end on page ${inspectedPageNum}`
              }
            >
              <Flag size={15} />
              End chapter on page {inspectedPageNum}
            </button>
          </aside>
        </Modal>
      )}
    </div>
  );
};
