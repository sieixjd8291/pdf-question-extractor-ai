import type { HandwritingEngine } from './engine';
import {
  PAGE_SIZES,
  PENS,
  combineAdjust,
  inkColor,
  isNeutralAdjust,
  type ActiveGuide,
  type AssignmentSettings,
  type AssignmentDoc,
  type Diagram,
  type HandwritingFont,
  type ImageAdjust,
  type PageLayout,
  type PaperChoice,
  samePaper,
} from './catalog';
import { applyImageAdjust } from './adjust';
import { GLYPH_FLAG, GLYPH_STRIDE, layoutForPage, type LayoutResult } from './compose';
import { applyLookFraming, applyLookLight, applyLookTone, pageLook, type PageVariation } from './variation';

export interface RenderInput {
  engine: HandwritingEngine;
  settings: AssignmentSettings;
  overrides: Record<number, PageLayout>;
  guideDoc?: Pick<AssignmentDoc, 'settings' | 'overrides'>;
  layout: LayoutResult;
  units: string[];
  fontA: HandwritingFont;
  fontB: HandwritingFont;
  photo: HTMLImageElement | null;
  pagePapers: Record<number, PaperChoice>;
  /** Per-page paper images keyed by `pageImageKey`. */
  images: Record<string, HTMLImageElement>;
  pageAdjust?: Record<number, ImageAdjust>;
  pageVariation?: Record<number, PageVariation>;
}

export function pageImageKey(paper: PaperChoice): string | null {
  if (paper.kind === 'stock') return `stock:${paper.id}`;
  if (paper.kind === 'photo' && paper.photoId) return `photo:${paper.photoId}`;
  return null;
}

export function paperForPage(s: AssignmentSettings, pagePapers: Record<number, PaperChoice> | undefined, page: number): PaperChoice | null {
  return pagePapers?.[page] ?? s.paper;
}

function resolvePaper(input: RenderInput, page: number): { paper: PaperChoice | null; photo: HTMLImageElement | null } {
  const { settings: s } = input;
  const own = input.pagePapers?.[page];
  if (!own || samePaper(own, s.paper)) return { paper: s.paper, photo: input.photo };
  const key = pageImageKey(own);
  return { paper: own, photo: key ? input.images?.[key] ?? null : null };
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function ensureScratch(ref: { canvas: HTMLCanvasElement | null }, w: number, h: number): HTMLCanvasElement {
  const rw = Math.max(1, Math.round(w));
  const rh = Math.max(1, Math.round(h));
  if (!ref.canvas) {
    ref.canvas = makeCanvas(rw, rh);
  } else if (ref.canvas.width !== rw || ref.canvas.height !== rh) {
    ref.canvas.width = rw;
    ref.canvas.height = rh;
  } else {
    const ctx = ref.canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, rw, rh);
  }
  return ref.canvas;
}

const inkScratchRef: { canvas: HTMLCanvasElement | null } = { canvas: null };
const fastPaperScratchRef: { canvas: HTMLCanvasElement | null } = { canvas: null };

const paperCache = new Map<string, HTMLCanvasElement>();
const basePaperCache = new Map<string, HTMLCanvasElement>();

const UNRULED_TEMPLATES = new Set([0, 6, 7]);

/**
 * Renders and caches the unruled base paper texture (grain, fiber, mottle,
 * edge burn, and spiral holes/coils) for a template so interactive layout
 * slider drags can composite rules in <0.5ms without re-running 2M WASM pixels.
 */
function getBasePaperCanvas(engine: HandwritingEngine, template: number, W: number, H: number): HTMLCanvasElement {
  const baseTemplate = template === 1 || template === 3 || template === 4 || template === 8 ? 1 : template;
  const key = `base|t${baseTemplate}|${W}x${H}`;
  const hit = basePaperCache.get(key);
  if (hit) return hit;

  if (UNRULED_TEMPLATES.has(baseTemplate)) {
    const fullHit = paperCache.get(`t${baseTemplate}|${W}x${H}`);
    if (fullHit) {
      basePaperCache.set(key, fullHit);
      return fullHit;
    }
  }

  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d')!;
  const img = engine.renderPaper(W, H, baseTemplate, H * 4, H * 4, 0, 7919);
  ctx.putImageData(img, 0, 0);
  if (basePaperCache.size > 8) basePaperCache.delete(basePaperCache.keys().next().value!);
  basePaperCache.set(key, c);
  if (UNRULED_TEMPLATES.has(baseTemplate)) {
    paperCache.set(`t${baseTemplate}|${W}x${H}`, c);
  }
  return c;
}

/** Pre-warms the unruled base texture for the active template during idle time. */
export function warmPaperBase(engine: HandwritingEngine, s: AssignmentSettings, scale: number): void {
  if (!s.paper || s.paper.kind !== 'template') return;
  const size = PAGE_SIZES[s.pageSize];
  const W = Math.round(size.width * scale);
  const H = Math.round(size.height * scale);
  getBasePaperCanvas(engine, s.paper.template, W, H);
}

