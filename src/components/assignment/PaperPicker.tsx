import { useEffect, useRef, useState } from 'react';
import { ImagePlus, LayoutTemplate, Lightbulb, Sparkles } from 'lucide-react';
import type { HandwritingEngine } from '../../lib/handwriting/engine';
import { DEFAULT_LAYOUT, PAPER_TEMPLATES, PAGE_SIZES, STOCK_PAPERS, type PageSizeId } from '../../lib/handwriting/catalog';

const thumbCache = new Map<string, string>();

function useTemplateThumbs(engine: HandwritingEngine | null, pageSize: PageSizeId) {
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  useEffect(() => {
    if (!engine) return;
    let cancelled = false;
    const size = PAGE_SIZES[pageSize];
    const scale = 0.24;
    const w = Math.round(size.width * scale);
    const h = Math.round(size.height * scale);
    (async () => {
      for (const t of PAPER_TEMPLATES) {
        const key = `${pageSize}|${t.id}`;
        let url = thumbCache.get(key);
        if (!url) {
          await new Promise((r) => setTimeout(r, 0));
          if (cancelled) return;
          const img = engine.renderPaper(w, h, t.id, DEFAULT_LAYOUT.lineHeight * scale, DEFAULT_LAYOUT.marginTop * scale, DEFAULT_LAYOUT.marginLeft * scale, 7919);
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          c.getContext('2d')!.putImageData(img, 0, 0);
          url = c.toDataURL('image/jpeg', 0.85);
          thumbCache.set(key, url);
        }
        if (cancelled) return;
        setThumbs((prev) => ({ ...prev, [t.id]: url! }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [engine, pageSize]);
  return thumbs;
}

export function PaperPicker({ engine, pageSize, selected, onPickTemplate, onPickStock, onPickPhoto, compact }: {
  engine: HandwritingEngine | null;
  pageSize: PageSizeId;
  selected: number | string | null;
  onPickTemplate: (id: number) => void;
  onPickStock: (id: string) => void;
  onPickPhoto: (file: File) => void;
  compact?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const templatesRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const thumbs = useTemplateThumbs(engine, pageSize);

  useEffect(() => {
    if (compact) return;
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        setDragging(true);
      }
    };
    const leave = (e: DragEvent) => {
      if (!e.relatedTarget) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      const file = e.dataTransfer?.files?.[0];
      setDragging(false);
      if (file && file.type.startsWith('image/')) {
        e.preventDefault();
        onPickPhoto(file);
      }
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [compact, onPickPhoto]);

  return (
    <div className={`am-picker${compact ? ' compact' : ''}`}>
      {!compact && (
        <div className={`am-upload-hero${dragging ? ' dragging' : ''}`}>
          <span className="am-hero-badge"><Sparkles size={14} />Rendered in Rust · 100% in your browser</span>
          <span className="am-hero-icon" aria-hidden="true"><ImagePlus size={30} /></span>
          <h2>Upload your page photo</h2>
          <p>Take a photo of your notebook or any paper. It becomes the canvas for your handwriting — or start from a ready-made page below.</p>
          <div className="am-hero-actions">
            <button type="button" className="btn primary" onClick={() => fileRef.current?.click()}>
              <ImagePlus size={16} />Select from device
            </button>
            <button type="button" className="btn secondary" onClick={() => templatesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
              <LayoutTemplate size={16} />Select a default page
            </button>
          </div>
          <span className="am-hero-drop">or drag &amp; drop anywhere</span>
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onPickPhoto(f);
        }}
      />
      <div className="am-templates-head" ref={templatesRef}>
        <h3>Real paper photos</h3>
        <span className="am-tip"><Lightbulb size={13} /><span>Lines are pre-aligned to the photo</span></span>
      </div>
      <div className="am-template-grid">
        {STOCK_PAPERS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`am-template-card${selected === p.id ? ' active' : ''}`}
            onClick={() => onPickStock(p.id)}
            aria-pressed={selected === p.id}
          >
            <span className="am-template-thumb">
              <img src={p.thumb} alt="" loading="lazy" />
              <span className="am-template-badge">Photo</span>
            </span>
            <span className="am-template-meta"><strong>{p.name}</strong><small>{p.description}</small></span>
          </button>
        ))}
      </div>
      <div className="am-templates-head">
        <h3>Notebook page templates</h3>
        <span className="am-tip"><Lightbulb size={13} /><span><strong>Tip:</strong> use Classic White for the cleanest alignment</span></span>
      </div>
      <div className="am-template-grid">
        {compact && (
          <button type="button" className={`am-template-card upload${selected === 'photo' ? ' active' : ''}`} onClick={() => fileRef.current?.click()}>
            <span className="am-template-thumb upload-thumb"><ImagePlus size={22} /><span>Upload photo</span></span>
            <span className="am-template-meta"><strong>Your own paper</strong><small>Photo of any page</small></span>
          </button>
        )}
        {PAPER_TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`am-template-card${selected === t.id ? ' active' : ''}`}
            onClick={() => onPickTemplate(t.id)}
            aria-pressed={selected === t.id}
          >
            <span className="am-template-thumb">
              {thumbs[t.id] ? <img src={thumbs[t.id]} alt="" /> : <span className="am-thumb-loading" />}
              {t.recommended && <span className="am-template-badge">Best alignment</span>}
            </span>
            <span className="am-template-meta"><strong>{t.name}</strong><small>{t.description}</small></span>
          </button>
        ))}
      </div>
    </div>
  );
}
