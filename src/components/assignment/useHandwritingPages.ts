import { useEffect, useRef, useState } from 'react';
import type { HandwritingEngine } from '../../lib/handwriting/engine';
import { findFont, type AssignmentDoc, type HandwritingFont } from '../../lib/handwriting/catalog';
import { loadFont, runLayout, segment } from '../../lib/handwriting/compose';
import { pageSignature, renderPage, type RenderInput } from '../../lib/handwriting/render';

export interface PagesState {
  canvases: HTMLCanvasElement[];
  input: RenderInput | null;
  rendering: boolean;
  error: string | null;
}

interface CachedPage {
  sig: string;
  canvas: HTMLCanvasElement;
}

/** Only flag "Writing…" for passes that take noticeably long, so quick edits don't flicker the status. */
const BUSY_DELAY_MS = 350;
/** Per-chunk time budget before yielding back to the browser. */
const FRAME_BUDGET_MS = 12;

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
 * Debounced, incremental render pipeline: prepare text → Rust layout → canvas pages.
 * Pages whose content didn't change keep their canvas; visible pages are drawn
 * first and the rest are filled in during idle time.
 */
export function useHandwritingPages(
  engine: HandwritingEngine | null,
  doc: AssignmentDoc,
  photo: HTMLImageElement | null,
  customFonts: HandwritingFont[],
  previewScale: number,
  getVisiblePages?: () => number[],
): PagesState {
  const [state, setState] = useState<PagesState>({ canvases: [], input: null, rendering: false, error: null });
  const cache = useRef<CachedPage[]>([]);
  const visibleRef = useRef(getVisiblePages);
  visibleRef.current = getVisiblePages;
  const { text, settings, overrides } = doc;

  useEffect(() => {
    if (!engine || !settings.paper) return;
    let cancelled = false;
    let busyTimer = 0;
    const timer = window.setTimeout(async () => {
      try {
        await whenVisible();
        if (cancelled) return;
        const fontA = findFont(settings.fontFamily, customFonts);
        const fontB = findFont(settings.fontFamilyB, customFonts);
        const prepared = engine.prepareText(text, { latex: settings.latex, markdown: settings.markdown });
        const sample = sampleChars(prepared + 'Page 0123456789');
        await Promise.all([loadFont(fontA.family, sample), settings.combineFonts ? loadFont(fontB.family, sample) : null]);
        if (cancelled) return;
        const seg = segment(prepared);
        const layout = runLayout(engine, settings, seg, fontA, fontB, overrides);
        const input: RenderInput = { engine, settings, overrides, layout, units: seg.units, fontA, fontB, photo };

        const base = [
          JSON.stringify(settings),
          fontA.family, fontA.sizeAdjust, fontB.family, fontB.sizeAdjust,
          photo ? `${photo.src.length}|${photo.src.slice(-32)}` : '',
          previewScale,
        ].join('|');
        const sigs = Array.from({ length: layout.pages }, (_, p) => pageSignature(input, p, base));
        const prev = cache.current;
        const next: CachedPage[] = sigs.map((sig, p) => (prev[p]?.sig === sig ? prev[p] : { sig: '', canvas: prev[p]?.canvas }) as CachedPage);
        const dirty = sigs.map((_, p) => p).filter((p) => next[p].sig !== sigs[p]);

        const publish = (rendering: boolean) => {
          cache.current = next;
          setState({ canvases: next.map((c) => c.canvas), input, rendering, error: null });
        };

        if (dirty.length === 0) {
          publish(false);
          return;
        }

        busyTimer = window.setTimeout(() => !cancelled && setState((s) => ({ ...s, rendering: true })), BUSY_DELAY_MS);
        const visible = new Set((visibleRef.current?.() ?? [0]).filter((p) => p < layout.pages));
        const order = [...dirty.filter((p) => visible.has(p)), ...dirty.filter((p) => !visible.has(p))];

        let chunkStart = performance.now();
        for (let i = 0; i < order.length; i++) {
          const p = order[i];
          next[p] = { sig: sigs[p], canvas: renderPage(input, p, { scale: previewScale, guides: settings.showGuides }) };
          if (cancelled) return;
          const more = i < order.length - 1;
          if (more && performance.now() - chunkStart > FRAME_BUDGET_MS) {
            publish(true);
            // Visible pages get the next frame; off-screen ones wait for idle time.
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
    }, 140);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearTimeout(busyTimer);
    };
  }, [engine, text, settings, overrides, photo, customFonts, previewScale]);

  return state;
}
