/**
 * Seeded per-page "photo" variation: framing, colour, lighting and camera
 * texture, so one page layout looks like several separately photographed pages.
 * Every value is derived from a seed, so a page looks the same on every render
 * and in every export.
 */

export type VariationStrength = 'off' | 'subtle' | 'natural' | 'strong';

/** Per-page override: a fixed seed keeps (locks) or re-rolls the look; `off` disables it for that page. */
export interface PageVariation {
  seed?: number;
  off?: boolean;
}

export interface PageLook {
  /** Uniform zoom about the page centre (>= coverage minimum so no edge is exposed). */
  zoom: number;
  /** Shift as a fraction of the page width / height. */
  dx: number;
  dy: number;
  /** Rotation in degrees. */
  angle: number;
  /** Colour, each as a signed fraction (0 = unchanged). */
  brightness: number;
  contrast: number;
  warmth: number;
  saturation: number;
  tint: number;
  /** Direction the light comes from, in radians, and how much the far side darkens. */
  lightAngle: number;
  lightAmount: number;
  vignette: number;
  vignetteX: number;
  vignetteY: number;
  /** 0 top, 1 right, 2 bottom, 3 left; null when there is no hand/phone shadow. */
  shadowSide: number | null;
  shadowAmount: number;
  shadowDepth: number;
  /** Grain amplitude in 0-255 channel units. */
  grain: number;
  /** Corner whose opposite side goes slightly soft (0-3), or null. */
  softCorner: number | null;
  softness: number;
  seed: number;
}

export const VARIATION_STRENGTHS: Array<{ id: VariationStrength; label: string }> = [
  { id: 'off', label: 'Off' },
  { id: 'subtle', label: 'Subtle' },
  { id: 'natural', label: 'Natural' },
  { id: 'strong', label: 'Strong' },
];

const STRENGTH_K: Record<VariationStrength, number> = { off: 0, subtle: 0.5, natural: 1, strong: 1.7 };

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The seed a page uses when it has no override of its own. */
export function defaultPageSeed(variationSeed: number, page: number): number {
  return (Math.imul((variationSeed >>> 0) ^ 0x9e3779b9, 2654435761) + Math.imul(page + 1, 0x85ebca6b)) >>> 0;
}

export function effectivePageSeed(variationSeed: number, pv: PageVariation | undefined, page: number): number {
  return pv?.seed ?? defaultPageSeed(variationSeed, page);
}

export function pageLook(
  strength: VariationStrength | undefined,
  variationSeed: number,
  pv: PageVariation | undefined,
  page: number,
  pageW: number,
  pageH: number,
): PageLook | null {
  const k = STRENGTH_K[strength ?? 'off'] ?? 0;
  if (k === 0 || pv?.off || (!variationSeed && pv?.seed === undefined)) return null;
  const seed = effectivePageSeed(variationSeed, pv, page);
  const r = mulberry32(seed);
  const signed = () => r() * 2 - 1;

  const angle = (r() < 0.5 ? -1 : 1) * (0.3 + r() * 0.5) * k;
  const dx = signed() * 0.012 * k;
  const dy = signed() * 0.012 * k;
  const theta = Math.abs((angle * Math.PI) / 180);
  const ratio = Math.max(pageW / pageH, pageH / pageW);
  const cover = Math.cos(theta) + Math.sin(theta) * ratio + 2 * Math.max(Math.abs(dx), Math.abs(dy));
  const zoom = Math.min(1.14, Math.max(1 + (0.01 + r() * 0.05) * k, cover + 0.002));

  const look: PageLook = {
    zoom,
    dx,
    dy,
    angle,
    brightness: signed() * 0.06 * k,
    contrast: signed() * 0.05 * k,
    warmth: signed() * 0.08 * k,
    saturation: signed() * 0.08 * k,
    tint: signed() * 0.02 * k,
    lightAngle: r() * Math.PI * 2,
    lightAmount: (0.05 + r() * 0.07) * k,
    vignette: (0.06 + r() * 0.08) * k,
    vignetteX: (r() - 0.5) * 0.3,
    vignetteY: (r() - 0.5) * 0.3,
    shadowSide: null,
    shadowAmount: 0,
    shadowDepth: 0,
    grain: (2 + r() * 3) * k,
    softCorner: null,
    softness: 0,
    seed,
  };
  if (r() < 0.35 * Math.min(1, k)) {
    look.shadowSide = Math.floor(r() * 4);
    look.shadowAmount = Math.min(0.32, (0.08 + r() * 0.1) * k);
    look.shadowDepth = 0.12 + r() * 0.18;
  }
  if (k >= 1 && r() < 0.4) {
    look.softCorner = Math.floor(r() * 4);
    look.softness = 0.6 + r() * 0.6;
  }
  return look;
}

