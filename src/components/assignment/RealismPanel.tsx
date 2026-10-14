import type { AssignmentSettings } from '../../lib/handwriting/catalog';
import { Section, SliderField, Toggle } from './controls';

export function RealismPanel({ settings: s, onSettings }: { settings: AssignmentSettings; onSettings: (p: Partial<AssignmentSettings>) => void }) {
  return (
    <Section title="Realism">
      <Toggle checked={s.photoFilter} onChange={(v) => onSettings({ photoFilter: v })} label="Realistic photo filter" description="Warm light, soft shadow and grain — like a phone photo" />
      {s.photoFilter && (
        <SliderField label="Filter strength" value={s.photoStrength} min={0.1} max={1} step={0.05} onChange={(v) => onSettings({ photoStrength: v })} format={(v) => `${Math.round(v * 100)}%`} defaultValue={0.6} />
      )}
      <Toggle checked={s.underlineHeadings} onChange={(v) => onSettings({ underlineHeadings: v })} label="Underline headings" description="Lines starting with # are written larger and underlined" />
      <Toggle checked={s.pageNumbers} onChange={(v) => onSettings({ pageNumbers: v })} label="Handwritten page numbers" />
    </Section>
  );
}
