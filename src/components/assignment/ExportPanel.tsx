import { FileArchive, FileImage, FileText, Loader2 } from 'lucide-react';
import type { AssignmentSettings } from '../../lib/handwriting/catalog';
import type { ExportFormat } from '../../lib/handwriting/export';
import { Section, Segmented, SliderField } from './controls';

const FORMATS: Array<{ format: ExportFormat; scope: 'all' | 'active'; label: string; hint: (pages: number) => string; Icon: typeof FileText }> = [
  { format: 'pdf', scope: 'all', label: 'PDF', hint: (n) => `${n} ${n === 1 ? 'page' : 'pages'}`, Icon: FileText },
  { format: 'jpg', scope: 'active', label: 'JPG', hint: () => 'Current page', Icon: FileImage },
  { format: 'png', scope: 'active', label: 'PNG', hint: () => 'Lossless', Icon: FileImage },
  { format: 'zip', scope: 'all', label: 'ZIP', hint: () => 'All as JPG', Icon: FileArchive },
];

export function ExportPanel({ settings: s, onSettings, pageCount, busy, disabled, onExport }: {
  settings: AssignmentSettings;
  onSettings: (p: Partial<AssignmentSettings>) => void;
  pageCount: number;
  busy: string | null;
  disabled: boolean;
  onExport: (format: ExportFormat, scope: 'all' | 'active') => void;
}) {
  const megapixels = (scale: number) => ((1240 * scale * 1754 * scale) / 1_000_000).toFixed(1);
  return (
    <Section title="Export" defaultOpen={false} badge={busy ? <span className="am-badge am-badge-busy"><Loader2 size={12} className="am-spin" />{busy}</span> : undefined}>
      <div className="am-export-grid">
        {FORMATS.map(({ format, scope, label, hint, Icon }) => (
          <button
            key={format}
            type="button"
            disabled={disabled || !!busy || (format === 'zip' && pageCount < 2)}
            onClick={() => onExport(format, scope)}
          >
            <Icon size={16} aria-hidden="true" />
            <strong>{label}</strong>
            <small>{hint(pageCount)}</small>
          </button>
        ))}
      </div>
      <p className="am-label">Resolution</p>
      <Segmented<1 | 2 | 3>
        label="Export resolution"
        value={s.exportScale}
        onChange={(v) => onSettings({ exportScale: v })}
        options={[
          { value: 1, label: '150 DPI', title: `≈ ${megapixels(1)} MP per page` },
          { value: 2, label: '300 DPI', title: `≈ ${megapixels(2)} MP per page` },
          { value: 3, label: '450 DPI', title: `≈ ${megapixels(3)} MP per page` },
        ]}
      />
      <SliderField label="JPG quality" value={s.exportQuality} min={0.5} max={1} step={0.02} onChange={(v) => onSettings({ exportQuality: v })} format={(v) => `${Math.round(v * 100)}%`} defaultValue={0.92} />
      <label className="am-text-field">
        <span>File name</span>
        <input value={s.fileName} onChange={(e) => onSettings({ fileName: e.target.value })} maxLength={80} placeholder="assignment" />
      </label>
    </Section>
  );
}