function lookDistance(a: PageLook, b: PageLook): number {
  return Math.abs(a.angle - b.angle) / 0.4 + Math.hypot(a.dx - b.dx, a.dy - b.dy) / 0.01
    + Math.abs(a.brightness - b.brightness) / 0.05 + Math.abs(a.warmth - b.warmth) / 0.06
    + Math.abs(Math.cos(a.lightAngle) - Math.cos(b.lightAngle)) + (a.shadowSide !== b.shadowSide ? 1 : 0);
}

/** Natural looks only: no near-zero tilt, no heavy shadow stacked on soft focus. */
function suitable(l: PageLook): boolean {
  return Math.abs(l.angle) >= 0.15 && !(l.shadowSide !== null && l.softCorner !== null);
}

/**
 * A fresh random seed for a re-roll that is clearly different from the page's current look
 * (and from its neighbours) yet still suitable. The result is stored, so it stays stable afterwards.
 */
export function pickRerollSeed(
  strength: VariationStrength | undefined,
  current: PageLook | null,
  avoid: Array<PageLook | null>,
  page: number,
  pageW: number,
  pageH: number,
): number {
  const s = !strength || strength === 'off' ? 'natural' : strength;
  const rand = () => {
    const buf = new Uint32Array(1);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(buf);
    else buf[0] = Math.floor(Math.random() * 4294967295);
    return (buf[0] >>> 0) || 1;
  };
  let best = rand();
  let bestScore = -1;
  for (let i = 0; i < 24; i++) {
    const seed = rand();
    const look = pageLook(s, 0, { seed }, page, pageW, pageH);
    if (!look) continue;
    const others = [current, ...avoid].filter((l): l is PageLook => !!l);
    const score = (suitable(look) ? 0 : -100) + (others.length ? Math.min(...others.map((o) => lookDistance(look, o))) : 10);
    if (score > bestScore) {
      best = seed;
      bestScore = score;
    }
    if (bestScore >= 4) break;
  }
  return best;
}

/** CSS transform equivalent of `applyLookFraming`, for preview overlays that sit on top of the canvas. */
export function lookTransformCss(look: PageLook | null): string | undefined {
  if (!look) return undefined;
  return `translate(${(look.dx * 100).toFixed(3)}%, ${(look.dy * 100).toFixed(3)}%) rotate(${look.angle.toFixed(3)}deg) scale(${look.zoom.toFixed(4)})`;
}

/** Draws `src` into `ctx` with the look's crop, zoom and tilt about the page centre. */
export function applyLookFraming(ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, look: PageLook) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(W / 2 + look.dx * W, H / 2 + look.dy * H);
  ctx.rotate((look.angle * Math.PI) / 180);
  ctx.scale(look.zoom, look.zoom);
  ctx.translate(-W / 2, -H / 2);
  ctx.drawImage(src, 0, 0, W, H);
  ctx.restore();
}

/** Brightness, contrast, warmth, saturation, green/magenta tint and sensor grain in a single pixel pass. */
export function applyLookTone(img: ImageData, look: PageLook, withGrain: boolean) {
  const d = img.data;
  const contrast = 1 + look.contrast;
  const bright = look.brightness * 255;
  const warmR = look.warmth * 40;
  const warmB = -look.warmth * 40;
  const tintG = look.tint * 60;
  const tintRB = -look.tint * 30;
  const sat = 1 + look.saturation;
  const grain = withGrain ? look.grain : 0;
  let x = (look.seed ^ 0x2545f491) >>> 0 || 1;

  const lut = new Float32Array(256);
  for (let v = 0; v < 256; v++) lut[v] = (v - 128) * contrast + 128 + bright;

  for (let i = 0; i < d.length; i += 4) {
    let r = lut[d[i]] + warmR + tintRB;
    let g = lut[d[i + 1]] + tintG;
    let b = lut[d[i + 2]] + warmB + tintRB;
    const lum = r * 0.299 + g * 0.587 + b * 0.114;
    r = lum + (r - lum) * sat;
    g = lum + (g - lum) * sat;
    b = lum + (b - lum) * sat;
    if (grain > 0) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      const n = (((x >>> 0) / 4294967296) - 0.5) * 2 * grain;
      r += n;
      g += n;
      b += n;
    }
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
  }
}

