import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileImage, Loader2, Move, RotateCcw, Shapes } from 'lucide-react';
import './assignment.css';
import { useToast } from '../Toast';
import { ConfirmDialog } from '../ConfirmDialog';
import { loadHandwritingEngine, type HandwritingEngine } from '../../lib/handwriting/engine';
import { DEFAULT_ADJUST, PAGE_SIZES, PAPER_TEMPLATES, findFont, findStockPaper, inkColor, isNeutralAdjust, samePaper, stockLayout, type ActiveGuide, type ArrangeMode, type Diagram, type TextOffset, type HandwritingFont, type ImageAdjust, type PageLayout, type PaperChoice } from '../../lib/handwriting/catalog';
import { clearMeasureCache, countMistakes, layoutForPage, registerCustomFont, registerFontBuffer } from '../../lib/handwriting/compose';
import { computePageNumberPlacement, formatPageNumber, loadImage, pageImageKey, paperForPage, tintDiagram } from '../../lib/handwriting/render';
import { effectivePageSeed, lookTransformCss, pageLook, pickRerollSeed, type PageVariation } from '../../lib/handwriting/variation';
import { exportAssignment, type ExportFormat } from '../../lib/handwriting/export';
import { runInBackground } from '../../lib/backgroundTask';
import { detectRuling, type DetectedRuling } from '../../lib/handwriting/detectLines';
import { docOnLines, pageWritesOnLines, templateLineStep } from '../../lib/handwriting/snapLines';
import { useAssignmentDoc } from './useAssignmentDoc';
import type { RulingStatus } from './LayoutPanel';
import { useHandwritingPages } from './useHandwritingPages';
import { PaperPicker } from './PaperPicker';
import { PageCanvas } from './PageCanvas';
import { TextArrangeLayer, blocksForMode, clampDelta, selectionBounds, shiftedOffsets, type MarginBox } from './TextArrangeLayer';
import { TextPanel } from './TextPanel';
import { QuickBar } from './QuickBar';
import { MistakePanel } from './MistakePanel';
import { LayoutPanel } from './LayoutPanel';
import { FontPanel } from './FontPanel';
import { PenPanel } from './PenPanel';
import { StylePanel } from './StylePanel';
import { RealismPanel } from './RealismPanel';
import { ExportPanel } from './ExportPanel';
import { RenameAssignment } from './RenameAssignment';
import { ExportMenu, HelpDialog, PageAdjustDialog, PageLayoutDialog, PaperDialog, type PageLookControls } from './dialogs';
import { SampleFontDialog } from './SampleFontDialog';
import { MobileTabs, type MobileView } from './MobileTabs';

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
  const [adjustDialogPage, setAdjustDialogPage] = useState<number | null>(null);
  const [activeGuide, setActiveGuide] = useState<ActiveGuide>(null);
  const [paperDialog, setPaperDialog] = useState(false);
  const [pagePaperDialog, setPagePaperDialog] = useState<number | null>(null);
  const [pageImages, setPageImages] = useState<Record<string, HTMLImageElement>>({});
  const [helpOpen, setHelpOpen] = useState(false);
  const [sampleFontOpen, setSampleFontOpen] = useState(false);
  const openSampleFont = useCallback(() => setSampleFontOpen(true), []);
  const [confirmReset, setConfirmReset] = useState(false);
  const [exportBusy, setExportBusy] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [tinted, setTinted] = useState<Record<string, string>>({});
  const [mobileView, setMobileView] = useState<MobileView>('preview');
  const [previewScale] = useState(() => (window.matchMedia('(pointer: coarse)').matches ? 0.6 : 1));

  const s = doc.settings;
  const size = PAGE_SIZES[s.pageSize];
  const pagesRef = useRef<HTMLDivElement>(null);
  const visiblePages = useRef(new Set<number>([0]));
  const getVisiblePages = useCallback(() => [...visiblePages.current].sort((a, b) => a - b), []);
  const rulingCache = useRef(new WeakMap<HTMLImageElement, { size: string; ruling: DetectedRuling | null }>());
  const rulingForImage = useCallback(
    (img: HTMLImageElement): DetectedRuling | null => {
      const sizeKey = `${size.width}x${size.height}`;
      const cached = rulingCache.current.get(img);
      if (cached && cached.size === sizeKey) return cached.ruling;
      const ruling = detectRuling(img, size.width, size.height);
      rulingCache.current.set(img, { size: sizeKey, ruling });
      return ruling;
    },
    [size.width, size.height],
  );
  /** Ruling of a page's own paper; page -1 means the document paper. */
  const rulingForPage = useCallback(
    (page: number): DetectedRuling | null => {
      const paper = page < 0 ? s.paper : paperForPage(s, doc.pagePapers, page);
      if (!paper || paper.kind === 'template') return null;
      const own = page < 0 ? undefined : doc.pagePapers[page];
      if (own && !samePaper(own, s.paper)) {
        const key = pageImageKey(own);
        const img = key ? pageImages[key] : null;
        return img ? rulingForImage(img) : null;
      }
      return photo ? rulingForImage(photo) : null;
    },
    [s, doc.pagePapers, pageImages, photo, rulingForImage],
  );
  const drawnDoc = useMemo(
    () => docOnLines(doc, rulingForPage, (page) => paperForPage(s, doc.pagePapers, page)),
    [doc, s, rulingForPage],
  );
  const drawn = drawnDoc.settings;
  const pages = useHandwritingPages(engine, drawnDoc, photo, pageImages, customFonts, previewScale, getVisiblePages, activeGuide, doc);
  const pageCount = pages.input?.layout.pages ?? pages.canvases.length;

  const [arrangeMode, setArrangeMode] = useState<ArrangeMode>('line');
  const [arrangeSel, setArrangeSel] = useState<{ page: number; ids: string[] }>({ page: 0, ids: [] });
  const changeArrangeMode = useCallback((mode: ArrangeMode) => {
    setArrangeMode(mode);
    setArrangeSel({ page: 0, ids: [] });
  }, []);
  const clearArrange = useCallback(() => setArrangeSel((cur) => (cur.ids.length ? { page: cur.page, ids: [] } : cur)), []);
  const moveText = useCallback(
    (patch: Record<string, TextOffset>) =>
      update((d) => {
        let textOffsets = d.textOffsets;
        for (const [id, o] of Object.entries(patch)) {
          const remove = Math.abs(o.x) < 0.05 && Math.abs(o.y) < 0.05;
          const previous = d.textOffsets[id];
          if (remove ? !previous : previous?.x === o.x && previous?.y === o.y) continue;
          if (textOffsets === d.textOffsets) textOffsets = { ...textOffsets };
          if (remove) delete textOffsets[id];
          else textOffsets[id] = o;
        }
        return textOffsets === d.textOffsets ? d : { ...d, textOffsets };
      }),
    [update],
  );
  const resetTextOffsets = () => {
    update((d) => ({ ...d, textOffsets: {} }), false);
    setArrangeSel({ page: 0, ids: [] });
  };
  const movedCount = Object.keys(doc.textOffsets).length;
  // Text moves freely anywhere on the sheet, on every page, regardless of its margins or rules.
  const marginBoxFor = (_page: number): MarginBox => ({ left: 0, top: 0, right: size.width, bottom: size.height });

  const lineStepRef = useRef<(page: number) => number | null>(() => null);
  const nudgeRef = useRef({ sel: arrangeSel, mode: arrangeMode, input: pages.input, offsets: drawnDoc.textOffsets, box: marginBoxFor(arrangeSel.page) });
  nudgeRef.current = { sel: arrangeSel, mode: arrangeMode, input: pages.input, offsets: drawnDoc.textOffsets, box: marginBoxFor(arrangeSel.page) };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { sel, mode, input, offsets, box } = nudgeRef.current;
      if (!sel.ids.length) return;
      const target = e.target as HTMLElement;
      if (target.closest('textarea, input, select, [contenteditable="true"], [role="dialog"]')) return;
      if (e.key === 'Escape') {
        setArrangeSel({ page: sel.page, ids: [] });
        return;
      }
      const dir: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const d = dir[e.key];
      if (!d || !input) return;
      const bounds = selectionBounds(blocksForMode(input.layout.blocks[sel.page], mode), sel.ids);
      if (!bounds) return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 2;
      const [dx, dy] = clampDelta(bounds, box, d[0] * step, d[1] * step, null);
      if (dx || dy) moveText(shiftedOffsets(sel.ids, offsets, dx, dy));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [moveText]);

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

  const rulingStatus: RulingStatus = !s.paper
    ? null
    : s.paper.kind === 'template'
      ? 'template'
      : !s.snapToLines || !photo
        ? null
        : rulingForPage(-1) ? 'detected' : 'none';

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
    update((d) => ({ ...d, settings: { ...d.settings, paper: { kind: 'template', template: id }, layout: { ...d.settings.layout, angle: 0 } } }), false);
    setPaperDialog(false);
  }, [update]);

  const pageStockKey = Object.values(doc.pagePapers)
    .flatMap((p) => (p.kind === 'stock' ? [p.id] : []))
    .sort()
    .join(',');
  useEffect(() => {
    const ids = pageStockKey ? [...new Set(pageStockKey.split(','))] : [];
    let cancelled = false;
    for (const id of ids) {
      const paper = findStockPaper(id);
      const key = `stock:${id}`;
      if (!paper || pageImages[key]) continue;
      loadImage(paper.src).then(
        (img) => !cancelled && setPageImages((prev) => ({ ...prev, [key]: img })),
        () => !cancelled && toast.error('That paper photo could not be loaded.'),
      );
    }
    return () => {
      cancelled = true;
    };
  }, [pageStockKey, pageImages, toast]);

  const setPagePaper = useCallback(
    (page: number, paper: PaperChoice | null, layout?: PageLayout) => {
      update((d) => {
        const pagePapers = { ...d.pagePapers };
        const overrides = { ...d.overrides };
        const previous = pagePapers[page];
        const useDocPaper = !paper || samePaper(paper, d.settings.paper);
        if (useDocPaper) delete pagePapers[page];
        else pagePapers[page] = paper;
        // A stock photo's layout follows its printed lines; drop it once the page leaves that photo.
        if (layout && !useDocPaper) overrides[page] = layout;
        else if (previous?.kind === 'stock' && !samePaper(previous, paper)) delete overrides[page];
        return { ...d, pagePapers, overrides };
      }, false);
      setPagePaperDialog(null);
    },
    [update],
  );

  const pickPagePhoto = useCallback(
    async (page: number, file: File) => {
      try {
        const { img } = await loadDownscaled(file, 2600);
        const photoId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        setPageImages((prev) => ({ ...prev, [`photo:${photoId}`]: img }));
        setPagePaper(page, { kind: 'photo', photoId });
        toast.info(`Photo set as the paper for page ${page + 1}.`);
      } catch {
        toast.error('That image could not be opened.');
      }
    },
    [setPagePaper, toast],
  );

  const paperLabel = (paper: PaperChoice | null | undefined) =>
    !paper
      ? null
      : paper.kind === 'photo'
        ? 'Your photo'
        : paper.kind === 'stock'
          ? findStockPaper(paper.id)?.name ?? 'Paper photo'
          : PAPER_TEMPLATES.find((t) => t.id === paper.template)?.name ?? 'Template';

  const addCustomFamily = (family: string) => {
    clearMeasureCache(family);
    setCustomFonts((prev) => [{ family, label: family.replace(/^Custom /, ''), category: 'print', sizeAdjust: 1, custom: true }, ...prev.filter((f) => f.family !== family)]);
    updateSettings({ fontFamily: family }, false);
  };

  const uploadFont = async (file: File) => {
    try {
      addCustomFamily(await registerCustomFont(file));
      toast.success('Your handwriting font is ready.');
    } catch {
      toast.error('That font file could not be loaded. Use a .ttf or .otf file.');
    }
  };

  const addGeneratedFont = async (name: string, buffer: ArrayBuffer) => {
    addCustomFamily(await registerFontBuffer(name, buffer));
    setSampleFontOpen(false);
    toast.success(`"${name}" was added to your fonts.`);
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
      setMobileView('preview');
    } catch {
      toast.error('That image could not be added.');
    }
  };

  const changeDiagram = (id: string, patch: Partial<Diagram>) =>
    update((d) => ({ ...d, diagrams: d.diagrams.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));

  const onText = useCallback((t: string, coalesce = true) => update((d) => ({ ...d, text: t }), coalesce), [update]);
  const clearOverrides = useCallback(() => update((d) => ({ ...d, overrides: {}, pageSnapToLines: {} }), false), [update]);

  const runExport = async (format: ExportFormat, scope: 'all' | 'active') => {
    if (!pages.input) return;
    const list = scope === 'active' ? [Math.min(activePage, pageCount - 1)] : Array.from({ length: pageCount }, (_, i) => i);
    setExportBusy('Preparing…');
    try {
      const input = pages.input;
      await runInBackground(() => exportAssignment(input, diagramsWithTint, format, list, (done, total) => setExportBusy(`Page ${done}/${total}`)));
      toast.success(format === 'pdf' ? 'PDF downloaded.' : 'Download ready.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setExportBusy(null);
    }
  };

  const setPageLayout = (page: number, layout: PageLayout) => setOverride(page, layout);

  /** Line pitch a page's text must move in so it stays on the rules, or null when free. */
  const lineStepFor = (page: number): number | null => {
    const paper = paperForPage(s, doc.pagePapers, page);
    if (!paper || !pageWritesOnLines(doc, page, paper)) return null;
    const layout = layoutForPage(drawn, drawnDoc.overrides, page);
    return templateLineStep(paper, layout) ?? (rulingForPage(page) ? layout.lineHeight : null);
  };
  lineStepRef.current = lineStepFor;

  const rerollAllLooks = useCallback(
    () =>
      update(
        (d) => ({
          ...d,
          settings: {
            ...d.settings,
            variation: (d.settings.variation ?? 'off') === 'off' ? 'natural' : d.settings.variation,
            variationSeed: 1 + Math.floor(Math.random() * 999_999_999),
          },
          pageVariation: {},
        }),
        false,
      ),
    [update],
  );
  const setAllNoVariation = useCallback(
    () =>
      update((d) => ({ ...d, settings: { ...d.settings, variationSeed: 0 }, pageVariation: {} }), false),
    [update],
  );

  const setOverride = (page: number, layout: PageLayout | null) =>
    update((d) => {
      const overrides = { ...d.overrides };
      if (layout) overrides[page] = layout;
      else delete overrides[page];
      return { ...d, overrides };
    });

  const setPageAdjust = (page: number, adjust: ImageAdjust | null) =>
    update((d) => {
      const pageAdjust = { ...d.pageAdjust };
      if (adjust && !isNeutralAdjust(adjust)) pageAdjust[page] = adjust;
      else delete pageAdjust[page];
      return { ...d, pageAdjust };
    }, Boolean(adjust));

  const setPageVariation = (page: number, pv: PageVariation | null) =>
    update((d) => {
      const pageVariation = { ...d.pageVariation };
      if (pv) pageVariation[page] = pv;
      else delete pageVariation[page];
      return { ...d, pageVariation };
    }, false);

  const pageLookControls = (page: number): PageLookControls => {
    const pv = doc.pageVariation[page];
    return {
      enabled: true,
      state: pv?.off ? 'off' : pv?.seed !== undefined ? 'locked' : 'auto',
      onReroll: () => update((d) => {
        const strength = !d.settings.variation || d.settings.variation === 'off' ? 'natural' : d.settings.variation;
        const lookAt = (i: number) => i < 0 || i >= pageCount ? null
          : pageLook(strength, d.settings.variationSeed ?? 0, d.pageVariation[i], i, size.width, size.height);
        const seed = pickRerollSeed(strength, lookAt(page), [lookAt(page - 1), lookAt(page + 1)], page, size.width, size.height);
        return {
          ...d,
          settings: { ...d.settings, variation: strength },
          pageVariation: { ...d.pageVariation, [page]: { seed } },
        };
      }, false),
      onLock: (locked) =>
        setPageVariation(page, locked
          ? pv?.seed !== undefined ? { seed: pv.seed } : s.variationSeed ? { seed: effectivePageSeed(s.variationSeed, undefined, page) } : { off: true }
          : null),
      onOff: (off) => setPageVariation(page, off ? { off: true } : null),
      onReset: () => setPageVariation(page, null),
    };
  };

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
      <>
        <ExportMenu
          disabled={!s.paper || !pages.input}
          busy={exportBusy}
          pageCount={pageCount}
          onExport={runExport}
        />
        <RenameAssignment name={s.fileName} disabled={!!exportBusy} onRename={(fileName) => updateSettings({ fileName })} />
      </>
    }
    onShuffle={() => updateSettings({ seed: Math.floor(Math.random() * 1_000_000) }, false)}
    onHelp={() => setHelpOpen(true)}
    fullscreen={fullscreen}
    onToggleFullscreen={toggleFullscreen}
    onReset={() => setConfirmReset(true)}
    arrangeMode={arrangeMode}
    onArrangeMode={changeArrangeMode}
      />

      <div className="am-body" data-mobile-view={mobileView}>
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
                <div className="am-arrange-bar">
                  <span className="am-arrange-hint hide-sm">
                    <Move size={13} aria-hidden="true" />
                    Drag {arrangeMode === 'line' ? 'lines' : arrangeMode === 'word' ? 'words' : 'the page text'}
                    {arrangeMode !== 'page' && <> · <kbd>Shift</kbd>+click to group</>}
                  </span>
                  {movedCount > 0 && (
                    <button type="button" className="am-arrange-reset" onClick={resetTextOffsets}>
                      <RotateCcw size={13} />Reset positions
                    </button>
                  )}
                  <span className="am-status" aria-live="polite">
                    {pages.rendering || !engine ? <><Loader2 size={14} className="am-spin" />Writing…</> : `${pageCount} ${pageCount === 1 ? 'page' : 'pages'} · ${size.label}`}
                  </span>
                </div>
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
                  ? computePageNumberPlacement(s, doc.overrides, i, estW, fontPx, paperForPage(s, doc.pagePapers, i))
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
                  paperLabel={doc.pagePapers[i] && !samePaper(doc.pagePapers[i], s.paper) ? paperLabel(doc.pagePapers[i]) : null}
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
                  onChangePaper={() => {
                    setActivePage(i);
                    setPagePaperDialog(i);
                  }}
                  onCustomize={() => setLayoutDialogPage(i)}
                  onClearArrange={clearArrange}
                  arrangeLayer={
                    <TextArrangeLayer
                      mode={arrangeMode}
                      blocks={pages.input?.layout.blocks[i]}
                      pageW={size.width}
                      pageH={size.height}
                      marginBox={marginBoxFor(i)}
                      selection={arrangeSel.page === i ? arrangeSel.ids : []}
                      offsets={drawnDoc.textOffsets}
                      layout={layoutForPage(drawn, drawnDoc.overrides, i)}
                      onSelect={(ids) => setArrangeSel({ page: i, ids })}
                      onMove={moveText}
                    />
                  }
                  hasAdjust={!isNeutralAdjust(doc.pageAdjust[i])}
                  lookTransform={lookTransformCss(
                    pageLook(s.variation, s.variationSeed ?? 0, doc.pageVariation[i], i, size.width, size.height),
                  )}
                  lookLabel={
                    (s.variation ?? 'off') === 'off'
                      ? null
                      : doc.pageVariation[i]?.off
                        ? 'No variation'
                        : doc.pageVariation[i]?.seed !== undefined
                          ? 'Locked look'
                          : null
                  }
                  onAdjust={() => {
                    setActivePage(i);
                    setAdjustDialogPage(i);
                  }}
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
          <FontPanelM settings={s} customFonts={customFonts} onSettings={updateSettings} onUploadFont={uploadFontRef} onMakeFont={openSampleFont} />
          <PenPanelM settings={s} onSettings={updateSettings} />
          <StylePanelM settings={s} onSettings={updateSettings} />
          <LayoutPanelM
            settings={s}
            overrideCount={new Set([...Object.keys(doc.overrides), ...Object.keys(doc.pageSnapToLines ?? {})]).size}
            rulingStatus={rulingStatus}
firstBaseline={drawn.layout.marginTop}
            onSettings={updateSettings}
              onClearOverrides={clearOverrides}
              onActiveGuide={setActiveGuide}
              pageLookCount={Object.keys(doc.pageVariation).length}
              onRerollAllLooks={rerollAllLooks}
              onAllNoVariation={setAllNoVariation}
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

      <MobileTabs view={mobileView} onChange={setMobileView} pageCount={s.paper ? Math.max(1, pageCount) : null} />


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
pageSize={s.pageSize}
firstBaseline={layoutForPage(drawn, drawnDoc.overrides, layoutDialogPage).marginTop}
isCustom={Boolean(doc.overrides[layoutDialogPage]) || doc.pageSnapToLines?.[layoutDialogPage] !== undefined}
          snapped={lineStepFor(layoutDialogPage) !== null}
          writeWithinLines={pageWritesOnLines(doc, layoutDialogPage, paperForPage(s, doc.pagePapers, layoutDialogPage))}
          onWriteWithinLines={(enabled) => update((d) => ({ ...d, pageSnapToLines: { ...d.pageSnapToLines, [layoutDialogPage]: enabled } }), false)}
          look={pageLookControls(layoutDialogPage)}
          onChange={(l) => setPageLayout(layoutDialogPage, l)}
          onReset={() => update((d) => {
            const overrides = { ...d.overrides };
            const pageSnapToLines = { ...d.pageSnapToLines };
            delete overrides[layoutDialogPage];
            delete pageSnapToLines[layoutDialogPage];
            return { ...d, overrides, pageSnapToLines };
          }, false)}
          onClose={() => {
            setActiveGuide(null);
            setLayoutDialogPage(null);
          }}
          onActiveGuide={setActiveGuide}
        />
      )}
      {adjustDialogPage !== null && (
        <PageAdjustDialog
          page={adjustDialogPage}
          value={doc.pageAdjust[adjustDialogPage] ?? DEFAULT_ADJUST}
          onChange={(a) => setPageAdjust(adjustDialogPage, a)}
          onReset={() => setPageAdjust(adjustDialogPage, null)}
          look={pageLookControls(adjustDialogPage)}
          onClose={() => {
            setActiveGuide(null);
            setAdjustDialogPage(null);
          }}
          onActiveGuide={setActiveGuide}
        />
      )}
      {paperDialog && (
        <PaperDialog onClose={() => setPaperDialog(false)}>
          <PaperPicker engine={engine} pageSize={s.pageSize} selected={selectedPaper} onPickTemplate={pickTemplate} onPickStock={pickStock} onPickPhoto={pickPhoto} compact />
        </PaperDialog>
      )}
      {pagePaperDialog !== null && (() => {
        const page = pagePaperDialog;
        const own = doc.pagePapers[page];
        const hasOwn = Boolean(own && !samePaper(own, s.paper));
        const current = paperForPage(s, doc.pagePapers, page);
        const selected = !current ? null : current.kind === 'photo' ? (hasOwn ? 'photo' : null) : current.kind === 'stock' ? current.id : current.template;
        return (
          <PaperDialog title={`Choose paper for page ${page + 1}`} onClose={() => setPagePaperDialog(null)}>
            <div className="am-page-paper-bar">
              <p>
                {hasOwn
                  ? <>This page uses <strong>{paperLabel(own)}</strong>. Other pages keep <strong>{paperName ?? 'the document paper'}</strong>.</>
                  : <>Only page {page + 1} changes. Other pages keep <strong>{paperName ?? 'the document paper'}</strong>.</>}
              </p>
              <div className="am-page-paper-actions">
                {hasOwn && (
                  <button type="button" className="btn secondary" onClick={() => setPagePaper(page, null)}>
                    <RotateCcw size={14} />Use document paper
                  </button>
                )}
                <button
                  type="button"
                  className="btn secondary"
                  onClick={() => {
                    setPagePaperDialog(null);
                    openDiagramPicker(page);
                  }}
                >
                  <Shapes size={14} />Insert image as diagram
                </button>
              </div>
            </div>
            <PaperPicker
              engine={engine}
              pageSize={s.pageSize}
              selected={selected}
              onPickTemplate={(id) => setPagePaper(page, { kind: 'template', template: id })}
              onPickStock={(id) => {
                const paper = findStockPaper(id);
                if (paper) setPagePaper(page, { kind: 'stock', id }, stockLayout(paper, s.pageSize));
              }}
              onPickPhoto={(file) => void pickPagePhoto(page, file)}
              compact
            />
          </PaperDialog>
        );
      })()}
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
      {sampleFontOpen && <SampleFontDialog onClose={() => setSampleFontOpen(false)} onCreate={addGeneratedFont} />}
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
