import React, { useState, useEffect, useRef } from 'react';
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  ChevronDown,
  ChevronUp,
  Loader2,
  AlertCircle,
  Minimize2,
} from 'lucide-react';
import { pdfjsLib, pdfAssetOptions } from '../lib/pdfConfig';

interface LaTeXPdfViewerProps {
  pdfBlob?: Blob | null;
  pdfUrl?: string | null;
}

interface PdfPageProps {
  pdfDoc: any;
  pageNumber: number;
  scale: number;
  onVisible?: (pageNum: number) => void;
}

const PdfPage: React.FC<PdfPageProps> = ({
  pdfDoc,
  pageNumber,
  scale,
  onVisible,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isRendered, setIsRendered] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const activeRenderTaskRef = useRef<any>(null);

  // Monitor visibility for lazy-rendering
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setIsVisible(true);
          onVisible?.(pageNumber);
        } else {
          // Keep rendered canvas if scrolled out, but don't cancel unless unmounted
        }
      },
      { rootMargin: '500px 0px 500px 0px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [pageNumber, onVisible]);

  // Render page when visible or when scale changes
  useEffect(() => {
    if (!isVisible || !pdfDoc) return;
    let isCancelled = false;

    const render = async () => {
      try {
        if (activeRenderTaskRef.current) {
          try {
            activeRenderTaskRef.current.cancel();
          } catch {}
          activeRenderTaskRef.current = null;
        }

        const page = await pdfDoc.getPage(pageNumber);
        if (isCancelled || !canvasRef.current) return;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: scale * dpr });
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) return;

        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
        canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const renderTask = page.render({
          canvasContext: ctx,
          viewport,
        });
        activeRenderTaskRef.current = renderTask;

        await renderTask.promise;
        if (!isCancelled) {
          setIsRendered(true);
        }
      } catch (err: any) {
        if (err?.name !== 'RenderingCancelledException') {
          console.warn(`Render notice on PDF page ${pageNumber}:`, err);
        }
      }
    };

    render();

    return () => {
      isCancelled = true;
      if (activeRenderTaskRef.current) {
        try {
          activeRenderTaskRef.current.cancel();
        } catch {}
        activeRenderTaskRef.current = null;
      }
    };
  }, [isVisible, pdfDoc, pageNumber, scale]);

  return (
    <div
      ref={containerRef}
      id={`latex-pdf-page-${pageNumber}`}
      className="latex-pdf-page-card"
      style={{
        width: 'max-content',
        margin: '0 auto 20px auto',
        position: 'relative',
      }}
    >
      <div
        className="latex-pdf-page-inner"
        style={{
          boxShadow: '0 4px 18px rgba(0, 0, 0, 0.2), 0 1px 4px rgba(0, 0, 0, 0.12)',
          borderRadius: 2,
          background: '#ffffff',
          overflow: 'hidden',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minWidth: 100,
          minHeight: 140,
        }}
      >
        <canvas
          ref={canvasRef}
          style={{
            display: 'block',
            maxWidth: '100%',
          }}
        />
        {!isRendered && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: '#fafafa',
              color: '#888',
              fontSize: 12,
            }}
          >
            <Loader2 size={16} className="spinner" style={{ marginRight: 6 }} />
            <span>Page {pageNumber}…</span>
          </div>
        )}
      </div>
      <div
        style={{
          textAlign: 'center',
          marginTop: 6,
          fontSize: 11,
          fontWeight: 500,
          color: 'var(--secondary)',
          letterSpacing: '0.02em',
        }}
      >
        {pageNumber}
      </div>
    </div>
  );
};

