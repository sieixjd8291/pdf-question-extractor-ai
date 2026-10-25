import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Ban, ChevronDown, Dices, Download, FileArchive, FileImage, FileText, Lock, LockOpen, RotateCcw, X } from 'lucide-react';
import { useDialog } from '../../hooks/useDialog';
import { isNeutralAdjust, type ActiveGuide, type ImageAdjust, type PageLayout, type PageSizeId } from '../../lib/handwriting/catalog';
import type { ExportFormat } from '../../lib/handwriting/export';
import { LayoutFields } from './LayoutPanel';
import { AdjustFields } from './AdjustFields';

function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useDialog(onClose);
  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={`modal-panel ${wide ? 'lg' : 'sm'} am-dialog`} role="dialog" aria-modal="true" aria-labelledby="am-dialog-title" tabIndex={-1}>
        <header className="am-dialog-head">
          <h2 id="am-dialog-title">{title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </header>
        <div className="am-dialog-body">{children}</div>
      </div>
    </div>
  );
}

/**
 * Floating non-blurring layout inspector so the user can see the live page
 * preview clearly while dragging per-page layout sliders.
 */
export function PageLayoutDialog({
  page,
  layout,
  pageSize,
  firstBaseline,
  isCustom,
  snapped,
  look,
  onChange,
  onReset,
  onClose,
  onActiveGuide,
}: {
  page: number;
  layout: PageLayout;
  pageSize: PageSizeId;
  firstBaseline?: number;
  isCustom: boolean;
  snapped?: boolean;
  look?: PageLookControls;
  onChange: (l: PageLayout) => void;
  onReset: () => void;
  onClose: () => void;
  onActiveGuide?: (guide: ActiveGuide) => void;
}) {
  const ref = useDialog(onClose);
  return (
    <div
      className="am-floating-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="modal-panel sm am-dialog am-floating-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="am-dialog-title"
        tabIndex={-1}
      >
        <header className="am-dialog-head">
          <h2 id="am-dialog-title">Page {page + 1} layout</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="am-dialog-body">
          <p className="am-help">
            Changes apply only to page {page + 1}. Drag any slider to see the live preview on the page.
          </p>
          {snapped && (
            <p className="am-help">
              Write within the lines is on — text keeps the tilt of this page&apos;s ruled lines as you adjust.
            </p>
          )}
          {look && <PageLookSection page={page} look={look} />}
          <LayoutFields
            layout={layout}
            pageSize={pageSize}
            firstBaseline={firstBaseline}
            onChange={(patch) => onChange({ ...layout, ...patch })}
            onActiveGuide={onActiveGuide}
          />
          <footer className="am-dialog-foot">
            <button type="button" className="btn quiet" onClick={onReset} disabled={!isCustom}>
              Use global layout
            </button>
            <button type="button" className="btn primary" onClick={onClose}>
              Done
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}

export type PageLookState = 'auto' | 'locked' | 'off';

export interface PageLookControls {
  /** False when Page variations is Off for the whole document. */
  enabled: boolean;
  state: PageLookState;
  onReroll: () => void;
  onLock: (locked: boolean) => void;
  onOff: (off: boolean) => void;
  onReset: () => void;
}

function PageLookSection({ page, look }: { page: number; look: PageLookControls }) {
  if (!look.enabled) {
    return <p className="am-help">Turn on Page variations in Realism to give each page its own photo look.</p>;
  }
  const isOff = look.state === 'off';
  return (
    <div className="am-pnum-card">
      <div className="am-pnum-head">
        <span className="am-label">Page {page + 1} look</span>
        {look.state !== 'auto' && (
          <button type="button" className="am-pnum-reset" onClick={look.onReset} title="Follow the document's variation again">
            <RotateCcw size={11} />Reset
          </button>
        )}
      </div>
      <div className="am-chip-row">
        <button type="button" className="am-chip-btn" onClick={look.onReroll}>
          <Dices size={13} />Re-roll this page
        </button>
        <button
          type="button"
          className={`am-chip-btn${look.state === 'locked' ? ' active' : ''}`}
          onClick={() => look.onLock(look.state !== 'locked')}
          aria-pressed={look.state === 'locked'}
          disabled={isOff}
        >
          {look.state === 'locked' ? <Lock size={13} /> : <LockOpen size={13} />}
          {look.state === 'locked' ? 'Look locked' : 'Lock look'}
        </button>
        <button
          type="button"
          className={`am-chip-btn${isOff ? ' active' : ''}`}
          onClick={() => look.onOff(!isOff)}
          aria-pressed={isOff}
        >
          <Ban size={13} />No variation
        </button>
      </div>
      <p className="am-pnum-hint">
        {look.state === 'locked'
          ? 'This page keeps its look when you re-roll all pages.'
          : isOff
            ? 'This page is drawn flat, without crop, colour or light changes.'
            : 'This page follows the document re-roll.'}
      </p>
    </div>
  );
}

export function PageAdjustDialog({
  page,
  value,
  onChange,
  onReset,
  onClose,
  onActiveGuide,
  look,
}: {
  page: number;
  value: ImageAdjust;
  onChange: (a: ImageAdjust) => void;
  onReset: () => void;
  onClose: () => void;
  onActiveGuide?: (guide: ActiveGuide) => void;
  look?: PageLookControls;
}) {
  const ref = useDialog(onClose);
  return (
    <div
      className="am-floating-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="modal-panel sm am-dialog am-floating-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="am-dialog-title"
        tabIndex={-1}
      >
        <header className="am-dialog-head">
          <h2 id="am-dialog-title">Page {page + 1} adjustments</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="am-dialog-body">
          <p className="am-help">
            Changes apply only to page {page + 1}, stacked on top of the Realism adjustments for all pages.
          </p>
          {look && <PageLookSection page={page} look={look} />}
          <AdjustFields value={value} onChange={(patch) => onChange({ ...value, ...patch })} onActiveGuide={onActiveGuide} />
          <footer className="am-dialog-foot">
            <button type="button" className="btn quiet" onClick={onReset} disabled={isNeutralAdjust(value)}>
              Reset adjustments
            </button>
            <button type="button" className="btn primary" onClick={onClose}>
              Done
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}

export function PaperDialog({ onClose, children, title = 'Choose paper' }: { onClose: () => void; children: ReactNode; title?: string }) {
  return <Dialog title={title} onClose={onClose} wide>{children}</Dialog>;
}

export function HelpDialog({ onClose }: { onClose: () => void }) {
  const tips: Array<[string, string]> = [
    ['Paper', 'Upload a photo of your notebook or pick a template. Templates redraw their rules from your line height, so text always sits on the lines.'],
    ['Photo calibration', 'For photo paper, turn on alignment guides and match First line, Line height and margins to the lines in your photo.'],
    ['Math', 'Write LaTeX such as \\frac{a}{b}, \\sqrt{x}, x^2, H_2O, \\alpha or \\times — it is converted into handwritten maths.'],
    ['Pages', 'Long text splits into pages automatically. Insert \\newpage to force a break; change the paper or layout of any single page from its toolbar.'],
    ['Headings', 'Start a line with # to write it larger and underlined. Pasted ChatGPT formatting is cleaned automatically.'],
    ['Realism', 'Auto mistakes add believable typos that are crossed out and rewritten. Page numbers can be placed in any corner or dragged to fit printed notebook boxes.'],
    ['Diagrams', 'Add Diagram places an image on the active page. Drag to move, use the corner to resize, and Ink to redraw it in pen colour.'],
    ['Shortcuts', 'Ctrl/⌘ + Z to undo, Ctrl/⌘ + Y or Ctrl/⌘ + Shift + Z to redo. Works for every setting, slider and diagram; inside text boxes it undoes your typing.'],
  ];
  return (
    <Dialog title="How Assignment Maker works" onClose={onClose}>
      <dl className="am-help-list">
        {tips.map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
        ))}
      </dl>
      <p className="am-help">Layout, mistake simulation, paper textures and ink effects run in a Rust engine compiled to WebAssembly. Nothing is uploaded.</p>
    </Dialog>
  );
}

