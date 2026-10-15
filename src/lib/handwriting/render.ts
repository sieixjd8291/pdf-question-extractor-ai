import type { HandwritingEngine } from './engine';
import { PAGE_SIZES, PENS, inkColor, type AssignmentSettings, type Diagram, type HandwritingFont, type PageLayout } from './catalog';
import { GLYPH_FLAG, GLYPH_STRIDE, layoutForPage, type LayoutResult } from './compose';

export interface RenderInput {
  engine: HandwritingEngine;
  settings: AssignmentSettings;
  overrides: Record<number, PageLayout>;
  layout: LayoutResult;
  units: string[];
  fontA: HandwritingFont;
  fontB: HandwritingFont;
  photo: HTMLImageElement | null;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

const paperCache = new Map<string, HTMLCanvasElement>();

function paperCanvas(input: RenderInput, page: number, scale: number): HTMLCanvasElement | null {
  const { settings: s, engine, photo } = input;
  const size = PAGE_SIZES[s.pageSize];
  const L = layoutForPage(s, input.overrides, page);
  const W = Math.round(size.width * scale);
  const H = Math.round(size.height * scale);
  if (!s.paper) return null;
  const key = s.paper.kind !== 'template'
    ? `img|${photo?.src.length}|${photo?.src.slice(-32)}|${W}x${H}`
    : `t${s.paper.template}|${W}x${H}|${L.lineHeight}|${L.marginTop}|${L.marginLeft}`;
  const hit = paperCache.get(key);
  if (hit) return hit;
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d')!;
  if (s.paper.kind !== 'template') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    if (!photo) return c;
    ctx.imageSmoothingQuality = 'high';
    const r = Math.max(W / photo.naturalWidth, H / photo.naturalHeight);
    const dw = photo.naturalWidth * r;
    const dh = photo.naturalHeight * r;
    ctx.drawImage(photo, (W - dw) / 2, (H - dh) / 2, dw, dh);
  } else {
    const img = engine.renderPaper(W, H, s.paper.template, L.lineHeight * scale, L.marginTop * scale, L.marginLeft * scale, 7919);
    ctx.putImageData(img, 0, 0);
  }
  if (paperCache.size > 10) paperCache.delete(paperCache.keys().next().value!);
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

function drawInk(input: RenderInput, page: number, scale: number): HTMLCanvasElement {
  const { settings: s, layout, units, fontA, fontB } = input;
  const size = PAGE_SIZES[s.pageSize];
  const pen = PENS.find((p) => p.id === s.pen) ?? PENS[0];
  const color = inkColor(s);
  const ink = makeCanvas(size.width * scale, size.height * scale);
  const ctx = ink.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.textBaseline = 'alphabetic';
  const g = layout.glyphs;
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
    ctx.setTransform(1, 0, 0, 1, g[o + 2] * scale, g[o + 3] * scale);
    ctx.rotate(g[o + 4]);
    ctx.transform(1, 0, g[o + 8], 1, 0, 0);
    ctx.globalAlpha = g[o + 7];
    ctx.fillText(unit, 0, 0);
    const tracedOver = (g[o + 9] & GLYPH_FLAG.overwrite) !== 0;
    if (tracedOver) {
      // A corrected letter is pressed hard and gone over twice, so it reads darker and bolder.
      ctx.globalAlpha = Math.min(1, g[o + 7] * 1.08);
      ctx.lineWidth = Math.max(strokeW * 2.6, s.fontSize * 0.035 * scale);
      ctx.strokeText(unit, 0, 0);
      ctx.fillText(unit, s.fontSize * 0.012 * scale, -s.fontSize * 0.008 * scale);
    } else if (strokeW > 0.15) {
      ctx.lineWidth = strokeW;
      ctx.strokeText(unit, 0, 0);
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = Math.min(1, s.inkOpacity * 1.02);
  for (const st of layout.strokes) {
    if (st.page !== page) continue;
    const weight = st.kind === 3 ? 0.04 : st.kind === 4 || st.kind === 5 ? 0.045 : 0.055;
    ctx.lineWidth = Math.max(1, s.fontSize * weight * scale * (pen.id === 'gel' ? 1.15 : pen.id === 'pencil' ? 0.8 : 1));
    drawSmoothPath(ctx, st.points, scale);
  }
  if (s.pageNumbers) {
    const L = layoutForPage(s, input.overrides, page);
    ctx.globalAlpha = s.inkOpacity;
    ctx.font = `${(s.fontSize * 0.8 * fontA.sizeAdjust * scale).toFixed(2)}px "${fontA.family}", cursive`;
    const label = `Page ${page + 1}`;
    const w = ctx.measureText(label).width;
    const y = Math.max(L.lineHeight, L.marginTop - L.lineHeight * 1.6) * scale;
    ctx.fillText(label, size.width * scale - L.marginRight * scale - w, y);
  }
  ctx.globalAlpha = 1;
  const img = ctx.getImageData(0, 0, ink.width, ink.height);
  input.engine.inkTexture(img, pen.engineId, s.seed + page * 101, scale);
  ctx.putImageData(img, 0, 0);
  return ink;
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
  diagrams?: LoadedDiagram[];
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

/**
 * Cheap fingerprint of everything that ends up on one page's pixels, so an
 * unchanged page can keep its existing canvas instead of being redrawn.
 * `base` must cover the settings, fonts, photo, scale and guides.
 */
export function pageSignature(input: RenderInput, page: number, base: string): string {
  const { layout, units, overrides } = input;
  const g = layout.glyphs;
  let h = mixString(2166136261, base);
  const ov = overrides[page];
  if (ov) h = mixString(h, JSON.stringify(ov));
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

export function renderPage(input: RenderInput, page: number, opts: RenderOptions): HTMLCanvasElement {
  const { settings: s } = input;
  const scale = opts.scale;
  const size = PAGE_SIZES[s.pageSize];
  const out = makeCanvas(size.width * scale, size.height * scale);
  const ctx = out.getContext('2d')!;
  const paper = paperCanvas(input, page, scale);
  if (paper) ctx.drawImage(paper, 0, 0);
  else {
    ctx.fillStyle = '#fdfdfb';
    ctx.fillRect(0, 0, out.width, out.height);
  }
  const ink = drawInk(input, page, scale);
  const pen = PENS.find((p) => p.id === s.pen) ?? PENS[0];
  ctx.globalCompositeOperation = 'multiply';
  if (pen.bleed > 0 && 'filter' in ctx) {
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
  if (s.photoFilter && s.photoStrength > 0) {
    const img = ctx.getImageData(0, 0, out.width, out.height);
    input.engine.photoFilter(img, s.photoStrength, s.seed + page * 31);
    ctx.putImageData(img, 0, 0);
  }
  if (opts.guides) {
    const L = layoutForPage(s, input.overrides, page);
    ctx.save();
    ctx.strokeStyle = 'rgba(46, 99, 214, 0.55)';
    ctx.lineWidth = Math.max(1, scale);
    ctx.setLineDash([8 * scale, 6 * scale]);
    ctx.strokeRect(L.marginLeft * scale, (L.marginTop - L.lineHeight) * scale, (size.width - L.marginLeft - L.marginRight) * scale, (size.height - L.marginBottom - L.marginTop + L.lineHeight) * scale);
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(46, 99, 214, 0.22)';
    for (let y = L.marginTop; y <= size.height - L.marginBottom + 0.5; y += L.lineHeight) {
      ctx.beginPath();
      ctx.moveTo(L.marginLeft * scale, y * scale);
      ctx.lineTo((size.width - L.marginRight) * scale, y * scale);
      ctx.stroke();
    }
    ctx.restore();
  }
  return out;
}

/** Recolours a diagram into ink: dark linework takes the pen colour, paper turns transparent. */
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