export const LaTeXPdfViewer: React.FC<LaTeXPdfViewerProps> = ({
  pdfBlob,
  pdfUrl,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);

  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [baseWidth, setBaseWidth] = useState<number>(612);
  const [baseHeight, setBaseHeight] = useState<number>(792);

  const [zoomMode, setZoomMode] = useState<'fit-width' | 'fit-page' | 'manual'>('fit-width');
  const [manualScale, setManualScale] = useState<number>(1.0);
  const [containerDimensions, setContainerDimensions] = useState<{ width: number; height: number }>({
    width: 600,
    height: 800,
  });

  // Track container resize to update fit-width and fit-page dynamically
  useEffect(() => {
    const el = scrollAreaRef.current;
    if (!el) return;

    const updateSize = () => {
      setContainerDimensions({
        width: el.clientWidth || 600,
        height: el.clientHeight || 800,
      });
    };

    updateSize();

    const ro = new ResizeObserver(() => {
      updateSize();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Load PDF Document with PDF.js
  useEffect(() => {
    let isCancelled = false;
    setLoading(true);
    setError(null);

    const load = async () => {
      try {
        let data: Uint8Array | null = null;

        if (pdfBlob) {
          const ab = await pdfBlob.arrayBuffer();
          data = new Uint8Array(ab);
        } else if (pdfUrl) {
          const res = await fetch(pdfUrl);
          const ab = await res.arrayBuffer();
          data = new Uint8Array(ab);
        }

        if (!data || data.byteLength === 0) {
          throw new Error('PDF data buffer is empty.');
        }

        const loadingTask = pdfjsLib.getDocument({
          data,
          ...pdfAssetOptions,
        });

        const doc = await loadingTask.promise;
        if (isCancelled) return;

        setPdfDoc(doc);
        setNumPages(doc.numPages);
        setCurrentPage(1);

        // Fetch page 1 dimensions for fit-to-page scaling
        try {
          const firstPage = await doc.getPage(1);
          const v = firstPage.getViewport({ scale: 1 });
          setBaseWidth(v.width);
          setBaseHeight(v.height);
        } catch {}

        setLoading(false);
      } catch (err: any) {
        if (!isCancelled) {
          console.error('Failed to load PDF document for in-app preview:', err);
          setError(err?.message || 'Failed to render PDF preview.');
          setLoading(false);
        }
      }
    };

    load();

    return () => {
      isCancelled = true;
    };
  }, [pdfBlob, pdfUrl]);

  // Compute effective scale based on zoomMode and viewport width
  const effectiveScale = React.useMemo(() => {
    if (zoomMode === 'fit-width') {
      const availableW = Math.max(200, containerDimensions.width - 48);
      const computed = availableW / (baseWidth || 612);
      return Math.max(0.4, Math.min(2.5, computed));
    }
    if (zoomMode === 'fit-page') {
      const availableW = Math.max(200, containerDimensions.width - 48);
      const availableH = Math.max(200, containerDimensions.height - 56);
      const scaleW = availableW / (baseWidth || 612);
      const scaleH = availableH / (baseHeight || 792);
      return Math.max(0.35, Math.min(2.5, Math.min(scaleW, scaleH)));
    }
    return manualScale;
  }, [zoomMode, manualScale, containerDimensions, baseWidth, baseHeight]);

  const handleZoomIn = () => {
    setZoomMode('manual');
    setManualScale(Math.min(3.0, +(effectiveScale * 1.2).toFixed(2)));
  };

  const handleZoomOut = () => {
    setZoomMode('manual');
    setManualScale(Math.max(0.35, +(effectiveScale / 1.2).toFixed(2)));
  };

  const handleResetZoom = () => {
    setZoomMode('manual');
    setManualScale(1.0);
  };

  const handleFitWidth = () => {
    setZoomMode('fit-width');
  };

  const handleFitPage = () => {
    setZoomMode('fit-page');
  };

  const scrollToPage = (pageNum: number) => {
    const p = Math.max(1, Math.min(numPages, pageNum));
    const targetEl = document.getElementById(`latex-pdf-page-${p}`);
    if (targetEl && scrollAreaRef.current) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setCurrentPage(p);
    }
  };

  const handlePrevPage = () => {
    scrollToPage(currentPage - 1);
  };

  const handleNextPage = () => {
    scrollToPage(currentPage + 1);
  };

  const handlePageInput = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const val = parseInt((e.target as HTMLInputElement).value, 10);
      if (!isNaN(val)) {
        scrollToPage(val);
      }
    }
  };

  return (
    <div
      ref={containerRef}
      id="latex-in-app-pdf-viewer"
      className="latex-in-app-pdf-viewer"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--muted)',
        overflow: 'hidden',
      }}
    >
      {/* Viewer Controls Toolbar */}
      <div
        id="latex-pdf-controls-bar"
        className="latex-pdf-controls-bar"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 12px',
          background: 'var(--surface)',
          borderBottom: '1px solid var(--line)',
          zIndex: 10,
          gap: 8,
          fontSize: 12,
          flexShrink: 0,
        }}
      >
        {/* Left: Page Navigation */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            type="button"
            className="btn quiet btn-sm latex-icon-btn"
            onClick={handlePrevPage}
            disabled={currentPage <= 1 || loading || !numPages}
            title="Previous Page"
            aria-label="Previous Page"
            style={{ width: 26, height: 26, padding: 0 }}
          >
            <ChevronUp size={15} />
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--ink)' }}>
            <input
              type="text"
              key={currentPage}
              defaultValue={currentPage}
              onKeyDown={handlePageInput}
              disabled={loading || !numPages}
              style={{
                width: 32,
                height: 22,
                textAlign: 'center',
                fontSize: 11,
                borderRadius: 'var(--r-sm)',
                border: '1px solid var(--line)',
                background: 'var(--muted)',
                color: 'var(--ink)',
                padding: 0,
              }}
              aria-label="Jump to page"
            />
            <span style={{ color: 'var(--secondary)', fontSize: 11 }}>/ {numPages || 1}</span>
          </div>

          <button
            type="button"
            className="btn quiet btn-sm latex-icon-btn"
            onClick={handleNextPage}
            disabled={currentPage >= numPages || loading || !numPages}
            title="Next Page"
            aria-label="Next Page"
            style={{ width: 26, height: 26, padding: 0 }}
          >
            <ChevronDown size={15} />
          </button>
        </div>

        {/* Center / Right: Zoom Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            type="button"
            className="btn quiet btn-sm latex-icon-btn"
            onClick={handleZoomOut}
            disabled={loading || effectiveScale <= 0.35}
            title="Zoom out"
            aria-label="Zoom out"
            style={{ width: 26, height: 26, padding: 0 }}
          >
            <ZoomOut size={14} />
          </button>

          <button
            type="button"
            className="btn quiet btn-sm"
            onClick={handleResetZoom}
            disabled={loading}
            title="Click to reset zoom to 100%"
            style={{
              padding: '2px 6px',
              fontSize: 11,
              fontFamily: 'monospace',
              minWidth: 44,
              justifyContent: 'center',
            }}
          >
            {Math.round(effectiveScale * 100)}%
          </button>

          <button
            type="button"
            className="btn quiet btn-sm latex-icon-btn"
            onClick={handleZoomIn}
            disabled={loading || effectiveScale >= 3.0}
            title="Zoom in"
            aria-label="Zoom in"
            style={{ width: 26, height: 26, padding: 0 }}
          >
            <ZoomIn size={14} />
          </button>

          <div style={{ width: 1, height: 16, background: 'var(--line)', margin: '0 2px' }} />

          <button
            type="button"
            className={`btn quiet btn-sm latex-icon-btn ${zoomMode === 'fit-width' ? 'active' : ''}`}
            onClick={handleFitWidth}
            disabled={loading}
            title="Fit to pane width"
            aria-label="Fit to pane width"
            style={{
              width: 26,
              height: 26,
              padding: 0,
              background: zoomMode === 'fit-width' ? 'var(--line)' : undefined,
            }}
          >
            <Maximize2 size={13} />
          </button>

          <button
            type="button"
            className={`btn quiet btn-sm latex-icon-btn ${zoomMode === 'fit-page' ? 'active' : ''}`}
            onClick={handleFitPage}
            disabled={loading}
            title="Fit whole page"
            aria-label="Fit whole page"
            style={{
              width: 26,
              height: 26,
              padding: 0,
              background: zoomMode === 'fit-page' ? 'var(--line)' : undefined,
            }}
          >
            <Minimize2 size={13} />
          </button>
        </div>
      </div>

      {/* Main Document Scrollable Viewport */}
      <div
        ref={scrollAreaRef}
        id="latex-pdf-scroll-area"
        className="latex-pdf-scroll-area"
        style={{
          flex: 1,
          overflowY: 'auto',
          overflowX: 'auto',
          padding: '24px 16px 40px 16px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        }}
      >
        {loading && (
          <div
            style={{
              margin: 'auto',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 10,
              color: 'var(--secondary)',
              padding: 32,
            }}
          >
            <Loader2 size={26} className="spinner" />
            <span style={{ fontSize: 13, fontWeight: 500 }}>Rendering PDF preview…</span>
          </div>
        )}

        {error && !loading && (
          <div
            style={{
              margin: 'auto',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 10,
              color: 'var(--danger)',
              padding: 32,
              textAlign: 'center',
              maxWidth: 360,
            }}
          >
            <AlertCircle size={30} />
            <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{error}</p>
            <span style={{ fontSize: 12, color: 'var(--secondary)' }}>
              You can still open or download the raw PDF using the buttons above.
            </span>
          </div>
        )}

        {!loading && !error && pdfDoc && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              width: '100%',
            }}
          >
            {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => (
              <PdfPage
                key={`${pdfDoc.fingerprint || 'doc'}-page-${pageNum}`}
                pdfDoc={pdfDoc}
                pageNumber={pageNum}
                scale={effectiveScale}
                              onVisible={(p) => setCurrentPage(p)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
