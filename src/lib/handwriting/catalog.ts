export type FontCategory = 'cursive' | 'print' | 'world';

export interface HandwritingFont {
  family: string;
  label: string;
  category: FontCategory;
  /** Visual size normaliser so every font reads at a similar x-height. */
  sizeAdjust: number;
  scripts?: string;
  custom?: boolean;
}

export const HANDWRITING_FONTS: HandwritingFont[] = [
  { family: 'Homemade Apple', label: 'Real Cursive', category: 'cursive', sizeAdjust: 0.78 },
  { family: 'Cedarville Cursive', label: 'Cedarville Cursive', category: 'cursive', sizeAdjust: 1 },
  { family: 'La Belle Aurore', label: 'Belle Aurore', category: 'cursive', sizeAdjust: 1 },
  { family: 'Dancing Script', label: 'Dancing Script', category: 'cursive', sizeAdjust: 1 },
  { family: 'Nothing You Could Do', label: 'Quick Cursive', category: 'cursive', sizeAdjust: 0.95 },
  { family: 'Dawning of a New Day', label: 'Dawning Script', category: 'cursive', sizeAdjust: 1.05 },
  { family: 'Waiting for the Sunrise', label: 'Sunrise Hand', category: 'cursive', sizeAdjust: 1.05 },
  { family: 'Zeyada', label: 'Zeyada Slant', category: 'cursive', sizeAdjust: 1.2 },
  { family: 'Sacramento', label: 'Sacramento Signature', category: 'cursive', sizeAdjust: 1.25 },
  { family: 'Satisfy', label: 'Satisfy Brush', category: 'cursive', sizeAdjust: 1 },
  { family: 'Mrs Saint Delafield', label: 'Formal Calligraphy', category: 'cursive', sizeAdjust: 1.35 },
  { family: 'Kristi', label: 'Kristi Flourish', category: 'cursive', sizeAdjust: 1.35 },
  { family: 'Caveat', label: 'Caveat Notes', category: 'print', sizeAdjust: 1.15, scripts: 'Latin · Cyrillic' },
  { family: 'Indie Flower', label: 'Indie Flower', category: 'print', sizeAdjust: 1 },
  { family: 'Shadows Into Light', label: 'Student Print', category: 'print', sizeAdjust: 1.05 },
  { family: 'Patrick Hand', label: 'Neat Print', category: 'print', sizeAdjust: 1.05 },
  { family: 'Gochi Hand', label: 'Gochi Hand', category: 'print', sizeAdjust: 1 },
  { family: 'Reenie Beanie', label: 'Rushed Notes', category: 'print', sizeAdjust: 1.3 },
  { family: 'Architects Daughter', label: 'Architect Caps', category: 'print', sizeAdjust: 0.9 },
  { family: 'Gloria Hallelujah', label: 'Gloria Round', category: 'print', sizeAdjust: 0.85 },
  { family: 'Just Another Hand', label: 'Tall Narrow', category: 'print', sizeAdjust: 1.35 },
  { family: 'Covered By Your Grace', label: 'Marker Print', category: 'print', sizeAdjust: 1.15 },
  { family: 'Over the Rainbow', label: 'Loopy Print', category: 'print', sizeAdjust: 1 },
  { family: 'Schoolbell', label: 'Schoolbell', category: 'print', sizeAdjust: 0.95 },
  { family: 'Coming Soon', label: 'Casual Print', category: 'print', sizeAdjust: 0.9 },
  { family: 'Annie Use Your Telescope', label: 'Annie Hand', category: 'print', sizeAdjust: 1.05 },
  { family: 'Handlee', label: 'Handlee', category: 'print', sizeAdjust: 0.95 },
  { family: 'Sue Ellen Francisco', label: 'Skinny Scrawl', category: 'print', sizeAdjust: 1.3 },
  { family: 'Loved by the King', label: 'Loose Print', category: 'print', sizeAdjust: 1.15 },
  { family: 'Delius', label: 'Rounded Print', category: 'print', sizeAdjust: 0.9 },
  { family: 'Rock Salt', label: 'Rough Marker', category: 'print', sizeAdjust: 0.75 },
  { family: 'Kalam', label: 'Kalam (Hindi/Marathi)', category: 'world', sizeAdjust: 0.95, scripts: 'Devanagari · Latin' },
  { family: 'Amita', label: 'Amita (Devanagari)', category: 'world', sizeAdjust: 0.95, scripts: 'Devanagari · Latin' },
  { family: 'Marck Script', label: 'Marck (Cyrillic cursive)', category: 'world', sizeAdjust: 1.05, scripts: 'Cyrillic · Latin' },
  { family: 'Neucha', label: 'Neucha (Russian print)', category: 'world', sizeAdjust: 1.05, scripts: 'Cyrillic · Latin' },
  { family: 'Nanum Pen Script', label: 'Nanum Pen', category: 'world', sizeAdjust: 1.35, scripts: 'Latin' },
];

