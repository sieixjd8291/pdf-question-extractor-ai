import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_SETTINGS, SAMPLE_TEXT, type AssignmentDoc, type AssignmentSettings } from '../../lib/handwriting/catalog';

const STORAGE_KEY = 'assignment-maker-draft-v1';
const COALESCE_MS = 600;
const HISTORY_LIMIT = 120;

function loadDraft(): AssignmentDoc {
  const fresh: AssignmentDoc = { text: SAMPLE_TEXT, settings: DEFAULT_SETTINGS, overrides: {}, diagrams: [] };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return fresh;
    const settings: AssignmentSettings = {
      ...DEFAULT_SETTINGS,
      ...saved.settings,
      mistakeKinds: { ...DEFAULT_SETTINGS.mistakeKinds, ...saved.settings?.mistakeKinds, crossOut: false },
      layout: { ...DEFAULT_SETTINGS.layout, ...saved.settings?.layout },
    };
    // Photos are not persisted, so a photo paper cannot be restored.
    if (settings.paper?.kind === 'photo') settings.paper = null;
    return {
      text: typeof saved.text === 'string' ? saved.text : SAMPLE_TEXT,
      settings,
      overrides: saved.overrides && typeof saved.overrides === 'object' ? saved.overrides : {},
      diagrams: [],
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
    commit({ text: '', settings: { ...DEFAULT_SETTINGS, paper: current.current.settings.paper }, overrides: {}, diagrams: [] }, false);
  }, [commit]);

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ text: doc.text, settings: doc.settings, overrides: doc.overrides }));
      } catch {
        // Storage full or blocked: the draft simply isn't kept.
      }
    }, 400);
    return () => clearTimeout(t);
  }, [doc.text, doc.settings, doc.overrides]);

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
