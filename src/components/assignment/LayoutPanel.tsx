import { DEFAULT_LAYOUT, PAGE_SIZES, type ActiveGuide, type AssignmentSettings, type PageLayout, type PageSizeId } from '../../lib/handwriting/catalog';
import { Ban, Dices } from 'lucide-react';
import { Section, Segmented, SliderField, Toggle } from './controls';

export type RulingStatus = 'detected' | 'none' | 'template' | null;

const LAYOUT_PRESETS: Array<{ id: string; label: string; layout: Partial<PageLayout>; fontSize: number }> = [
  { id: 'college', label: 'College ruled', layout: { lineHeight: 52 }, fontSize: 38 },
  { id: 'wide', label: 'Wide ruled', layout: { lineHeight: 64 }, fontSize: 46 },
  { id: 'narrow', label: 'Narrow', layout: { lineHeight: 42 }, fontSize: 31 },
];

export function LayoutFields({
  layout,
  onChange,
  onActiveGuide,
}: {
  layout: PageLayout;
  onChange: (patch: Partial<PageLayout>) => void;
  onActiveGuide?: (guide: ActiveGuide) => void;
}) {
  return (
    <>
      <SliderField
        label="Left margin"
        value={layout.marginLeft}
        min={0}
        max={420}
        onChange={(v) => onChange({ marginLeft: v })}
        onDragChange={(d) => onActiveGuide?.(d ? 'marginLeft' : null)}
        format={(v) => `${v}px`}
        defaultValue={DEFAULT_LAYOUT.marginLeft}
        stepper
      />
      <SliderField
        label="Right margin"
        value={layout.marginRight}
        min={0}
        max={320}
        onChange={(v) => onChange({ marginRight: v })}
        onDragChange={(d) => onActiveGuide?.(d ? 'marginRight' : null)}
        format={(v) => `${v}px`}
        defaultValue={DEFAULT_LAYOUT.marginRight}
        stepper
      />
      <SliderField
        label="First line (top)"
        value={layout.marginTop}
        min={0}
        max={1600}
        onChange={(v) => onChange({ marginTop: v })}
        onDragChange={(d) => onActiveGuide?.(d ? 'marginTop' : null)}
        format={(v) => `${v}px`}
        defaultValue={DEFAULT_LAYOUT.marginTop}
        stepper
      />
      <SliderField
        label="Bottom margin"
        value={layout.marginBottom}
        min={0}
        max={1600}
        onChange={(v) => onChange({ marginBottom: v })}
        onDragChange={(d) => onActiveGuide?.(d ? 'marginBottom' : null)}
        format={(v) => `${v}px`}
        defaultValue={DEFAULT_LAYOUT.marginBottom}
        stepper
      />
      <SliderField
        label="Line height"
        value={layout.lineHeight}
        min={10}
        max={300}
        step={0.5}
        onChange={(v) => onChange({ lineHeight: v })}
        onDragChange={(d) => onActiveGuide?.(d ? 'lineHeight' : null)}
        format={(v) => `${v}px`}
        defaultValue={DEFAULT_LAYOUT.lineHeight}
        stepper
      />
    </>
  );
}

export function LayoutPanel({
  settings: s,
  overrideCount,
  rulingStatus,
  onSettings,
  onClearOverrides,
  onActiveGuide,
  pageLookCount,
  onRerollAllLooks,
  onAllNoVariation,
}: {
  settings: AssignmentSettings;
  overrideCount: number;
  rulingStatus: RulingStatus;
  onSettings: (p: Partial<AssignmentSettings>) => void;
  onClearOverrides: () => void;
  onActiveGuide?: (guide: ActiveGuide) => void;
  pageLookCount: number;
  onRerollAllLooks: () => void;
  onAllNoVariation: (off: boolean) => void;
}) {
  const variationOff = (s.variation ?? 'off') === 'off';
  const setLayout = (patch: Partial<PageLayout>) => onSettings({ layout: { ...s.layout, ...patch } });
  const isTemplate = rulingStatus === 'template';
  const snapDescription = isTemplate
    ? 'Template rules are drawn from your line height, so text always sits on them'
    : !s.snapToLines
      ? 'Detect the ruled lines on the paper photo and write on them'
      : rulingStatus === 'detected'
        ? 'Ruled lines detected — sliders stay free and text lands on the nearest printed line on every page. Line height picks every line, every other line, and so on'
        : rulingStatus === 'none'
          ? 'No ruled lines found on this paper — adjust the sliders manually'
          : 'Detecting ruled lines…';
  return (
    <Section title="Default page layout" defaultOpen={false} badge={<span className="am-badge">Live preview</span>}>
      <p className="am-help">Drag any slider to preview margins and line spacing live on the page.</p>
      <Toggle
        checked={isTemplate || s.snapToLines}
        onChange={(v) => !isTemplate && onSettings({ snapToLines: v })}
        label="Write within the lines"
        description={snapDescription}
      />
      <div className="am-pnum-card">
        <div className="am-pnum-head">
          <span className="am-label">Page looks · all pages</span>
        </div>
        <div className="am-chip-row">
          <button type="button" className="am-chip-btn" onClick={onRerollAllLooks}>
            <Dices size={13} aria-hidden="true" />
            Re-roll all pages
          </button>
          <button
            type="button"
            className={`am-chip-btn${variationOff ? ' active' : ''}`}
            aria-pressed={variationOff}
            onClick={() => onAllNoVariation(!variationOff)}
          >
            <Ban size={13} aria-hidden="true" />
            No variation
          </button>
        </div>
        <p className="am-pnum-hint">
          {variationOff
            ? 'Every page is drawn flat, with no crop, tilt, colour or light changes.'
            : `One click gives every page a fresh photo look${pageLookCount ? `, including the ${pageLookCount} ${pageLookCount === 1 ? 'page' : 'pages'} set individually` : ''}.`}
          {(isTemplate || s.snapToLines) && ' Text stays on the ruled lines on every page.'}
        </p>
      </div>
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
      <LayoutFields layout={s.layout} onChange={setLayout} onActiveGuide={onActiveGuide} />
      <SliderField
        label="Paragraph indent"
        value={s.paragraphIndent}
        min={0}
        max={200}
        onChange={(v) => onSettings({ paragraphIndent: v })}
        onDragChange={(d) => onActiveGuide?.(d ? 'paragraphIndent' : null)}
        format={(v) => `${v}px`}
        defaultValue={0}
        stepper
      />
      <Toggle
        checked={s.showGuides}
        onChange={(v) => onSettings({ showGuides: v })}
        label="Show alignment guides"
        description="Overlay margins and baselines to calibrate photo paper"
      />
      {overrideCount > 0 && (
        <button type="button" className="btn quiet btn-sm am-full" onClick={onClearOverrides}>
          Reset {overrideCount} customized {overrideCount === 1 ? 'page' : 'pages'} to global layout
        </button>
      )}
    </Section>
  );
}