export type PenType = 'ballpoint' | 'gel' | 'fountain' | 'pencil';

export interface PenSpec {
  id: PenType;
  label: string;
  tag: string;
  description: string;
  /** Index understood by the Rust ink texture filter. */
  engineId: number;
  strokeWidth: number;
  bleed: number;
}

export const PENS: PenSpec[] = [
  { id: 'ballpoint', label: 'Ball Point', tag: 'Oil-based', description: 'Crisp oil-paste ink with natural roller pressure variation and zero fiber bleed.', engineId: 0, strokeWidth: 0.01, bleed: 0 },
  { id: 'gel', label: 'Gel Pen', tag: 'Water-based', description: 'Smooth, saturated gel ink with fuller strokes and a soft sheen.', engineId: 1, strokeWidth: 0.022, bleed: 0.012 },
  { id: 'fountain', label: 'Ink Pen', tag: 'Fountain', description: 'Liquid fountain ink that pools at stroke ends with a gentle fiber bleed.', engineId: 2, strokeWidth: 0.016, bleed: 0.03 },
  { id: 'pencil', label: 'Pencil', tag: 'Graphite', description: 'Soft graphite with paper-tooth grain and uneven pressure.', engineId: 3, strokeWidth: 0.004, bleed: 0 },
];

export interface InkPreset {
  id: string;
  pen: PenType;
  name: string;
  description: string;
  color: string;
}

export const INK_PRESETS: InkPreset[] = [
  { id: 'bp-blue', pen: 'ballpoint', name: 'Classic Ballpoint Blue', description: 'Everyday blue with crisp oil-paste texture', color: '#1f3ea6' },
  { id: 'bp-navy', pen: 'ballpoint', name: 'Formal Exam Navy', description: 'Dense dark navy used in formal exams', color: '#1b2a5e' },
  { id: 'bp-black', pen: 'ballpoint', name: 'Carbon Ballpoint Black', description: 'Neutral charcoal-black ballpoint', color: '#24262c' },
  { id: 'bp-red', pen: 'ballpoint', name: 'Correction Red', description: 'Teacher grading and margin annotation red', color: '#b3252c' },
  { id: 'bp-green', pen: 'ballpoint', name: 'Notebook Green', description: 'Dark green for subheadings and bullets', color: '#1f6a3b' },
  { id: 'gel-royal', pen: 'gel', name: 'Royal Blue Gel', description: 'Bright, saturated royal blue', color: '#1c3fd4' },
  { id: 'gel-deep', pen: 'gel', name: 'Classic Deep Blue', description: 'Deep blue gel for clean assignments', color: '#182f94' },
  { id: 'gel-black', pen: 'gel', name: 'Midnight Black Gel', description: 'Rich jet black with full coverage', color: '#111215' },
  { id: 'gel-purple', pen: 'gel', name: 'Violet Gel', description: 'Playful purple for journals and notes', color: '#5a2a9b' },
  { id: 'gel-red', pen: 'gel', name: 'Scarlet Gel', description: 'Vivid red for highlights and headings', color: '#c51f2b' },
  { id: 'gel-teal', pen: 'gel', name: 'Teal Gel', description: 'Cool teal for diagrams and labels', color: '#0e6a74' },
  { id: 'fp-blueblack', pen: 'fountain', name: 'Blue-Black Ink', description: 'Traditional iron-gall style blue-black', color: '#1c2a6a' },
  { id: 'fp-royal', pen: 'fountain', name: 'Washable Royal Blue', description: 'Classic school fountain pen blue', color: '#2a4fc2' },
  { id: 'fp-black', pen: 'fountain', name: 'Jet Black Ink', description: 'Deep black with soft edges', color: '#131313' },
  { id: 'fp-sepia', pen: 'fountain', name: 'Sepia Brown', description: 'Warm vintage brown for letters', color: '#5c3b1e' },
  { id: 'fp-oxblood', pen: 'fountain', name: 'Oxblood', description: 'Dark burgundy for signatures', color: '#6d1f27' },
  { id: 'pc-2b', pen: 'pencil', name: 'Soft 2B Graphite', description: 'Dark, smudgy sketching graphite', color: '#3f4045' },
  { id: 'pc-hb', pen: 'pencil', name: 'HB Graphite', description: 'Light, everyday school pencil', color: '#62636a' },
];

