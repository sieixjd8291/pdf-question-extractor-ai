import type { AssignmentDoc, PageLayout, PaperChoice, TextOffsets } from './catalog';

export function templateLineStep(paper: PaperChoice | null | undefined, layout: PageLayout): number | null {
  if (paper?.kind !== 'template' || ![1, 2, 3, 4, 5, 8, 9].includes(paper.template)) return null;
  return layout.lineHeight / (paper.template === 3 || paper.template === 4 ? 2 : 1);
}
import { layoutForPage } from './compose';
import type { DetectedRuling } from './detectLines';

/**
 * Lands a layout on the printed lines without changing what the user set:
 * inside the ruled area the first line goes to the nearest rule; the spacing becomes a whole number
 * of rules (1 = every line, 2 = every other line…), and the tilt follows the paper.
 * Margins left/right/bottom stay exactly as the sliders say.
 */
export function layoutOnLines(ruling: DetectedRuling, desired: PageLayout, minimumBaseline = 0): PageLayout {
  const pitch = ruling.lineHeight;
  const every = Math.max(1, Math.round(desired.lineHeight / pitch));
  const firstAtMargin = ruling.firstLine + ruling.slope * (desired.marginLeft - ruling.centerX);
  const steps = Math.max(0, Math.round((desired.marginTop - firstAtMargin) / pitch));
  // The unruled header is reachable; leave room for letters above the baseline at 0px.
  const marginTop = desired.marginTop < firstAtMargin
    ? Math.min(firstAtMargin, Math.max(minimumBaseline, desired.marginTop))
    : Math.round((firstAtMargin + steps * pitch) * 10) / 10;
  return {
    ...desired,
    lineHeight: Number((pitch * every).toFixed(2)),
    marginTop,
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
  paperFor: (page: number) => PaperChoice | null,
): AssignmentDoc {
  const s = doc.settings;
  let settings = s;
  let overrides = doc.overrides;

  if (s.snapToLines) {
    const minimumBaseline = Math.ceil(s.fontSize * Math.max(1, s.headingScale));
    const global = rulingFor(-1);
    if (global) settings = { ...s, layout: layoutOnLines(global, s.layout, minimumBaseline) };
    const pages = new Set([...Object.keys(doc.overrides), ...Object.keys(doc.pagePapers)].map(Number));
    const next: Record<number, PageLayout> = { ...doc.overrides };
    for (const page of pages) {
      const ruling = rulingFor(page);
      const own = doc.overrides[page];
      if (!ruling) {
        // A plain or generated page must not inherit another photo's snapped geometry.
        next[page] = { ...(own ?? s.layout), angle: paperFor(page)?.kind === 'template' ? 0 : (own?.angle ?? 0) };
        continue;
      }
      if (!own && ruling === global) continue;
      next[page] = layoutOnLines(ruling, own ?? s.layout, minimumBaseline);
    }
    overrides = next;
  }

  const stepFor = (page: number): number | null => {
    if (!s.snapToLines) return null;
    const layout = layoutForPage(settings, overrides, page);
    return templateLineStep(paperFor(page), layout) ?? (rulingFor(page) ? layout.lineHeight : null);
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
