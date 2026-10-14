import { Ban, PenLine } from 'lucide-react';
import type { AssignmentSettings, CrossStyle } from '../../lib/handwriting/catalog';
import { SliderField } from './controls';

const PRESETS = [
  { value: 0, label: 'Off' },
  { value: 1, label: '1%', sub: 'Light' },
  { value: 2, label: '2%' },
  { value: 3, label: '3%' },
  { value: 5, label: '5%', sub: 'Heavy' },
];

const STYLES: Array<{ id: CrossStyle; label: string; glyph: string }> = [
  { id: 'single', label: 'Single', glyph: '—' },
  { id: 'double', label: 'Double', glyph: '═' },
  { id: 'wavy', label: 'Wavy', glyph: '〰' },
  { id: 'scribble', label: 'Scribble', glyph: '✕' },
];

export function MistakePanel({ settings: s, onSettings }: { settings: AssignmentSettings; onSettings: (p: Partial<AssignmentSettings>) => void }) {
  const rate = s.autoMistake ? s.mistakeRate : 0;
  const setRate = (v: number) => onSettings(v <= 0 ? { autoMistake: false, mistakeRate: s.mistakeRate || 1 } : { autoMistake: true, mistakeRate: v });

  return (
    <section className="am-section am-mistake">
      <div className="am-mistake-head">
        <span className="am-mistake-icon" aria-hidden="true"><PenLine size={16} /></span>
        <div>
          <h3>Auto mistake <span className="am-pill">{rate}%</span></h3>
          <p>Human typos &amp; crossed-out words</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={s.autoMistake}
          aria-label="Auto mistakes"
          className={`am-switch warm${s.autoMistake ? ' on' : ''}`}
          onClick={() => onSettings({ autoMistake: !s.autoMistake })}
        >
          <span />
        </button>
      </div>
      {s.autoMistake ? (
        <>
          <button type="button" className="am-off-btn" onClick={() => onSettings({ autoMistake: false })}>
            <Ban size={14} />Turn off auto mistakes
          </button>
          <SliderField label="Mistake frequency" value={s.mistakeRate} min={0} max={5} step={0.5} onChange={setRate} format={(v) => `${v}%`} stepper />
          <div className="am-rate-grid" role="radiogroup" aria-label="Mistake frequency presets">
            {PRESETS.map((p) => (
              <button key={p.value} type="button" role="radio" aria-checked={rate === p.value} className={rate === p.value ? 'active' : ''} onClick={() => setRate(p.value)}>
                <strong>{p.label}</strong>
                {p.sub && <small>{p.sub}</small>}
              </button>
            ))}
          </div>
          <p className="am-label">Cross-out pen style</p>
          <div className="am-cross-grid" role="radiogroup" aria-label="Cross-out pen style">
            {STYLES.map((st) => (
              <button key={st.id} type="button" role="radio" aria-checked={s.crossStyle === st.id} className={s.crossStyle === st.id ? 'active' : ''} onClick={() => onSettings({ crossStyle: st.id })}>
                <span aria-hidden="true">{st.glyph}</span>{st.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <button type="button" className="btn secondary btn-sm am-full" onClick={() => onSettings({ autoMistake: true, mistakeRate: s.mistakeRate || 1 })}>
          Turn on realistic mistakes
        </button>
      )}
    </section>
  );
}