export interface PaperTemplate {
  id: number;
  name: string;
  description: string;
  recommended?: boolean;
}

/** Ids match the Rust paper renderer (rust/handwriting-engine/src/paper.rs). */
export const PAPER_TEMPLATES: PaperTemplate[] = [
  { id: 0, name: 'Classic White', description: 'Plain bright sheet', recommended: true },
  { id: 1, name: 'Ruled Notebook', description: 'Blue rules, red margin' },
  { id: 2, name: 'Spiral Notebook', description: 'Ruled with spiral binding' },
  { id: 8, name: 'Exam Sheet', description: 'Double margin and header' },
  { id: 9, name: 'Cream Ruled', description: 'Warm ruled, no margin' },
  { id: 5, name: 'Legal Pad', description: 'Yellow with double margin' },
  { id: 3, name: 'Graph Paper', description: 'Square grid for maths' },
  { id: 4, name: 'Dotted Journal', description: 'Dot grid bullet journal' },
  { id: 6, name: 'Vintage Parchment', description: 'Aged paper, darkened edges' },
  { id: 7, name: 'Kraft Paper', description: 'Recycled brown fiber' },
];

export const PAGE_SIZES = {
  a4: { label: 'A4', width: 1240, height: 1754 },
  letter: { label: 'US Letter', width: 1275, height: 1650 },
  b5: { label: 'Notebook (B5)', width: 1040, height: 1476 },
} as const;
export type PageSizeId = keyof typeof PAGE_SIZES;

export type CrossStyle = 'single' | 'double' | 'wavy' | 'scribble' | 'mixed';
export const CROSS_STYLE_ID: Record<CrossStyle, number> = { single: 0, double: 1, wavy: 2, scribble: 3, mixed: 4 };

export interface MistakeKinds {
  crossOut: boolean;
  caret: boolean;
  overwrite: boolean;
}

export function mistakeMask(k: MistakeKinds): number {
  return (k.crossOut ? 1 : 0) | (k.caret ? 2 : 0) | (k.overwrite ? 4 : 0);
}
export type TextAlign = 'left' | 'center' | 'right' | 'justify';
export const ALIGN_ID: Record<TextAlign, number> = { left: 0, center: 1, right: 2, justify: 3 };

export type PageNumberPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export type PageNumberFormat = 'page' | 'number' | 'slash' | 'dash' | 'pg' | 'circled';

export type ActiveGuide =
  | 'marginLeft'
  | 'marginRight'
  | 'marginTop'
  | 'marginBottom'
  | 'lineHeight'
  | 'paragraphIndent'
  | 'pageNumber'
  | 'photoStrength'
  | 'adjust'
  | null;

/** Manual image adjustments, each from -100 to 100 with 0 meaning unchanged. */
export interface ImageAdjust {
  brightness: number;
  contrast: number;
  saturation: number;
  sharpness: number;
}

export const DEFAULT_ADJUST: ImageAdjust = { brightness: 0, contrast: 0, saturation: 0, sharpness: 0 };

export function isNeutralAdjust(a: ImageAdjust | null | undefined): boolean {
  return !a || (a.brightness === 0 && a.contrast === 0 && a.saturation === 0 && a.sharpness === 0);
}

