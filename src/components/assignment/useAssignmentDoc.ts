import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_ADJUST, DEFAULT_SETTINGS, SAMPLE_TEXT, type AssignmentDoc, type AssignmentSettings, type ImageAdjust, type PaperChoice, type TextOffset, type TextOffsets } from '../../lib/handwriting/catalog';
import type { PageVariation } from '../../lib/handwriting/variation';

const STORAGE_KEY = 'assignment-maker-draft-v1';
const COALESCE_MS = 600;
const HISTORY_LIMIT = 120;

function restorePagePapers(saved: unknown): Record<number, PaperChoice> {
  if (!saved || typeof saved !== 'object') return {};
  const out: Record<number, PaperChoice> = {};
  for (const [k, v] of Object.entries(saved as Record<string, PaperChoice>)) {
    // Uploaded photos are not persisted, so those pages fall back to the document paper.
    if (v && (v.kind === 'template' || v.kind === 'stock')) out[Number(k)] = v;
  }
  return out;
}

function restorePageAdjust(saved: unknown): Record<number, ImageAdjust> {
  if (!saved || typeof saved !== 'object') return {};
  const out: Record<number, ImageAdjust> = {};
  for (const [k, v] of Object.entries(saved as Record<string, Partial<ImageAdjust>>)) {
    if (v && typeof v === 'object') out[Number(k)] = { ...DEFAULT_ADJUST, ...v };
  }
  return out;
}

function restorePageVariation(saved: unknown): Record<number, PageVariation> {
  if (!saved || typeof saved !== 'object') return {};
  const out: Record<number, PageVariation> = {};
  for (const [k, v] of Object.entries(saved as Record<string, PageVariation>)) {
    if (!v || typeof v !== 'object') continue;
    if (v.off) out[Number(k)] = { off: true };
    else if (Number.isFinite(v.seed)) out[Number(k)] = { seed: Number(v.seed) >>> 0 };
  }
  return out;
}

function restoreTextOffsets(saved: unknown): TextOffsets {
  if (!saved || typeof saved !== 'object') return {};
  const out: TextOffsets = {};
  for (const [k, v] of Object.entries(saved as Record<string, Partial<TextOffset>>)) {
    if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) out[k] = { x: Number(v.x), y: Number(v.y) };
  }
  return out;
}

function loadDraft(): AssignmentDoc {
  const fresh: AssignmentDoc = { text: SAMPLE_TEXT, settings: DEFAULT_SETTINGS, overrides: {}, pagePapers: {}, pageAdjust: {}, pageVariation: {}, diagrams: [], textOffsets: {} };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return fresh;
    const settings: AssignmentSettings = {
      ...DEFAULT_SETTINGS,
      ...saved.settings,
      mistakeKinds: { ...DEFAULT_SETTINGS.mistakeKinds, ...saved.settings?.mistakeKinds, crossOut: false },
      layout: { ...DEFAULT_SETTINGS.layout, ...saved.settings?.layout },
      adjust: { ...DEFAULT_ADJUST, ...saved.settings?.adjust },
    };
    // Photos are not persisted, so a photo paper cannot be restored.
    if (settings.paper?.kind === 'photo') settings.paper = null;
    return {
      text: typeof saved.text === 'string' ? saved.text : SAMPLE_TEXT,
      settings,
      overrides: saved.overrides && typeof saved.overrides === 'object' ? saved.overrides : {},
      pagePapers: restorePagePapers(saved.pagePapers),
      pageAdjust: restorePageAdjust(saved.pageAdjust),
      pageVariation: restorePageVariation(saved.pageVariation),
      diagrams: [],
      textOffsets: restoreTextOffsets(saved.textOffsets),
    };
  } catch {
    return fresh;
  }
}

/** Document state with coalesced undo/redo and a local draft (text + settings). */
export function useAssignmentDoc() {
  const [doc, setDoc] = useState<AssignmentDoc>(loadDraft);
  const current = useRef(doc);
  const past = useRef<AssignmentDoc[]>([]);
  const future = useRef<AssignmentDoc[]>([]);
  const lastChange = useRef(0);

  const commit = useCallback((next: AssignmentDoc, coalesce = true) => {
    const prev = current.current;
    if (next === prev) return;
    const now = Date.now();
    if (!coalesce || now - lastChange.current > COALESCE_MS) {
      past.current.push(prev);
      if (past.current.length > HISTORY_LIMIT) past.current.shift();
    }
    lastChange.current = now;
    future.current = [];
    current.current = next;
    setDoc(next);
  }, []);

  const update = useCallback((fn: (d: AssignmentDoc) => AssignmentDoc, coalesce = true) => commit(fn(current.current), coalesce), [commit]);

  const updateSettings = useCallback(
    (patch: Partial<AssignmentSettings>, coalesce = true) => update((d) => ({ ...d, settings: { ...d.settings, ...patch } }), coalesce),
    [update],
  );

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(current.current);
    current.current = prev;
    lastChange.current = 0;
    setDoc(prev);
  }, []);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(current.current);
    current.current = next;
    lastChange.current = 0;
    setDoc(next);
  }, []);

  const reset = useCallback(() => {
    commit({ text: '', settings: { ...DEFAULT_SETTINGS, paper: current.current.settings.paper }, overrides: {}, pagePapers: {}, pageAdjust: {}, pageVariation: {}, diagrams: [], textOffsets: {} }, false);
  }, [commit]);

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ text: doc.text, settings: doc.settings, overrides: doc.overrides, pagePapers: doc.pagePapers, pageAdjust: doc.pageAdjust, pageVariation: doc.pageVariation, textOffsets: doc.textOffsets }));
      } catch {
        // Storage full or blocked: the draft simply isn't kept.
      }
    }, 400);
    return () => clearTimeout(t);
  }, [doc.text, doc.settings, doc.overrides, doc.pagePapers, doc.pageAdjust, doc.pageVariation, doc.textOffsets]);

  return {
    doc,
    update,
    updateSettings,
    undo,
    redo,
    reset,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
  };
}
