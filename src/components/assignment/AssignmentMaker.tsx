import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileImage, Loader2 } from 'lucide-react';
import './assignment.css';
import { useToast } from '../Toast';
import { ConfirmDialog } from '../ConfirmDialog';
import { loadHandwritingEngine, type HandwritingEngine } from '../../lib/handwriting/engine';
import { PAGE_SIZES, PAPER_TEMPLATES, findFont, findStockPaper, inkColor, stockLayout, type ActiveGuide, type Diagram, type HandwritingFont, type PageLayout } from '../../lib/handwriting/catalog';
import { clearMeasureCache, countMistakes, layoutForPage, registerCustomFont } from '../../lib/handwriting/compose';
import { computePageNumberPlacement, formatPageNumber, loadImage, tintDiagram } from '../../lib/handwriting/render';
import { exportAssignment, type ExportFormat } from '../../lib/handwriting/export';
import { detectRuling, layoutFromRuling } from '../../lib/handwriting/detectLines';
import { useAssignmentDoc } from './useAssignmentDoc';
import type { RulingStatus } from './LayoutPanel';
import { useHandwritingPages } from './useHandwritingPages';
import { PaperPicker } from './PaperPicker';
import { PageCanvas } from './PageCanvas';
import { TextPanel } from './TextPanel';
import { QuickBar } from './QuickBar';
import { MistakePanel } from './MistakePanel';
import { LayoutPanel } from './LayoutPanel';
import { FontPanel } from './FontPanel';
import { PenPanel } from './PenPanel';
import { StylePanel } from './StylePanel';
import { RealismPanel } from './RealismPanel';
import { ExportPanel } from './ExportPanel';
import { ExportMenu, HelpDialog, PageLayoutDialog, PaperDialog } from './dialogs';

// Panels only depend on settings + stable callbacks, so typing or page
// rendering progress shouldn't re-render them.
const QuickBarM = memo(QuickBar);
const TextPanelM = memo(TextPanel);
const MistakePanelM = memo(MistakePanel);
const FontPanelM = memo(FontPanel);
const PenPanelM = memo(PenPanel);
const StylePanelM = memo(StylePanel);
const LayoutPanelM = memo(LayoutPanel);
const RealismPanelM = memo(RealismPanel);

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

async function loadDownscaled(file: File, maxEdge: number): Promise<{ src: string; img: HTMLImageElement }> {
  const raw = await readAsDataUrl(file);
  const img = new Image();
  img.src = raw;
  await img.decode();
  const k = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  if (k >= 1) return { src: raw, img };
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * k);
  c.height = Math.round(img.naturalHeight * k);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  const src = c.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.92);
  const out = new Image();
  out.src = src;
  await out.decode();
  return { src, img: out };
}