/** Page adjustments stack on top of the document-wide ones. */
export function combineAdjust(base: ImageAdjust | undefined, page: ImageAdjust | undefined): ImageAdjust {
  const b = base ?? DEFAULT_ADJUST;
  if (!page) return b;
  const c = (v: number) => Math.max(-100, Math.min(100, v));
  return {
    brightness: c(b.brightness + page.brightness),
    contrast: c(b.contrast + page.contrast),
    saturation: c(b.saturation + page.saturation),
    sharpness: c(b.sharpness + page.sharpness),
  };
}

export interface PageLayout {
  marginLeft: number;
  marginRight: number;
  /** Baseline of the first text line. */
  marginTop: number;
  marginBottom: number;
  lineHeight: number;
  /** Slant of the printed ruling in degrees (positive = lines descend to the right); text follows it. */
  angle?: number;
}

/** `photoId` identifies a per-page uploaded photo; without it, `photo` is the document-wide upload. */
export type PaperChoice = { kind: 'template'; template: number } | { kind: 'photo'; photoId?: string } | { kind: 'stock'; id: string };

export function samePaper(a: PaperChoice | null | undefined, b: PaperChoice | null | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'template' && b.kind === 'template') return a.template === b.template;
  if (a.kind === 'stock' && b.kind === 'stock') return a.id === b.id;
  if (a.kind === 'photo' && b.kind === 'photo') return a.photoId === b.photoId;
  return false;
}

export interface StockPaper {
  id: string;
  name: string;
  description: string;
  src: string;
  thumb: string;
  /** Calibrated to the photo's printed lines, in A4 page units (1240 x 1754). */
  layout: PageLayout;
  fontSize: number;
}

/** Real paper photos (cropped to A4) whose ruling the text grid is matched to. */
export const STOCK_PAPERS: StockPaper[] = [
  {
    id: 'spiral-notebook',
    name: 'Spiral Notebook Photo',
    description: 'Real ruled page, red margin',
    src: '/papers/spiral-notebook.jpg',
    thumb: '/papers/spiral-notebook-thumb.jpg',
    layout: { marginLeft: 196, marginRight: 46, marginTop: 227, marginBottom: 107, lineHeight: 48.78 },
    fontSize: 34,
  },
  {
    id: 'plain-sheet',
    name: 'Plain Sheet Photo',
    description: 'Real unruled white A4',
    src: '/papers/plain-sheet.jpg',
    thumb: '/papers/plain-sheet-thumb.jpg',
    layout: { marginLeft: 120, marginRight: 96, marginTop: 160, marginBottom: 110, lineHeight: 52 },
    fontSize: 38,
  },
];

export function findStockPaper(id: string): StockPaper | undefined {
  return STOCK_PAPERS.find((p) => p.id === id);
}

/** Maps a stock photo's A4 calibration onto any page size (the photo is cover-fitted). */
export function stockLayout(paper: StockPaper, pageSize: PageSizeId): PageLayout {
  const { width: W, height: H } = PAGE_SIZES[pageSize];
  const k = Math.max(W / 1240, H / 1754);
  const ox = (W - 1240 * k) / 2;
  const oy = (H - 1754 * k) / 2;
  const L = paper.layout;
  return {
    marginLeft: Math.round(ox + L.marginLeft * k),
    marginRight: Math.round(W - (ox + (1240 - L.marginRight) * k)),
    marginTop: Math.round(oy + L.marginTop * k),
    marginBottom: Math.round(H - (oy + (1754 - L.marginBottom) * k)),
    lineHeight: Number((L.lineHeight * k).toFixed(2)),
  };
}

export interface AssignmentSettings {
  pageSize: PageSizeId;
  paper: PaperChoice | null;
  layout: PageLayout;
  paragraphIndent: number;
  fontFamily: string;
  fontFamilyB: string;
  combineFonts: boolean;
  fontMix: number;
  fontSize: number;
  letterSpacing: number;
  wordSpacing: number;
  tilt: number;
  inkOpacity: number;
  align: TextAlign;
  charVariance: number;
  sizeVariance: number;
  baselineWobble: number;
  lineSlope: number;
  inkVariance: number;
  marginJitter: number;
  pen: PenType;
  inkId: string;
  customInk: string | null;
  autoMistake: boolean;
  mistakeRate: number;
  mistakeKinds: MistakeKinds;
  mistakeSeed: number;
  crossStyle: CrossStyle;
  latex: boolean;
  markdown: boolean;
  underlineHeadings: boolean;
  headingScale: number;
  pageNumbers: boolean;
  pageNumberPosition: PageNumberPosition;
  pageNumberFormat: PageNumberFormat;
  pageNumberScale: number;
  pageNumberStart: number;
  pageNumberOffsetX: number;
  pageNumberOffsetY: number;
  showGuides: boolean;
  /** Auto-detect the paper photo's ruling and keep text on its lines. */
  snapToLines: boolean;
  photoFilter: boolean;
  photoStrength: number;
  adjust: ImageAdjust;
  seed: number;
  exportScale: 1 | 2 | 3;
  exportQuality: number;
  fileName: string;
}