/**
 * Fast hardware-accelerated 2D Canvas rule compositor used during active
 * slider dragging (`fast: true`). Matches `rust/handwriting-engine/src/paper.rs`
 * rule geometry pixel-for-pixel in <0.5ms per frame.
 */
function fastPaperCanvas(input: RenderInput, page: number, scale: number): HTMLCanvasElement | null {
  const { settings: s, engine } = input;
  const { paper, photo } = resolvePaper(input, page);
  if (!paper) return null;
  const size = PAGE_SIZES[s.pageSize];
  const L = layoutForPage(s, input.overrides, page);
  const W = Math.round(size.width * scale);
  const H = Math.round(size.height * scale);

  if (paper.kind !== 'template') {
    return paperCanvas(input, page, scale);
  }

  const template = paper.template;
  const exactKey = UNRULED_TEMPLATES.has(template)
    ? `t${template}|${W}x${H}`
    : `t${template}|${W}x${H}|${L.lineHeight}|${L.marginTop}|${L.marginLeft}`;
  const exactHit = paperCache.get(exactKey);
  if (exactHit) return exactHit;

  const base = getBasePaperCanvas(engine, template, W, H);
  if (UNRULED_TEMPLATES.has(template)) return base;

  const c = ensureScratch(fastPaperScratchRef, W, H);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(base, 0, 0);

  const k = W / 1240;
  const lineH = Math.max(8 * k, L.lineHeight * scale);
  const firstBaseline = L.marginTop * scale;
  const marginLeft = L.marginLeft * scale;
  const ruleOffset = 2 * k;
  const top = Math.max(lineH * 1.1, H * 0.05);

  const ruledRows = () => {
    const rows: number[] = [];
    let y = firstBaseline + ruleOffset;
    while (y - lineH >= top) y -= lineH;
    while (y < H - lineH * 0.35) {
      rows.push(y);
      y += lineH;
    }
    return rows;
  };

  const marginX = marginLeft - 16 * k;

  ctx.save();
  if (template === 1 || template === 2 || template === 8 || template === 9) {
    ctx.strokeStyle = 'rgba(118, 158, 214, 0.56)';
    ctx.lineWidth = Math.max(1, 1.4 * k);
    ctx.beginPath();
    for (const y of ruledRows()) {
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
    ctx.stroke();

    if (template !== 9 && marginX > 6 * k) {
      ctx.strokeStyle = 'rgba(222, 86, 92, 0.58)';
      ctx.lineWidth = Math.max(1, 1.6 * k);
      ctx.beginPath();
      ctx.moveTo(marginX, 0);
      ctx.lineTo(marginX, H);
      ctx.stroke();

      if (template === 8) {
        ctx.strokeStyle = 'rgba(222, 86, 92, 0.48)';
        ctx.lineWidth = Math.max(1, 1.2 * k);
        ctx.beginPath();
        ctx.moveTo(marginX - 6 * k, 0);
        ctx.lineTo(marginX - 6 * k, H);
        ctx.stroke();

        const header = Math.max(top * 0.6, firstBaseline - lineH * 1.35);
        ctx.strokeStyle = 'rgba(222, 86, 92, 0.56)';
        ctx.lineWidth = Math.max(1, 1.6 * k);
        ctx.beginPath();
        ctx.moveTo(0, header);
        ctx.lineTo(W, header);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(222, 86, 92, 0.46)';
        ctx.lineWidth = Math.max(1, 1.2 * k);
        ctx.beginPath();
        ctx.moveTo(0, header - 5 * k);
        ctx.lineTo(W, header - 5 * k);
        ctx.stroke();
      }
    }
  } else if (template === 5) {
    ctx.strokeStyle = 'rgba(110, 150, 196, 0.46)';
    ctx.lineWidth = Math.max(1, 1.4 * k);
    ctx.beginPath();
    for (const y of ruledRows()) {
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
    ctx.stroke();

    if (marginX > 10 * k) {
      ctx.strokeStyle = 'rgba(222, 86, 92, 0.56)';
      ctx.lineWidth = Math.max(1, 1.5 * k);
      ctx.beginPath();
      ctx.moveTo(marginX, 0);
      ctx.lineTo(marginX, H);
      ctx.moveTo(marginX - 6 * k, 0);
      ctx.lineTo(marginX - 6 * k, H);
      ctx.stroke();
    }
  } else if (template === 3) {
    const g = lineH / 2;
    let y = (firstBaseline + ruleOffset) % g;
    if (y < 0) y += g;
    let row = Math.round((firstBaseline + ruleOffset - y) / g);
    while (y < H) {
      const major = row % 2 === 0;
      ctx.strokeStyle = major ? 'rgba(128, 176, 190, 0.39)' : 'rgba(128, 176, 190, 0.22)';
      ctx.lineWidth = Math.max(0.75, (major ? 1.3 : 0.9) * k);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
      y += g;
      row += 1;
    }
    let x = marginLeft % g;
    if (x < 0) x += g;
    let col = Math.round((marginLeft - x) / g);
    while (x < W) {
      const major = col % 2 === 0;
      ctx.strokeStyle = major ? 'rgba(128, 176, 190, 0.39)' : 'rgba(128, 176, 190, 0.22)';
      ctx.lineWidth = Math.max(0.75, (major ? 1.3 : 0.9) * k);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
      x += g;
      col += 1;
    }
  } else if (template === 4) {
    const g = lineH / 2;
    let y = (firstBaseline + ruleOffset) % g;
    if (y < 0) y += g;
    const startX = ((marginLeft % g) + g) % g;
    const r = Math.max(1, 1.3 * k);
    ctx.fillStyle = 'rgba(150, 160, 175, 0.55)';
    ctx.beginPath();
    while (y < H) {
      let x = startX;
      while (x < W) {
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
        x += g;
      }
      y += g;
    }
    ctx.fill();
  }
  ctx.restore();

  void photo;
  return c;
}

function paperCanvas(input: RenderInput, page: number, scale: number): HTMLCanvasElement | null {
  const { settings: s, engine } = input;
  const { paper, photo } = resolvePaper(input, page);
  const size = PAGE_SIZES[s.pageSize];
  const L = layoutForPage(s, input.overrides, page);
  const W = Math.round(size.width * scale);
  const H = Math.round(size.height * scale);
  if (!paper) return null;
  const key = paper.kind !== 'template'
    ? `img|${photo?.src.length}|${photo?.src.slice(-32)}|${W}x${H}`
    : UNRULED_TEMPLATES.has(paper.template)
      ? `t${paper.template}|${W}x${H}`
      : `t${paper.template}|${W}x${H}|${L.lineHeight}|${L.marginTop}|${L.marginLeft}`;
  const hit = paperCache.get(key);
  if (hit) return hit;
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d')!;
  if (paper.kind !== 'template') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    if (!photo) return c;
    ctx.imageSmoothingQuality = 'high';
    const r = Math.max(W / photo.naturalWidth, H / photo.naturalHeight);
    const dw = photo.naturalWidth * r;
    const dh = photo.naturalHeight * r;
    ctx.drawImage(photo, (W - dw) / 2, (H - dh) / 2, dw, dh);
  } else {
    const img = engine.renderPaper(W, H, paper.template, L.lineHeight * scale, L.marginTop * scale, L.marginLeft * scale, 7919);
    ctx.putImageData(img, 0, 0);
  }
  if (paperCache.size > 12) paperCache.delete(paperCache.keys().next().value!);
  paperCache.set(key, c);
  return c;
}

function drawSmoothPath(ctx: CanvasRenderingContext2D, pts: Float32Array, scale: number) {
  const n = pts.length / 2;
  if (n < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0] * scale, pts[1] * scale);
  for (let i = 1; i < n - 1; i++) {
    const mx = ((pts[i * 2] + pts[i * 2 + 2]) / 2) * scale;
    const my = ((pts[i * 2 + 1] + pts[i * 2 + 3]) / 2) * scale;
    ctx.quadraticCurveTo(pts[i * 2] * scale, pts[i * 2 + 1] * scale, mx, my);
  }
  ctx.lineTo(pts[(n - 1) * 2] * scale, pts[(n - 1) * 2 + 1] * scale);
  ctx.stroke();
}

