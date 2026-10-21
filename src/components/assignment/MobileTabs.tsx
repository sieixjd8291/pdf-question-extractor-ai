import { Eye, SlidersHorizontal } from 'lucide-react';

export type MobileView = 'edit' | 'preview';

export function MobileTabs({ view, onChange, pageCount }: { view: MobileView; onChange: (v: MobileView) => void; pageCount: number }) {
  return (
    <nav className="am-mobile-tabs" aria-label="Assignment Maker view">
      <button type="button" className={view === 'edit' ? 'active' : ''} aria-pressed={view === 'edit'} onClick={() => onChange('edit')}>
        <SlidersHorizontal size={17} aria-hidden="true" />
        Write &amp; style
      </button>
      <button type="button" className={view === 'preview' ? 'active' : ''} aria-pressed={view === 'preview'} onClick={() => onChange('preview')}>
        <Eye size={17} aria-hidden="true" />
        Preview
        <span className="am-mobile-tabs-count">{pageCount}</span>
      </button>
    </nav>
  );
}