export const DEFAULT_LAYOUT: PageLayout = {
  marginLeft: 150,
  marginRight: 70,
  marginTop: 176,
  marginBottom: 90,
  lineHeight: 52,
};

export const DEFAULT_SETTINGS: AssignmentSettings = {
  pageSize: 'a4',
  paper: null,
  layout: DEFAULT_LAYOUT,
  paragraphIndent: 0,
  fontFamily: 'Homemade Apple',
  fontFamilyB: 'Cedarville Cursive',
  combineFonts: false,
  fontMix: 0.35,
  fontSize: 38,
  letterSpacing: 0,
  wordSpacing: 0,
  tilt: 0,
  inkOpacity: 0.88,
  align: 'left',
  charVariance: 0.45,
  sizeVariance: 0.4,
  baselineWobble: 1.6,
  lineSlope: 0.35,
  inkVariance: 0.35,
  marginJitter: 8,
  pen: 'ballpoint',
  inkId: 'bp-blue',
  customInk: null,
  autoMistake: true,
  mistakeRate: 1,
  mistakeKinds: { crossOut: false, caret: true, overwrite: true },
  mistakeSeed: 0,
  crossStyle: 'mixed',
  latex: true,
  markdown: true,
  underlineHeadings: true,
  headingScale: 1.12,
  pageNumbers: false,
  pageNumberPosition: 'top-right',
  pageNumberFormat: 'page',
  pageNumberScale: 0.82,
  pageNumberStart: 1,
  pageNumberOffsetX: 0,
  pageNumberOffsetY: 0,
  showGuides: false,
  snapToLines: true,
  photoFilter: false,
  photoStrength: 0.6,
  adjust: DEFAULT_ADJUST,
  seed: 1337,
  exportScale: 2,
  exportQuality: 0.92,
  fileName: 'assignment',
};

export interface Diagram {
  id: string;
  page: number;
  src: string;
  tintedSrc: string | null;
  tint: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  opacity: number;
}

export interface AssignmentDoc {
  text: string;
  settings: AssignmentSettings;
  overrides: Record<number, PageLayout>;
  /** Paper chosen for an individual page; pages without an entry use `settings.paper`. */
  pagePapers: Record<number, PaperChoice>;
  /** Extra image adjustments for an individual page, stacked on `settings.adjust`. */
  pageAdjust: Record<number, ImageAdjust>;
  diagrams: Diagram[];
}

export function findFont(family: string, custom: HandwritingFont[] = []): HandwritingFont {
  return custom.find((f) => f.family === family) ?? HANDWRITING_FONTS.find((f) => f.family === family) ?? HANDWRITING_FONTS[0];
}

export function inkColor(s: AssignmentSettings): string {
  return s.customInk ?? INK_PRESETS.find((i) => i.id === s.inkId)?.color ?? '#1f3ea6';
}

export const SAMPLE_TEXT = `# Newton's Laws of Motion

Newton's first law states that an object at rest stays at rest, and an object in motion stays in motion with the same speed and direction, unless acted upon by an unbalanced force. This tendency is called inertia.

The second law relates force, mass and acceleration: F = ma. If a net force of 10 N acts on a 2 kg body, the acceleration is a = \\frac{F}{m} = 5 m/s^2.

The third law says that for every action there is an equal and opposite reaction. When you push against a wall, the wall pushes back on you with the same force.

Kinetic energy is given by KE = \\frac{1}{2}mv^2, and the speed of a freely falling body after time t is v = \\sqrt{2gh}.`;
