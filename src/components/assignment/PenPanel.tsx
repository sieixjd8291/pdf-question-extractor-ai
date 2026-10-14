import { Check, Pencil, PenTool, Pen, Feather } from 'lucide-react';
import { INK_PRESETS, PENS, inkColor, type AssignmentSettings, type PenType } from '../../lib/handwriting/catalog';
import { Section } from './controls';

const PEN_ICON: Record<PenType, typeof Pen> = { ballpoint: Pen, gel: PenTool, fountain: Feather, pencil: Pencil };

export function PenPanel({ settings: s, onSettings }: { settings: AssignmentSettings; onSettings: (p: Partial<AssignmentSettings>) => void }) {
  const pen = PENS.find((p) => p.id === s.pen) ?? PENS[0];
  const inks = INK_PRESETS.filter((i) => i.pen === s.pen);
  const color = inkColor(s);

  return (
    <Section title="Pen & ink">
      <div className="am-pen-grid" role="radiogroup" aria-label="Pen type">
        {PENS.map((p) => {
          const Icon = PEN_ICON[p.id];
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={s.pen === p.id}
              className={s.pen === p.id ? 'active' : ''}
              onClick={() => {
                const first = INK_PRESETS.find((i) => i.pen === p.id);
                onSettings({ pen: p.id, inkId: first?.id ?? s.inkId, customInk: null });
              }}
            >
              <Icon size={16} aria-hidden="true" />
              {p.label}
            </button>
          );
        })}
      </div>
      <div className="am-pen-card">
        <div>
          <strong>{pen.label}</strong>
          <span className="am-badge">{pen.tag}</span>
        </div>
        <p>{pen.description}</p>
      </div>
      <ul className="am-ink-list" role="listbox" aria-label="Ink colour">
        {inks.map((ink) => {
          const active = !s.customInk && s.inkId === ink.id;
          return (
            <li key={ink.id}>
              <button type="button" role="option" aria-selected={active} className={active ? 'active' : ''} onClick={() => onSettings({ inkId: ink.id, customInk: null })}>
                <span className="am-swatch" style={{ background: ink.color }} aria-hidden="true">{active && <Check size={12} />}</span>
                <span className="am-ink-text"><strong>{ink.name}</strong><small>{ink.description}</small></span>
              </button>
            </li>
          );
        })}
      </ul>
      <label className="am-color-row">
        <span>Custom ink colour</span>
        <input type="color" value={color} onChange={(e) => onSettings({ customInk: e.target.value })} />
      </label>
    </Section>
  );
}