export function AssignmentMaker() {
  const toast = useToast();
  const rootRef = useRef<HTMLDivElement>(null);
  const diagramInputRef = useRef<HTMLInputElement>(null);
  const diagramTarget = useRef(0);
  const [engine, setEngine] = useState<HandwritingEngine | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const { doc, update, updateSettings, undo, redo, reset, canUndo, canRedo } = useAssignmentDoc();
  const [photo, setPhoto] = useState<HTMLImageElement | null>(null);
  const [customFonts, setCustomFonts] = useState<HandwritingFont[]>([]);
  const [activePage, setActivePage] = useState(0);
  const [selectedDiagram, setSelectedDiagram] = useState<string | null>(null);
  const [layoutDialogPage, setLayoutDialogPage] = useState<number | null>(null);
  const [activeGuide, setActiveGuide] = useState<ActiveGuide>(null);
  const [paperDialog, setPaperDialog] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [exportBusy, setExportBusy] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [tinted, setTinted] = useState<Record<string, string>>({});
  const [previewScale] = useState(() => (window.matchMedia('(pointer: coarse)').matches ? 0.6 : 1));

  const s = doc.settings;
  const size = PAGE_SIZES[s.pageSize];
  const pagesRef = useRef<HTMLDivElement>(null);
  const visiblePages = useRef(new Set<number>([0]));
  const getVisiblePages = useCallback(() => [...visiblePages.current].sort((a, b) => a - b), []);
  const pages = useHandwritingPages(engine, doc, photo, customFonts, previewScale, getVisiblePages, activeGuide);
  const pageCount = pages.input?.layout.pages ?? pages.canvases.length;

  const movePageNumber = useCallback(
    (offsetX: number, offsetY: number) => updateSettings({ pageNumberOffsetX: offsetX, pageNumberOffsetY: offsetY }),
    [updateSettings],
  );

  useEffect(() => {
    const root = pagesRef.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const i = Array.prototype.indexOf.call(root.querySelectorAll('.am-page'), e.target);
          if (i < 0) continue;
          if (e.isIntersecting) visiblePages.current.add(i);
          else visiblePages.current.delete(i);
        }
      },
      { rootMargin: '400px 0px' },
    );
    visiblePages.current.clear();
    root.querySelectorAll('.am-page').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [pageCount, s.paper]);
  const color = inkColor(s);

  useEffect(() => {
    loadHandwritingEngine().then(setEngine, (e) => setEngineError(e instanceof Error ? e.message : 'Engine failed to load'));
  }, []);

  useEffect(() => {
    if (activePage > 0 && activePage >= pageCount) setActivePage(Math.max(0, pageCount - 1));
  }, [activePage, pageCount]);

  useEffect(() => {
    let cancelled = false;
    for (const d of doc.diagrams) {
      const key = `${d.id}|${color}`;
      if (d.tint && !tinted[key]) {
        tintDiagram(d.src, color).then((url) => {
          if (!cancelled) setTinted((prev) => ({ ...prev, [key]: url }));
        });
      }
    }
    return () => {
      cancelled = true;
    };
  }, [doc.diagrams, color, tinted]);

  const [rulingStatus, setRulingStatus] = useState<RulingStatus>(null);
  const layoutRef = useRef(s.layout);
  layoutRef.current = s.layout;
  const fontSizeRef = useRef(s.fontSize);
  fontSizeRef.current = s.fontSize;
  const paperKind = s.paper?.kind ?? null;

  useEffect(() => {
    if (!paperKind) return setRulingStatus(null);
    if (paperKind === 'template') return setRulingStatus('template');
    if (!s.snapToLines || !photo) return setRulingStatus(null);
    const ruling = detectRuling(photo, size.width, size.height);
    if (!ruling) return setRulingStatus('none');
    setRulingStatus('detected');
    const cur = layoutRef.current;
    const next = layoutFromRuling(ruling, cur, size.height);
    const changed = (Object.keys(next) as Array<keyof PageLayout>).some((k) => Math.abs(next[k] - cur[k]) > 0.5);
    const ratio = fontSizeRef.current / next.lineHeight;
    const patch: Partial<typeof s> = {};
    if (changed) patch.layout = next;
    if (ratio < 0.55 || ratio > 0.85) patch.fontSize = Math.round(next.lineHeight * 0.72);
    if (Object.keys(patch).length) updateSettings(patch, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.snapToLines, photo, paperKind, size.width, size.height, updateSettings]);

  const diagramsWithTint: Diagram[] = useMemo(
    () => doc.diagrams.map((d) => ({ ...d, tintedSrc: tinted[`${d.id}|${color}`] ?? null })),
    [doc.diagrams, tinted, color],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      // Text fields keep their native caret-aware undo; sliders, switches and buttons use document history.
      const editing = target.closest(
        'textarea, [contenteditable="true"], input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="color"]):not([type="file"]):not([type="button"])',
      );
      const mod = e.ctrlKey || e.metaKey;
      const key = e.code === 'KeyZ' ? 'z' : e.code === 'KeyY' ? 'y' : e.key.toLowerCase();
      if (mod && !e.altKey && (key === 'z' || key === 'y') && editing) return;
      if (mod && !e.altKey && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && !e.altKey && key === 'y') {
        e.preventDefault();
        redo();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedDiagram) {
        e.preventDefault();
        update((d) => ({ ...d, diagrams: d.diagrams.filter((x) => x.id !== selectedDiagram) }), false);
        setSelectedDiagram(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, update, selectedDiagram]);

  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else rootRef.current?.requestFullscreen?.().catch(() => toast.error('Fullscreen is not available in this browser.'));
  };

  const pickPhoto = useCallback(async (file: File) => {
    try {
      const { img } = await loadDownscaled(file, 2600);
      setPhoto(img);
      updateSettings({ paper: { kind: 'photo' }, showGuides: true }, false);
      setPaperDialog(false);
      toast.info('Photo added. Use the alignment guides and layout sliders to match its lines.');
    } catch {
      toast.error('That image could not be opened.');
    }
  }, [updateSettings, toast]);

  const stockId = s.paper?.kind === 'stock' ? s.paper.id : null;
  useEffect(() => {
    const paper = stockId ? findStockPaper(stockId) : undefined;
    if (!paper || photo?.src.endsWith(paper.src)) return;
    let cancelled = false;
    loadImage(paper.src).then(
      (img) => !cancelled && setPhoto(img),
      () => !cancelled && toast.error('That paper photo could not be loaded.'),
    );
    return () => {
      cancelled = true;
    };
  }, [stockId, photo, toast]);

  const pickStock = useCallback((id: string) => {
    const paper = findStockPaper(id);
    if (!paper) return;
    updateSettings({ paper: { kind: 'stock', id }, layout: stockLayout(paper, s.pageSize), fontSize: paper.fontSize, showGuides: false }, false);
    setPaperDialog(false);
  }, [updateSettings, s.pageSize]);

  const pickTemplate = useCallback((id: number) => {
    updateSettings({ paper: { kind: 'template', template: id } }, false);
    setPaperDialog(false);
  }, [updateSettings]);

  const uploadFont = async (file: File) => {
    try {
      const family = await registerCustomFont(file);
      clearMeasureCache(family);
      setCustomFonts((prev) => [{ family, label: family.replace(/^Custom /, ''), category: 'print', sizeAdjust: 1, custom: true }, ...prev.filter((f) => f.family !== family)]);
      updateSettings({ fontFamily: family }, false);
      toast.success('Your handwriting font is ready.');
    } catch {
      toast.error('That font file could not be loaded. Use a .ttf or .otf file.');
    }
  };

  const uploadFontLatest = useRef(uploadFont);
  uploadFontLatest.current = uploadFont;
  const uploadFontRef = useCallback((file: File) => uploadFontLatest.current(file), []);

  const openDiagramPicker = (page: number) => {
    diagramTarget.current = page;
    diagramInputRef.current?.click();
  };

  const addDiagram = async (file: File) => {
    try {
      const { src, img } = await loadDownscaled(file, 1600);
      const w = size.width * 0.42;
      const h = w * (img.naturalHeight / img.naturalWidth);
      const page = Math.min(diagramTarget.current, Math.max(0, pageCount - 1));
      const L = layoutForPage(s, doc.overrides, page);
      const diagram: Diagram = {
        id: `dg-${Date.now().toString(36)}`,
        page,
        src,
        tintedSrc: null,
        tint: false,
        x: (size.width - w) / 2,
        y: Math.min(size.height - h - L.marginBottom, L.marginTop + L.lineHeight * 4),
        w,
        h,
        opacity: 1,
      };
      update((d) => ({ ...d, diagrams: [...d.diagrams, diagram] }), false);
      setSelectedDiagram(diagram.id);
      setActivePage(page);
    } catch {
      toast.error('That image could not be added.');
    }
  };

  const changeDiagram = (id: string, patch: Partial<Diagram>) =>
    update((d) => ({ ...d, diagrams: d.diagrams.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));

  const onText = useCallback((t: string, coalesce = true) => update((d) => ({ ...d, text: t }), coalesce), [update]);
  const clearOverrides = useCallback(() => update((d) => ({ ...d, overrides: {} }), false), [update]);

  const runExport = async (format: ExportFormat, scope: 'all' | 'active') => {
    if (!pages.input) return;
    const list = scope === 'active' ? [Math.min(activePage, pageCount - 1)] : Array.from({ length: pageCount }, (_, i) => i);
    setExportBusy('Preparing…');
    try {
      await exportAssignment(pages.input, diagramsWithTint, format, list, (done, total) => setExportBusy(`Page ${done}/${total}`));
      toast.success(format === 'pdf' ? 'PDF downloaded.' : 'Download ready.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setExportBusy(null);
    }
  };

  const setOverride = (page: number, layout: PageLayout | null) =>
    update((d) => {
      const overrides = { ...d.overrides };
      if (layout) overrides[page] = layout;
      else delete overrides[page];
      return { ...d, overrides };
    });

  const paperName = s.paper?.kind === 'photo'
    ? 'Your photo'
    : s.paper?.kind === 'stock'
      ? findStockPaper(s.paper.id)?.name
      : PAPER_TEMPLATES.find((t) => s.paper?.kind === 'template' && t.id === s.paper.template)?.name;
  const selectedPaper = !s.paper ? null : s.paper.kind === 'photo' ? 'photo' : s.paper.kind === 'stock' ? s.paper.id : s.paper.template;
  const mistakeCounts = useMemo(() => (pages.input ? countMistakes(pages.input.layout) : null), [pages.input]);

  return (
    <div className="am-root" ref={rootRef}>
      <QuickBarM
        settings={s}
        onSettings={updateSettings}  
    canUndo={canUndo}
    canRedo={canRedo}
    undo={undo}
    redo={redo}
    onAddDiagram={() => openDiagramPicker(activePage)}
    diagramDisabled={!s.paper}
    exportMenu={
      <ExportMenu
        disabled={!s.paper || !pages.input}
        busy={exportBusy}
        pageCount={pageCount}
        onExport={runExport}
      />
    }
    onShuffle={() => updateSettings({ seed: Math.floor(Math.random() * 1_000_000) }, false)}
    onHelp={() => setHelpOpen(true)}
    fullscreen={fullscreen}
    onToggleFullscreen={toggleFullscreen}
    onReset={() => setConfirmReset(true)}
      />

      <div className="am-body">
        <div className="am-stage">
          {engineError ? (
            <div className="am-state" role="alert">
              <h2>The handwriting engine could not start</h2>
              <p>{engineError}. Reload the page to try again.</p>
            </div>
          ) : !s.paper ? (
            <PaperPicker engine={engine} pageSize={s.pageSize} selected={selectedPaper} onPickTemplate={pickTemplate} onPickStock={pickStock} onPickPhoto={pickPhoto} />
          ) : (
            <div className="am-pages" ref={pagesRef}>
              <div className="am-stage-bar">
                <button type="button" className="am-paper-chip" onClick={() => setPaperDialog(true)}>
                  <FileImage size={14} />{paperName ?? 'Paper'}<span>Change</span>
                </button>
                <span className="am-status" aria-live="polite">
                  {pages.rendering || !engine ? <><Loader2 size={14} className="am-spin" />Writing…</> : `${pageCount} ${pageCount === 1 ? 'page' : 'pages'} · ${size.label}`}
                </span>
              </div>
              {pages.error && <p className="am-error" role="alert">{pages.error}</p>}
              {doc.text.trim() === '' && <p className="am-empty-hint">Start typing in the panel to see your handwriting appear.</p>}
              {Array.from({ length: Math.max(1, pageCount) }, (_, i) => {
                const fontA = findFont(s.fontFamily, customFonts);
                const numScale = s.pageNumberScale || 0.82;
                const fontPx = s.fontSize * numScale * fontA.sizeAdjust;
                const label = s.pageNumbers ? formatPageNumber(s, i, Math.max(1, pageCount)) : '';
                const estW = label ? Math.max(24, label.length * fontPx * 0.48) : 0;
                const pageNumBox = s.pageNumbers
                  ? computePageNumberPlacement(s, doc.overrides, i, estW, fontPx)
                  : null;
                return (
                <PageCanvas
                  key={i}
                  canvas={pages.canvases[i]}
                  index={i}
                  pageCount={Math.max(1, pageCount)}
                  pageW={size.width}
                  pageH={size.height}
                  diagrams={diagramsWithTint.filter((d) => d.page === i)}
                  selectedDiagram={selectedDiagram}
                  hasOverride={Boolean(doc.overrides[i])}
                  active={i === activePage}
                  pageNumberBox={pageNumBox}
                  pageNumberOffsetX={s.pageNumberOffsetX}
                  pageNumberOffsetY={s.pageNumberOffsetY}
                  onMovePageNumber={movePageNumber}
                  onActiveGuide={setActiveGuide}
                  onActivate={() => setActivePage(i)}
                  onSelectDiagram={setSelectedDiagram}
                  onChangeDiagram={changeDiagram}
                  onDeleteDiagram={(id) => {
                    update((d) => ({ ...d, diagrams: d.diagrams.filter((x) => x.id !== id) }), false);
                    setSelectedDiagram(null);
                  }}
                  onAddDiagram={() => openDiagramPicker(i)}
                  onCustomize={() => setLayoutDialogPage(i)}
                  onDownload={() => {
                    setActivePage(i);
                    if (!pages.input) return;
                    setExportBusy('Preparing…');
                    exportAssignment(pages.input, diagramsWithTint, 'jpg', [i])
                      .catch(() => toast.error('Export failed.'))
                      .finally(() => setExportBusy(null));
                  }}
                />
                );
              })}
            </div>
          )}
        </div>

        <aside className="am-sidebar" aria-label="Handwriting settings">
          <TextPanelM
            text={doc.text}
            pages={pageCount || 1}
            settings={s}
            onText={onText}
            onSettings={updateSettings}
          />
          <MistakePanelM settings={s} counts={mistakeCounts} onSettings={updateSettings} />
          <FontPanelM settings={s} customFonts={customFonts} onSettings={updateSettings} onUploadFont={uploadFontRef} />
          <PenPanelM settings={s} onSettings={updateSettings} />
          <StylePanelM settings={s} onSettings={updateSettings} />
          <LayoutPanelM
            settings={s}
            overrideCount={Object.keys(doc.overrides).length}
            rulingStatus={rulingStatus}
            onSettings={updateSettings}
            onClearOverrides={clearOverrides}
            onActiveGuide={setActiveGuide}
          />
          <RealismPanelM settings={s} onSettings={updateSettings} onActiveGuide={setActiveGuide} />
          <ExportPanel
            settings={s}
            onSettings={updateSettings}
            pageCount={pageCount}
            busy={exportBusy}
            disabled={!s.paper || !pages.input}
            onExport={runExport}
          />
        </aside>
      </div>

      <input
        ref={diagramInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void addDiagram(f);
        }}
      />

      {layoutDialogPage !== null && (
        <PageLayoutDialog
          page={layoutDialogPage}
          layout={layoutForPage(s, doc.overrides, layoutDialogPage)}
          isCustom={Boolean(doc.overrides[layoutDialogPage])}
          onChange={(l) => setOverride(layoutDialogPage, l)}
          onReset={() => setOverride(layoutDialogPage, null)}
          onClose={() => {
            setActiveGuide(null);
            setLayoutDialogPage(null);
          }}
          onActiveGuide={setActiveGuide}
        />
      )}
      {paperDialog && (
        <PaperDialog onClose={() => setPaperDialog(false)}>
          <PaperPicker engine={engine} pageSize={s.pageSize} selected={selectedPaper} onPickTemplate={pickTemplate} onPickStock={pickStock} onPickPhoto={pickPhoto} compact />
        </PaperDialog>
      )}
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
      {confirmReset && (
        <ConfirmDialog
          title="Reset this document?"
          message="Your text, diagrams, page customizations and style settings will be cleared. You can undo this."
          confirmLabel="Reset"
          danger
          onConfirm={() => {
            reset();
            setSelectedDiagram(null);
          }}
          onClose={() => setConfirmReset(false)}
        />
      )}
    </div>
  );
}
