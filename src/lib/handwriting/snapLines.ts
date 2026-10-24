import type { AssignmentDoc, PageLayout, TextOffsets } from './catalog';
import { layoutForPage } from './compose';
import type { DetectedRuling } from './detectLines';

/**
 * Lands a layout on the printed lines without changing what the user set:
 * the first line goes to the nearest rule, the spacing becomes a whole number
 * of rules (1 = every line, 2 = every other line…), and the tilt follows the paper.
 * Margins left/right/bottom stay exactly as the sliders say.
 */
export function layoutOnLines(ruling: DetectedRuling, desired: PageLayout): PageLayout {
  const pitch = ruling.lineHeight;
  const every = Math.max(1, Math.round(desired.lineHeight / pitch));
  const firstAtMargin = ruling.firstLine + ruling.slope * (desired.marginLeft - ruling.centerX);
  const steps = Math.max(0, Math.round((desired.marginTop - firstAtMargin) / pitch));
  return {
    ...desired,
    lineHeight: Number((pitch * every).toFixed(2)),
    marginTop: Math.round((firstAtMargin + steps * pitch) * 10) / 10,
    angle: ruling.angle,
  };
}

const pageOfOffset = (id: string) => Number(/^p(\d+)/.exec(id)?.[1]);

/**
 * Builds the document that is actually drawn. Stored slider values are never
 * rewritten, so every slider stays free; "Write within the lines" is applied here,
 * page by page, against each page's own paper.
 */
export function docOnLines(
  doc: AssignmentDoc,
  rulingFor: (page: number) => DetectedRuling | null,
  isTemplatePage: (page: number) => boolean,
): AssignmentDoc {
  const s = doc.settings;
  let settings = s;
  let overrides = doc.overrides;

  if (s.snapToLines) {
    const global = rulingFor(-1);
    if (global) settings = { ...s, layout: layoutOnLines(global, s.layout) };
    const pages = new Set([...Object.keys(doc.overrides), ...Object.keys(doc.pagePapers)].map(Number));
    const next: Record<number, PageLayout> = { ...doc.overrides };
    for (const page of pages) {
      const ruling = rulingFor(page);
      if (!ruling) continue;
      const own = doc.overrides[page];
      if (!own && ruling === global) continue;
      next[page] = layoutOnLines(ruling, own ?? s.layout);
    }
    overrides = next;
  }

  const stepFor = (page: number): number | null => {
    if (isTemplatePage(page)) return layoutForPage(settings, overrides, page).lineHeight;
    if (!s.snapToLines || !rulingFor(page)) return null;
    return layoutForPage(settings, overrides, page).lineHeight;
  };

  let textOffsets: TextOffsets = doc.textOffsets;
  for (const [id, o] of Object.entries(doc.textOffsets)) {
    const page = pageOfOffset(id);
    if (!Number.isFinite(page)) continue;
    const step = stepFor(page);
    if (!step) continue;
    const y = Math.round(Math.round(o.y / step) * step * 10) / 10;
    if (Math.abs(y - o.y) < 0.05) continue;
    if (textOffsets === doc.textOffsets) textOffsets = { ...doc.textOffsets };
    textOffsets[id] = { x: o.x, y };
  }

  if (settings === s && overrides === doc.overrides && textOffsets === doc.textOffsets) return doc;
  return { ...doc, settings, overrides, textOffsets };
}
