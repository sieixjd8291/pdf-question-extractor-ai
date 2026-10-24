import { useEffect, useRef, useState } from 'react';
import type { HandwritingEngine } from '../../lib/handwriting/engine';
import { findFont, type ActiveGuide, type AssignmentDoc, type HandwritingFont } from '../../lib/handwriting/catalog';
import { loadFont, runLayout, segment, type Segmented } from '../../lib/handwriting/compose';
import { pageSignature, renderPage, warmPaperBase, type RenderInput } from '../../lib/handwriting/render';
import { normalizeAssignmentText, stripInertMarkers } from '../../lib/handwriting/smartFormat';

export interface PagesState {
  canvases: HTMLCanvasElement[];
  input: RenderInput | null;
  rendering: boolean;
  error: string | null;
}

interface CachedPage {
  sig: string;
  fast: boolean;
  canvas: HTMLCanvasElement;
}

interface PrepCache {
  key: string;
  seg: Segmented;
  sample: string;
}

/** Only flag "Writing…" for passes that take noticeably long, so quick edits don't flicker the status. */
const BUSY_DELAY_MS = 350;
/** Per-chunk time budget before yielding back to the browser. */
const FRAME_BUDGET_MS = 12;
/** Idle delay after rapid slider scrubbing before running full WASM ink/paper texture pass. */
const SETTLE_DELAY_MS = 130;

function sampleChars(text: string): string {
  return Array.from(new Set(Array.from(text))).slice(0, 400).join('') || 'abc';
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

const whenIdle = () =>
  new Promise<void>((r) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => r(), { timeout: 300 });
    else setTimeout(r, 16);
  });

/** Avoids burning CPU on a background tab; resumes as soon as it's visible again. */
const whenVisible = () =>
  document.visibilityState === 'visible'
    ? Promise.resolve()
    : new Promise<void>((r) => {
        const on = () => {
          if (document.visibilityState !== 'visible') return;
          document.removeEventListener('visibilitychange', on);
          r();
        };
        document.addEventListener('visibilitychange', on);
      });

/**
 * Two-stage incremental render pipeline:
 * 1. Immediate `requestAnimationFrame` pass (`fast: true`) renders visible pages
 *    in <3ms so dragging Page Layout, Realism, or Style sliders previews smoothly at 60 FPS
 *    without debounce starvation.
 * 2. Settled pass (`fast: false`) 130ms after the last change upgrades pages with
 *    full WASM ink texture / paper rules and fills in off-screen pages during idle time.
 */