export function formatPageNumber(s: AssignmentSettings, page: number, totalPages: number): string {
  const start = Math.max(1, Math.round(s.pageNumberStart || 1));
  const num = start + page;
  const total = Math.max(num, start + Math.max(1, totalPages) - 1);
  switch (s.pageNumberFormat) {
    case 'number':
    case 'circled':
      return String(num);
    case 'slash':
      return `${num} / ${total}`;
    case 'dash':
      return `- ${num} -`;
    case 'pg':
      return `Pg. ${num}`;
    case 'page':
    default:
      return `Page ${num}`;
  }
}

export interface PageNumberBox {
  /** Left X in unscaled page units */
  x: number;
  /** Baseline Y in unscaled page units */
  y: number;
  /** Measured width in unscaled page units */
  w: number;
  /** Font height in unscaled page units */
  h: number;
  /** Preset anchor X before user offset */
  baseX: number;
  /** Preset anchor Y before user offset */
  baseY: number;
}

/**
 * Computes paper-aware page number placement in unscaled page coordinates,
 * aligning naturally with ruled headers, Exam Sheet double headers, or the
 * printed "Page ____" box on Spiral Notebook Photo, plus user X/Y offsets.
 */
export function computePageNumberPlacement(
  s: AssignmentSettings,
  overrides: Record<number, PageLayout>,
  page: number,
  textWidth: number,
  fontPx: number,
  paper: PaperChoice | null = s.paper,
): PageNumberBox {
  const size = PAGE_SIZES[s.pageSize];
  const L = layoutForPage(s, overrides, page);
  const pos = s.pageNumberPosition ?? 'top-right';
  const fmt = s.pageNumberFormat ?? 'page';
  const isTop = pos.startsWith('top-');
  const isLeft = pos.endsWith('-left');
  const isCenter = pos.endsWith('-center');

  const ruleScale = size.width / 1240;
  const ruleOffset = 2 * ruleScale;
  const topLimit = Math.max(L.lineHeight * 1.1, size.height * 0.05);

  let baseX: number | null = null;
  let baseY: number;

  if (isTop) {
    if (paper?.kind === 'stock' && paper.id === 'spiral-notebook') {
      const k = Math.max(size.width / 1240, size.height / 1754);
      const ox = (size.width - 1240 * k) / 2;
      const oy = (size.height - 1754 * k) / 2;
      if (pos === 'top-right') {
        if (fmt === 'number' || fmt === 'slash' || fmt === 'circled' || fmt === 'dash') {
          baseX = ox + 1079 * k - textWidth / 2;
          baseY = oy + 132 * k;
        } else {
          baseY = Math.max(fontPx * 1.1, L.marginTop - L.lineHeight);
        }
      } else {
        baseY = oy + 146 * k;
      }
    } else if (paper?.kind === 'template' && paper.template === 8) {
      const headerY = Math.max(topLimit * 0.6, L.marginTop - L.lineHeight * 1.35);
      baseY = Math.max(fontPx * 1.05, headerY - Math.max(16, L.lineHeight * 0.34));
    } else if (paper?.kind === 'template' && (paper.template === 1 || paper.template === 2 || paper.template === 5 || paper.template === 9)) {
      let topRuleY = L.marginTop;
      while (topRuleY - L.lineHeight + ruleOffset >= topLimit) {
        topRuleY -= L.lineHeight;
      }
      if (topRuleY < L.marginTop - 4) {
        baseY = topRuleY;
      } else {
        baseY = Math.max(fontPx * 1.05, (topRuleY - fontPx * 0.25) * 0.64);
      }
    } else {
      baseY = Math.max(fontPx * 1.1, Math.min(L.marginTop - Math.max(L.lineHeight * 0.95, fontPx * 1.3), L.marginTop * 0.62));
    }
  } else {
    if (paper?.kind === 'template' && (paper.template === 1 || paper.template === 2 || paper.template === 5 || paper.template === 8 || paper.template === 9)) {
      let y = L.marginTop;
      while (y <= size.height - L.marginBottom + 0.5) {
        y += L.lineHeight;
      }
      if (y + ruleOffset < size.height - L.lineHeight * 0.35) {
        baseY = y;
      } else {
        baseY = Math.min(
          size.height - Math.max(22, fontPx * 0.42),
          Math.max(size.height - L.marginBottom + fontPx * 1.15, size.height - L.marginBottom * 0.42),
        );
      }
    } else {
      baseY = Math.min(
        size.height - Math.max(24, fontPx * 0.45),
        Math.max(size.height - L.marginBottom + fontPx * 1.15, size.height - L.marginBottom * 0.45),
      );
    }
  }

  if (baseX === null) {
    if (isLeft) {
      baseX = Math.max(24, L.marginLeft);
    } else if (isCenter) {
      const colCenter = (L.marginLeft + (size.width - L.marginRight)) / 2;
      baseX = colCenter - textWidth / 2;
    } else {
      baseX = size.width - Math.max(42, L.marginRight) - textWidth;
    }
  }

  const offsetX = s.pageNumberOffsetX || 0;
  const offsetY = s.pageNumberOffsetY || 0;
  const x = Math.min(size.width - textWidth - 8, Math.max(8, baseX + offsetX));
  const y = Math.min(size.height - 10, Math.max(fontPx * 0.85, baseY + offsetY));

  return { x, y, w: textWidth, h: fontPx, baseX, baseY };
}

