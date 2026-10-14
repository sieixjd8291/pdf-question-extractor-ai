import { DEFAULT_LAYOUT, PAGE_SIZES, type AssignmentSettings, type PageLayout, type PageSizeId } from '../../lib/handwriting/catalog';
import { Section, Segmented, SliderField, Toggle } from './controls';

const LAYOUT_PRESETS: Array<{ id: string; label: string; layout: Partial<PageLayout>; fontSize: number }> = [
  { id: 'college', label: 'College ruled', layout: { lineHeight: 52 }, fontSize: 38 },
  { id: 'wide', label: 'Wide ruled', layout: { lineHeight: 64 }, fontSize: 46 },
  { id: 'narrow', label: 'Narrow', layout: { lineHeight: 42 }, fontSize: 31 },
];

export function LayoutFields({ layout, onChange }: { layout: PageLayout; onChange: (patch: Partial<PageLayout>) => void }) {
  return (
    <>
      <SliderField label="Left margin" value={layout.marginLeft} min={0} max={420} onChange={(v) => onChange({ marginLeft: v })} format={(v) => `${v}px`} defaultValue={DEFAULT_LAYOUT.marginLeft} />
      <SliderField label="Right margin" value={layout.marginRight} min={0} max={320} onChange={(v) => onChange({ marginRight: v })} format={(v) => `${v}px`} defaultValue={DEFAULT_LAYOUT.marginRight} />
      <SliderField label="First line (top)" value={layout.marginTop} min={30} max={700} onChange={(v) => onChange({ marginTop: v })} format={(v) => `${v}px`} defaultValue={DEFAULT_LAYOUT.marginTop} />
      <SliderField label="Bottom margin" value={layout.marginBottom} min={10} max={500} onChange={(v) => onChange({ marginBottom: v })} format={(v) => `${v}px`} defaultValue={DEFAULT_LAYOUT.marginBottom} />
      <SliderField label="Line height" value={layout.lineHeight} min={24} max={130} step={0.5} onChange={(v) => onChange({ lineHeight: v })} format={(v) => `${v}px`} defaultValue={DEFAULT_LAYOUT.lineHeight} stepper />
    </>
  );
}

export function LayoutPanel({ settings: s, overrideCount, onSettings, onClearOverrides }: {
  settings: AssignmentSettings;
  overrideCount: number;
  onSettings: (p: Partial<AssignmentSettings>) => void;
  onClearOverrides: () => void;
}) {
  const setLayout = (patch: Partial<PageLayout>) => onSettings({ layout: { ...s.layout, ...patch } });
  return (
    <Section title="Default page layout" badge={<span className="am-badge">Global presets</span>}>
      <p className="am-help">Every page uses these values unless you customize it from the page toolbar.</p>
      <p className="am-label">Page size</p>
      <Segmented<PageSizeId>
        label="Page size"
        value={s.pageSize}
        onChange={(v) => onSettings({ pageSize: v })}
        options={(Object.keys(PAGE_SIZES) as PageSizeId[]).map((k) => ({ value: k, label: PAGE_SIZES[k].label }))}
      />
      <p className="am-label">Ruling presets</p>
      <div className="am-chip-row">
        {LAYOUT_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`am-chip-btn${s.layout.lineHeight === p.layout.lineHeight ? ' active' : ''}`}
            onClick={() => onSettings({ layout: { ...s.layout, ...p.layout }, fontSize: p.fontSize })}
          >
            {p.label}
          </button>
        ))}
      </div>
      <LayoutFields layout={s.layout} onChange={setLayout} />
      <SliderField label="Paragraph indent" value={s.paragraphIndent} min={0} max={200} onChange={(v) => onSettings({ paragraphIndent: v })} format={(v) => `${v}px`} defaultValue={0} />
      <Toggle checked={s.showGuides} onChange={(v) => onSettings({ showGuides: v })} label="Show alignment guides" description="Overlay margins and baselines to calibrate photo paper" />
      {overrideCount > 0 && (
        <button type="button" className="btn quiet btn-sm am-full" onClick={onClearOverrides}>
          Reset {overrideCount} customized {overrideCount === 1 ? 'page' : 'pages'} to global layout
        </button>
      )}
    </Section>
  );
}
