import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Shuffle } from 'lucide-react';
import { DEFAULT_SETTINGS as D, type AssignmentSettings, type TextAlign } from '../../lib/handwriting/catalog';
import { Section, Segmented, SliderField } from './controls';

const NATURAL_PRESETS: Array<{ id: string; label: string; patch: Partial<AssignmentSettings> }> = [
  { id: 'neat', label: 'Neat', patch: { charVariance: 0.2, sizeVariance: 0.2, baselineWobble: 0.6, lineSlope: 0.1, inkVariance: 0.2, marginJitter: 3 } },
  { id: 'natural', label: 'Natural', patch: { charVariance: D.charVariance, sizeVariance: D.sizeVariance, baselineWobble: D.baselineWobble, lineSlope: D.lineSlope, inkVariance: D.inkVariance, marginJitter: D.marginJitter } },
  { id: 'rushed', label: 'Rushed', patch: { charVariance: 0.85, sizeVariance: 0.75, baselineWobble: 3.2, lineSlope: 0.9, inkVariance: 0.55, marginJitter: 18 } },
];

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function StylePanel({ settings: s, onSettings }: { settings: AssignmentSettings; onSettings: (p: Partial<AssignmentSettings>) => void }) {
  return (
    <>
      <Section title="Text style" defaultOpen={false}>
        <SliderField label="Font size" value={s.fontSize} min={14} max={96} onChange={(v) => onSettings({ fontSize: v })} defaultValue={D.fontSize} stepper />
        <SliderField label="Letter spacing" value={s.letterSpacing} min={-6} max={16} step={0.5} onChange={(v) => onSettings({ letterSpacing: v })} format={(v) => `${v}px`} defaultValue={0} />
        <SliderField label="Word spacing" value={s.wordSpacing} min={-12} max={48} onChange={(v) => onSettings({ wordSpacing: v })} format={(v) => `${v}px`} defaultValue={0} />
        <SliderField label="Ink opacity" value={s.inkOpacity} min={0.3} max={1} step={0.02} onChange={(v) => onSettings({ inkOpacity: v })} format={(v) => v.toFixed(2)} defaultValue={D.inkOpacity} />
        <p className="am-label">Text alignment</p>
        <Segmented<TextAlign>
          label="Text alignment"
          value={s.align}
          onChange={(v) => onSettings({ align: v })}
          options={[
            { value: 'left', label: <AlignLeft size={15} aria-label="Left" />, title: 'Left' },
            { value: 'center', label: <AlignCenter size={15} aria-label="Center" />, title: 'Center' },
            { value: 'right', label: <AlignRight size={15} aria-label="Right" />, title: 'Right' },
            { value: 'justify', label: <AlignJustify size={15} aria-label="Justify" />, title: 'Justify' },
          ]}
        />
      </Section>
      <Section title="Natural variation" defaultOpen={false}>
        <div className="am-chip-row">
          {NATURAL_PRESETS.map((p) => (
            <button key={p.id} type="button" className={`am-chip-btn${s.charVariance === p.patch.charVariance ? ' active' : ''}`} onClick={() => onSettings(p.patch)}>
              {p.label}
            </button>
          ))}
          <button type="button" className="am-chip-btn" onClick={() => onSettings({ seed: Math.floor(Math.random() * 1_000_000) })} title="Re-roll every random choice">
            <Shuffle size={13} />Re-roll
          </button>
        </div>
        <SliderField label="Character variance" value={s.charVariance} min={0} max={1} step={0.05} onChange={(v) => onSettings({ charVariance: v })} format={pct} defaultValue={D.charVariance} />
        <SliderField label="Size variance" value={s.sizeVariance} min={0} max={1} step={0.05} onChange={(v) => onSettings({ sizeVariance: v })} format={pct} defaultValue={D.sizeVariance} />
        <SliderField label="Baseline wobble" value={s.baselineWobble} min={0} max={6} step={0.2} onChange={(v) => onSettings({ baselineWobble: v })} format={(v) => `${v.toFixed(1)}px`} defaultValue={D.baselineWobble} />
        <SliderField label="Tilt / rotation" value={s.tilt} min={-12} max={12} step={0.5} onChange={(v) => onSettings({ tilt: v })} format={(v) => `${v.toFixed(1)}°`} defaultValue={0} />
        <SliderField label="Line slope" value={s.lineSlope} min={0} max={2} step={0.05} onChange={(v) => onSettings({ lineSlope: v })} format={(v) => `±${v.toFixed(2)}°`} defaultValue={D.lineSlope} />
        <SliderField label="Pen pressure variance" value={s.inkVariance} min={0} max={1} step={0.05} onChange={(v) => onSettings({ inkVariance: v })} format={pct} defaultValue={D.inkVariance} />
        <SliderField label="Margin drift" value={s.marginJitter} min={0} max={30} onChange={(v) => onSettings({ marginJitter: v })} format={(v) => `${v}px`} defaultValue={D.marginJitter} />
      </Section>
    </>
  );
}