/** Sets the transform to (x, y) with the whole page rotated about the first-line/left-margin pivot. */
function applyPageSlant(ctx: CanvasRenderingContext2D, slant: { rad: number; px: number; py: number }, x: number, y: number) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (slant.rad === 0) {
    ctx.translate(x, y);
    return;
  }
  ctx.translate(slant.px, slant.py);
  ctx.rotate(slant.rad);
  ctx.translate(x - slant.px, y - slant.py);
}

function drawInk(input: RenderInput, page: number, scale: number, fast?: boolean): { ink: HTMLCanvasElement; pageNumBox: PageNumberBox | null } {
  const { settings: s, layout, units, fontA, fontB } = input;
  const size = PAGE_SIZES[s.pageSize];
  const pen = PENS.find((p) => p.id === s.pen) ?? PENS[0];
  const color = inkColor(s);
  const ink = ensureScratch(inkScratchRef, size.width * scale, size.height * scale);
  const ctx = ink.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.textBaseline = 'alphabetic';
  const g = layout.glyphs;
  const pageLayout = layoutForPage(s, input.overrides, page);
  const pageSlant = {
    rad: ((pageLayout.angle ?? 0) * Math.PI) / 180,
    px: pageLayout.marginLeft * scale,
    py: pageLayout.marginTop * scale,
  };
  let currentFont = '';
  const strokeW = s.fontSize * pen.strokeWidth * scale;
  for (const idx of layout.glyphsByPage[page] ?? []) {
    const o = idx * GLYPH_STRIDE;
    const unit = units[g[o + 1]];
    if (!unit) continue;
    const f = g[o + 6] > 0.5 ? fontB : fontA;
    const px = s.fontSize * g[o + 5] * f.sizeAdjust * scale;
    const font = `${px.toFixed(2)}px "${f.family}", cursive`;
    if (font !== currentFont) {
      ctx.font = font;
      currentFont = font;
    }
    applyPageSlant(ctx, pageSlant, g[o + 2] * scale, g[o + 3] * scale);
    ctx.rotate(g[o + 4]);
    ctx.transform(1, 0, g[o + 8], 1, 0, 0);
    ctx.globalAlpha = g[o + 7];
    ctx.fillText(unit, 0, 0);
    const tracedOver = (g[o + 9] & GLYPH_FLAG.overwrite) !== 0;
    if (tracedOver) {
      ctx.globalAlpha = Math.min(1, g[o + 7] * 1.08);
      ctx.lineWidth = Math.max(strokeW * 2.6, s.fontSize * 0.035 * scale);
      ctx.strokeText(unit, 0, 0);
      ctx.fillText(unit, s.fontSize * 0.012 * scale, -s.fontSize * 0.008 * scale);
    }
  }
  applyPageSlant(ctx, pageSlant, 0, 0);
  ctx.globalAlpha = Math.min(1, s.inkOpacity * 1.02);
  for (const st of layout.strokes) {
    if (st.page !== page) continue;
    const weight = st.kind === 3 ? 0.04 : st.kind === 4 || st.kind === 5 ? 0.045 : 0.055;
    ctx.lineWidth = Math.max(1, s.fontSize * weight * scale * (pen.id === 'gel' ? 1.15 : pen.id === 'pencil' ? 0.8 : 1));
    drawSmoothPath(ctx, st.points, scale);
  }

  let pageNumBox: PageNumberBox | null = null;
  if (s.pageNumbers) {
    const numScale = s.pageNumberScale || 0.82;
    const fontPx = s.fontSize * numScale * fontA.sizeAdjust;
    const scaledFontPx = fontPx * scale;
    ctx.font = `${scaledFontPx.toFixed(2)}px "${fontA.family}", cursive`;
    const label = formatPageNumber(s, page, layout.pages);
    const chars = Array.from(label);
    const charWidths = chars.map((ch) => ctx.measureText(ch).width / scale + s.letterSpacing * 0.5);
    const totalW = Math.max(12, charWidths.reduce((acc, w) => acc + w, 0));
    pageNumBox = computePageNumberPlacement(s, input.overrides, page, totalW, fontPx, resolvePaper(input, page).paper);
    const tiltRad = (s.tilt * Math.PI) / 180;
    const pnStrokeW = strokeW * numScale;

    let cursorX = pageNumBox.x;
    chars.forEach((ch, idx) => {
      const hSeed = (s.seed + page * 131 + idx * 37) >>> 0;
      const r1 = ((Math.imul(hSeed ^ 0x9e3779b9, 1664525) >>> 0) / 4294967295) - 0.5;
      const r2 = ((Math.imul(hSeed ^ 0x85ebca6b, 22695477) >>> 0) / 4294967295) - 0.5;
      const dy = r1 * Math.min(2.2, s.baselineWobble * 0.65);
      const dRot = tiltRad + r2 * 0.045 * s.charVariance;
      ctx.setTransform(1, 0, 0, 1, cursorX * scale, (pageNumBox!.y + dy) * scale);
      ctx.rotate(dRot);
      ctx.globalAlpha = Math.min(1, Math.max(0.25, s.inkOpacity * (1 + r1 * 0.08 * s.inkVariance)));
      ctx.fillText(ch, 0, 0);
      if (pnStrokeW > 0.14) {
        ctx.lineWidth = pnStrokeW;
        ctx.strokeText(ch, 0, 0);
      }
      cursorX += charWidths[idx];
    });
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    if (s.pageNumberFormat === 'circled') {
      const cx = (pageNumBox.x + totalW / 2) * scale;
      const cy = (pageNumBox.y - fontPx * 0.34) * scale;
      const rx = Math.max(fontPx * 0.64, totalW * 0.68) * scale;
      const ry = fontPx * 0.6 * scale;
      ctx.save();
      ctx.globalAlpha = Math.min(1, s.inkOpacity * 0.9);
      ctx.lineWidth = Math.max(1.1 * scale, s.fontSize * 0.042 * scale);
      ctx.beginPath();
      const steps = 20;
      for (let i = 0; i <= steps + 2; i++) {
        const t = (i / steps) * Math.PI * 2 + 0.25;
        const wobble = Math.sin(i * 1.9 + page) * 1.15 * scale;
        const px = cx + Math.cos(t) * (rx + wobble);
        const py = cy + Math.sin(t) * (ry + wobble * 0.7);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  ctx.globalAlpha = 1;
  if (!fast) {
    const img = ctx.getImageData(0, 0, ink.width, ink.height);
    input.engine.inkTexture(img, pen.engineId, s.seed + page * 101, scale);
    ctx.putImageData(img, 0, 0);
  }
  return { ink, pageNumBox };
}

export interface LoadedDiagram {
  diagram: Diagram;
  image: HTMLImageElement;
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image failed to load'));
    img.src = src;
  });
}

export interface RenderOptions {
  scale: number;
  guides?: boolean;
  activeGuide?: ActiveGuide;
  fast?: boolean;
  diagrams?: LoadedDiagram[];
  /**
   * Bake the page-variation crop/zoom/tilt into the canvas. Exports set this;
   * the preview leaves it off and applies the same transform with CSS so the
   * drag overlays stay aligned with the text.
   */
  frame?: boolean;
}

const hashView = new DataView(new ArrayBuffer(4));

function mixFloat(h: number, v: number): number {
  hashView.setFloat32(0, v);
  return Math.imul(h ^ hashView.getUint32(0), 16777619) >>> 0;
}

function mixString(h: number, str: string): number {
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619) >>> 0;
  return h;
}

