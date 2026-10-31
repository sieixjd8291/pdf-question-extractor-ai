import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  ImagePlus,
  RotateCcw,
  RotateCw,
  Crop as CropIcon,
  Trash2,
  ArrowLeft,
  ArrowRight,
  Download,
  RefreshCcw,
  ScanLine,
  Plus,
  SlidersHorizontal,
  Check,
  X,
  Loader2,
  AlertTriangle,
  Copy,
  Maximize,
  ListOrdered,
  GripVertical,
  Pencil,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  Image as ImageIcon,
  Magnet,
  Eraser,
  Undo2,
  Redo2,
  ZoomIn,
  ZoomOut,
  Feather,
  Compass,
  Minimize2,
} from 'lucide-react';
import { CompressDialog, effectiveScale, resizeSmooth, type CompressionSettings } from './CompressDialog';
import { useToast } from './Toast';
import { useDialog } from '../hooks/useDialog';
import { jsPDF } from 'jspdf';
import JSZip from 'jszip';
import {
  SCAN_FILTERS,
  SCAN_QUALITY_PRESETS,
  NEUTRAL_ADJUSTMENTS,
  ScanAdjustments,
  ScanEraseStroke,
  ScanFilterId,
  ScanQuad,
  isSaneQuad,
  type EdgeSnapEngine,
  renderScanCanvas,
  captureCanvasToDataUrl,
  loadImageFromUrl,
  PREVIEW_MAX_EDGE,
  THUMB_MAX_EDGE,
  renderFilterThumbnailsFast,
  clearImageCache,
} from '../lib/scannerFilters';
import { applyEraseStrokes } from '../lib/backgroundEraser';
import {
  detectDocumentCached, createBoundarySnapEngine, releaseDocumentDetection, clearDocumentDetections, warmDocumentDetection,
  type DetectionSnapEngine,
} from '../lib/documentDetectionClient';
import type { DocumentDetectionResult } from '../lib/precisionDetection';
import { automaticDocumentQuad } from '../lib/automaticDocumentCrop';
import { renderScanPreviewCanvas, clearScannerPreviews } from '../lib/scannerPreview';
import { CropMagnifier } from './CropMagnifier';
import {
  detectDocumentOrientation,
  autoFixImageOrientation,
} from '../lib/orientationDetector';
import { warmUpOrientationModel } from '../lib/mlOrientation';
import { streamRenderPdfPages } from '../lib/pdfEngine';
import { downloadFileMobileSafe, isIosLikeBrowser } from '../lib/cropper';
import { downloadBlob } from '../lib/zipPackager';
import { StagedProgress, useProgressStatus, yieldToPaint } from '../lib/stagedProgress';
import { runInBackground } from '../lib/backgroundTask';
import { imageImportConcurrency, importMaxEdge, isLowPowerDevice } from '../lib/devicePerf';
import { ExportButtonLabel, ScannerProgressBubble } from './ScannerProgressBubble';
import type { AppMode, ScanMargin, ScanPageSize, ScanQualityPreset } from '../types';

/**
 * Cam Scanner — the fourth tool. Turns the device camera, photos or PDF pages
 * into clean scanned documents: perspective crop with auto edge detection,
 * onlinedocscanner-style filters (SuperScan, Better, Simple, Grayscale, B&W),
 * a manual Adobe-Scan-style clean-up eraser (brushed marks are filled with the
 * nearest surrounding color), manual adjustments, multi-page management, and
 * PDF / JPG / PNG / ZIP export. Everything runs locally in the browser.
 */

type ExportFormat = 'pdf' | 'jpg' | 'png';

interface ScanPage {
  id: string;
  name: string;
  originalUrl: string; // capped-resolution capture, un-rotated / un-warped
  sourceKind: 'photo' | 'pdf';
  cropRevision: number;
  thumbUrl?: string; // lightweight ~160px thumbnail for filmstrip and grid to avoid huge image decoding
  rotation: 0 | 90 | 180 | 270;
  quad: ScanQuad | null; // page outline, normalized to the rotated image
  filter: ScanFilterId;
  adj: ScanAdjustments;
  /** Manual clean-up eraser strokes, normalized to the warped page. */
  eraser: ScanEraseStroke[];
}

const QUAD_CORNERS = ['tl', 'tr', 'br', 'bl'] as const;
type QuadCorner = (typeof QUAD_CORNERS)[number];

const QUAD_EDGES = ['top', 'right', 'bottom', 'left'] as const;
type QuadEdge = (typeof QUAD_EDGES)[number];
const EDGE_CORNERS: Record<QuadEdge, [QuadCorner, QuadCorner]> = {
  top: ['tl', 'tr'],
  right: ['tr', 'br'],
  bottom: ['br', 'bl'],
  left: ['bl', 'tl'],
};

type ActiveHandle = QuadCorner | QuadEdge;

const FULL_IMAGE_QUAD: ScanQuad = {
  tl: { x: 0, y: 0 }, tr: { x: 1, y: 0 }, br: { x: 1, y: 1 }, bl: { x: 0, y: 1 },
};

const ADJUSTMENT_CONTROLS: Array<{ key: keyof ScanAdjustments; label: string }> = [
  { key: 'brightness', label: 'Brightness' },
  { key: 'contrast', label: 'Contrast' },
  { key: 'sharpen', label: 'Sharpness' },
  { key: 'saturation', label: 'Saturation' },
];

let pageCounter = 0;
const newPageId = () => `scan_${Date.now().toString(36)}_${++pageCounter}`;

/** True when two outlines are identical point-for-point. */
const sameQuad = (a: ScanQuad, b: ScanQuad): boolean =>
  a.tl.x === b.tl.x && a.tl.y === b.tl.y &&
  a.tr.x === b.tr.x && a.tr.y === b.tr.y &&
  a.br.x === b.br.x && a.br.y === b.br.y &&
  a.bl.x === b.bl.x && a.bl.y === b.bl.y;

/** PDF margins per margin preset, in points (1 pt ≈ 0.353 mm). */
const MARGIN_PT: Record<ScanMargin, number> = {
  none: 0,
  small: 12,
  normal: 24,
};

/**
 * Preview size while the user drags a slider — pixel ops are much cheaper at
 * this size, so adjustments track the finger in real time. Phones get an even
 * smaller one. A full-resolution preview render is debounced in behind it.
 */
const interactiveEdge = () =>
  typeof window !== 'undefined' && window.innerWidth <= 720 ? 540 : 720;
/** How long to wait after the last slider move before the full-quality render. */
const FULL_PREVIEW_DEBOUNCE_MS = 280;
const IMAGE_IMPORT_CONCURRENCY = imageImportConcurrency();


interface CamScannerProps {
  qualityPreset?: ScanQualityPreset;
  customQuality?: number;
  pageSize?: ScanPageSize;
  margin?: ScanMargin;
  autoOrient?: boolean;
  autoCrop?: boolean;
  onChangeAppMode?: (mode: AppMode) => void;
}

/** Stable string key of a quad (or 'none') — used by the preview signature. */
function quadKey(q: ScanQuad | null): string {
  return q
    ? `${q.tl.x.toFixed(4)},${q.tl.y.toFixed(4)},${q.tr.x.toFixed(4)},${q.tr.y.toFixed(4)},${q.br.x.toFixed(4)},${q.br.y.toFixed(4)},${q.bl.x.toFixed(4)},${q.bl.y.toFixed(4)}`
    : 'none';
}

/**
 * Signature of everything the preview bitmap depends on. Used to skip
 * redundant re-renders: rotate() updates the bitmap in place and records the
 * new signature, so the effect sees "already displayed" instead of re-running
 * the whole enhancement pipeline (the quad object it used to key on changes
 * identity on every rotation even though the picture is identical).
 */
function previewSig(page: ScanPage, showRaw: boolean): string {
  const q = showRaw ? null : page.quad;
  const quadPart = quadKey(q);
  const adjPart = `${page.adj.brightness},${page.adj.contrast},${page.adj.sharpen},${page.adj.saturation}`;
  return [
    page.id,
    quadPart,
    page.filter,
    adjPart,
    showRaw ? 'raw' : 'crop',
    String(page.rotation),
    String(page.eraser?.length ?? 0),
  ].join('|');
}

/**
 * Carries a crop outline across a 90° or 180° rotation. Quad coordinates live in
 * the rotated image's space, so every corner position maps into the new
 * orientation — +90° maps (x, y) → (1 − y, x), −90° maps (x, y) → (y, 1 − x),
 * 180° maps (x, y) → (1 − x, 1 − y) — and the corner labels shift so the exported
 * page is the previous crop rotated.
 */
function rotateQuad(quad: ScanQuad, dir: -1 | 1 | 2): ScanQuad {
  if (dir === 2) {
    return {
      tl: { x: 1 - quad.br.x, y: 1 - quad.br.y },
      tr: { x: 1 - quad.bl.x, y: 1 - quad.bl.y },
      br: { x: 1 - quad.tl.x, y: 1 - quad.tl.y },
      bl: { x: 1 - quad.tr.x, y: 1 - quad.tr.y },
    };
  }
  const map = (p: { x: number; y: number }) =>
    dir === 1 ? { x: 1 - p.y, y: p.x } : { x: p.y, y: 1 - p.x };
  const tl = map(quad.tl);
  const tr = map(quad.tr);
  const br = map(quad.br);
  const bl = map(quad.bl);
  if (dir === 1) {
    return { tl: bl, tr: tl, br: tr, bl: br };
  }
  return { tl: tr, tr: br, br: bl, bl: tl };
}

/**
 * Carries eraser strokes across a 90° or 180° rotation with the same point mapping
 * rotateQuad uses for crop corners ((x, y) → (1 − y, x) for +90°, (y, 1 − x)
 * for −90°, (1 − x, 1 − y) for 180°), so erased marks stay glued to their content.
 */
function rotateEraseStrokes(strokes: ScanEraseStroke[], dir: -1 | 1 | 2): ScanEraseStroke[] {
  return strokes.map((s) => ({
    mode: s.mode,
    feather: s.feather,
    pts: s.pts.map((p) => {
      if (dir === 2) {
        return { x: 1 - p.x, y: 1 - p.y, r: p.r, feather: p.feather };
      }
      return dir === 1
        ? { x: 1 - p.y, y: p.x, r: p.r, feather: p.feather }
        : { x: p.y, y: 1 - p.x, r: p.r, feather: p.feather };
    }),
  }));
}

/**
 * Fixes the canvas DISPLAY box from its aspect ratio and the available space.
 * Without this, the element shows at its natural pixel size, so the 720px
 * interactive renders displayed smaller than the 1200px debounced ones — the
 * page visibly "zoomed" in and out during adjustments. With an explicit box,
 * both tiers display identically (the lower-res one is just slightly softer
 * until the full render lands).
 */
function fitCanvasDisplay(canvas: HTMLCanvasElement): void {
  if (canvas.width <= 0 || canvas.height <= 0) return;
  const wrap = canvas.parentElement?.parentElement;
  const wrapW = wrap?.clientWidth ?? 720;
  const wrapH = wrap?.clientHeight ?? 400;
  const pad = wrapW < 500 ? 12 : 20;
  const availW = Math.max(120, wrapW - pad);
  const availH = Math.max(120, wrapH - pad);
  const scale = Math.min(availW / canvas.width, availH / canvas.height);
  canvas.style.width = `${Math.max(1, Math.round(canvas.width * scale))}px`;
  canvas.style.height = `${Math.max(1, Math.round(canvas.height * scale))}px`;
}

function safeFileName(raw: string): string {
  const clean = raw.trim().replace(/[^\w\-. ]+/g, '_').replace(/\s+/g, '_');
  return clean || 'scan';
}

/** Decode an image URL with a throwaway element (never cached). */
const decodeImage = (url: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('decode failed'));
    el.src = url;
  });

/** Compact rename dialog (mobile-friendly entry point via the pencil button). */
function RenameDialog({ initial, onDone, onClose }: {
  initial: string;
  onDone: (name: string) => void;
  onClose: () => void;
}) {
  const ref = useDialog(onClose);
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);

  useEffect(() => { inputRef.current?.select(); }, []);

  const submit = () => {
    onDone(value.trim() || initial);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className="modal-panel sm latex-name-dialog" role="dialog" aria-modal="true" aria-labelledby="scanner-rename-title" tabIndex={-1}>
        <h2 id="scanner-rename-title">Rename document</h2>
        <label>
          Document name
          <input
            ref={inputRef}
            type="text"
            value={value}
            autoFocus
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.nativeEvent.isComposing || e.keyCode === 229) return; if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
          />
        </label>
        <footer>
          <button className="btn quiet" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={submit}>Save</button>
        </footer>
      </div>
    </div>
  );
}