export function ExportMenu({ disabled, busy, pageCount, onExport }: {
  disabled: boolean;
  busy: string | null;
  pageCount: number;
  onExport: (format: ExportFormat, scope: 'all' | 'active') => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  // The toolbar scrolls horizontally (overflow clips absolute children), so the menu is fixed-positioned.
  useLayoutEffect(() => {
    if (!open || !wrap.current) return;
    const place = () => {
      const r = wrap.current!.getBoundingClientRect();
      const width = 248;
      setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  useEffect(() => {
    if (disabled || busy) setOpen(false);
  }, [disabled, busy]);
  const pick = (f: ExportFormat, scope: 'all' | 'active') => {
    setOpen(false);
    onExport(f, scope);
  };
  return (
    <div className="am-export" ref={wrap}>
      <button type="button" className="btn primary btn-sm" disabled={disabled || !!busy} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Download size={15} />{busy ?? 'Export'}<ChevronDown size={14} />
      </button>
      {open && pos && (
        <div className="am-menu am-menu-fixed" role="menu" style={pos}>
          <button type="button" role="menuitem" onClick={() => pick('pdf', 'all')}><FileText size={15} /><span><strong>PDF document</strong><small>All {pageCount} {pageCount === 1 ? 'page' : 'pages'}, print-ready</small></span></button>
          <button type="button" role="menuitem" onClick={() => pick('jpg', 'active')}><FileImage size={15} /><span><strong>JPG image</strong><small>Current page</small></span></button>
          <button type="button" role="menuitem" onClick={() => pick('png', 'active')}><FileImage size={15} /><span><strong>PNG image</strong><small>Current page, lossless</small></span></button>
          <button type="button" role="menuitem" onClick={() => pick('zip', 'all')} disabled={pageCount < 2}><FileArchive size={15} /><span><strong>ZIP of JPGs</strong><small>Every page as an image</small></span></button>
        </div>
      )}
    </div>
  );
}