export function pageSignature(input: RenderInput, page: number, base: string): string {
  const { layout, units, overrides, settings } = input;
  const g = layout.glyphs;
  let h = mixString(2166136261, base);
  if (settings.pageNumbers) {
    h = mixFloat(h, page);
    h = mixFloat(h, layout.pages);
  }
  const ov = overrides[page];
  if (ov) h = mixString(h, JSON.stringify(ov));
  if (input.guideDoc) h = mixString(h, JSON.stringify(layoutForPage(input.guideDoc.settings, input.guideDoc.overrides, page)));
  const pageAdj = input.pageAdjust?.[page];
  if (pageAdj) h = mixString(h, JSON.stringify(pageAdj));
  const pageVar = input.pageVariation?.[page];
  if (pageVar) h = mixString(h, `var|${JSON.stringify(pageVar)}`);
  const own = input.pagePapers?.[page];
  if (own) {
    const img = resolvePaper(input, page).photo;
    h = mixString(h, `${JSON.stringify(own)}|${img ? `${img.src.length}|${img.src.slice(-32)}` : ''}`);
  }
  const idxs = layout.glyphsByPage[page] ?? [];
  for (const idx of idxs) {
    const o = idx * GLYPH_STRIDE;
    h = mixString(h, units[g[o + 1]] ?? '');
    for (let k = 2; k < GLYPH_STRIDE; k++) h = mixFloat(h, g[o + k]);
  }
  for (const st of layout.strokes) {
    if (st.page !== page) continue;
    h = mixFloat(h, st.kind);
    for (let k = 0; k < st.points.length; k++) h = mixFloat(h, st.points[k]);
  }
  return `${idxs.length}:${h.toString(36)}`;
}