export function CamScanner({ qualityPreset = 'balanced', customQuality = 80, pageSize = 'fit', margin = 'none', autoOrient = true, autoCrop = true, onChangeAppMode }: CamScannerProps) {
  const toast = useToast();
  const autoOrientRef = useRef(autoOrient);
  const autoCropRef = useRef(autoCrop);
  autoOrientRef.current = autoOrient;
  autoCropRef.current = autoCrop;

  const [pages, setPages] = useState<ScanPage[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [docName, setDocName] = useState('scanned-document');
  const [exportFormat, setExportFormat] = useState<ExportFormat>('pdf');
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [compressOpen, setCompressOpen] = useState(false);
  const [compression, setCompression] = useState<CompressionSettings | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress] = useState(() => new StagedProgress());
  const progressStatus = useProgressStatus(progress);
  useEffect(() => () => progress.cancel(), [progress]);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cropMode, setCropMode] = useState(false);
  const [cropDraft, setCropDraftState] = useState<ScanQuad>(FULL_IMAGE_QUAD);
  const cropDraftRef = useRef(cropDraft);
  const cropEditRef = useRef(0);
  const cropManualRef = useRef(false);
  const setCropDraft = useCallback((value: React.SetStateAction<ScanQuad>) => {
    const next = typeof value === 'function' ? value(cropDraftRef.current) : value;
    if (sameQuad(next, cropDraftRef.current)) return;
    cropDraftRef.current = next;
    cropEditRef.current++;
    setCropDraftState(next);
  }, []);
  const cropDragRectRef = useRef<DOMRect | null>(null);
  const snapLockRef = useRef<{
    a: { x: number; y: number };
    b?: { x: number; y: number };
  } | null>(null);
  const snapHapticRef = useRef(false);
  const [activeHandle, setActiveHandle] = useState<ActiveHandle | null>(null);
  const [edgeSnapping, setEdgeSnapping] = useState<boolean>(true);
  const [snappedCorner, setSnappedCorner] = useState<QuadCorner | null>(null);
  const edgeSnapEngineRef = useRef<EdgeSnapEngine | null>(null);
  const [cropDetection, setCropDetection] = useState<DocumentDetectionResult | null>(null);
  const [detectingEdges, setDetectingEdges] = useState(false);
  const [cropSource, setCropSource] = useState<{ url: string; image: HTMLImageElement } | null>(null);
  const [focusedCorner, setFocusedCorner] = useState<QuadCorner | null>(null);
  const detectionRequestRef = useRef(0);
  /** Manual clean-up eraser (Adobe Scan–style brush over the preview). */
  const [eraseMode, setEraseMode] = useState(false);
  /** Erase removes marks; restore paints the pre-eraser pixels back selectively. */
  const [cleanupBrush, setCleanupBrush] = useState<'erase' | 'restore'>('erase');
  /**
   * Brush radius in SCREEN pixels — constant on screen regardless of zoom, so
   * zooming in makes strokes finer in image space (the point of zoom-to-erase).
   */
  const [brushPx, setBrushPx] = useState(24);
  const [brushHardness, setBrushHardness] = useState<number>(0.5);
  const [featherPopoverOpen, setFeatherPopoverOpen] = useState<boolean>(false);
  const brushFeatherPx = useMemo(() => 0.5 + (1 - brushHardness) * 5.0, [brushHardness]);
  /**
   * Erase-mode zoom. Kept in refs and applied as direct canvas style writes so
   * pinch moves never trigger React re-renders; `zoomPct` mirrors the value
   * into state only for the zoom-percentage label (updated on gesture ends and
   * wheel/button events).
   */
  const [zoomPct, setZoomPct] = useState(1);
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  /** Live two-finger pinch gesture (mobile zoom+pan). */
  const pinchRef = useRef<null | {
    baseCx: number;
    baseCy: number;
    dist0: number;
    m0x: number;
    m0y: number;
    t0x: number;
    t0y: number;
    z0: number;
  }>(null);
  /** Desktop pan drag (middle-button or Ctrl/Cmd + drag). */
  const panDragRef = useRef<null | { startX: number; startY: number; t0x: number; t0y: number }>(null);
  /** Active pointers — count decides draw vs pinch. */
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  /** True between a pinch start and the release of ALL fingers (no drawing). */
  const drawBlockedRef = useRef(false);
  /** Copy of the preview bitmap at stroke start — a pinch mid-stroke restores it. */
  const strokeSnapshotRef = useRef<HTMLCanvasElement | null>(null);
  /** Filtered/cropped bitmap before any clean-up strokes; restore brush samples it. */
  const cleanupOriginalRef = useRef<HTMLCanvasElement | null>(null);
  /** Mobile bottom sheet: whether the filters & adjust panel is open. */
  const [sheetOpen, setSheetOpen] = useState(false);
  const [arranging, setArranging] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [editorDragOver, setEditorDragOver] = useState(false);
  const [previewPending, setPreviewPending] = useState(false);
  const [filterThumbs, setFilterThumbs] = useState<Partial<Record<ScanFilterId, string>>>({});
  const lastRearrangedIdRef = useRef<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraFileInputRef = useRef<HTMLInputElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const cropLayerRef = useRef<HTMLDivElement>(null);
  const cropDragRef = useRef<
    | { kind: 'corner'; corner: QuadCorner }
    | {
        kind: 'edge';
        edge: QuadEdge;
        normalX: number;
        normalY: number;
        startX: number;
        startY: number;
        rectW: number;
        rectH: number;
        aStart: { x: number; y: number };
        bStart: { x: number; y: number };
      }
    | null
  >(null);
  const cropSessionRef = useRef(0);
  const cropRafRef = useRef<number | null>(null);
  const pendingCropMoveRef = useRef<{ clientX: number; clientY: number } | null>(null);
  /** Bumped to invalidate in-flight preview renders (rotate() reuses this). */
  const previewTokenRef = useRef(0);
  /** True while the preview canvas holds a completed render for this page. */
  const previewReadyRef = useRef(false);
  /** Signature of the bitmap currently displayed — prevents redundant re-renders. */
  const displayedSigRef = useRef<string | null>(null);
  /** Debounce timer that upgrades interactive renders to full quality. */
  const previewDebounceRef = useRef<number | null>(null);
  /** In-progress eraser stroke; committed to the page on pointer-up. */
  const strokeDraftRef = useRef<ScanEraseStroke | null>(null);
  /** Brush cursor ring over the preview. */
  const eraseRingRef = useRef<HTMLDivElement>(null);
  /** Pointer-capture layer over the preview while erasing. */
  const eraseLayerRef = useRef<HTMLDivElement>(null);

  // Free memory on component unmount
  useEffect(() => {
    return () => {
  cropSessionRef.current++;
  previewTokenRef.current++;
  clearScannerPreviews();
  clearDocumentDetections();
  clearImageCache();
      const canvas = previewCanvasRef.current;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      if (cleanupOriginalRef.current) {
        cleanupOriginalRef.current.width = 0;
        cleanupOriginalRef.current.height = 0;
        cleanupOriginalRef.current = null;
      }
      if (strokeSnapshotRef.current) {
        strokeSnapshotRef.current.width = 0;
        strokeSnapshotRef.current.height = 0;
        strokeSnapshotRef.current = null;
      }
      if (cropRafRef.current !== null) {
        cancelAnimationFrame(cropRafRef.current);
      }
    };
  }, []);

  const activePage = useMemo(
    () => pages.find((p) => p.id === activeId) ?? pages[0] ?? null,
    [pages, activeId]
  );
  /** Always-fresh mirror of activePage for debounced callbacks. */
  const activePageRef = useRef(activePage);
  activePageRef.current = activePage;
  /** Mirror of cropMode for stable callbacks (avoids stale closures). */
  const cropModeRef = useRef(cropMode);
  cropModeRef.current = cropMode;

  /* ------------------------------------------------------------------
     Page management
     ------------------------------------------------------------------ */

  const addPagesBatch = useCallback(
    (
      newPages: Array<{
        dataUrl: string;
        name: string;
        thumbUrl?: string;
        rotation?: ScanPage['rotation'];
        quad?: ScanQuad | null;
        sourceKind?: ScanPage['sourceKind'];
      }>
    ): string[] => {
      if (newPages.length === 0) return [];
      const created: ScanPage[] = newPages.map((item) => ({
        id: newPageId(),
        name: item.name,
        originalUrl: item.dataUrl,
        sourceKind: item.sourceKind ?? 'photo',
        cropRevision: 0,
        thumbUrl: item.thumbUrl,
        rotation: item.rotation ?? 0,
        quad: item.quad ?? null,
        filter: 'superscan', // the flagship scan look, like classic scanner apps
        adj: { ...NEUTRAL_ADJUSTMENTS },
        eraser: [],
      }));
      setPages((prev) => [...prev, ...created]);
      setActiveId((prev) => prev ?? created[0]?.id ?? null);
      return created.map((p) => p.id);
    },
    []
  );

  const addPageFromDataUrl = useCallback(
    (dataUrl: string, name: string, thumbUrl?: string, rotation?: ScanPage['rotation']): string => {
      const [id] = addPagesBatch([{ dataUrl, name, thumbUrl, rotation }]);
      return id;
    },
    [addPagesBatch]
  );

  /**
   * Auto-crops a photo page in the background: detect the page edges and
   * store the quad so every picture comes out pre-cropped like a real
   * scanner app. Never applied to PDF pages (they are already rectangular),
   * and never overwrites a quad the user has set. Detections are SERIALISED
   * with a yield between pages — importing 20 photos stays responsive
   * instead of stacking synchronous detection passes on the main thread.
   */
  const autoCropQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pageDetectionVersionRef = useRef(new Map<string, number>());
  const [autoCropStatus, setAutoCropStatus] = useState<string | null>(null);
  useEffect(() => { warmDocumentDetection(); }, []);
  const autoCropPage = useCallback((
    pageId: string,
    url: string,
    knownRotation: ScanPage['rotation'] = 0,
    sourceKind: ScanPage['sourceKind'] = 'photo'
  ): Promise<boolean> => {
    if (!autoCropRef.current) return Promise.resolve(false);
    const version = pageDetectionVersionRef.current.get(pageId) ?? 0;
    const job = autoCropQueueRef.current.then(async (): Promise<boolean> => {
      try {
        const result = await detectDocumentCached(url, knownRotation);
        if ((pageDetectionVersionRef.current.get(pageId) ?? 0) !== version) return false;
        const quad = automaticDocumentQuad(result, sourceKind, true);
        if (!quad) return false;
        setPages((prev) => prev.map((p) => {
          if (p.id !== pageId || p.quad || p.cropRevision > 0 || p.originalUrl !== url || p.rotation !== knownRotation ||
            (cropModeRef.current && activePageRef.current?.id === pageId)) return p;
          return { ...p, quad };
        }));
        return true;
      } catch {
        // detection is best-effort; the crop editor stays available
        return false;
      }
    });
    autoCropQueueRef.current = job.then(() => undefined);
    return job;
  }, []);

  /** Queues detection for a freshly imported batch and tells the user what happened. */
  const autoCropBatch = useCallback(async (
    jobs: Array<{ id: string; url: string; rotation: ScanPage['rotation']; sourceKind: ScanPage['sourceKind'] }>
  ) => {
    if (jobs.length === 0 || !autoCropRef.current) return;
    let done = 0;
    setAutoCropStatus(`Detecting page edges 0/${jobs.length}…`);
    const outcomes = await Promise.all(jobs.map(async (job) => {
      const ok = await autoCropPage(job.id, job.url, job.rotation, job.sourceKind);
      done++;
      setAutoCropStatus(done < jobs.length ? `Detecting page edges ${done}/${jobs.length}…` : null);
      return ok;
    }));
    const cropped = outcomes.filter(Boolean).length;
    // Digital PDF pages usually have no paper edge to find, so a miss there is not worth a message.
    if (cropped === 0 && jobs.every((job) => job.sourceKind === 'pdf')) return;
    if (cropped === jobs.length) {
      toast.success(jobs.length === 1 ? 'Page auto-cropped. Tap Crop to fine-tune.' : `Auto-cropped all ${jobs.length} pages. Tap Crop to fine-tune.`);
    } else if (cropped > 0) {
      toast.info(`Auto-cropped ${cropped} of ${jobs.length} pages. Open Crop on the others to set edges.`);
    } else {
      toast.info('No clear page edges found. Open Crop and use Detect or drag the corners.');
    }
  }, [autoCropPage, toast]);

  const importPdfPages = useCallback(
    async (
      file: File,
      onSlice?: (from: number, to: number, message: string) => void
    ): Promise<number> => {
      setBusy('Loading PDF…');
      // Opening the document takes the first 8% of this file's share; the pages split the rest.
      const LOAD_SHARE = 0.08;
      const pageSlice = (index: number, total: number) =>
        [
          LOAD_SHARE + (index / total) * (1 - LOAD_SHARE),
          LOAD_SHARE + ((index + 1) / total) * (1 - LOAD_SHARE),
        ] as const;
      try {
        onSlice?.(0, LOAD_SHARE, `Opening ${file.name}…`);
        const data = new Uint8Array(await file.arrayBuffer());
        const base = file.name.replace(/\.pdf$/i, '');
        const batch: Array<{
          dataUrl: string;
          name: string;
          thumbUrl?: string;
          rotation?: ScanPage['rotation'];
        }> = [];
        await streamRenderPdfPages(data, {
          scale: isLowPowerDevice() ? 1.5 : 2.0, // crisp, but sized to the device's memory
          quality: 0.88,
          generateThumbnail: true,
          thumbnailMaxEdge: 160,
          onProgress: (curr, total) => {
            setBusy(`Rendering PDF page ${curr} of ${total}…`);
            const [from, to] = pageSlice(curr - 1, Math.max(1, total));
            onSlice?.(from, to, `Processing PDF page ${curr} of ${total}…`);
          },
          onPage: async (p, thumbUrl) => {
            let finalDataUrl = p.dataUrl;
            let finalThumb = thumbUrl;
            if (autoOrientRef.current) try {
              const pImg = await decodeImage(p.dataUrl);
              const fixRes = await autoFixImageOrientation(pImg, 0.88);
              if (fixRes.wasRotated) {
                finalDataUrl = fixRes.dataUrl;
                const tScale = Math.min(1, 160 / Math.max(fixRes.width, fixRes.height));
                const tc = document.createElement('canvas');
                tc.width = Math.max(1, Math.round(fixRes.width * tScale));
                tc.height = Math.max(1, Math.round(fixRes.height * tScale));
                const tctx = tc.getContext('2d', { alpha: false });
                if (tctx) {
                  const fixedSource = fixRes.canvas ?? (await decodeImage(fixRes.dataUrl));
                  tctx.drawImage(fixedSource, 0, 0, tc.width, tc.height);
                  finalThumb = tc.toDataURL('image/jpeg', 0.7);
                }
                tc.width = 0;
                tc.height = 0;
              }
            } catch {}

            batch.push({
              dataUrl: finalDataUrl,
              name: `${base} p${p.pageNumber}`,
              thumbUrl: finalThumb,
              rotation: 0,
            });
            await yieldToPaint();
          },
        });
        if (batch.length > 0) {
          const ids = addPagesBatch(batch.map(page => ({ ...page, sourceKind: 'pdf' as const })));
          toast.success(`Imported ${batch.length} PDF page${batch.length === 1 ? '' : 's'}.`);
          await autoCropBatch(
            batch.flatMap((page, index) =>
              ids[index] ? [{ id: ids[index], url: page.dataUrl, rotation: page.rotation ?? 0, sourceKind: 'pdf' as const }] : []
            )
          );
        } else {
          toast.error('No pages could be rendered from this PDF.');
        }
        return batch.length;
      } catch (err: any) {
        console.error('PDF import failed:', err);
        toast.error(`Could not read PDF: ${err?.message || 'Unknown error'}`);
        return 0;
      } finally {
        setBusy(null);
      }
    },
    [addPagesBatch, autoCropBatch, toast]
  );

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      const pdfs = list.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
      const images = list.filter((f) => /^image\//.test(f.type));
      if (pdfs.length === 0 && images.length === 0) {
        toast.error('Please choose image files or a PDF.');
        return;
      }
      // Each file gets an equal share of 2–95%. The last 5% covers adding the
      // pages and opening the editor, so 100% means "ready to edit".
      const totalUnits = pdfs.length + images.length;
      const unitPct = (units: number) => 2 + (units / totalUnits) * 93;
      let imported = 0;
      progress.start('import', `Preparing ${totalUnits} file${totalUnits === 1 ? '' : 's'}…`);
      progress.stage(0, 2);
      await yieldToPaint();

      for (let pi = 0; pi < pdfs.length; pi++) {
        const pdf = pdfs[pi];
        const suffix = pdfs.length > 1 ? ` (file ${pi + 1} of ${pdfs.length})` : '';
        imported += await importPdfPages(pdf, (from, to, msg) =>
          progress.stage(unitPct(pi + from), unitPct(pi + to), msg + suffix)
        );
        progress.stage(unitPct(pi + 1), unitPct(pi + 1), `Loaded ${pdf.name}`);
      }
      if (images.length > 0) {
        const imageBase = pdfs.length;
        let imagesDone = 0;
        progress.stage(
          unitPct(imageBase),
          unitPct(imageBase + Math.min(images.length, IMAGE_IMPORT_CONCURRENCY)),
          `Analyzing ${images.length} picture${images.length === 1 ? '' : 's'}…`
        );
        await yieldToPaint();
        setBusy(
          images.length > 1
            ? `Analyzing & orienting ${images.length} pictures in parallel…`
            : 'Checking page orientation…'
        );
        const batch: Array<{
          dataUrl: string;
          name: string;
          thumbUrl?: string;
          rotation?: ScanPage['rotation'];
          quad: ScanQuad | null;
        }> = [];
        let failedCount = 0;
        let autoCorrectedCount = 0;

        const processImage = async (file: File) => {
            const url = URL.createObjectURL(file);
            try {
              const [img, fileBytes] = await Promise.all([
                decodeImage(url),
                file.arrayBuffer().catch(() => undefined),
              ]);

              let quad: ScanQuad | null = null;
              if (autoCropRef.current) try {
                const detection = await detectDocumentCached(url, 0);
                quad = automaticDocumentQuad(detection, 'photo', true);
              } catch {
                // A detection failure must not discard a readable photo.
              }
              const fixRes = await autoFixImageOrientation(img, 0.92, fileBytes, importMaxEdge(), quad, autoOrientRef.current);
              const wasFixed = fixRes.wasRotated || fixRes.wasFlipped;
              if (quad && fixRes.appliedDelta !== 0) {
                quad = rotateQuad(quad, fixRes.appliedDelta === 90 ? 1 : fixRes.appliedDelta === 180 ? 2 : -1);
              }

              let thumbUrl: string | undefined;
              try {
                const tScale = Math.min(1, 160 / Math.max(fixRes.width, fixRes.height));
                const tc = document.createElement('canvas');
                tc.width = Math.max(1, Math.round(fixRes.width * tScale));
                tc.height = Math.max(1, Math.round(fixRes.height * tScale));
                const tctx = tc.getContext('2d', { alpha: false });
                if (tctx) {
                  const drawSource = fixRes.canvas || img;
                  tctx.drawImage(drawSource, 0, 0, tc.width, tc.height);
                  thumbUrl = tc.toDataURL('image/jpeg', 0.7);
                }
                tc.width = 0;
                tc.height = 0;
              } catch {}

              return {
                ok: true,
                wasFixed,
                item: {
                  dataUrl: fixRes.dataUrl,
                  name: file.name.replace(/\.[^.]+$/, ''),
                  thumbUrl,
                  quad,
                  rotation: 0 as ScanPage['rotation'],
                },
              };
            } catch {
              return { ok: false, wasFixed: false, item: null };
            } finally {
              releaseDocumentDetection(url);
              URL.revokeObjectURL(url);
            }
        };

        // A small worker pool, not one Promise.all over every file: all the
        // pictures finishing together made the bar sit still and then jump.
        // Doing a couple at a time lets each finished picture move the bar.
        const results: Array<Awaited<ReturnType<typeof processImage>>> = new Array(images.length);
        let nextIndex = 0;
        const worker = async () => {
          while (nextIndex < images.length) {
            const idx = nextIndex++;
            results[idx] = await processImage(images[idx]);
            imagesDone++;
            progress.stage(
              unitPct(imageBase + imagesDone),
              unitPct(imageBase + Math.min(images.length, imagesDone + IMAGE_IMPORT_CONCURRENCY)),
              `Processed picture ${imagesDone} of ${images.length}`
            );
            await yieldToPaint();
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(IMAGE_IMPORT_CONCURRENCY, images.length) }, worker)
        );

        for (const res of results) {
          if (res.ok && res.item) {
            batch.push(res.item);
            if (res.wasFixed) autoCorrectedCount++;
          } else {
            failedCount++;
          }
        }

        if (batch.length > 0) {
          progress.stage(95, 99, 'Opening editor…');
          await yieldToPaint();
          // Atomically commit all uploaded images to state in a single batch
          addPagesBatch(batch);
          imported += batch.length;
          if (autoCorrectedCount > 0) {
            toast.success(
              batch.length === 1
                ? `Added ${batch[0].name} (auto-aligned to 0° upright).`
                : `Added ${batch.length} pictures (${autoCorrectedCount} auto-aligned to 0°).`
            );
          } else {
            toast.success(
              batch.length === 1
                ? `Added ${batch[0].name}.`
                : `Added all ${batch.length} pictures.`
            );
          }
          const cropped = batch.filter((item) => item.quad !== null).length;
          if (autoCropRef.current && cropped > 0) {
            toast.success(`Auto-cropped ${cropped} of ${batch.length} pictures. Tap Crop to fine-tune.`);
          }
          if (autoCropRef.current && cropped < batch.length) {
            toast.info(`${batch.length - cropped} picture(s) need crop review — no clear page boundary found.`);
          }
        }
        if (failedCount > 0) {
          toast.error(`Could not read ${failedCount} file${failedCount === 1 ? '' : 's'}.`);
        }
        setBusy(null);
      }

      if (imported > 0) {
        // Let the editor mount before claiming 100%.
        await yieldToPaint();
        progress.finish(`${imported} page${imported === 1 ? '' : 's'} ready to edit`, 1200);
      } else {
        progress.cancel();
      }
    },
    [addPagesBatch, autoCropBatch, importPdfPages, progress, toast]
  );

  const updateActivePage = (patch: Partial<ScanPage>) => {
    if (!activePage) return;
    if (patch.originalUrl && patch.originalUrl !== activePage.originalUrl) {
      releaseDocumentDetection(activePage.originalUrl);
      cropSessionRef.current++;
      edgeSnapEngineRef.current = null;
    }
    setPages((prev) => prev.map((p) => (p.id === activePage.id ? { ...p, ...patch } : p)));
  };

  const deletePage = (id: string) => {
    const idx = pages.findIndex((p) => p.id === id);
    if (idx < 0) return;
    releaseDocumentDetection(pages[idx].originalUrl);
    if (activePage?.id === id) { cropSessionRef.current++; edgeSnapEngineRef.current = null; }
    const next = pages.filter((p) => p.id !== id);
    setPages(next);
    if (activeId === id) setActiveId(next[Math.min(idx, next.length - 1)]?.id ?? null);
    if (next.length === 0) {
      setCropMode(false);
      setArranging(false);
      setEraseMode(false);
      strokeDraftRef.current = null;
    }
  };

  /** Reorders pages by index (drag & drop in the rearrange mode). */
  const movePageTo = (from: number, to: number) => {
    setPages((prev) => {
      if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const movePage = (id: string, dir: -1 | 1) => {
    setPages((prev) => {
      const idx = prev.findIndex((p) => p.id === id);
      const target = idx + dir;
      if (idx < 0 || target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  };

  const applyFilterToAll = () => {
    if (!activePage) return;
    setPages((prev) =>
      prev.map((p) => ({ ...p, filter: activePage.filter, adj: { ...activePage.adj } }))
    );
    toast.success(`Applied “${SCAN_FILTERS.find((f) => f.id === activePage.filter)?.label}” to all pages.`);
  };

  const applyAdjustToAll = () => {
    if (!activePage) return;
    setPages((prev) => prev.map((p) => ({ ...p, adj: { ...activePage.adj } })));
    toast.success('Adjustments applied to all pages.');
  };

  /* ------------------------------------------------------------------
     Manual clean-up eraser (Adobe Scan–style nearest-color brush).
     Independent of filters/adjustments: strokes are applied to the FINAL
     rendered image, after the filter and tone pipeline, so those behave
     exactly as before whether or not marks are erased.
     ------------------------------------------------------------------ */

  /** Per-page redo stacks for stroke-level undo/redo. */
  const eraseRedoRef = useRef<Map<string, ScanEraseStroke[]>>(new Map());

  const enterEraseMode = () => {
    if (!activePage) return;
    setSheetOpen(false);
    setCropMode(false);
    if (activePage.eraser.length === 0) setCleanupBrush('erase');
    resetZoomTransform();
    setEraseMode(true);
  };

  const exitEraseMode = () => {
    strokeDraftRef.current = null;
    strokeSnapshotRef.current = null;
    pinchRef.current = null;
    panDragRef.current = null;
    pointersRef.current.clear();
    drawBlockedRef.current = false;
    resetZoomTransform();
    setEraseMode(false);
  };

  const commitEraseStroke = (stroke: ScanEraseStroke) => {
    const page = activePageRef.current;
    if (!page) return;
    eraseRedoRef.current.set(page.id, []); // new work invalidates redo
    updateActivePage({ eraser: [...page.eraser, stroke] });
  };

  const undoErase = () => {
    const page = activePageRef.current;
    if (!page || page.eraser.length === 0) return;
    const stack = eraseRedoRef.current.get(page.id) ?? [];
    eraseRedoRef.current.set(page.id, [...stack, page.eraser[page.eraser.length - 1]]);
    updateActivePage({ eraser: page.eraser.slice(0, -1) });
  };

  const redoErase = () => {
    const page = activePageRef.current;
    if (!page) return;
    const stack = eraseRedoRef.current.get(page.id) ?? [];
    if (stack.length === 0) return;
    const restore = stack[stack.length - 1];
    eraseRedoRef.current.set(page.id, stack.slice(0, -1));
    updateActivePage({ eraser: [...page.eraser, restore] });
  };

  const clearErase = () => {
    const page = activePageRef.current;
    if (!page || page.eraser.length === 0) return;
    eraseRedoRef.current.set(page.id, []);
    setCleanupBrush('erase');
    updateActivePage({ eraser: [] });
    toast.success('All clean-up marks cleared on this page.');
  };

  /**
   * Persists a crop change. Eraser strokes are normalized to the warped page,
   * so a new crop re-maps the content under them — they are reset (with a
   * notice) rather than left erasing the wrong spots.
   */
  const commitQuadChange = (quad: ScanQuad) => {
    if (!activePage) return;
    const hadStrokes = activePage.eraser.length > 0;
    updateActivePage({ quad, cropRevision: activePage.cropRevision + 1, eraser: hadStrokes ? [] : activePage.eraser });
    if (hadStrokes) {
      eraseRedoRef.current.delete(activePage.id);
      toast.success('Crop updated — eraser marks were reset because the page geometry changed.');
    }
  };

  /* ------------------------------------------------------------------
     Eraser drawing: pointer → normalized stroke → live nearest-color fill.
     Zoom/pan live here too: one finger draws, two fingers pinch-zoom and pan
     (touch); wheel zooms at the cursor and Ctrl/middle-drag pans (desktop).
     ------------------------------------------------------------------ */

  /**
   * Canvas-space pointer position, normalized 0–1, or null when off-canvas.
   * Normalizing against the TRANSFORMED rect is invariant under the zoom
   * translate+scale, so coordinates stay correct at any zoom/pan.
   */
  const erasePointerPos = (e: React.PointerEvent): { x: number; y: number } | null => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  };

  /**
   * Brush radius in normalized image space: the screen-size brush divided by
   * the zoomed display size. A constant on-screen brush therefore erases a
   * smaller image area as you zoom in — finer strokes where it matters.
   */
  const brushNorm = (): number => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return 0.02;
    const rect = canvas.getBoundingClientRect();
    const minDisp = Math.min(rect.width, rect.height);
    return Math.max(0.002, brushPx / Math.max(1, minDisp));
  };

  /** Positions/sizes the brush cursor ring (direct style writes — no re-render). */
  const moveEraseRing = (e: React.PointerEvent) => {
    const ring = eraseRingRef.current;
    const layer = eraseLayerRef.current;
    if (!ring || !layer) return;
    const layerRect = layer.getBoundingClientRect();
    ring.style.width = `${brushPx * 2}px`;
    ring.style.height = `${brushPx * 2}px`;
    ring.style.left = `${e.clientX - layerRect.left}px`;
    ring.style.top = `${e.clientY - layerRect.top}px`;
    ring.dataset.mode = cleanupBrush;
    ring.style.opacity = '1';
  };

  /** Copies the preview bitmap so a pinch mid-stroke can undo the live dabs. */
  const snapshotCanvas = () => {
    const canvas = previewCanvasRef.current;
    if (!canvas || canvas.width === 0 || canvas.height === 0) return;
    const snap = document.createElement('canvas');
    snap.width = canvas.width;
    snap.height = canvas.height;
    snap.getContext('2d')?.drawImage(canvas, 0, 0);
    strokeSnapshotRef.current = snap;
  };

  /** Discards the in-progress stroke and restores the pre-stroke bitmap. */
  const cancelInProgressStroke = () => {
    strokeDraftRef.current = null;
    const snap = strokeSnapshotRef.current;
    strokeSnapshotRef.current = null;
    const canvas = previewCanvasRef.current;
    if (snap && canvas) canvas.getContext('2d')?.drawImage(snap, 0, 0);
    snap.width = 0;
    snap.height = 0;
  };

  /* ---------------- Zoom engine (refs + direct style writes) ---------------- */

  const clampPan = () => {
    const canvas = previewCanvasRef.current;
    const frame = canvas?.parentElement;
    if (!canvas || !frame) return;
    const z = zoomRef.current;
    // clientWidth/Height are layout sizes — unaffected by the transform.
    const maxX = Math.max(0, (canvas.clientWidth * z - frame.clientWidth) / 2);
    const maxY = Math.max(0, (canvas.clientHeight * z - frame.clientHeight) / 2);
    panRef.current.x = Math.max(-maxX, Math.min(maxX, panRef.current.x));
    panRef.current.y = Math.max(-maxY, Math.min(maxY, panRef.current.y));
  };

  const applyZoomTransform = () => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    const { x, y } = panRef.current;
    canvas.style.transformOrigin = 'center center';
    canvas.style.transform =
      zoomRef.current === 1 && x === 0 && y === 0
        ? ''
        : `translate(${x}px, ${y}px) scale(${zoomRef.current})`;
  };

  /**
   * Zooms to `zNext` keeping the image point under the given client position
   * anchored (cursor-centered wheel zoom; the midpoint for pinch). With the
   * transform origin at the canvas center, screen = base + pan + z·q, so the
   * pan that re-anchors q is pan' = m − q·z.
   */
  const zoomAtPoint = (clientX: number, clientY: number, zNext: number) => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    const z0 = zoomRef.current;
    const z = Math.max(1, Math.min(8, zNext));
    const rect = canvas.getBoundingClientRect();
    const baseCx = rect.left + rect.width / 2 - panRef.current.x;
    const baseCy = rect.top + rect.height / 2 - panRef.current.y;
    const qx = (clientX - baseCx - panRef.current.x) / z0;
    const qy = (clientY - baseCy - panRef.current.y) / z0;
    zoomRef.current = z;
    panRef.current.x = z === 1 ? 0 : clientX - baseCx - qx * z;
    panRef.current.y = z === 1 ? 0 : clientY - baseCy - qy * z;
    clampPan();
    applyZoomTransform();
    setZoomPct(z);
  };

  /** Button zoom, anchored at the center of the visible page. */
  const zoomStep = (factor: number) => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    zoomAtPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, zoomRef.current * factor);
  };

  const resetZoomTransform = () => {
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
    pinchRef.current = null;
    panDragRef.current = null;
    setZoomPct(1);
    applyZoomTransform();
  };

  useEffect(() => {
    // Low-power devices load the model on first use instead of competing with the camera/import.
    if (isLowPowerDevice()) return;
    const idle = window.requestIdleCallback?.bind(window);
    if (idle) {
      const id = idle(() => warmUpOrientationModel(), { timeout: 4000 });
      return () => window.cancelIdleCallback(id);
    }
    const t = window.setTimeout(warmUpOrientationModel, 2000);
    return () => window.clearTimeout(t);
  }, []);

  // Wheel zoom (desktop) — needs a non-passive listener to stop page scroll.
  useEffect(() => {
    if (!eraseMode) return;
    const layer = eraseLayerRef.current;
    if (!layer) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAtPoint(e.clientX, e.clientY, zoomRef.current * Math.exp(-e.deltaY * 0.0015));
    };
    layer.addEventListener('wheel', onWheel, { passive: false });
    return () => layer.removeEventListener('wheel', onWheel);
    // zoomAtPoint reads only refs + brush state via closure; stable in practice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eraseMode]);

  // Keyboard undo/redo while erasing, for devices with a keyboard:
  // Ctrl/Cmd+Z (or Ctrl/Cmd+Shift+Z) and Ctrl/Cmd+Y.
  useEffect(() => {
    if (!eraseMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'z') {
        e.preventDefault();
        undoErase();
      } else if (key === 'y') {
        e.preventDefault();
        redoErase();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eraseMode]);

  useEffect(() => () => {
    const original = cleanupOriginalRef.current;
    if (original) {
      original.width = 0;
      original.height = 0;
      cleanupOriginalRef.current = null;
    }
  }, []);

  // Reset clean-up brush mode to erase whenever the active page changes.
  useEffect(() => {
    setCleanupBrush('erase');
  }, [activeId]);

  // Leaving erase mode (Done, Escape, page switch, crop, empty-page delete)
  // always clears the zoom so the transform can never leak into other modes.
  useEffect(() => {
    if (eraseMode) return;
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
    pinchRef.current = null;
    panDragRef.current = null;
    drawBlockedRef.current = false;
    strokeDraftRef.current = null;
    strokeSnapshotRef.current = null;
    pointersRef.current.clear();
    setZoomPct(1);
    const canvas = previewCanvasRef.current;
    if (canvas) canvas.style.transform = '';
  }, [eraseMode]);

  const onErasePointerDown = (e: React.PointerEvent) => {
    if (!eraseMode) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);

    // Second finger while drawing → scrap the partial stroke, start the pinch.
    if (pointersRef.current.size === 2) {
      cancelInProgressStroke();
      const canvas = previewCanvasRef.current;
      const [a, b] = [...pointersRef.current.values()];
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      pinchRef.current = {
        baseCx: rect.left + rect.width / 2 - panRef.current.x,
        baseCy: rect.top + rect.height / 2 - panRef.current.y,
        dist0: Math.hypot(a.x - b.x, a.y - b.y),
        m0x: (a.x + b.x) / 2 - (rect.left + rect.width / 2 - panRef.current.x),
        m0y: (a.y + b.y) / 2 - (rect.top + rect.height / 2 - panRef.current.y),
        t0x: panRef.current.x,
        t0y: panRef.current.y,
        z0: zoomRef.current,
      };
      drawBlockedRef.current = true;
      const ring = eraseRingRef.current;
      if (ring) ring.style.opacity = '0';
      return;
    }
    if (pointersRef.current.size > 2 || drawBlockedRef.current) return;

    // Desktop pan: middle-button drag or Ctrl/Cmd + drag.
    if (e.button === 1 || ((e.ctrlKey || e.metaKey) && e.button === 0)) {
      e.preventDefault();
      panDragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        t0x: panRef.current.x,
        t0y: panRef.current.y,
      };
      return;
    }
    if (e.button !== 0) return;
    const pos = erasePointerPos(e);
    if (!pos) return;
    moveEraseRing(e);
    const r = brushNorm();
    const feather = brushFeatherPx;
    const stroke: ScanEraseStroke = { mode: cleanupBrush, feather, pts: [{ x: pos.x, y: pos.y, r, feather }] };
    strokeDraftRef.current = stroke;
    snapshotCanvas();
    // Instant feedback: apply the selected clean-up brush to the displayed bitmap.
    const canvas = previewCanvasRef.current;
    if (canvas) applyEraseStrokes(canvas, [stroke], cleanupOriginalRef.current);
  };

  const onErasePointerMove = (e: React.PointerEvent) => {
    if (!eraseMode) return;
    if (pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    // Pinch zoom + pan: the midpoint keeps its image anchor, the distance
    // ratio drives the scale, both recomputed from live finger positions.
    if (pinchRef.current && pointersRef.current.size >= 2) {
      const p = pinchRef.current;
      const [a, b] = [...pointersRef.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const z = Math.max(1, Math.min(8, p.z0 * (dist / Math.max(1, p.dist0))));
      zoomRef.current = z;
      panRef.current.x = (a.x + b.x) / 2 - p.baseCx - (p.m0x - p.t0x) * (z / p.z0);
      panRef.current.y = (a.y + b.y) / 2 - p.baseCy - (p.m0y - p.t0y) * (z / p.z0);
      clampPan();
      applyZoomTransform();
      return;
    }

    if (panDragRef.current) {
      panRef.current.x = panDragRef.current.t0x + (e.clientX - panDragRef.current.startX);
      panRef.current.y = panDragRef.current.t0y + (e.clientY - panDragRef.current.startY);
      clampPan();
      applyZoomTransform();
      return;
    }

    moveEraseRing(e);
    const stroke = strokeDraftRef.current;
    if (!stroke) return;
    const pos = erasePointerPos(e);
    if (!pos) return;
    const last = stroke.pts[stroke.pts.length - 1];
    const minGap = brushNorm() * 0.35; // overlapping dabs → a continuous stroke
    if (Math.hypot(pos.x - last.x, pos.y - last.y) < minGap) return;
    const dab: ScanEraseStroke = { mode: stroke.mode, feather: stroke.feather, pts: [{ x: pos.x, y: pos.y, r: brushNorm(), feather: stroke.feather }] };
    stroke.pts.push(dab.pts[0]);
    const canvas = previewCanvasRef.current;
    if (canvas) applyEraseStrokes(canvas, [dab], cleanupOriginalRef.current);
  };

  const onErasePointerUp = (e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) {
      if (pinchRef.current) setZoomPct(zoomRef.current); // sync label on gesture end
      pinchRef.current = null;
    }
    if (pointersRef.current.size === 0) drawBlockedRef.current = false;
    panDragRef.current = null;

    const stroke = strokeDraftRef.current;
    strokeDraftRef.current = null;
    strokeSnapshotRef.current = null;
    if (!stroke || stroke.pts.length === 0) return;
    commitEraseStroke(stroke);
  };

  const onErasePointerLeave = () => {
    const ring = eraseRingRef.current;
    if (ring) ring.style.opacity = '0';
  };

  /* ------------------------------------------------------------------
     Camera
     ------------------------------------------------------------------ */

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraActive(false);
  }, []);

  const startCamera = async () => {
    setCameraError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('This browser does not support camera capture. Upload images or a PDF instead.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1440 } },
        audio: false,
      });
      streamRef.current = stream;
      setCameraActive(true);
    } catch (err: any) {
      const name = err?.name || '';
      setCameraError(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Camera access was blocked. Allow camera permission, or upload images instead.'
          : name === 'NotFoundError' || name === 'OverconstrainedError'
            ? 'No usable camera was found. Upload images instead.'
            : 'Camera could not be started. Upload images instead.'
      );
    }
  };

  useEffect(() => {
    if (!cameraActive) return;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return;
    video.srcObject = stream;
    const playAttempt = video.play();
    if (playAttempt) playAttempt.catch(() => {/* autoplay guard — user can tap */ });
    return () => {
      video.srcObject = null;
    };
  }, [cameraActive]);

  useEffect(() => stopCamera, [stopCamera]);

  const captureFrame = async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    try {
      const rawDataUrl = await captureCanvasToDataUrl(video, video.videoWidth, video.videoHeight, importMaxEdge());
      const img = await decodeImage(rawDataUrl);
      const fixRes = await autoFixImageOrientation(img, 0.92, undefined, undefined, null, autoOrientRef.current);
      const pageId = addPageFromDataUrl(fixRes.dataUrl, `Scan ${pages.length + 1}`);
      void autoCropPage(pageId, fixRes.dataUrl, 0);
      toast.success(
        fixRes.wasRotated
          ? `Page ${pages.length + 1} captured & auto-aligned to 0° upright.`
          : `Page ${pages.length + 1} captured.`
      );
    } catch {
      toast.error('Capture failed — try again.');
    }
  };

  /* ------------------------------------------------------------------
     Filter thumbnails (live previews, like the reference popup)
     ------------------------------------------------------------------ */

  const thumbsPageRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const page = activePage;
    if (!page || cropMode) return;
    // Clear the tiles only when switching pages — for filter/quad/rotation
    // tweaks the previous thumbs stay visible and refresh in place instead
    // of flickering through spinners.
    if (thumbsPageRef.current !== page.id) {
      thumbsPageRef.current = page.id;
      setFilterThumbs({});
    }
    (async () => {
      try {
        const thumbs = await renderFilterThumbnailsFast(
          page.originalUrl,
          { rotation: page.rotation, quad: page.quad },
          THUMB_MAX_EDGE
        );
        if (!cancelled) {
          setFilterThumbs(thumbs);
        }
      } catch {
        // best-effort thumbnails
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activePage?.id, activePage?.originalUrl, activePage?.rotation, activePage?.quad, cropMode]);

  /* ------------------------------------------------------------------
     Preview rendering
     ------------------------------------------------------------------ */

  // In crop mode the preview shows the rotated page WITHOUT the warp so the
  // outline can be adjusted against the raw capture; otherwise the fully
  // processed page renders. Rotation is NOT a trigger: rotate() updates the
  // displayed bitmap synchronously, which is exact (see rotate below).
  const renderPreview = useCallback(async (page: ScanPage, showRaw: boolean, sig: string, maxEdge = PREVIEW_MAX_EDGE) => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    const token = ++previewTokenRef.current;
    setPreviewPending(true);
    try {
      const rendered = await renderScanPreviewCanvas(
        page.originalUrl,
        {
          rotation: page.rotation,
          quad: showRaw ? null : page.quad,
          filter: page.filter,
          adj: page.adj,
          // Clean-up strokes are applied below after preserving this pristine
          // filtered/cropped bitmap for the selective restore brush.
          eraserStrokes: null,
        },
        maxEdge,
        () => previewTokenRef.current === token && previewCanvasRef.current === canvas
      );
      if (!rendered) return;
      let cleanupOriginal: HTMLCanvasElement | null = null;
      if (!showRaw) {
        cleanupOriginal = document.createElement('canvas');
        cleanupOriginal.width = rendered.width;
        cleanupOriginal.height = rendered.height;
        cleanupOriginal.getContext('2d', { alpha: false })?.drawImage(rendered, 0, 0);
        if (page.eraser.length > 0) applyEraseStrokes(rendered, page.eraser, cleanupOriginal);
      }
      // Invalidated by a newer render or a rotate() (which already updated
      // the displayed bitmap) — discard without touching the canvas.
      if (!previewCanvasRef.current || previewTokenRef.current !== token) {
        rendered.width = 0;
        rendered.height = 0;
        if (cleanupOriginal) {
          cleanupOriginal.width = 0;
          cleanupOriginal.height = 0;
        }
        return;
      }
      canvas.width = rendered.width;
      canvas.height = rendered.height;
      canvas.getContext('2d', { alpha: false })?.drawImage(rendered, 0, 0);
      rendered.width = 0;
      rendered.height = 0;
      const previousOriginal = cleanupOriginalRef.current;
      cleanupOriginalRef.current = cleanupOriginal;
      if (previousOriginal && previousOriginal !== cleanupOriginal) {
        previousOriginal.width = 0;
        previousOriginal.height = 0;
      }
      fitCanvasDisplay(canvas);
      // Marks THIS element as holding a render — the marker lives (and dies)
      // with the DOM node, so a remounted canvas always re-renders.
      canvas.dataset.scannerReady = '1';
      displayedSigRef.current = sig;
      previewReadyRef.current = true;
      setPreviewPending(false);
    } catch {
      if (previewTokenRef.current === token) {
        setPreviewPending(false);
        toast.error('Preview failed for this page.');
      }
    }
    // toast is stable in practice; including it would re-render previews needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAdjust = useCallback((key: keyof ScanAdjustments, value: number) => {
    const page = activePageRef.current;
    if (!page) return;
    setPages(prev => prev.map(p => p.id === page.id ? { ...p, adj: { ...p.adj, [key]: value } } : p));
  }, []);

  useEffect(() => {
    if (!activePage || cameraActive || arranging) return;
    const sig = previewSig(activePage, cropMode);
    // rotate() already put the exact bitmap for this state on the canvas —
    // don't re-run the whole enhancement pipeline for it.
    // The dataset marker dies with the DOM node, so a REMOUNTED canvas
    // (camera/arrange round-trips) always re-renders instead of staying blank.
    if (
      sig === displayedSigRef.current &&
      previewReadyRef.current &&
      previewCanvasRef.current?.dataset.scannerReady === '1'
    ) {
      setPreviewPending(false);
      return;
    }
    previewReadyRef.current = previewCanvasRef.current?.dataset.scannerReady === '1';
    let cancelled = false;
    void renderPreview(activePage, cropMode, sig, interactiveEdge()).then(() => {
      if (cancelled) return;
      previewDebounceRef.current = window.setTimeout(() => {
        void renderPreview(activePage, cropMode, sig);
      }, FULL_PREVIEW_DEBOUNCE_MS);
    });
    return () => {
      cancelled = true;
      if (previewDebounceRef.current) window.clearTimeout(previewDebounceRef.current);
      previewDebounceRef.current = null;
      previewTokenRef.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activePage?.id,
    activePage?.originalUrl,
    activePage?.rotation,
    activePage?.quad,
    activePage?.filter,
    activePage?.adj,
    activePage?.eraser.length,
    cropMode,
    cameraActive,
    arranging,
    renderPreview,
  ]);

  /* ------------------------------------------------------------------
     Perspective crop editor
     ------------------------------------------------------------------ */

  /**
   * Loads the page bitmap and builds the interactive edge-snap engine so
   * dragged corner handles magnetize onto detected page edges (CamScanner
   * style). Best-effort: dragging keeps working un-snapped if it fails.
   */
  const initEdgeSnapEngine = useCallback(async (page: ScanPage): Promise<DetectionSnapEngine | null> => {
    pageDetectionVersionRef.current.set(page.id, (pageDetectionVersionRef.current.get(page.id) ?? 0) + 1);
    const session = cropSessionRef.current, request = ++detectionRequestRef.current;
    edgeSnapEngineRef.current = null;
    setCropDetection(null);
    setFocusedCorner(null);
    setDetectingEdges(true);
    const current = () => cropSessionRef.current === session && detectionRequestRef.current === request;
    try {
      const img = await loadImageFromUrl(page.originalUrl);
      if (!current()) return null;
      setCropSource({ url: page.originalUrl, image: img });
      const result = await detectDocumentCached(page.originalUrl, page.rotation);
      if (!current()) return null;
      const engine = createBoundarySnapEngine(result);
      setCropDetection(result);
      edgeSnapEngineRef.current = engine;
      return engine;
    } catch {
      if (current()) edgeSnapEngineRef.current = null;
      return null;
    } finally {
      if (current()) setDetectingEdges(false);
    }
  }, []);

  const enterCropMode = () => {
    if (!activePage) return;
    setSheetOpen(false);
    setEraseMode(false);
    strokeDraftRef.current = null;
    cropSessionRef.current++;
    const session = cropSessionRef.current;
    setCropDraft(activePage.quad ?? FULL_IMAGE_QUAD);
    cropManualRef.current = false;
    setCropMode(true);
    setSnappedCorner(null);

    // If activePage.quad is null, the preview canvas was ALREADY showing the raw image!
    // Align displayedSigRef so we don't throw away the ready canvas!
    if (!activePage.quad) {
      displayedSigRef.current = previewSig(activePage, true);
    }

    const edit = cropEditRef.current;
    void (async () => {
      try {
        const engine = await initEdgeSnapEngine(activePage);
        const quad = autoCropRef.current && engine && automaticDocumentQuad(engine.detection, activePage.sourceKind, true);
        if (quad && !activePage.quad && activePage.cropRevision === 0 && cropSessionRef.current === session && cropEditRef.current === edit && !cropDragRef.current) {
          setCropDraft(quad);
        }
      } catch {
        // detection is best-effort
      }
    })();
  };

  const applyCrop = () => {
    if (!saveDraftIfChanged()) return;
    cancelCrop();
    toast.success('Crop applied.');
  };

  const cancelCrop = () => {
    cropSessionRef.current++;
    onCropPointerUp();
    edgeSnapEngineRef.current = null;
    setCropSource(null);
    setCropDetection(null);
    setDetectingEdges(false);
    setFocusedCorner(null);
    setCropMode(false);
    setActiveHandle(null);
    setSnappedCorner(null);
  };

  /**
   * Persists the crop draft onto the active page when it moved away from the
   * saved outline (or from the untouched whole-image default). Powers the
   * crop-mode page arrows: shifting pages auto-applies the current edits,
   * while Done remains the explicit finish and Cancel still discards.
   */
  const saveDraftIfChanged = () => {
    if (!activePage) return false;
    onCropPointerUp();
    const draft = cropDraftRef.current;
    if (!isSaneQuad(draft)) {
      toast.error('This selection looks invalid — adjust the crop before switching pages.');
      return false;
    }
    const untouched = sameQuad(draft, activePage.quad ?? FULL_IMAGE_QUAD);
    if (!untouched || cropManualRef.current) commitQuadChange(draft);
    return true;
  };

  /**
   * Crop-mode page arrows: auto-save the current page's crop, then jump to
   * the previous/next page while STAYING in crop mode. The incoming page
   * loads its saved outline (or a fresh auto-detection) and a rebuilt snap
   * engine, exactly as if crop mode had been entered on it.
   */
  const selectCropPage = (next: ScanPage) => {
    if (next.id === activePage?.id || !saveDraftIfChanged()) return;
    cropSessionRef.current++;
    const session = cropSessionRef.current;
    setActiveId(next.id);
    setCropDraft(next.quad ?? FULL_IMAGE_QUAD);
    cropManualRef.current = false;
    setSnappedCorner(null);
    const edit = cropEditRef.current;
    void initEdgeSnapEngine(next).then((engine) => {
      const quad = engine && automaticDocumentQuad(engine.detection, next.sourceKind);
      if (quad && cropSessionRef.current === session && cropEditRef.current === edit &&
          !next.quad && next.cropRevision === 0 && !cropDragRef.current) {
        setCropDraft(quad);
      }
    });
  };

  const shiftCropPage = (dir: -1 | 1) => {
    if (pages.length < 2) return;
    const idx = pages.findIndex((p) => p.id === activePage?.id);
    const next = pages[(idx + dir + pages.length) % pages.length];
    if (next) selectCropPage(next);
  };

  const detectNow = async () => {
    if (!activePage) return;
    const session = cropSessionRef.current;
    const edit = cropEditRef.current;
    try {
      const engine = await initEdgeSnapEngine(activePage);
      if (session !== cropSessionRef.current || edit !== cropEditRef.current || cropDragRef.current) return;
      const detected = engine?.autoQuad;
      if (detected) {
        cropManualRef.current = false;
        setCropDraft(detected);
        if (engine.detection.quality === 'strong') toast.success('Page edges detected — adjust if needed.');
        else toast.info('Check edges — this outline is a suggestion.');
      } else {
        toast.error('Could not detect the page edges. Drag the corners manually.');
      }
    } catch {
      toast.error('Detection failed on this page.');
    }
  };

  /**
   * Hit-test the crop overlay in display pixels: corner handles win (they sit
   * on top of the edges), then the mid-edge handles within a touch-friendly
   * band. Returns the handle id or null when the press is elsewhere.
   */
  const hitTestCrop = (e: React.PointerEvent): ActiveHandle | null => {
    const layer = cropLayerRef.current;
    if (!layer) return null;
    const rect = layer.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    let bestCorner: ActiveHandle | null = null;
    let bestDist = 36; // generous touch radius for phones
    for (const k of QUAD_CORNERS) {
      const c = cropDraft[k];
      const d = Math.hypot(c.x * rect.width - px, c.y * rect.height - py);
      if (d < bestDist) {
        bestDist = d;
        bestCorner = k;
      }
    }
    if (bestCorner) return bestCorner;
    let bestEdge: QuadEdge | null = null;
    let bestEdgeDist = 24;
    for (const edge of QUAD_EDGES) {
      const [a, b] = EDGE_CORNERS[edge];
      const ax = cropDraft[a].x * rect.width;
      const ay = cropDraft[a].y * rect.height;
      const vx = cropDraft[b].x * rect.width - ax;
      const vy = cropDraft[b].y * rect.height - ay;
      const len2 = vx * vx + vy * vy;
      // Clamp t away from the ends so corner handles stay grabbable.
      let t = len2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0;
      t = Math.max(0.12, Math.min(0.88, t));
      const d = Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
      if (d < bestEdgeDist) {
        bestEdgeDist = d;
        bestEdge = edge;
      }
    }
    return bestEdge;
  };

  const nudgeCropCorner = (e: React.KeyboardEvent, corner: QuadCorner) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const image = cropSource?.image;
    if (!image || !activePage) return;
    const turned = activePage.rotation === 90 || activePage.rotation === 270;
    const width = turned ? image.naturalHeight : image.naturalWidth;
    const height = turned ? image.naturalWidth : image.naturalHeight;
    const step = e.shiftKey ? 10 : 1, current = cropDraftRef.current;
    const point = current[corner];
    const next = { ...current, [corner]: {
      x: Math.max(0, Math.min(1, point.x + (e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0) / width)),
      y: Math.max(0, Math.min(1, point.y + (e.key === 'ArrowDown' ? step : e.key === 'ArrowUp' ? -step : 0) / height)),
    } };
    if (!isSaneQuad(next)) return;
    cropManualRef.current = true;
    cropEditRef.current++;
    snapLockRef.current = null;
    setSnappedCorner(null);
    setCropDraft(next);
  };

  const onCropPointerDown = (e: React.PointerEvent) => {
    if (!cropMode) return;
    const handle = hitTestCrop(e);
    if (!handle || cropDragRef.current) return;
    cropManualRef.current = true;
    cropEditRef.current++;
    cropDragRectRef.current = cropLayerRef.current!.getBoundingClientRect();
    snapLockRef.current = null;
    snapHapticRef.current = false;
    pendingCropMoveRef.current = null;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (QUAD_CORNERS.includes(handle as QuadCorner)) {
      cropDragRef.current = { kind: 'corner', corner: handle as QuadCorner };
      setActiveHandle(handle);
      return;
    }
    const layer = cropLayerRef.current;
    if (!layer) return;
    const rect = layer.getBoundingClientRect();
    const edge = handle as QuadEdge;
    const [a, b] = EDGE_CORNERS[edge];
    const ax = cropDraft[a].x * rect.width;
    const ay = cropDraft[a].y * rect.height;
    const bx = cropDraft[b].x * rect.width;
    const by = cropDraft[b].y * rect.height;
    const len = Math.hypot(bx - ax, by - ay) || 1;
    // Unit normal of the edge; pointer deltas get projected onto it so the
    // edge slides in/out while staying parallel to itself.
    const normalX = -(by - ay) / len;
    const normalY = (bx - ax) / len;
    cropDragRef.current = {
      kind: 'edge',
      edge,
      normalX,
      normalY,
      startX: e.clientX,
      startY: e.clientY,
      rectW: rect.width,
      rectH: rect.height,
      aStart: { ...cropDraft[a] },
      bStart: { ...cropDraft[b] },
    };
    setActiveHandle(handle);
  };

  const processCropPointer = useCallback((clientX: number, clientY: number) => {
    const drag = cropDragRef.current;
    const layer = cropLayerRef.current;
    if (!drag || !layer) return;
    const rect = cropDragRectRef.current ?? layer.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const markSnapped = (corner: QuadCorner) => {
      setSnappedCorner(corner);
      if (!snapHapticRef.current) {
        snapHapticRef.current = true;
        try { navigator.vibrate?.(8); } catch { /* best-effort haptic */ }
      }
    };
    if (drag.kind === 'corner') {
      const rawX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const rawY = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));

      if (edgeSnapping && edgeSnapEngineRef.current) {
        const lock = snapLockRef.current;
        // A wider release radius prevents noisy ridges from alternating each frame.
        if (lock && Math.hypot((rawX - lock.a.x) * rect.width, (rawY - lock.a.y) * rect.height) <= 34) {
          setCropDraft((prev) => ({ ...prev, [drag.corner]: lock.a }));
          markSnapped(drag.corner);
          return;
        }
        snapLockRef.current = null;
        const snap = edgeSnapEngineRef.current.snapPoint(
          { x: rawX, y: rawY }, drag.corner, rect.width, rect.height, 22
        );
        if (snap.snapped) {
          const point = { x: snap.x, y: snap.y };
          // Boundary projections slide along a line; only fixed targets latch.
          if (snap.type !== 'edge') snapLockRef.current = { a: point };
          setCropDraft((prev) => ({ ...prev, [drag.corner]: point }));
          markSnapped(drag.corner);
          return;
        }
      }

      snapLockRef.current = null;
      setCropDraft((prev) => ({ ...prev, [drag.corner]: { x: rawX, y: rawY } }));
      setSnappedCorner(null);
      return;
    }
    const dxPx = clientX - drag.startX;
    const dyPx = clientY - drag.startY;
    const proj = dxPx * drag.normalX + dyPx * drag.normalY;
    const dx = (drag.normalX * proj) / drag.rectW;
    const dy = (drag.normalY * proj) / drag.rectH;
    const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
    const [ca, cb] = EDGE_CORNERS[drag.edge];
    const rawA = { x: clamp01(drag.aStart.x + dx), y: clamp01(drag.aStart.y + dy) };
    const rawB = { x: clamp01(drag.bStart.x + dx), y: clamp01(drag.bStart.y + dy) };

    // Magnetic snap for edge handles: lock the dragged edge onto the detected
    // document boundary or the strongest nearby gradient ridge, exactly as
    // corner handles do. Falls back to free sliding when nothing is in range.
    if (edgeSnapping && edgeSnapEngineRef.current?.snapEdge) {
      const lock = snapLockRef.current;
      if (lock?.b && Math.max(
        Math.hypot((rawA.x - lock.a.x) * rect.width, (rawA.y - lock.a.y) * rect.height),
        Math.hypot((rawB.x - lock.b.x) * rect.width, (rawB.y - lock.b.y) * rect.height)
      ) <= 34) {
        setCropDraft((prev) => ({ ...prev, [ca]: lock.a, [cb]: lock.b! }));
        markSnapped(ca);
        return;
      }
      snapLockRef.current = null;
      const snap = edgeSnapEngineRef.current.snapEdge(rawA, rawB, rect.width, rect.height, 22);
      if (snap.snapped) {
        snapLockRef.current = { a: snap.a, b: snap.b };
        setCropDraft((prev) => ({ ...prev, [ca]: snap.a, [cb]: snap.b }));
        markSnapped(ca);
        return;
      }
    }

    snapLockRef.current = null;
    setSnappedCorner(null);
    setCropDraft((prev) => ({ ...prev, [ca]: rawA, [cb]: rawB }));
  }, [edgeSnapping, setCropDraft]);

  const onCropPointerMove = (e: React.PointerEvent) => {
    if (!cropDragRef.current || !cropLayerRef.current) return;
    pendingCropMoveRef.current = { clientX: e.clientX, clientY: e.clientY };
    if (cropRafRef.current === null) {
      cropRafRef.current = requestAnimationFrame(() => {
        cropRafRef.current = null;
        const pt = pendingCropMoveRef.current;
        pendingCropMoveRef.current = null;
        if (!pt) return;
        processCropPointer(pt.clientX, pt.clientY);
      });
    }
  };

  const onCropPointerUp = () => {
    if (cropRafRef.current !== null) {
      cancelAnimationFrame(cropRafRef.current);
      cropRafRef.current = null;
    }
    if (pendingCropMoveRef.current) {
      processCropPointer(pendingCropMoveRef.current.clientX, pendingCropMoveRef.current.clientY);
      pendingCropMoveRef.current = null;
    }
    cropDragRef.current = null;
    cropDragRectRef.current = null;
    snapLockRef.current = null;
    setActiveHandle(null);
    setSnappedCorner(null);
  };

  const rotate = (dir: -1 | 1 | 2) => {
    if (!activePage) return;
    const deltaDeg = dir === 2 ? 180 : dir === 1 ? 90 : 270;
    const next = (((activePage.rotation + deltaDeg) % 360) + 360) % 360;
    const nextQuad = activePage.quad ? rotateQuad(activePage.quad, dir) : null;
    const nextStrokes = activePage.eraser.length
      ? rotateEraseStrokes(activePage.eraser, dir)
      : activePage.eraser;
    const redoStack = eraseRedoRef.current.get(activePage.id);
    if (redoStack && redoStack.length > 0) {
      eraseRedoRef.current.set(activePage.id, rotateEraseStrokes(redoStack, dir));
    }
    if (cropMode) {
      cropSessionRef.current++;
      setCropDraft((prev) => rotateQuad(prev, dir));
      setSnappedCorner(null);
      edgeSnapEngineRef.current = null;
    }
    // Fast path: rotate the already-rendered preview bitmap in place — a
    // single GPU canvas draw that snaps instantly.
    previewTokenRef.current++; // invalidate any in-flight preview render
    const nextPage = { ...activePage, rotation: next as ScanPage['rotation'], quad: nextQuad, eraser: nextStrokes };
    const sig = previewSig(nextPage, cropMode);
    if (previewReadyRef.current) {
      const canvas = previewCanvasRef.current;
      if (canvas && canvas.width > 0 && canvas.height > 0) {
        const snapshot = document.createElement('canvas');
        snapshot.width = canvas.width;
        snapshot.height = canvas.height;
        snapshot.getContext('2d', { alpha: false })?.drawImage(canvas, 0, 0);

        const swapDims = dir !== 2;
        const newW = swapDims ? snapshot.height : snapshot.width;
        const newH = swapDims ? snapshot.width : snapshot.height;
        canvas.width = newW;
        canvas.height = newH;
        const ctx = canvas.getContext('2d', { alpha: false });
        if (ctx) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, newW, newH);
          ctx.imageSmoothingQuality = 'high';
          ctx.translate(newW / 2, newH / 2);
          const rad = (deltaDeg * Math.PI) / 180;
          ctx.rotate(rad);
          ctx.drawImage(snapshot, -snapshot.width / 2, -snapshot.height / 2);
        }
        snapshot.width = 0;
        snapshot.height = 0;

        // Keep the restore brush's pristine source aligned with the same fast rotation (erase mode only)
        if (eraseMode) {
          const original = cleanupOriginalRef.current;
          if (original && original.width > 0 && original.height > 0) {
            const originalSnapshot = document.createElement('canvas');
            originalSnapshot.width = original.width;
            originalSnapshot.height = original.height;
            originalSnapshot.getContext('2d', { alpha: false })?.drawImage(original, 0, 0);
            original.width = swapDims ? originalSnapshot.height : originalSnapshot.width;
            original.height = swapDims ? originalSnapshot.width : originalSnapshot.height;
            const originalCtx = original.getContext('2d', { alpha: false });
            if (originalCtx) {
              originalCtx.fillStyle = '#ffffff';
              originalCtx.fillRect(0, 0, original.width, original.height);
              originalCtx.translate(original.width / 2, original.height / 2);
              const rad = (deltaDeg * Math.PI) / 180;
              originalCtx.rotate(rad);
              originalCtx.drawImage(originalSnapshot, -originalSnapshot.width / 2, -originalSnapshot.height / 2);
            }
            originalSnapshot.width = 0;
            originalSnapshot.height = 0;
          }
        }
        // Aspect ratio transposed — recompute the display box
        fitCanvasDisplay(canvas);
      }
      // Record the new state so the preview effect skips its re-render.
      displayedSigRef.current = sig;
      setPreviewPending(false);
    } else {
      // Initial render still in flight — re-render directly at the new angle.
      void renderPreview(nextPage, cropMode, sig);
    }
    updateActivePage({ rotation: nextPage.rotation, quad: nextQuad, eraser: nextStrokes });
    if (cropMode) void initEdgeSnapEngine(nextPage);
  };

  /**
   * Runs client-side computer vision orientation detection on the active page,
   * detecting whether text lines or aspect ratios are sideways/inverted, and rotates to upright.
   */
  const autoOrientActivePage = async () => {
    if (!activePage) return;
    setBusy('Detecting orientation…');
    try {
      const img = await loadImageFromUrl(activePage.originalUrl);
      const res = await detectDocumentOrientation(img, activePage.rotation, activePage.quad);
      const engineTag = `· ${res.source === 'ml' ? 'on-device model' : res.source === 'ai' ? 'server CV' : 'browser CV'} ${Math.round((res.confidence || 0) * 100)}%`;
      if (res.needsRotation && res.rotationDelta !== 0) {
        const delta = res.rotationDelta;
        if (delta === 90) rotate(1);
        else if (delta === 270) rotate(-1);
        else if (delta === 180) rotate(2);
        toast.success(`${res.reason || `Rotated ${delta}° to upright orientation.`} ${engineTag}`);
      } else {
        toast.success(`${res.reason || 'Document is already in upright orientation.'} ${engineTag}`);
      }
    } catch (err: any) {
      console.error('Auto orient failed:', err);
      toast.error('Could not detect orientation.');
    } finally {
      setBusy(null);
    }
  };

  /**
   * Batch auto-orientation: analyzes all scanned pages and rotates any sideways or upside-down pages upright.
   */
  const autoOrientAllPages = async () => {
    if (pages.length === 0) return;
    setBusy(`Analyzing ${pages.length} pages…`);
    let rotatedCount = 0;
    try {
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        setBusy(`Analyzing page ${i + 1} of ${pages.length}…`);
        const img = await loadImageFromUrl(p.originalUrl);
        const res = await detectDocumentOrientation(img, p.rotation, p.quad);
        if (res.needsRotation && res.rotationDelta !== 0) {
          rotatedCount++;
          const delta = res.rotationDelta;
          const dir: -1 | 1 | 2 = delta === 180 ? 2 : delta === 90 ? 1 : -1;
          const nextRot = (((p.rotation + delta) % 360) + 360) % 360 as ScanPage['rotation'];
          const nextQuad = p.quad ? rotateQuad(p.quad, dir) : null;
          const nextStrokes = p.eraser.length ? rotateEraseStrokes(p.eraser, dir) : p.eraser;
          setPages((prev) =>
            prev.map((item) =>
              item.id === p.id
                ? { ...item, rotation: nextRot, quad: nextQuad, eraser: nextStrokes }
                : item
            )
          );
        }
      }
      displayedSigRef.current = null;
      previewReadyRef.current = false;
      const latest = activePageRef.current;
      if (latest) {
        void renderPreview(latest, cropModeRef.current, previewSig(latest, cropModeRef.current));
      }
      if (rotatedCount > 0) {
        toast.success(`Auto-oriented ${rotatedCount} page${rotatedCount === 1 ? '' : 's'}.`);
      } else {
        toast.success('All pages are already in upright orientation.');
      }
    } catch (err: any) {
      console.error('Auto orient all failed:', err);
      toast.error('Auto-orientation failed on one or more pages.');
    } finally {
      setBusy(null);
    }
  };

  const autoCropAllPages = async () => {
    if (pages.length === 0) return;
    let croppedCount = 0;
    try {
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        setBusy(`Detecting page edges ${i + 1} of ${pages.length}…`);
        const result = await detectDocumentCached(p.originalUrl, p.rotation);
        const quad = automaticDocumentQuad(result, p.sourceKind, true);
        if (!quad) continue;
        croppedCount++;
        setPages((prev) => prev.map((item) =>
          item.id === p.id && item.originalUrl === p.originalUrl && item.rotation === p.rotation ? { ...item, quad } : item
        ));
      }
      displayedSigRef.current = null;
      previewReadyRef.current = false;
      if (croppedCount > 0) {
        toast.success(`Auto-cropped ${croppedCount} of ${pages.length} page${pages.length === 1 ? '' : 's'}.`);
      } else {
        toast.info('No clear page edges found. Open Crop to set them manually.');
      }
    } catch (err: any) {
      console.error('Auto crop all failed:', err);
      toast.error('Auto-crop failed on one or more pages.');
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    const handleActive = () => { void autoOrientActivePage(); };
    const handleAll = () => { void autoOrientAllPages(); };
    const handleCropAll = () => { void autoCropAllPages(); };
    window.addEventListener('camscanner-auto-orient-active', handleActive);
    window.addEventListener('camscanner-auto-orient-all', handleAll);
    window.addEventListener('camscanner-auto-crop-all', handleCropAll);
    return () => {
      window.removeEventListener('camscanner-auto-orient-active', handleActive);
      window.removeEventListener('camscanner-auto-orient-all', handleAll);
      window.removeEventListener('camscanner-auto-crop-all', handleCropAll);
    };
  });

  /* ------------------------------------------------------------------
     Export
     ------------------------------------------------------------------ */

  const resetAdjustments = () => {
    if (!activePage) return;
    setPages(prev => prev.map(p => p.id === activePage.id ? { ...p, adj: { ...NEUTRAL_ADJUSTMENTS } } : p));
  };

  const runExport = (fmt: ExportFormat) => runInBackground(() => runExportNow(fmt));
  const runExportNow = async (fmt: ExportFormat) => {
    if (pages.length === 0 || busy) return;
    setExportFormat(fmt);
    const baseName = safeFileName(docName);
    const qualityPercent = qualityPreset === 'custom' ? customQuality : SCAN_QUALITY_PRESETS[qualityPreset];
    const jpegQuality = compression ? compression.quality : Math.min(1, Math.max(0.4, qualityPercent / 100));
    const label = fmt.toUpperCase();
    const n = pages.length;
    // Each step covers a range of the bar, and the bar creeps forward inside
    // it. We wait for a paint before each heavy synchronous block (canvas
    // encoding, PDF/ZIP building) so the new value actually appears.
    // Ranges: render 2–65%, build 65–92%, finalize 92–99%, download 100%.
    const report = async (from: number, to: number, message: string) => {
      progress.stage(from, to, message);
      await yieldToPaint();
    };
    let succeeded = false;
    setBusy('Rendering pages…');
    progress.start('export', `Preparing ${label} export…`, label);
    await report(0, 2, `Preparing ${label} export…`);
    let doc: jsPDF | null = null;
    try {
      // Pages are held as binary blobs, not base64 data URLs: a data URL costs
      // about 1.37x the memory and is rebuilt as a string on every use, which
      // is what crashes low-memory phones on 50+ page documents.
      const rendered: Array<{ blob: Blob | null; w: number; h: number }> = [];
      for (let i = 0; i < n; i++) {
        await report(2 + (i / n) * 63, 2 + ((i + 1) / n) * 63, `Rendering page ${i + 1} of ${n}…`);
        setBusy(`Processing page ${i + 1} of ${pages.length}…`);
        // Strokes are normalized, so exports re-apply them at full capture
        // resolution — the eraser quality matches the preview.
        const canvas = await renderScanCanvas(pages[i].originalUrl, {
          rotation: pages[i].rotation,
          quad: pages[i].quad,
          filter: pages[i].filter,
          adj: pages[i].adj,
          eraserStrokes: pages[i].eraser,
        });
        let outCanvas = canvas;
        if (compression) {
          outCanvas = resizeSmooth(canvas, effectiveScale(compression, Math.max(canvas.width, canvas.height)));
        }
        const pageBlob = await new Promise<Blob | null>((resolve) =>
          outCanvas.toBlob(resolve, fmt === 'png' ? 'image/png' : 'image/jpeg', jpegQuality)
        );
        if (!pageBlob) throw new Error(`Page ${i + 1} is too large for this device to encode. Try a lower compression level or fewer pages.`);
        rendered.push({ blob: pageBlob, w: outCanvas.width, h: outCanvas.height });
        if (outCanvas !== canvas) { outCanvas.width = 0; outCanvas.height = 0; }
        canvas.width = 0;
        canvas.height = 0;
      }
      await report(65, 66, `Rendered ${n} page${n === 1 ? '' : 's'}`);

      let finalBlob: Blob | null = null;
      let finalUrl: string | null = null;
      let finalName = '';

      if (fmt === 'pdf') {
        setBusy('Building PDF�����');
        const marginPt = MARGIN_PT[margin];
        // In Fit mode, scans from different photos have different pixel
        // resolutions, which made same-looking pages appear at different sizes.
        // Give every page of the same orientation a common width (the median,
        // so one outlier can't blow up or shrink the rest). Each page keeps its
        // own aspect ratio, so nothing is stretched and no blank space is added.
        // Only the page's physical size changes, not the image resolution.
        const medianOf = (values: number[]) => {
          if (values.length === 0) return 0;
          const s = [...values].sort((a, b) => a - b);
          const mid = Math.floor(s.length / 2);
          return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
        };
        const landscapeWidths = rendered.filter((r) => r.w > r.h).map((r) => r.w * 0.75);
        const portraitWidths = rendered.filter((r) => r.w <= r.h).map((r) => r.w * 0.75);
        const commonWidthPt = {
          landscape: medianOf(landscapeWidths),
          portrait: medianOf(portraitWidths),
        };
        for (let i = 0; i < rendered.length; i++) {
          await report(
            65 + (i / rendered.length) * 27,
            65 + ((i + 1) / rendered.length) * 27,
            `Adding page ${i + 1} of ${rendered.length} to PDF…`
          );
          const { blob: pageBlob, w, h } = rendered[i];
          const pageBytes = new Uint8Array(await pageBlob!.arrayBuffer());
          rendered[i].blob = null;
          const imgWpt = Math.max(20, w * 0.75);
          const imgHpt = Math.max(20, h * 0.75);
          let pageW: number;
          let pageH: number;
          let drawW: number;
          let drawH: number;
          let dx: number;
          let dy: number;
          if (pageSize === 'fit') {
            // Page matches the scan's shape at the shared width, plus the margin.
            const targetW = w > h ? commonWidthPt.landscape : commonWidthPt.portrait;
            const fitScale = targetW > 0 ? targetW / imgWpt : 1;
            drawW = imgWpt * fitScale;
            drawH = imgHpt * fitScale;
            pageW = drawW + marginPt * 2;
            pageH = drawH + marginPt * 2;
            dx = marginPt;
            dy = marginPt;
          } else {
            // Fixed sheet (A4/Letter) in the scan's orientation, scan centered.
            const baseW = pageSize === 'a4' ? 595.28 : 612;
            const baseH = pageSize === 'a4' ? 841.89 : 792;
            const landscape = imgWpt > imgHpt;
            pageW = landscape ? baseH : baseW;
            pageH = landscape ? baseW : baseH;
            const availW = Math.max(20, pageW - marginPt * 2);
            const availH = Math.max(20, pageH - marginPt * 2);
            const scale = Math.min(availW / imgWpt, availH / imgHpt);
            drawW = imgWpt * scale;
            drawH = imgHpt * scale;
            dx = (pageW - drawW) / 2;
            dy = (pageH - drawH) / 2;
          }
          const orientation = pageW > pageH ? 'landscape' : 'portrait';
          if (!doc) {
            doc = new jsPDF({ orientation, unit: 'pt', format: [pageW, pageH] });
          } else {
            doc.addPage([pageW, pageH], orientation);
          }
          doc.addImage(pageBytes, 'JPEG', dx, dy, drawW, drawH, undefined, 'FAST');
          await yieldToPaint();
        }
        await report(92, 99, 'Finalizing PDF…');
        finalBlob = doc!.output('blob');
        finalName = `${baseName}.pdf`;
      } else {
        const single = (i: number) => `${baseName}_page_${String(i + 1).padStart(3, '0')}.${fmt}`;
        if (rendered.length === 1) {
          await report(92, 99, `Preparing ${label} image…`);
          finalBlob = rendered[0].blob;
          finalName = single(0);
        } else {
          setBusy('Building ZIP…');
          await report(66, 70, 'Creating ZIP archive…');
          const zip = new JSZip();
          // JPEG/PNG are already compressed; STORE skips a pointless, slow deflate pass.
          rendered.forEach((r, i) => {
            zip.file(single(i), r.blob!, { binary: true, compression: 'STORE' });
            r.blob = null;
          });
          await report(70, 72, 'Packing archive…');
          finalBlob = await zip.generateAsync({ type: 'blob', compression: 'STORE', streamFiles: true }, (metadata) => {
            progress.stage(
              70 + (metadata.percent / 100) * 27,
              99,
              `Compressing archive… (${Math.round(metadata.percent)}%)`
            );
          });
          finalName = `${baseName}_${fmt}.zip`;
        }
      }

      // Everything is built: show the finished state first, then hand the
      // file to the browser, so the bar reads 100% at the moment the download
      // actually starts rather than jumping there afterwards.
      progress.finish(`Downloading ${finalName}`, 1400);
      await yieldToPaint();
      if (finalBlob) downloadBlob(finalBlob, finalName);
      else if (finalUrl) await downloadFileMobileSafe(finalUrl, finalName);
      succeeded = true;
      toast.success(`Exported ${n} page${n === 1 ? '' : 's'} as ${label}.`);
    } catch (err: any) {
      console.error('Scanner export failed:', err);
      toast.error(`Export failed: ${err?.message || 'Unknown error'}`);
    } finally {
      doc = null;
      setBusy(null);
      if (!succeeded) progress.cancel();
    }
  };

  // Escape dismisses the export menu, the mobile bottom sheets and erase mode.
  useEffect(() => {
    if (!exportMenuOpen && !sheetOpen && !eraseMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setExportMenuOpen(false);
        setSheetOpen(false);
        setEraseMode(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [exportMenuOpen, sheetOpen, eraseMode]);

  /* ------------------------------------------------------------------
     Guards
     ------------------------------------------------------------------ */

  // Keep the preview's display box correct when the window resizes or container resizes.
  // The erase zoom is reset too: its pan offsets are relative to the old display box.
  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;

    const updateDisplay = () => {
      if (previewCanvasRef.current) fitCanvasDisplay(previewCanvasRef.current);
    };

    updateDisplay();

    const wrap = canvas.parentElement?.parentElement;
    let ro: ResizeObserver | null = null;
    if (wrap && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        updateDisplay();
      });
      ro.observe(wrap);
    }

    const onResize = () => {
      updateDisplay();
      zoomRef.current = 1;
      panRef.current = { x: 0, y: 0 };
      pinchRef.current = null;
      panDragRef.current = null;
      setZoomPct(1);
      applyZoomTransform();
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (ro) ro.disconnect();
    };
  }, [pages.length, activeId, eraseMode, cropMode]);

  useEffect(() => {
    if (pages.length === 0) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [pages.length]);

  /* ------------------------------------------------------------------
     Render
     ------------------------------------------------------------------ */

  const filterLabel = activePage
    ? SCAN_FILTERS.find((f) => f.id === activePage.filter)?.label ?? ''
    : '';

  /** Size of the active page's eraser redo stack (for the Redo button state). */
  const redoCount = activePage ? (eraseRedoRef.current.get(activePage.id)?.length ?? 0) : 0;

  const filePicker = (
    <input
      ref={fileInputRef}
      type="file"
      accept="image/*,application/pdf,.pdf"
      multiple
      hidden
      onChange={(e) => {
        if (e.target.files) void handleFiles(e.target.files);
        e.target.value = '';
      }}
    />
  );

  const exportBubble = <ScannerProgressBubble store={progress} />;

  const busyText = busy && !progressStatus ? busy : autoCropStatus;
  const busyChip = busyText ? (
    <div className="scanner-busy" role="status">
      <Loader2 size={15} className="spin" />
      <span>{busyText}</span>
    </div>
  ) : null;

  // ---------- Landing / camera screens ----------
  if (pages.length === 0 || cameraActive) {
    return (
      <div className="scanner-page animate-fadeIn">
        {exportBubble}
        {busyChip}
        {cameraActive ? (
          <div className="scanner-camera">
            <video ref={videoRef} playsInline muted className="scanner-camera-video" />
            <div className="scanner-camera-hint">Position the page inside the frame, then tap the shutter.</div>
            <div className="scanner-camera-actions">
              <button className="btn quiet btn-sm" onClick={stopCamera}>
                <X size={15} /><span>Done</span>
              </button>
              <button
                className="scanner-shutter"
                onClick={captureFrame}
                aria-label="Capture page"
                title="Capture page"
              >
                <ScanLine size={24} />
              </button>
              <button
                className="btn quiet btn-sm"
                onClick={() => cameraFileInputRef.current?.click()}
                title="Upload images or a PDF instead"
              >
                <ImagePlus size={15} /><span>Upload</span>
              </button>
            </div>
            {pages.length > 0 && (
              <div className="scanner-camera-count chip accent">{pages.length} page{pages.length === 1 ? '' : 's'} captured</div>
            )}
            <input
              ref={cameraFileInputRef}
              type="file"
              accept="image/*,application/pdf,.pdf"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void handleFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </div>
        ) : (
          <div
            className={'scanner-landing' + (dragOver ? ' drag' : '')}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (e.dataTransfer?.files?.length) void handleFiles(e.dataTransfer.files);
            }}
          >
            <span className="scanner-landing-icon ch-tint-4"><Camera size={26} /></span>
            <h2>Cam scanner</h2>
            <p>
              Photograph a page, or upload images or a PDF. Edges are detected, perspective is
              corrected, and scanner filters make it look like a real office scan — all locally
              in your browser.
            </p>
            <div className="scanner-landing-actions">
              <button className="btn primary" onClick={startCamera}>
                <Camera size={16} /><span>Use camera</span>
              </button>
              <button className="btn secondary" onClick={() => fileInputRef.current?.click()}>
                <ImagePlus size={16} /><span>Upload images / PDF</span>
              </button>
            </div>
            {cameraError && (
              <div className="scanner-camera-error" role="alert">
                <AlertTriangle size={15} />
                <span>{cameraError}</span>
              </div>
            )}
            <span className="scanner-landing-hint">or drop images / a PDF here · JPG, PNG, PDF · multi-page supported</span>
            {filePicker}
          </div>
        )}
      </div>
    );
  }

  // ---------- Rearrange mode ----------
  if (arranging) {
    return (
      <div className="scanner-page animate-fadeIn">
        {exportBubble}
        {busyChip}
        <div className="scanner-arrange-head">
          <div>
            <h2 className="scanner-arrange-title">Rearrange pages</h2>
            <span className="text-secondary text-[12.5px]">
              Drag pages into the order you want — or use the arrows on each page.
              {' '}{pages.length} page{pages.length === 1 ? '' : 's'}.
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="btn quiet btn-sm"
              onClick={autoOrientAllPages}
              disabled={!!busy}
              title="Automatically detect orientation and rotate all pages upright"
            >
              <Compass size={14} /><span>Auto orient all</span>
            </button>
            <button className="btn primary btn-sm" onClick={() => {
              setArranging(false);
              if (lastRearrangedIdRef.current) setActiveId(lastRearrangedIdRef.current);
              displayedSigRef.current = null;
              previewReadyRef.current = false;
              // Force a full-quality re-render by clearing the signature
              // and trigger the render process for the active page again.
              const page = activePageRef.current;
              if (page) {
                  void renderPreview(page, cropModeRef.current, previewSig(page, cropModeRef.current));
              }
            }}>
              <Check size={14} /><span>Done</span>
            </button>
          </div>
        </div>
        <div className="scanner-arrange-grid">
          {pages.map((page, idx) => (
            <div
              key={page.id}
              className={
                'scanner-arrange-tile' +
                (dragIndex === idx ? ' dragging' : '') +
                (overIndex === idx && dragIndex !== null && dragIndex !== idx ? ' over' : '')
              }
              draggable
              onDragStart={(e) => {
                setDragIndex(idx);
                lastRearrangedIdRef.current = page.id;
                e.dataTransfer.setData('text/plain', String(idx));
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setOverIndex((prev) => (prev === idx ? prev : idx));
              }}
              onDragLeave={() => setOverIndex((prev) => (prev === idx ? null : prev))}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIndex !== null) movePageTo(dragIndex, idx);
                setDragIndex(null);
                setOverIndex(null);
              }}
              onDragEnd={() => {
                setDragIndex(null);
                setOverIndex(null);
              }}
            >
              <span className="scanner-thumb-num">{idx + 1}</span>
              <img
                src={page.thumbUrl || page.originalUrl}
                alt={`Page ${idx + 1}`}
                draggable={false}
                loading="lazy"
                decoding="async"
                style={{ transform: `rotate(${page.rotation}deg)` }}
              />
              <span className="scanner-thumb-filter">
                {SCAN_FILTERS.find((f2) => f2.id === page.filter)?.label}
              </span>
              <span className="scanner-arrange-actions">
                <button
                  title="Move earlier"
                  aria-label={`Move page ${idx + 1} earlier`}
                  disabled={idx === 0}
                  onClick={() => movePageTo(idx, idx - 1)}
                >
                  <ArrowLeft size={13} />
                </button>
                <button
                  title="Move later"
                  aria-label={`Move page ${idx + 1} later`}
                  disabled={idx === pages.length - 1}
                  onClick={() => movePageTo(idx, idx + 1)}
                >
                  <ArrowRight size={13} />
                </button>
                <button
                  className="danger-text"
                  title="Delete page"
                  aria-label={`Delete page ${idx + 1}`}
                  onClick={() => deletePage(page.id)}
                >
                  <Trash2 size={13} />
                </button>
              </span>
              <GripVertical size={15} className="scanner-arrange-grip" aria-hidden="true" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ---------- Editor workspace ----------
  return (
    <div
      className={
        'scanner-page editor-mode animate-fadeIn' +
        (cropMode ? ' crop-active' : eraseMode ? ' erase-active' : '') +
        (editorDragOver ? ' editor-drag-over' : '')
      }
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes('Files')) {
          e.preventDefault();
          e.stopPropagation();
          setEditorDragOver(true);
        }
      }}
      onDragEnter={(e) => {
        if (e.dataTransfer?.types?.includes('Files')) {
          e.preventDefault();
          e.stopPropagation();
          setEditorDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setEditorDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setEditorDragOver(false);
        if (e.dataTransfer?.files?.length) {
          void handleFiles(e.dataTransfer.files);
        }
      }}
    >
      {exportBubble}
      {busyChip}

      {editorDragOver && (
        <div className="scanner-drop-overlay animate-fadeIn pointer-events-none">
          <div className="scanner-drop-overlay-card">
            <div className="scanner-drop-overlay-icon">
              <Plus size={32} />
            </div>
            <h3 className="text-base font-bold text-ink mb-1">Add to Scanner</h3>
            <p className="text-xs text-secondary">Drop image or PDF files to add them as new pages</p>
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className={`scanner-toolbar${cropMode || eraseMode ? ' scanner-toolbar-editing' : ''}`}>
        <div className="field-group">
          {/* Desktop: inline rename. Mobile: pencil button opens the rename dialog. */}
          <input
            className="scanner-name-input"
            type="text"
            value={docName}
            onChange={(e) => setDocName(e.target.value)}
            aria-label="Document name"
            placeholder="Document name"
          />
          <div className="scanner-export-wrap">
            <button
              className="btn primary btn-sm"
              onClick={() => setExportMenuOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={exportMenuOpen}
              disabled={!!busy}
              title="Export"
            >
              {busy ? <Loader2 size={15} className="spin" /> : <Download size={15} />}
              <ExportButtonLabel store={progress} idleLabel={busy ? busy : 'Export'} />
              <ChevronDown size={14} className="scanner-export-caret" />
            </button>
            {exportMenuOpen && (
              <>
                <div className="scanner-menu-backdrop" onClick={() => setExportMenuOpen(false)} />
                <div className="scanner-export-menu" role="menu" aria-label="Export format">
                  {(['pdf', 'jpg', 'png'] as ExportFormat[]).map((fmt) => (
                    <button
                      key={fmt}
                      role="menuitem"
                      onClick={() => {
                        setExportMenuOpen(false);
                        void runExport(fmt);
                      }}
                    >
                      {fmt === 'pdf' ? <FileText size={15} /> : <ImageIcon size={15} />}
                      <span>Download as {fmt.toUpperCase()}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <button
            className="icon-button bordered scanner-rename-btn scanner-rename-btn-compact"
            onClick={() => setRenameOpen(true)}
            aria-label="Rename document"
            title="Rename document"
            disabled={!!busy}
          >
            <Pencil size={15} />
          </button>
        </div>
        {!eraseMode && !cropMode ? (
          <div className="field-group">
            <button className="btn secondary btn-sm" onClick={startCamera}>
              <Camera size={15} /><span className="hide-sm">Camera</span>
            </button>
            <button className="btn secondary btn-sm" onClick={() => fileInputRef.current?.click()}>
              <Plus size={15} /><span className="hide-sm">Add images / PDF</span>
            </button>
            <button
              className="btn secondary btn-sm"
              onClick={() => { setCropMode(false); setArranging(true); }}
              disabled={pages.length < 2}
              title={pages.length < 2 ? 'Add at least two pages to rearrange' : 'Reorder pages'}
            >
              <ListOrdered size={15} /><span className="hide-sm">Rearrange</span>
            </button>
            <button
              className={`btn ${compression ? '' : 'secondary'} btn-sm`}
              onClick={() => setCompressOpen(true)}
              disabled={pages.length < 1 || !!busy}
              title={compression ? `Compression on (${compression.level}%)` : 'Compress file size'}
              aria-label="Compress"
            >
              <Minimize2 size={15} /><span className="hide-sm">Compress</span>
            </button>
          </div>
        ) : (
          <div className="field-group scanner-mode-status">
            <span className="scanner-mode-chip">
              {eraseMode ? (
                <>
                  <Eraser size={13} />
                  <span>Clean up · Page {pages.findIndex((p) => p.id === activePage?.id) + 1} of {pages.length}</span>
                </>
              ) : (
                <>
                  <CropIcon size={13} />
                  <span>Crop · Page {pages.findIndex((p) => p.id === activePage?.id) + 1} of {pages.length}</span>
                </>
              )}
            </span>
            {cropMode && (
              <span className="scanner-snap-status" role="status" aria-live="polite">
                {snappedCorner && edgeSnapping && activeHandle !== null && (
                  <><Magnet size={13} aria-hidden="true" /><span>Snap edges</span></>
                )}
              </span>
            )}
          </div>
        )}
        {filePicker}
        {compressOpen && (
          <CompressDialog
            format={exportFormat}
            baseQuality={Math.min(1, Math.max(0.4, (qualityPreset === 'custom' ? customQuality : SCAN_QUALITY_PRESETS[qualityPreset]) / 100))}
            current={compression}
            pageCount={pages.length}
            renderPage={(i) =>
              renderScanCanvas(pages[i].originalUrl, {
                rotation: pages[i].rotation,
                quad: pages[i].quad,
                filter: pages[i].filter,
                adj: pages[i].adj,
                eraserStrokes: pages[i].eraser,
              })
            }
            onApply={(s) => {
              setCompression(s);
              setCompressOpen(false);
              toast.success(s ? 'Compression will be applied to your next export.' : 'Compression removed.');
            }}
            onClose={() => setCompressOpen(false)}
          />
        )}
      </div>

      <div className="scanner-workspace">
        {/* Preview */}
        <div className="scanner-preview-col">
          <div className="scanner-canvas-wrap">
            <div className="scanner-canvas-frame">
              <canvas ref={previewCanvasRef} className="scanner-canvas" aria-label="Scanned page preview" />
              {cropMode && (
                <div
                  ref={cropLayerRef}
                  className="scanner-crop-layer"
                  role="application"
                  aria-label="Crop outline. Drag the corner handles to set the page corners, or the side handles to move an edge."
                  onPointerDown={onCropPointerDown}
                  onPointerMove={onCropPointerMove}
                  onPointerUp={onCropPointerUp}
                  onPointerCancel={onCropPointerUp}
                >
                  <svg className="scanner-crop-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
                    <path
                      className="scanner-crop-mask"
                      fillRule="evenodd"
                      d={`M0 0 H100 V100 H0 Z M${cropDraft.tl.x * 100} ${cropDraft.tl.y * 100} L${cropDraft.tr.x * 100} ${cropDraft.tr.y * 100} L${cropDraft.br.x * 100} ${cropDraft.br.y * 100} L${cropDraft.bl.x * 100} ${cropDraft.bl.y * 100} Z`}
                    />
                    <polygon
                      className="scanner-crop-polygon"
                      points={`${cropDraft.tl.x * 100},${cropDraft.tl.y * 100} ${cropDraft.tr.x * 100},${cropDraft.tr.y * 100} ${cropDraft.br.x * 100},${cropDraft.br.y * 100} ${cropDraft.bl.x * 100},${cropDraft.bl.y * 100}`}
                      fill="none"
                      stroke="#22c55e"
                      strokeWidth="0.8"
                      vectorEffect="non-scaling-stroke"
                    />
                    {activeHandle !== null && (
                      <g className="scanner-crop-grid" stroke="rgba(255, 255, 255, 0.45)" strokeWidth="0.5" strokeDasharray="1.5 1.5" vectorEffect="non-scaling-stroke">
                        {/* 1/3 and 2/3 vertical guidelines */}
                        <line
                          x1={(cropDraft.tl.x * 2 + cropDraft.tr.x) / 3 * 100}
                          y1={(cropDraft.tl.y * 2 + cropDraft.tr.y) / 3 * 100}
                          x2={(cropDraft.bl.x * 2 + cropDraft.br.x) / 3 * 100}
                          y2={(cropDraft.bl.y * 2 + cropDraft.br.y) / 3 * 100}
                        />
                        <line
                          x1={(cropDraft.tl.x + cropDraft.tr.x * 2) / 3 * 100}
                          y1={(cropDraft.tl.y + cropDraft.tr.y * 2) / 3 * 100}
                          x2={(cropDraft.bl.x + cropDraft.br.x * 2) / 3 * 100}
                          y2={(cropDraft.bl.y + cropDraft.br.y * 2) / 3 * 100}
                        />
                        {/* 1/3 and 2/3 horizontal guidelines */}
                        <line
                          x1={(cropDraft.tl.x * 2 + cropDraft.bl.x) / 3 * 100}
                          y1={(cropDraft.tl.y * 2 + cropDraft.bl.y) / 3 * 100}
                          x2={(cropDraft.tr.x * 2 + cropDraft.br.x) / 3 * 100}
                          y2={(cropDraft.tr.y * 2 + cropDraft.br.y) / 3 * 100}
                        />
                        <line
                          x1={(cropDraft.tl.x + cropDraft.bl.x * 2) / 3 * 100}
                          y1={(cropDraft.tl.y + cropDraft.bl.y * 2) / 3 * 100}
                          x2={(cropDraft.tr.x + cropDraft.br.x * 2) / 3 * 100}
                          y2={(cropDraft.tr.y + cropDraft.br.y * 2) / 3 * 100}
                        />
                      </g>
                    )}
                    {snappedCorner && (
                      <g className="scanner-snap-reticle">
                        <circle
                          cx={cropDraft[snappedCorner].x * 100}
                          cy={cropDraft[snappedCorner].y * 100}
                          r="3.5"
                          fill="none"
                          stroke="#10b981"
                          strokeWidth="1"
                          strokeDasharray="1.2 1.2"
                          vectorEffect="non-scaling-stroke"
                        />
                      </g>
                    )}
                  </svg>
                  {QUAD_CORNERS.map((k) => (
                    <button
                      type="button"
                      key={k}
                      aria-label={`${k === 'tl' ? 'Top left' : k === 'tr' ? 'Top right' : k === 'br' ? 'Bottom right' : 'Bottom left'} crop corner. Arrow keys move one pixel; Shift moves ten.`}
                      onKeyDown={(e) => nudgeCropCorner(e, k)}
                      onFocus={() => setFocusedCorner(k)}
                      onBlur={() => setFocusedCorner(null)}
                      className={
                        'scanner-crop-handle' +
                        (activeHandle === k ? ' active' : '') +
                        (snappedCorner === k ? ' snapped' : '')
                      }
                      style={{ left: `${cropDraft[k].x * 100}%`, top: `${cropDraft[k].y * 100}%` }}
                    />
                  ))}
                  {cropSource?.url === activePage?.originalUrl && (QUAD_CORNERS.includes(activeHandle as QuadCorner) || focusedCorner) && (
                    <CropMagnifier image={cropSource.image} rotation={activePage.rotation}
                      point={cropDraft[(QUAD_CORNERS.includes(activeHandle as QuadCorner) ? activeHandle : focusedCorner) as QuadCorner]} />
                  )}
                  {QUAD_EDGES.map((edge) => {
                    const [a, b] = EDGE_CORNERS[edge];
                    return (
                      <span
                        key={edge}
                        className={'scanner-crop-handle mid' + (activeHandle === edge ? ' active' : '')}
                        style={{
                          left: `${((cropDraft[a].x + cropDraft[b].x) / 2) * 100}%`,
                          top: `${((cropDraft[a].y + cropDraft[b].y) / 2) * 100}%`,
                        }}
                      />
                    );
                  })}
                </div>
              )}
              {eraseMode && (
                <div
                  ref={eraseLayerRef}
                  className="scanner-erase-layer"
                  role="application"
                  aria-label={`${cleanupBrush === 'erase' ? 'Erase' : 'Restore'} brush. ${cleanupBrush === 'erase' ? 'Brush over marks or stains to remove them.' : 'Brush over erased areas to restore the original pixels.'}`}
                  onPointerDown={onErasePointerDown}
                  onPointerMove={onErasePointerMove}
                  onPointerUp={onErasePointerUp}
                  onPointerCancel={onErasePointerUp}
                  onPointerLeave={onErasePointerLeave}
                >
                  <div ref={eraseRingRef} className="scanner-erase-ring" />
                </div>
              )}
            </div>
            {/* Spinner only when there is nothing on the canvas yet — during
                interactive slider renders the previous bitmap stays visible. */}
            {previewPending && !previewReadyRef.current && (
              <div className="scanner-preview-spinner"><Loader2 size={22} className="spin" /></div>
            )}

          </div>

          {cropMode ? (
            <div className="scanner-crop-actions">
              <div className="scanner-crop-navigation" role="group" aria-label="Crop page navigation">
                <button type="button" className="scanner-crop-nav" disabled={pages.length < 2}
                  onClick={() => shiftCropPage(-1)}
                  aria-label="Previous page — edits are applied automatically" title="Apply edits and go to previous page">
                  <ChevronLeft size={20} />
                </button>
                <span className="scanner-crop-pagechip" aria-live="polite" aria-atomic="true">
                  Page {pages.findIndex((p) => p.id === activePage?.id) + 1} of {pages.length}
                </span>
                <button type="button" className="scanner-crop-nav" disabled={pages.length < 2}
                  onClick={() => shiftCropPage(1)}
                  aria-label="Next page — edits are applied automatically" title="Apply edits and go to next page">
                  <ChevronRight size={20} />
                </button>
              </div>
              <span className={`scanner-crop-hint scanner-detection-status ${cropDetection?.quality === 'review' ? 'needs-review' : ''}`} role="status">
                {detectingEdges ? 'Finding page boundaries… You can adjust manually.' :
                  cropManualRef.current ? 'Manual outline · Arrow keys: 1 pixel. Shift + arrow: 10 pixels.' :
                  cropDetection ? `${cropDetection.reason}. Drag or use arrow keys to fine-tune.` :
                  'Drag the corners onto the page edges, or focus a corner and use arrow keys.'}
              </span>
              <div className="spacer" />
              <div className="scanner-crop-tools">
                <button
                  type="button"
                  className={`btn quiet btn-sm scanner-crop-tool-btn ${edgeSnapping ? 'active text-emerald-400' : 'opacity-70'}`}
                  onClick={() => setEdgeSnapping((v) => !v)}
                  aria-pressed={edgeSnapping}
                  title={edgeSnapping ? 'Edge snapping is ON (auto-aligns to high-contrast edges)' : 'Edge snapping is OFF'}
                >
                  <Magnet size={14} />
                  <span className="hide-sm">Snap: {edgeSnapping ? 'ON' : 'OFF'}</span>
                </button>
                <button
                  type="button"
                  className="btn quiet btn-sm scanner-crop-tool-btn"
                  onClick={() => rotate(-1)}
                  title="Rotate counter-clockwise 90°"
                  aria-label="Rotate counter-clockwise"
                >
                  <RotateCcw size={14} />
                </button>
                <button
                  type="button"
                  className="btn quiet btn-sm scanner-crop-tool-btn"
                  onClick={() => rotate(1)}
                  title="Rotate clockwise 90°"
                  aria-label="Rotate clockwise"
                >
                  <RotateCw size={14} />
                </button>
                <button
                  type="button"
                  className="btn quiet btn-sm scanner-crop-tool-btn"
                  onClick={autoOrientActivePage}
                  title="Auto-detect text direction and orient upright"
                  aria-label="Auto orient"
                >
                  <Compass size={14} />
                  <span className="hide-sm">Auto orient</span>
                </button>
                <button
                  type="button"
                  className="btn quiet btn-sm scanner-crop-tool-btn"
                  onClick={() => { cropManualRef.current = true; cropEditRef.current++; setCropDraft(FULL_IMAGE_QUAD); setCropDetection(null); }}
                  title="Use the whole image"
                  aria-label="Use the whole image"
                >
                  <Maximize size={14} />
                  <span className="hide-sm">Whole image</span>
                </button>
                <button
                  type="button"
                  className="btn quiet btn-sm scanner-crop-tool-btn"
                  onClick={detectNow}
                  disabled={detectingEdges}
                  title="Auto-detect page edges"
                  aria-label="Auto-detect page edges"
                >
                  <ScanLine size={14} />
                  <span className="hide-sm">Auto detect</span>
                </button>
              </div>
              <div className="scanner-crop-confirm-actions">
                <button type="button" className="btn quiet btn-sm" onClick={cancelCrop} aria-label="Cancel crop changes">
                  <X size={14} /><span>Cancel</span>
                </button>
                <button type="button" className="btn primary btn-sm scanner-crop-done-btn" onClick={applyCrop}>
                  <Check size={14} /><span>Done</span>
                </button>
              </div>
            </div>
          ) : eraseMode ? (
            <div className="scanner-erase-bar" role="toolbar" aria-label="Erase and restore tools">
              <div className="scanner-erase-row-main">
                {/* 1. Brush Switch (Erase / Restore) - always accessible */}
                <div className="scanner-brush-switch" role="group" aria-label="Brush mode">
                  <button
                    type="button"
                    className={`scanner-brush-btn${cleanupBrush === 'erase' ? ' active' : ''}`}
                    onClick={() => setCleanupBrush('erase')}
                    aria-pressed={cleanupBrush === 'erase'}
                    title="Erase unwanted marks or dust"
                  >
                    <Eraser size={13} /><span>Erase</span>
                  </button>
                  <button
                    type="button"
                    className={`scanner-brush-btn${cleanupBrush === 'restore' ? ' active' : ''}`}
                    onClick={() => setCleanupBrush('restore')}
                    aria-pressed={cleanupBrush === 'restore'}
                    title="Restore original pixels"
                  >
                    <Undo2 size={13} /><span>Restore</span>
                  </button>
                </div>

                <div className="scanner-erase-sep hide-sm" />

                {/* 2. Brush Size */}
                <div className="scanner-erase-size">
                  <span className="scanner-erase-label">Size</span>
                  <input
                    type="range"
                    min={8}
                    max={60}
                    step={2}
                    value={brushPx}
                    onChange={(e) => setBrushPx(Number(e.target.value))}
                    aria-label="Brush size"
                    className="scanner-erase-slider"
                  />
                  <span className="scanner-erase-val">{brushPx}px</span>
                </div>

                <div className="scanner-erase-sep hide-sm" />

                {/* 3. Hardness / Feather button */}
                <button
                  type="button"
                  className={`btn quiet btn-sm scanner-hardness-btn${featherPopoverOpen ? ' active' : ''}`}
                  onClick={() => setFeatherPopoverOpen((o) => !o)}
                  title="Brush edge hardness (feathering)"
                  aria-expanded={featherPopoverOpen}
                >
                  <Feather size={13} />
                  <span>{Math.round(brushHardness * 100)}%</span>
                </button>

                <div className="scanner-erase-sep hide-sm" />

                {/* 4. Desktop Zoom Controls */}
                <div className="hidden md:flex items-center gap-0.5">
                  <button
                    type="button"
                    className="btn quiet btn-sm px-1.5"
                    onClick={() => zoomStep(1 / 1.4)}
                    disabled={zoomPct <= 1.001}
                    title="Zoom out"
                  >
                    <ZoomOut size={13} />
                  </button>
                  <span className="scanner-zoom-label text-xs font-semibold px-1" aria-live="off">{Math.round(zoomPct * 100)}%</span>
                  <button
                    type="button"
                    className="btn quiet btn-sm px-1.5"
                    onClick={() => zoomStep(1.4)}
                    disabled={zoomPct >= 7.999}
                    title="Zoom in"
                  >
                    <ZoomIn size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn quiet btn-sm px-1.5"
                    onClick={resetZoomTransform}
                    disabled={zoomPct <= 1.001}
                    title="Fit page"
                  >
                    <Maximize size={13} />
                  </button>
                </div>

                <div className="spacer hide-sm" />

                {/* 5. History & Exit */}
                <div className="scanner-erase-actions">
                  <div className="scanner-erase-actions-history">
                    <button
                      type="button"
                      className="btn quiet btn-sm"
                      onClick={undoErase}
                      disabled={!activePage || activePage.eraser.length === 0}
                      title="Undo last stroke"
                    >
                      <Undo2 size={13} /><span>Undo</span>
                    </button>
                    <button
                      type="button"
                      className="btn quiet btn-sm"
                      onClick={redoErase}
                      disabled={redoCount === 0}
                      title="Redo stroke"
                    >
                      <Redo2 size={13} /><span>Redo</span>
                    </button>
                    <button
                      type="button"
                      className="btn quiet btn-sm text-danger"
                      onClick={clearErase}
                      disabled={!activePage || activePage.eraser.length === 0}
                      title="Clear all strokes on this page"
                    >
                      <Trash2 size={13} /><span>Clear</span>
                    </button>
                  </div>
                  <button type="button" className="btn primary btn-sm scanner-erase-done" onClick={exitEraseMode}>
                    <Check size={14} /><span>Done</span>
                  </button>
                </div>
              </div>

              {/* Inline expandable Hardness / Feather drawer */}
              {featherPopoverOpen && (
                <div className="scanner-hardness-drawer animate-fadeIn" role="region" aria-label="Brush hardness settings">
                  <div className="scanner-hardness-drawer-title">
                    <Feather size={13} />
                    <span>Hardness:</span>
                  </div>
                  <span className="text-[11px] text-secondary">Soft</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={brushHardness}
                    onChange={(e) => setBrushHardness(Number(e.target.value))}
                    aria-label="Brush hardness"
                    className="scanner-hardness-slider"
                  />
                  <span className="text-[11px] text-secondary">Hard</span>
                  <span className="scanner-erase-val">{Math.round(brushHardness * 100)}%</span>
                  <button
                    type="button"
                    className="scanner-hardness-close"
                    onClick={() => setFeatherPopoverOpen(false)}
                    title="Close hardness slider"
                    aria-label="Close hardness slider"
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="scanner-page-actions">
              <button className="btn quiet btn-sm" onClick={enterCropMode} title="Crop / perspective">
                <CropIcon size={14} /><span className="hide-sm">Crop</span>
              </button>
              <button
                className="btn quiet btn-sm"
                onClick={enterEraseMode}
                disabled={!activePage}
                title="Clean up — erase marks and selectively restore erased parts"
              >
                <Eraser size={14} /><span className="hide-sm">Clean up</span>
              </button>
              <button
                type="button"
                className="btn quiet btn-sm"
                onClick={() => rotate(1)}
                disabled={!activePage}
                title="Rotate 90° clockwise"
              >
                <RotateCw size={14} /><span className="hide-sm">Rotate</span>
              </button>
              <div className="spacer" />
              <button
                className="btn quiet btn-sm danger-text"
                onClick={() => activePage && deletePage(activePage.id)}
                title="Delete this page"
              >
                <Trash2 size={14} /><span className="hide-sm">Delete page</span>
              </button>
            </div>
          )}
        </div>

        {/* Side panel: filters + adjustments — sidebar on desktop, bottom sheet on mobile */}
        {sheetOpen && (
          <div className="scanner-sheet-backdrop" onClick={() => setSheetOpen(false)} />
        )}
        <aside
          className={
            'scanner-side' +
            (sheetOpen ? ' sheet-open' : '')
          }
        >
          <div className="scanner-sheet-head">
            <strong>Filters & Adjust</strong>
            <button className="btn primary btn-sm" onClick={() => setSheetOpen(false)}>
              <Check size={14} /><span>Done</span>
            </button>
          </div>
          <section className="scanner-panel">
            <h3 className="scanner-panel-title"><ScanLine size={14} /> Filter</h3>
            <div className="scanner-filter-grid" role="group" aria-label="Scanner filters">
              {SCAN_FILTERS.map((f) => (
                <button
                  key={f.id}
                  className={'scanner-filter-tile' + (activePage?.filter === f.id ? ' on' : '')}
                  aria-pressed={activePage?.filter === f.id}
                  title={f.hint}
                  onClick={() => updateActivePage({ filter: f.id })}
                >
                  <span className="scanner-filter-thumb">
                    {filterThumbs[f.id] ? (
                      <img src={filterThumbs[f.id]} alt="" />
                    ) : (
                      <span className="scanner-filter-thumb-ph"><Loader2 size={14} className="spin" /></span>
                    )}
                  </span>
                  <span className="scanner-filter-name">{f.label}</span>
                </button>
              ))}
            </div>
            <p className="scanner-filter-hint">
              {SCAN_FILTERS.find((f) => f.id === activePage?.filter)?.hint}
            </p>

            <h3 className="scanner-panel-title" style={{ marginTop: '1.5rem' }}><SlidersHorizontal size={14} /> Adjust</h3>
            {ADJUSTMENT_CONTROLS.map((ctrl) => (
              <label key={ctrl.key} className="scanner-slider">
                <span>{ctrl.label}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={activePage?.adj[ctrl.key] ?? 50}
                  onChange={(e) => handleAdjust(ctrl.key, Number(e.target.value))}
                  disabled={!activePage}
                />
              </label>
            ))}

            <div className="scanner-panel-actions" style={{ marginTop: '1rem', borderTop: '1px solid var(--line)', paddingTop: '1rem' }}>
              <button className="btn quiet btn-sm" onClick={resetAdjustments}>
                <RefreshCcw size={13} /><span>Reset</span>
              </button>
              <button className="btn quiet btn-sm" onClick={() => { applyFilterToAll(); applyAdjustToAll(); }}>
                <Copy size={13} /><span>Apply All to All Pages</span>
              </button>
            </div>
          </section>

          <p className="scanner-side-note">
            Viewing <strong>{filterLabel}</strong>. Exports always use the full-resolution capture,
            not the preview.
          </p>
        </aside>
      </div>

      {/* Page strip */}
      {!eraseMode && !cropMode && (
        <div className="scanner-strip" role="listbox" aria-label="Scanned pages">
          {pages.map((page, idx) => (
            <div
              key={page.id}
              role="option"
              aria-selected={page.id === activePage?.id}
              tabIndex={0}
              className={'scanner-thumb' + (page.id === activePage?.id ? ' on' : '')}
              onClick={() => {
                  if (cropMode) { selectCropPage(page); return; }
                setActiveId(page.id);
                setCropMode(false);
                setEraseMode(false); // strokes live per page; switch re-enters cleanly
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                    if (cropMode) { selectCropPage(page); return; }
                  setActiveId(page.id);
                  setCropMode(false);
                  setEraseMode(false);
                }
              }}
            >
              <span className="scanner-thumb-num">{idx + 1}</span>
              <img
                src={page.thumbUrl || page.originalUrl}
                alt={`Page ${idx + 1}`}
                loading="lazy"
                decoding="async"
                style={{ transform: `rotate(${page.rotation}deg)` }}
              />
              <span className="scanner-thumb-filter">{SCAN_FILTERS.find((f) => f.id === page.filter)?.label}</span>
              <span className="scanner-thumb-actions">
                <button
                  title="Move earlier"
                  aria-label={`Move page ${idx + 1} earlier`}
                  disabled={idx === 0}
                  onClick={(e) => { e.stopPropagation(); movePage(page.id, -1); }}
                >
                  <ArrowLeft size={12} />
                </button>
                <button
                  title="Move later"
                  aria-label={`Move page ${idx + 1} later`}
                  disabled={idx === pages.length - 1}
                  onClick={(e) => { e.stopPropagation(); movePage(page.id, 1); }}
                >
                  <ArrowRight size={12} />
                </button>
                <button
                  className="danger-text"
                  title="Delete page"
                  aria-label={`Delete page ${idx + 1}`}
                  onClick={(e) => { e.stopPropagation(); deletePage(page.id); }}
                >
                  <Trash2 size={12} />
                </button>
              </span>
            </div>
          ))}
          <button
            className="scanner-thumb scanner-thumb-add"
            onClick={() => fileInputRef.current?.click()}
            title="Add images or a PDF"
            aria-label="Add more pages"
          >
            <Plus size={20} />
          </button>
        </div>
      )}

      {/* Mobile bottom action bar — Crop · Filters & Adjust · Erase · Rotate L/R ·
          Export (reference-style; hidden on desktop, and while cropping) */}
      <div className="scanner-mobile-bar" role="toolbar" aria-label="Scan actions">
        <button
          type="button"
          className="bar-btn"
          onClick={() => {
            if (cropMode) {
              cancelCrop();
            } else if (eraseMode) {
              exitEraseMode();
            } else if (sheetOpen) {
              setSheetOpen(false);
            } else if (onChangeAppMode) {
              onChangeAppMode('dashboard');
            }
          }}
          title="Back"
        >
          <ArrowLeft size={20} />
          <span>Back</span>
        </button>
        <button className="bar-btn" onClick={enterCropMode} disabled={!!busy}>
          <CropIcon size={20} /><span>Crop</span>
        </button>
        <button
          className={'bar-btn' + (sheetOpen ? ' active' : '')}
          aria-label="Filters and adjustments"
          aria-expanded={sheetOpen}
          onClick={() => setSheetOpen((o) => !o)}
          title="Filters & Adjust"
        >
          <SlidersHorizontal size={20} /><span className="bar-label-wrap">Filters &amp; Adjust</span>
        </button>
        <button className="bar-btn" onClick={enterEraseMode} disabled={!!busy}>
          <Eraser size={20} /><span>Erase</span>
        </button>
        <div className="scanner-export-wrap up">
          <button
            className="bar-btn primary"
            aria-haspopup="menu"
            aria-expanded={exportMenuOpen}
            disabled={!!busy}
            onClick={() => setExportMenuOpen((o) => !o)}
          >
            {busy ? <Loader2 size={20} className="spin" /> : <Download size={20} />}
            <span>Export</span>
          </button>
          {exportMenuOpen && (
            <>
              <div className="scanner-menu-backdrop" onClick={() => setExportMenuOpen(false)} />
              <div className="scanner-export-menu" role="menu" aria-label="Export format">
                {(['pdf', 'jpg', 'png'] as ExportFormat[]).map((fmt) => (
                  <button
                    key={fmt}
                    role="menuitem"
                    onClick={() => {
                      setExportMenuOpen(false);
                      void runExport(fmt);
                    }}
                  >
                    {fmt === 'pdf' ? <FileText size={15} /> : <ImageIcon size={15} />}
                    <span>Download as {fmt.toUpperCase()}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {isIosLikeBrowser() && pages.length > 1 && exportFormat !== 'pdf' && (
        <p className="scanner-mobile-note text-secondary text-[12.5px]">
          Multi-image exports on this device are packaged as a ZIP for reliability.
        </p>
      )}

      {renameOpen && (
        <RenameDialog
          initial={docName}
          onDone={setDocName}
          onClose={() => setRenameOpen(false)}
        />
      )}
    </div>
  );
}
