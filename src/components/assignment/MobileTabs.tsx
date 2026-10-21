import { Eye, FileImage, SlidersHorizontal } from 'lucide-react';

export type MobileView = 'edit' | 'preview';

export function MobileTabs({ view, onChange, pageCount }: { view: MobileView; onChange: (v: MobileView) => void; pageCount: number | null }) {
  return (
    <nav className="am-mobile-tabs" aria-label="Assignment Maker view">
      <div className="am-mobile-tabs-track">
        <button type="button" className={view === 'edit' ? 'active' : ''} aria-pressed={view === 'edit'} onClick={() => onChange('edit')}>
          <SlidersHorizontal size={15} aria-hidden="true" />
          Write &amp; style
        </button>
        <button type="button" className={view === 'preview' ? 'active' : ''} aria-pressed={view === 'preview'} onClick={() => onChange('preview')}>
          {pageCount === null ? <FileImage size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
          {pageCount === null ? 'Paper' : 'Preview'}
          {pageCount !== null && <span className="am-mobile-tabs-count">{pageCount}</span>}
        </button>
      </div>
    </nav>
  );
}
