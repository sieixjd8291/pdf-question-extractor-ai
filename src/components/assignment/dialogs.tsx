import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Download, FileArchive, FileImage, FileText, X } from 'lucide-react';
import { useDialog } from '../../hooks/useDialog';
import type { ActiveGuide, PageLayout } from '../../lib/handwriting/catalog';
import type { ExportFormat } from '../../lib/handwriting/export';
import { LayoutFields } from './LayoutPanel';

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
  isCustom,
  onChange,
  onReset,
  onClose,
  onActiveGuide,
}: {
  page: number;
  layout: PageLayout;
  isCustom: boolean;
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
          <LayoutFields
            layout={layout}
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

export function PaperDialog({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return <Dialog title="Choose paper" onClose={onClose} wide>{children}</Dialog>;
}

export function HelpDialog({ onClose }: { onClose: () => void }) {
  const tips: Array<[string, string]> = [
    ['Paper', 'Upload a photo of your notebook or pick a template. Templates redraw their rules from your line height, so text always sits on the lines.'],
    ['Photo calibration', 'For photo paper, turn on alignment guides and match First line, Line height and margins to the lines in your photo.'],
    ['Math', 'Write LaTeX such as \\frac{a}{b}, \\sqrt{x}, x^2, H_2O, \\alpha or \\times — it is converted into handwritten maths.'],
    ['Pages', 'Long text splits into pages automatically. Insert \\newpage to force a break; customize any single page from its toolbar.'],
    ['Headings', 'Start a line with # to write it larger and underlined. Pasted ChatGPT formatting is cleaned automatically.'],
    ['Realism', 'Auto mistakes add believable typos that are crossed out and rewritten. Page numbers can be placed in any corner or dragged to fit printed notebook boxes.'],
    ['Diagrams', 'Add Diagram places an image on the active page. Drag to move, use the corner to resize, and Ink to redraw it in pen colour.'],
    ['Shortcuts', 'Ctrl/⌘ + Z to undo, Ctrl/⌘ + Shift + Z or Ctrl + Y to redo (outside the text box).'],
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
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  const pick = (f: ExportFormat, scope: 'all' | 'active') => {
    setOpen(false);
    onExport(f, scope);
  };
  return (
    <div className="am-export" ref={wrap}>
      <button type="button" className="btn primary btn-sm" disabled={disabled || !!busy} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Download size={15} />{busy ?? 'Export'}<ChevronDown size={14} />
      </button>
      {open && (
        <div className="am-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => pick('pdf', 'all')}><FileText size={15} /><span><strong>PDF document</strong><small>All {pageCount} {pageCount === 1 ? 'page' : 'pages'}, print-ready</small></span></button>
          <button type="button" role="menuitem" onClick={() => pick('jpg', 'active')}><FileImage size={15} /><span><strong>JPG image</strong><small>Current page</small></span></button>
          <button type="button" role="menuitem" onClick={() => pick('png', 'active')}><FileImage size={15} /><span><strong>PNG image</strong><small>Current page, lossless</small></span></button>
          <button type="button" role="menuitem" onClick={() => pick('zip', 'all')} disabled={pageCount < 2}><FileArchive size={15} /><span><strong>ZIP of JPGs</strong><small>Every page as an image</small></span></button>
        </div>
      )}
    </div>
  );
}