let softScratch: HTMLCanvasElement | null = null;

/** Window light, vignette, an occasional hand/phone shadow and optional soft focus toward one side. */
export function applyLookLight(ctx: CanvasRenderingContext2D, look: PageLook, scale: number, withSoftFocus: boolean) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.hypot(W, H) / 2;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  if (withSoftFocus && look.softCorner !== null && 'filter' in ctx) {
    softScratch ??= document.createElement('canvas');
    softScratch.width = W;
    softScratch.height = H;
    const sctx = softScratch.getContext('2d')!;
    sctx.filter = `blur(${(look.softness * Math.max(0.6, scale)).toFixed(2)}px)`;
    sctx.drawImage(ctx.canvas, 0, 0);
    sctx.filter = 'none';
    const corners = [[0, 0], [W, 0], [W, H], [0, H]];
    const [sx, sy] = corners[look.softCorner];
    const mask = sctx.createRadialGradient(W - sx, H - sy, R * 0.9, W - sx, H - sy, R * 2.1);
    mask.addColorStop(0, 'rgba(0,0,0,0)');
    mask.addColorStop(1, 'rgba(0,0,0,1)');
    sctx.globalCompositeOperation = 'destination-in';
    sctx.fillStyle = mask;
    sctx.fillRect(0, 0, W, H);
    sctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(softScratch, 0, 0);
  }

  ctx.globalCompositeOperation = 'multiply';
  const lx = Math.cos(look.lightAngle);
  const ly = Math.sin(look.lightAngle);
  const light = ctx.createLinearGradient(cx - lx * R, cy - ly * R, cx + lx * R, cy + ly * R);
  light.addColorStop(0, 'rgba(255, 250, 240, 0)');
  light.addColorStop(1, `rgba(52, 42, 30, ${look.lightAmount.toFixed(3)})`);
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, W, H);

  const vx = cx + look.vignetteX * W;
  const vy = cy + look.vignetteY * H;
  const vignette = ctx.createRadialGradient(vx, vy, R * 0.45, vx, vy, R * 1.15);
  vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
  vignette.addColorStop(1, `rgba(30, 24, 18, ${look.vignette.toFixed(3)})`);
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, W, H);

  if (look.shadowSide !== null && look.shadowAmount > 0) {
    const horizontal = look.shadowSide === 1 || look.shadowSide === 3;
    const depth = (horizontal ? W : H) * look.shadowDepth;
    const [x0, y0, x1, y1] =
      look.shadowSide === 0 ? [0, 0, 0, depth]
        : look.shadowSide === 1 ? [W, 0, W - depth, 0]
          : look.shadowSide === 2 ? [0, H, 0, H - depth]
            : [0, 0, depth, 0];
    const shadow = ctx.createLinearGradient(x0, y0, x1, y1);
    shadow.addColorStop(0, `rgba(28, 22, 16, ${look.shadowAmount.toFixed(3)})`);
    shadow.addColorStop(0.55, `rgba(28, 22, 16, ${(look.shadowAmount * 0.35).toFixed(3)})`);
    shadow.addColorStop(1, 'rgba(28, 22, 16, 0)');
    ctx.fillStyle = shadow;
    ctx.fillRect(0, 0, W, H);
  }

  ctx.globalCompositeOperation = 'screen';
  const hx = cx - lx * R * 0.7;
  const hy = cy - ly * R * 0.7;
  const highlight = ctx.createRadialGradient(hx, hy, 0, hx, hy, R * 0.9);
  highlight.addColorStop(0, `rgba(255, 250, 238, ${(look.lightAmount * 0.45).toFixed(3)})`);
  highlight.addColorStop(1, 'rgba(255, 250, 238, 0)');
  ctx.fillStyle = highlight;
  ctx.fillRect(0, 0, W, H);

  ctx.restore();
}
