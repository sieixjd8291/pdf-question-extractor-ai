import { useMemo, useRef, useState } from 'react';
import { ChevronDown, Search, Upload, WandSparkles } from 'lucide-react';
import { HANDWRITING_FONTS, findFont, type AssignmentSettings, type FontCategory, type HandwritingFont } from '../../lib/handwriting/catalog';
import { Section, Segmented, SliderField, Toggle } from './controls';

type Filter = 'all' | FontCategory | 'custom';

function FontList({ fonts, value, onPick }: { fonts: HandwritingFont[]; value: string; onPick: (f: string) => void }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return fonts.filter((f) => {
      if (filter === 'custom' ? !f.custom : filter !== 'all' && f.category !== filter) return false;
      return !q || f.label.toLowerCase().includes(q) || f.family.toLowerCase().includes(q);
    });
  }, [fonts, query, filter]);
  return (
    <div className="am-font-browser">
      <div className="am-search">
        <Search size={14} aria-hidden="true" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${fonts.length} fonts…`} aria-label="Search fonts" />
      </div>
      <Segmented<Filter>
        label="Font category"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'All' },
          { value: 'cursive', label: 'Cursive' },
          { value: 'print', label: 'Print' },
          { value: 'world', label: 'World' },
          ...(fonts.some((f) => f.custom) ? [{ value: 'custom' as Filter, label: 'Mine' }] : []),
        ]}
      />
      <ul className="am-font-list" role="listbox" aria-label="Handwriting fonts">
        {list.map((f) => (
          <li key={f.family}>
            <button type="button" role="option" aria-selected={f.family === value} className={f.family === value ? 'active' : ''} onClick={() => onPick(f.family)}>
              <span className="am-font-sample" style={{ fontFamily: `"${f.family}", cursive`, fontSize: `${20 * f.sizeAdjust}px` }}>
                {f.category === 'world' && f.scripts?.includes('Devanagari') ? 'नमस्ते Hello' : f.scripts?.includes('Cyrillic') ? 'Привет Hello' : 'The quick fox'}
              </span>
              <span className="am-font-name">{f.label}{f.scripts && <small>{f.scripts}</small>}</span>
            </button>
          </li>
        ))}
        {list.length === 0 && <li className="am-empty">No fonts match.</li>}
      </ul>
    </div>
  );
}

export function FontPanel({ settings: s, customFonts, onSettings, onUploadFont, onMakeFont }: {
  settings: AssignmentSettings;
  customFonts: HandwritingFont[];
  onSettings: (p: Partial<AssignmentSettings>) => void;
  onUploadFont: (file: File) => void;
  onMakeFont: () => void;
}) {
  const [browsing, setBrowsing] = useState<'a' | 'b' | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const fonts = useMemo(() => [...customFonts, ...HANDWRITING_FONTS], [customFonts]);
  const a = findFont(s.fontFamily, customFonts);
  const b = findFont(s.fontFamilyB, customFonts);

  const picker = (which: 'a' | 'b', font: HandwritingFont) => (
    <div className="am-font-current">
      <button type="button" className="am-font-trigger" aria-expanded={browsing === which} onClick={() => setBrowsing(browsing === which ? null : which)}>
        <span className="am-font-sample" style={{ fontFamily: `"${font.family}", cursive`, fontSize: `${24 * font.sizeAdjust}px` }}>Handwriting</span>
        <span className="am-font-name">{font.label}<small>{font.custom ? 'Uploaded font' : font.category}</small></span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {browsing === which && (
        <FontList
          fonts={fonts}
          value={font.family}
          onPick={(f) => {
            onSettings(which === 'a' ? { fontFamily: f } : { fontFamilyB: f });
            setBrowsing(null);
          }}
        />
      )}
    </div>
  );

  return (
    <Section title="Handwriting font" badge={<span className="am-badge">{fonts.length} styles</span>}>
      {picker('a', a)}
      <button type="button" className="btn secondary btn-sm am-full" onClick={() => fileRef.current?.click()}>
        <Upload size={14} />Upload your handwriting (.ttf / .otf)
      </button>
      <button type="button" className="btn secondary btn-sm am-full" onClick={onMakeFont}>
        <WandSparkles size={14} />Make a font from a handwriting sample
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onUploadFont(f);
        }}
      />
      <Toggle checked={s.combineFonts} onChange={(v) => onSettings({ combineFonts: v })} label="Combine two fonts" description="Blends glyphs from two fonts for an ultra-natural look" />
      {s.combineFonts && (
        <>
          {picker('b', b)}
          <SliderField label="Second font share" value={s.fontMix} min={0.05} max={0.95} step={0.05} onChange={(v) => onSettings({ fontMix: v })} format={(v) => `${Math.round(v * 100)}%`} defaultValue={0.35} />
        </>
      )}
    </Section>
  );
}