function drawGuidePill(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, scale: number, color = '#1d4ed8') {
  ctx.save();
  const fontSize = Math.round(18 * scale);
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
  const padX = 10 * scale;
  const padY = 5 * scale;
  const tw = ctx.measureText(text).width;
  const bw = tw + padX * 2;
  const bh = fontSize + padY * 2;
  const rx = Math.min(ctx.canvas.width - bw - 8 * scale, Math.max(8 * scale, x - bw / 2));
  const ry = Math.min(ctx.canvas.height - bh - 8 * scale, Math.max(8 * scale, y - bh / 2));

  ctx.fillStyle = color;
  ctx.beginPath();
  const r = 6 * scale;
  ctx.roundRect(rx, ry, bw, bh, r);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, rx + padX, ry + bh / 2 + 0.5 * scale);
  ctx.restore();
}

export function renderPage(input: RenderInput, page: number, opts: RenderOptions): HTMLCanvasElement {
  const { settings: s } = input;
  const scale = opts.scale;
  const size = PAGE_SIZES[s.pageSize];
  const out = makeCanvas(size.width * scale, size.height * scale);
  const ctx = out.getContext('2d')!;
  const paper = opts.fast ? fastPaperCanvas(input, page, scale) : paperCanvas(input, page, scale);
  if (paper) ctx.drawImage(paper, 0, 0);
  else {
    ctx.fillStyle = '#fdfdfb';
    ctx.fillRect(0, 0, out.width, out.height);
  }
  const { ink, pageNumBox } = drawInk(input, page, scale, opts.fast);
  const pen = PENS.find((p) => p.id === s.pen) ?? PENS[0];
  ctx.globalCompositeOperation = 'multiply';
  if (!opts.fast && pen.bleed > 0 && 'filter' in ctx) {
    ctx.filter = `blur(${Math.max(0.6, s.fontSize * pen.bleed * scale).toFixed(2)}px)`;
    ctx.globalAlpha = 0.45;
    ctx.drawImage(ink, 0, 0);
    ctx.filter = 'none';
    ctx.globalAlpha = 1;
  }
  ctx.drawImage(ink, 0, 0);
  for (const { diagram: d, image } of opts.diagrams ?? []) {
    if (d.page !== page) continue;
    ctx.globalAlpha = d.opacity;
    ctx.drawImage(image, d.x * scale, d.y * scale, d.w * scale, d.h * scale);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  if (s.photoFilter && s.photoStrength > 0 && (!opts.fast || opts.activeGuide === 'photoStrength')) {
    const img = ctx.getImageData(0, 0, out.width, out.height);
    input.engine.photoFilter(img, s.photoStrength, s.seed + page * 31);
    ctx.putImageData(img, 0, 0);
  }
  const adj = combineAdjust(s.adjust, input.pageAdjust?.[page]);
  if (!isNeutralAdjust(adj)) {
    const img = ctx.getImageData(0, 0, out.width, out.height);
    applyImageAdjust(img, adj, !opts.fast || opts.activeGuide === 'adjust');
    ctx.putImageData(img, 0, 0);
  }

  const look = pageLook(s.variation, s.variationSeed ?? 0, input.pageVariation?.[page], page, size.width, size.height);
  if (look) {
    if (opts.frame) {
      const flat = makeCanvas(out.width, out.height);
      flat.getContext('2d')!.drawImage(out, 0, 0);
      applyLookFraming(ctx, flat, look);
    }
    const img = ctx.getImageData(0, 0, out.width, out.height);
    applyLookTone(img, look, !opts.fast);
    ctx.putImageData(img, 0, 0);
    applyLookLight(ctx, look, scale, !opts.fast);
  }

  const ag = opts.activeGuide ?? null;
  const isLayoutDrag =
    ag === 'marginLeft' ||
    ag === 'marginRight' ||
    ag === 'marginTop' ||
    ag === 'marginBottom' ||
    ag === 'lineHeight' ||
    ag === 'paragraphIndent';

  if (opts.guides || isLayoutDrag) {
    const L = layoutForPage(s, input.overrides, page);
    const boxLeft = L.marginLeft * scale;
    const boxRight = (size.width - L.marginRight) * scale;
    const boxTop = (L.marginTop - L.lineHeight) * scale;
    const boxBottom = (size.height - L.marginBottom) * scale;

    ctx.save();
    ctx.strokeStyle = 'rgba(37, 99, 235, 0.5)';
    ctx.lineWidth = Math.max(1.2, 1.4 * scale);
    ctx.setLineDash([8 * scale, 6 * scale]);
    ctx.strokeRect(boxLeft, boxTop, boxRight - boxLeft, boxBottom - boxTop);
    ctx.setLineDash([]);

    ctx.strokeStyle = ag === 'lineHeight' ? 'rgba(37, 99, 235, 0.48)' : 'rgba(37, 99, 235, 0.22)';
    ctx.lineWidth = Math.max(1, (ag === 'lineHeight' ? 1.4 : 1) * scale);
    for (let y = L.marginTop; y <= size.height - L.marginBottom + 0.5; y += L.lineHeight) {
      ctx.beginPath();
      ctx.moveTo(boxLeft, y * scale);
      ctx.lineTo(boxRight, y * scale);
      ctx.stroke();
    }

    if (s.paragraphIndent > 0 || ag === 'paragraphIndent') {
      const indentX = (L.marginLeft + s.paragraphIndent) * scale;
      ctx.strokeStyle = ag === 'paragraphIndent' ? '#d97706' : 'rgba(217, 119, 6, 0.45)';
      ctx.lineWidth = Math.max(1.5, 2 * scale);
      ctx.setLineDash([5 * scale, 4 * scale]);
      ctx.beginPath();
      ctx.moveTo(indentX, boxTop);
      ctx.lineTo(indentX, boxBottom);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.lineWidth = Math.max(2, 2.6 * scale);
    ctx.strokeStyle = '#1d4ed8';
    if (ag === 'marginLeft') {
      ctx.beginPath();
      ctx.moveTo(boxLeft, 0);
      ctx.lineTo(boxLeft, out.height);
      ctx.stroke();
      drawGuidePill(ctx, `Left margin · ${Math.round(L.marginLeft)}px`, boxLeft, Math.max(46 * scale, boxTop + 34 * scale), scale);
    } else if (ag === 'marginRight') {
      ctx.beginPath();
      ctx.moveTo(boxRight, 0);
      ctx.lineTo(boxRight, out.height);
      ctx.stroke();
      drawGuidePill(ctx, `Right margin · ${Math.round(L.marginRight)}px`, boxRight, Math.max(46 * scale, boxTop + 34 * scale), scale);
    } else if (ag === 'marginTop') {
      const requested = input.guideDoc ? layoutForPage(input.guideDoc.settings, input.guideDoc.overrides, page) : L;
      const firstY = requested.marginTop * scale;
      ctx.beginPath();
      ctx.moveTo(0, firstY);
      ctx.lineTo(out.width, firstY);
      ctx.stroke();
      const snappedLabel = Math.abs(requested.marginTop - L.marginTop) > 0.5 ? ` · snapped to ${Math.round(L.marginTop)}px` : '';
      drawGuidePill(ctx, `First line · ${Math.round(requested.marginTop)}px${snappedLabel}`, (boxLeft + boxRight) / 2, Math.max(30 * scale, firstY - 24 * scale), scale);
    } else if (ag === 'marginBottom') {
      ctx.beginPath();
      ctx.moveTo(0, boxBottom);
      ctx.lineTo(out.width, boxBottom);
      ctx.stroke();
      drawGuidePill(ctx, `Bottom margin · ${Math.round(L.marginBottom)}px`, (boxLeft + boxRight) / 2, Math.min(out.height - 30 * scale, boxBottom + 24 * scale), scale);
    } else if (ag === 'lineHeight') {
      drawGuidePill(ctx, `Line height · ${L.lineHeight}px`, (boxLeft + boxRight) / 2, Math.max(36 * scale, L.marginTop * scale - 22 * scale), scale);
    } else if (ag === 'paragraphIndent') {
      const indentX = (L.marginLeft + s.paragraphIndent) * scale;
      drawGuidePill(ctx, `Indent · ${Math.round(s.paragraphIndent)}px`, indentX, Math.max(46 * scale, boxTop + 34 * scale), scale, '#b45309');
    }
    ctx.restore();
  }

  if (pageNumBox && (opts.guides || ag === 'pageNumber')) {
    ctx.save();
    const padX = 10 * scale;
    const padY = 6 * scale;
    const bx = pageNumBox.x * scale - padX;
    const by = (pageNumBox.y - pageNumBox.h * 0.85) * scale - padY;
    const bw = pageNumBox.w * scale + padX * 2;
    const bh = pageNumBox.h * 1.1 * scale + padY * 2;

    ctx.strokeStyle = ag === 'pageNumber' ? '#b9541a' : 'rgba(185, 84, 26, 0.55)';
    ctx.fillStyle = ag === 'pageNumber' ? 'rgba(185, 84, 26, 0.08)' : 'rgba(185, 84, 26, 0.04)';
    ctx.lineWidth = Math.max(1.4, 1.8 * scale);
    ctx.setLineDash([5 * scale, 4 * scale]);
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 6 * scale);
    ctx.fill();
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.strokeStyle = '#b9541a';
    ctx.lineWidth = Math.max(1.5, 2 * scale);
    ctx.beginPath();
    ctx.moveTo(bx + 4 * scale, pageNumBox.y * scale);
    ctx.lineTo(bx + bw - 4 * scale, pageNumBox.y * scale);
    ctx.stroke();

    if (ag === 'pageNumber') {
      const ox = Math.round(s.pageNumberOffsetX || 0);
      const oy = Math.round(s.pageNumberOffsetY || 0);
      const pillLabel = ox === 0 && oy === 0
        ? `Page # (${(s.pageNumberPosition ?? 'top-right').replace('-', ' ')})`
        : `Page # (${ox >= 0 ? `+${ox}` : ox}px, ${oy >= 0 ? `+${oy}` : oy}px)`;
      const pillY = pageNumBox.y < size.height / 2
        ? by + bh + 18 * scale
        : by - 18 * scale;
      drawGuidePill(ctx, pillLabel, bx + bw / 2, pillY, scale, '#b9541a');
    }
    ctx.restore();
  }

  return out;
}

export async function tintDiagram(src: string, color: string): Promise<string> {
  const img = await loadImage(src);
  const c = makeCanvas(img.naturalWidth, img.naturalHeight);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height);
  const r = parseInt(color.slice(1, 3), 16);
  const gg = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
    const a = Math.pow(Math.max(0, 1 - lum), 0.75) * (d[i + 3] / 255);
    d[i] = r;
    d[i + 1] = gg;
    d[i + 2] = b;
    d[i + 3] = Math.round(Math.min(1, a * 1.35) * 255);
  }
  ctx.putImageData(data, 0, 0);
  return c.toDataURL('image/png');
}
