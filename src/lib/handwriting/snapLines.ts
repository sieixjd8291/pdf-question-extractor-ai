import type { AssignmentDoc, PageLayout, TextOffsets } from './catalog';
import { layoutForPage } from './compose';
import type { DetectedRuling } from './detectLines';

export function layoutOnLines(ruling: DetectedRuling, desired: PageLayout): PageLayout {
  const pitch = ruling.lineHeight;
  const every = Math.max(1, Math.round(desired.lineHeight / pitch));
  const firstAtMargin = ruling.firstLine + ruling.slope * (desired.marginLeft - ruling.centerX);
  const steps = Math.round((desired.marginTop - firstAtMargin) / pitch);
  return {
    ...desired,
    lineHeight: Number((pitch * every).toFixed(2)),
    marginTop: Math.round((firstAtMargin + steps * pitch) * 10) / 10,
    angle: ruling.angle,
    onLines: true,
    ruleStep: pitch,
  };
}

const RULED_TEMPLATES = new Set([1, 2, 3, 4, 5, 8, 9]);
const pageOfOffset = (id: string) => Number(/^p(\d+)/.exec(id)?.[1]);

/** Resolve against each page's own paper, without mutating any stored layout. */
export function docOnLines(
  doc: AssignmentDoc,
  rulingFor: (page: number) => DetectedRuling | null,
  templateFor: (page: number) => number | null,
): AssignmentDoc {
  const s = doc.settings;
  const resolve = (page: number, desired: PageLayout): PageLayout => {
    const template = templateFor(page);
    if (template !== null) {
      const onLines = s.snapToLines && RULED_TEMPLATES.has(template);
      return { ...desired, angle: 0, onLines, ruleStep: onLines ? desired.lineHeight / (template === 3 || template === 4 ? 2 : 1) : undefined };
    }
    const ruling = s.snapToLines ? rulingFor(page) : null;
    return ruling ? layoutOnLines(ruling, desired) : { ...desired, angle: 0, onLines: false, ruleStep: undefined };
  };
  const settings = { ...s, layout: resolve(-1, s.layout) };
  const overrides: Record<number, PageLayout> = {};
  const pages = new Set([...Object.keys(doc.overrides), ...Object.keys(doc.pagePapers)].map(Number));
  for (const page of pages) overrides[page] = resolve(page, doc.overrides[page] ?? s.layout);

  let textOffsets: TextOffsets = doc.textOffsets;
  for (const [id, o] of Object.entries(doc.textOffsets)) {
    const page = pageOfOffset(id);
    if (!Number.isFinite(page)) continue;
    const step = layoutForPage(settings, overrides, page).ruleStep;
    if (!step) continue;
    const y = Math.round(Math.round(o.y / step) * step * 10) / 10;
    if (Math.abs(y - o.y) < 0.05) continue;
    if (textOffsets === doc.textOffsets) textOffsets = { ...doc.textOffsets };
    textOffsets[id] = { x: o.x, y };
  }
  return { ...doc, settings, overrides, textOffsets };
}
