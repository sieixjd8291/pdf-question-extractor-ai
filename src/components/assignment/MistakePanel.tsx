import { Ban, PenLine, Shuffle } from 'lucide-react';
import type { AssignmentSettings, CrossStyle, MistakeKinds } from '../../lib/handwriting/catalog';
import type { MistakeCounts } from '../../lib/handwriting/compose';
import { SliderField } from './controls';

const PRESETS = [
  { value: 0, label: 'Off' },
  { value: 1, label: '1%', sub: 'Light' },
  { value: 2, label: '2%' },
  { value: 3, label: '3%' },
  { value: 5, label: '5%', sub: 'Heavy' },
];

const STYLES: Array<{ id: CrossStyle; label: string; glyph: string }> = [
  { id: 'mixed', label: 'Mixed', glyph: '≈' },
  { id: 'single', label: 'Single', glyph: '—' },
  { id: 'double', label: 'Double', glyph: '═' },
  { id: 'wavy', label: 'Wavy', glyph: '〰' },
  { id: 'scribble', label: 'Scribble', glyph: '#' },
];

const KINDS: Array<{ id: keyof MistakeKinds; label: string; hint: string; count: keyof MistakeCounts }> = [
  { id: 'crossOut', label: 'Cross-outs', hint: 'Wrong word struck through, then rewritten', count: 'crossOut' },
  { id: 'caret', label: 'Inserted letters', hint: 'Forgotten letter added above with a ^', count: 'caret' },
  { id: 'overwrite', label: 'Overwrites', hint: 'Letter traced over to correct it', count: 'overwrite' },
];

interface Props {
  settings: AssignmentSettings;
  counts: MistakeCounts | null;
  onSettings: (p: Partial<AssignmentSettings>) => void;
}

export function MistakePanel({ settings: s, counts, onSettings }: Props) {
  const rate = s.autoMistake ? s.mistakeRate : 0;
  const setRate = (v: number) => onSettings(v <= 0 ? { autoMistake: false, mistakeRate: s.mistakeRate || 1 } : { autoMistake: true, mistakeRate: v });
  const enabledKinds = KINDS.filter((k) => s.mistakeKinds[k.id]).length;
  const total = counts ? counts.crossOut + counts.caret + counts.overwrite : 0;

  const toggleKind = (id: keyof MistakeKinds) => {
    if (s.mistakeKinds[id] && enabledKinds <= 1) return;
    onSettings({ mistakeKinds: { ...s.mistakeKinds, [id]: !s.mistakeKinds[id] } });
  };

  return (
    <section className="am-section am-mistake">
      <div className="am-mistake-head">
        <span className="am-mistake-icon" aria-hidden="true"><PenLine size={16} /></span>
        <div>
          <h3>Auto mistakes <span className="am-pill">{rate}%</span></h3>
          <p>{s.autoMistake && counts ? `${total} ${total === 1 ? 'correction' : 'corrections'} in this document` : 'Human typos & crossed-out words'}</p>
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
          <div className="am-rate-grid" role="radiogroup" aria-label="Mistake frequency presets">
            {PRESETS.map((p) => (
              <button key={p.value} type="button" role="radio" aria-checked={rate === p.value} className={rate === p.value ? 'active' : ''} onClick={() => setRate(p.value)}>
                <strong>{p.label}</strong>
                {p.sub && <small>{p.sub}</small>}
              </button>
            ))}
          </div>
          <SliderField label="Fine-tune frequency" value={s.mistakeRate} min={0} max={5} step={0.5} onChange={setRate} format={(v) => `${v}%`} stepper />

          <p className="am-label">Mistake types</p>
          <ul className="am-kind-list">
            {KINDS.map((k) => {
              const on = s.mistakeKinds[k.id];
              const locked = on && enabledKinds <= 1;
              return (
                <li key={k.id}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    aria-disabled={locked}
                    title={locked ? 'Keep at least one mistake type on' : k.hint}
                    className={`am-kind${on ? ' on' : ''}`}
                    onClick={() => toggleKind(k.id)}
                  >
                    <span className="am-kind-check" aria-hidden="true" />
                    <span className="am-kind-text">
                      <strong>{k.label}</strong>
                      <small>{k.hint}</small>
                    </span>
                    {counts && on && <span className="am-kind-count">{counts[k.count]}</span>}
                  </button>
                </li>
              );
            })}
          </ul>

          {s.mistakeKinds.crossOut && (
            <>
              <p className="am-label">Cross-out pen style</p>
              <div className="am-cross-grid" role="radiogroup" aria-label="Cross-out pen style">
                {STYLES.map((st) => (
                  <button key={st.id} type="button" role="radio" aria-checked={s.crossStyle === st.id} className={s.crossStyle === st.id ? 'active' : ''} onClick={() => onSettings({ crossStyle: st.id })}>
                    <span aria-hidden="true">{st.glyph}</span>{st.label}
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="am-mistake-actions">
            <button type="button" className="am-off-btn" onClick={() => onSettings({ mistakeSeed: Math.floor(Math.random() * 1_000_000) })}>
              <Shuffle size={14} />New mistakes
            </button>
            <button type="button" className="am-off-btn" onClick={() => onSettings({ autoMistake: false })}>
              <Ban size={14} />Turn off
            </button>
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
