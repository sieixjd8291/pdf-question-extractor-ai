import { useEffect, useState } from 'react';
import type { HandwritingEngine } from '../../lib/handwriting/engine';
import { findFont, type AssignmentDoc, type HandwritingFont } from '../../lib/handwriting/catalog';
import { loadFont, runLayout, segment } from '../../lib/handwriting/compose';
import { renderPage, type RenderInput } from '../../lib/handwriting/render';

export interface PagesState {
  canvases: HTMLCanvasElement[];
  input: RenderInput | null;
  rendering: boolean;
  error: string | null;
}

const yieldFrame = () => new Promise((r) => setTimeout(r, 0));

function sampleChars(text: string): string {
  return Array.from(new Set(Array.from(text))).slice(0, 400).join('') || 'abc';
}

/** Debounced render pipeline: prepare text → Rust layout → canvas pages. */
export function useHandwritingPages(
  engine: HandwritingEngine | null,
  doc: AssignmentDoc,
  photo: HTMLImageElement | null,
  customFonts: HandwritingFont[],
  previewScale: number,
): PagesState {
  const [state, setState] = useState<PagesState>({ canvases: [], input: null, rendering: false, error: null });
  const { text, settings, overrides } = doc;

  useEffect(() => {
    if (!engine || !settings.paper) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setState((s) => ({ ...s, rendering: true }));
      try {
        const fontA = findFont(settings.fontFamily, customFonts);
        const fontB = findFont(settings.fontFamilyB, customFonts);
        const prepared = engine.prepareText(text, { latex: settings.latex, markdown: settings.markdown });
        const sample = sampleChars(prepared + 'Page 0123456789');
        await Promise.all([loadFont(fontA.family, sample), settings.combineFonts ? loadFont(fontB.family, sample) : null]);
        if (cancelled) return;
        const seg = segment(prepared);
        const layout = runLayout(engine, settings, seg, fontA, fontB, overrides);
        const input: RenderInput = { engine, settings, overrides, layout, units: seg.units, fontA, fontB, photo };
        const canvases: HTMLCanvasElement[] = [];
        for (let p = 0; p < layout.pages; p++) {
          canvases.push(renderPage(input, p, { scale: previewScale, guides: settings.showGuides }));
          if (cancelled) return;
          if (p === 0 || p % 3 === 2) setState({ canvases: canvases.slice(), input, rendering: p < layout.pages - 1, error: null });
          await yieldFrame();
          if (cancelled) return;
        }
        setState({ canvases, input, rendering: false, error: null });
      } catch (e) {
        if (!cancelled) setState((s) => ({ ...s, rendering: false, error: e instanceof Error ? e.message : 'Rendering failed' }));
      }
    }, 140);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [engine, text, settings, overrides, photo, customFonts, previewScale]);

  return state;
}
