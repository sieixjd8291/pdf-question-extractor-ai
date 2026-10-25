import type { AssignmentDoc, PageLayout, PaperChoice, TextOffsets } from './catalog';

export function pageWritesOnLines(doc: AssignmentDoc, page: number, paper: PaperChoice | null | undefined): boolean {
  if (!paper || (paper.kind === 'template' && templateLineStep(paper, doc.settings.layout) === null)) return false;
  return doc.pageSnapToLines?.[page]
    ?? (paper?.kind === 'template' && (paper.template === 3 || paper.template === 4) ? true : doc.settings.snapToLines);
}

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
    rulingStart: firstAtMargin,
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

  const minimumBaseline = Math.ceil(s.fontSize * Math.max(1, s.headingScale));
  const globalRequested = pageWritesOnLines(doc, -1, s.paper);
  const global = globalRequested ? rulingFor(-1) : null;
  const globalEnabled = globalRequested && (global !== null || templateLineStep(s.paper, s.layout) !== null);
  const globalLayout = global
    ? layoutOnLines(global, s.layout, minimumBaseline)
    : s.paper?.kind === 'template' ? { ...s.layout, angle: 0 } : s.layout;
  if (globalLayout !== s.layout || globalEnabled !== s.snapToLines) {
    settings = { ...s, snapToLines: globalEnabled, layout: globalLayout };
  }
  const pages = new Set([
    ...Object.keys(doc.overrides), ...Object.keys(doc.pagePapers), ...Object.keys(doc.pageSnapToLines ?? {}),
  ].map(Number));
  for (const page of pages) {
    const paper = paperFor(page);
    const requested = pageWritesOnLines(doc, page, paper);
    const ruling = requested ? rulingFor(page) : null;
    const own = doc.overrides[page];
    const desired = own ?? s.layout;
    const enabled = requested && (ruling !== null || templateLineStep(paper, desired) !== null);
    if (!own && !doc.pagePapers[page] && enabled === globalEnabled && ruling === global) continue;
    if (overrides === doc.overrides) overrides = { ...doc.overrides };
    overrides[page] = {
      ...(ruling ? layoutOnLines(ruling, desired, minimumBaseline) : desired),
      ...(!ruling && paper?.kind === 'template' ? { angle: 0 } : {}),
      snapToLines: enabled,
    };
  }

  const stepFor = (page: number): number | null => {
    const layout = layoutForPage(settings, overrides, page);
    if (!(layout.snapToLines ?? settings.snapToLines)) return null;
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