export function useHandwritingPages(
  engine: HandwritingEngine | null,
  doc: AssignmentDoc,
  photo: HTMLImageElement | null,
  images: Record<string, HTMLImageElement>,
  customFonts: HandwritingFont[],
  previewScale: number,
  getVisiblePages?: () => number[],
  activeGuide?: ActiveGuide,
): PagesState {
  const [state, setState] = useState<PagesState>({ canvases: [], input: null, rendering: false, error: null });
  const cache = useRef<CachedPage[]>([]);
  const prepCache = useRef<PrepCache | null>(null);
  const loadedFonts = useRef(new Set<string>());
  const visibleRef = useRef(getVisiblePages);
  visibleRef.current = getVisiblePages;

  const latestRef = useRef({ engine, doc, photo, images, customFonts, previewScale, activeGuide: activeGuide ?? null });
  latestRef.current = { engine, doc, photo, images, customFonts, previewScale, activeGuide: activeGuide ?? null };

  const liveRafRef = useRef(0);
  const prevTextRef = useRef(doc.text);

  const getPrepared = (eng: HandwritingEngine, text: string, latex: boolean, markdown: boolean): PrepCache => {
    const key = `${latex ? 1 : 0}|${markdown ? 1 : 0}|${text}`;
    if (prepCache.current && prepCache.current.key === key) {
      return prepCache.current;
    }
    const prepared = stripInertMarkers(eng.prepareText(normalizeAssignmentText(text, { latex, markdown }), { latex, markdown }));
    const sample = sampleChars(prepared + 'PageofPg.-/() 0123456789');
    const seg = segment(prepared);
    const entry: PrepCache = { key, seg, sample };
    prepCache.current = entry;
    return entry;
  };

  // Pre-warm base paper texture whenever paper template or page size changes
  useEffect(() => {
    if (!engine || !doc.settings.paper || doc.settings.paper.kind !== 'template') return;
    const id = window.setTimeout(() => {
      warmPaperBase(engine, doc.settings, previewScale);
    }, 20);
    return () => clearTimeout(id);
  }, [engine, doc.settings.paper, doc.settings.pageSize, previewScale]);

  useEffect(() => {
    const { settings } = doc;
    if (!engine || !settings.paper) return;

    const textChanged = prevTextRef.current !== doc.text;
    prevTextRef.current = doc.text;

    const fontA = findFont(settings.fontFamily, customFonts);
    const fontB = findFont(settings.fontFamilyB, customFonts);
    const prep = getPrepared(engine, doc.text, settings.latex, settings.markdown);
    const fontKeyA = `${fontA.family}|${prep.sample}`;
    const fontKeyB = `${fontB.family}|${prep.sample}`;
    const fontsReady =
      loadedFonts.current.has(fontKeyA) && (!settings.combineFonts || loadedFonts.current.has(fontKeyB));

    // Stage 1: Immediate 60fps RAF live preview for slider drags and setting changes
    // Do NOT cancel an already-queued liveRafRef on intermediate slider moves so every
    // display frame paints the latest slider position smoothly.
    if (fontsReady && !textChanged && liveRafRef.current === 0) {
      liveRafRef.current = requestAnimationFrame(() => {
        liveRafRef.current = 0;
        const cur = latestRef.current;
        if (!cur.engine || !cur.doc.settings.paper) return;
        try {
          const s = cur.doc.settings;
          const fA = findFont(s.fontFamily, cur.customFonts);
          const fB = findFont(s.fontFamilyB, cur.customFonts);
          const p = getPrepared(cur.engine, cur.doc.text, s.latex, s.markdown);
          const layout = runLayout(cur.engine, s, p.seg, fA, fB, cur.doc.overrides, cur.doc.textOffsets);
          const input: RenderInput = {
            engine: cur.engine,
            settings: s,
            overrides: cur.doc.overrides,
            layout,
            units: p.seg.units,
            fontA: fA,
            fontB: fB,
            photo: cur.photo,
            pagePapers: cur.doc.pagePapers,
            images: cur.images,
            pageAdjust: cur.doc.pageAdjust,
          };

          const base = [
            JSON.stringify(s),
            fA.family, fA.sizeAdjust, fB.family, fB.sizeAdjust,
            cur.photo ? `${cur.photo.src.length}|${cur.photo.src.slice(-32)}` : '',
            cur.previewScale,
            cur.activeGuide ?? '',
          ].join('|');

          const sigs = Array.from({ length: layout.pages }, (_, pageIdx) => pageSignature(input, pageIdx, base));
          const prev = cache.current;
          const next: CachedPage[] = sigs.map((sig, pageIdx) =>
            prev[pageIdx]?.sig === sig
              ? prev[pageIdx]
              : ({ sig: '', fast: true, canvas: prev[pageIdx]?.canvas } as CachedPage),
          );

          const visible = new Set((visibleRef.current?.() ?? [0]).filter((pageIdx) => pageIdx < layout.pages));
          if (visible.size === 0) visible.add(0);

          for (const pageIdx of visible) {
            if (next[pageIdx].sig !== sigs[pageIdx]) {
              next[pageIdx] = {
                sig: sigs[pageIdx],
                fast: true,
                canvas: renderPage(input, pageIdx, {
                  scale: cur.previewScale,
                  guides: s.showGuides,
                  activeGuide: cur.activeGuide,
                  fast: true,
                }),
              };
            }
          }

          cache.current = next;
          setState({ canvases: next.map((c) => c.canvas), input, rendering: false, error: null });
        } catch {
          // Settled pass will handle any error state
        }
      });
    }

    // Stage 2: Settled full-quality WASM pass after slider/typing settles
    let cancelled = false;
    let busyTimer = 0;
    const delay = textChanged ? 110 : SETTLE_DELAY_MS;

    const timer = window.setTimeout(async () => {
      try {
        await whenVisible();
        if (cancelled) return;
        const fA = findFont(settings.fontFamily, customFonts);
        const fB = findFont(settings.fontFamilyB, customFonts);
        const p = getPrepared(engine, doc.text, settings.latex, settings.markdown);
        const kA = `${fA.family}|${p.sample}`;
        const kB = `${fB.family}|${p.sample}`;

        if (!loadedFonts.current.has(kA) || (settings.combineFonts && !loadedFonts.current.has(kB))) {
          await Promise.all([
            loadFont(fA.family, p.sample).then(() => loadedFonts.current.add(kA)),
            settings.combineFonts ? loadFont(fB.family, p.sample).then(() => loadedFonts.current.add(kB)) : null,
          ]);
        }
        if (cancelled) return;

        const layout = runLayout(engine, settings, p.seg, fA, fB, doc.overrides, doc.textOffsets);
        const input: RenderInput = {
          engine,
          settings,
          overrides: doc.overrides,
          layout,
          units: p.seg.units,
          fontA: fA,
          fontB: fB,
          photo,
          pagePapers: doc.pagePapers,
          images,
          pageAdjust: doc.pageAdjust,
        };

        const base = [
          JSON.stringify(settings),
          fA.family, fA.sizeAdjust, fB.family, fB.sizeAdjust,
          photo ? `${photo.src.length}|${photo.src.slice(-32)}` : '',
          previewScale,
          activeGuide ?? '',
        ].join('|');
        const sigs = Array.from({ length: layout.pages }, (_, pageIdx) => pageSignature(input, pageIdx, base));
        const prev = cache.current;
        const next: CachedPage[] = sigs.map((sig, pageIdx) =>
          prev[pageIdx]?.sig === sig && !prev[pageIdx]?.fast
            ? prev[pageIdx]
            : ({ sig: '', fast: false, canvas: prev[pageIdx]?.canvas } as CachedPage),
        );
        const dirty = sigs.map((_, pageIdx) => pageIdx).filter((pageIdx) => next[pageIdx].sig !== sigs[pageIdx] || next[pageIdx].fast);

        const publish = (rendering: boolean) => {
          cache.current = next;
          setState({ canvases: next.map((c) => c.canvas), input, rendering, error: null });
        };

        if (dirty.length === 0) {
          publish(false);
          return;
        }

        busyTimer = window.setTimeout(() => !cancelled && setState((s) => ({ ...s, rendering: true })), BUSY_DELAY_MS);
        const visible = new Set((visibleRef.current?.() ?? [0]).filter((pageIdx) => pageIdx < layout.pages));
        if (visible.size === 0) visible.add(0);
        const order = [...dirty.filter((pageIdx) => visible.has(pageIdx)), ...dirty.filter((pageIdx) => !visible.has(pageIdx))];

        let chunkStart = performance.now();
        for (let i = 0; i < order.length; i++) {
          const pageIdx = order[i];
          next[pageIdx] = {
            sig: sigs[pageIdx],
            fast: false,
            canvas: renderPage(input, pageIdx, {
              scale: previewScale,
              guides: settings.showGuides,
              activeGuide: activeGuide ?? null,
              fast: false,
            }),
          };
          if (cancelled) return;
          const more = i < order.length - 1;
          if (more && performance.now() - chunkStart > FRAME_BUDGET_MS) {
            publish(true);
            await (visible.has(order[i + 1]) ? nextFrame() : whenIdle());
            await whenVisible();
            if (cancelled) return;
            chunkStart = performance.now();
          }
        }
        clearTimeout(busyTimer);
        publish(false);
      } catch (e) {
        clearTimeout(busyTimer);
        if (!cancelled) setState((s) => ({ ...s, rendering: false, error: e instanceof Error ? e.message : 'Rendering failed' }));
      }
    }, delay);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearTimeout(busyTimer);
    };
  }, [engine, doc, photo, images, customFonts, previewScale, activeGuide]);

  useEffect(() => {
    return () => {
      if (liveRafRef.current) cancelAnimationFrame(liveRafRef.current);
    };
  }, []);

  return state;
}
