import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ChevronDown,
  CircleHelp,
  Expand,
  Layers,
  Minimize,
  Minus,
  PenLine,
  Plus,
  Redo2,
  RotateCcw,
  Shuffle,
  Type,
  Undo2,
} from 'lucide-react';
import {
  HANDWRITING_FONTS,
  INK_PRESETS,
  PENS,
  inkColor,
  type AssignmentSettings,
  type TextAlign,
} from '../../lib/handwriting/catalog';

type Patch = (patch: Partial<AssignmentSettings>, undoable?: boolean) => void;

export interface QuickBarProps {
  settings: AssignmentSettings;
  onSettings: Patch;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onAddDiagram: () => void;
  diagramDisabled: boolean;
  exportMenu: ReactNode;
  onShuffle: () => void;
  onHelp: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onReset: () => void;
}

const RATES = [0, 1, 2, 3, 5];

function Dropdown({ id, open, onToggle, trigger, label, children, split }: {
  id: string;
  open: string | null;
  onToggle: (id: string | null) => void;
  trigger?: ReactNode;
  label: string;
  children: ReactNode;
  split?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const isOpen = open === id;
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!isOpen || !ref.current) return;
    const place = () => {
      const r = ref.current!.getBoundingClientRect();
      setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - 248)) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [isOpen]);
  useEffect(() => {
    if (!isOpen) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onToggle(null);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onToggle(null);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [isOpen, onToggle]);
  return (
    <div className={`qb-group${split ? ' qb-split' : ''}`} ref={ref}>
      {trigger}
      <button
        type="button"
        className="qb-btn qb-arrow"
        aria-label={`${label} options`}
        aria-expanded={isOpen}
        onClick={() => onToggle(isOpen ? null : id)}
      >
        <ChevronDown size={14} className={isOpen ? 'qb-rot' : ''} />
      </button>
      {isOpen && pos && <div className="qb-menu" role="menu" style={pos}>{children}</div>}
    </div>
  );
}

function Stepper({ value, onChange, min, max, step = 1, suffix = '', label }: {
  value: number; onChange: (v: number) => void; min: number; max: number; step?: number; suffix?: string; label: string;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v * 10) / 10));
  return (
    <div className="qb-group qb-stepper" role="group" aria-label={label}>
      <button type="button" className="qb-btn" aria-label={`Decrease ${label}`} disabled={value <= min} onClick={() => onChange(clamp(value - step))}><Minus size={14} /></button>
      <span className="qb-value">{value}{suffix}</span>
      <button type="button" className="qb-btn" aria-label={`Increase ${label}`} disabled={value >= max} onClick={() => onChange(clamp(value + step))}><Plus size={14} /></button>
    </div>
  );
}

export function QuickBar({ settings: s, onSettings }: Pick<QuickBarProps, 'settings' | 'onSettings'>) {
  const [open, setOpen] = useState<string | null>(null);
  const font = HANDWRITING_FONTS.find((f) => f.family === s.fontFamily);
  const pen = PENS.find((p) => p.id === s.pen);
  const rate = s.autoMistake ? s.mistakeRate : 0;
  const setRate = (r: number) => onSettings(r <= 0 ? { autoMistake: false } : { autoMistake: true, mistakeRate: r });
  const aligns: { id: TextAlign; icon: ReactNode }[] = [
    { id: 'left', icon: <AlignLeft size={16} /> },
    { id: 'center', icon: <AlignCenter size={16} /> },
    { id: 'right', icon: <AlignRight size={16} /> },
  ];

  return (
    <div className="qb-wrap">
    <nav className="qb" aria-label="Assignment Maker toolbar">
      <div className="am-brand">
        <span className="am-brand-icon" aria-hidden="true"><PenLine size={17} /></span>
        <div className="am-brand-text">
          <h1>Assignment Maker</h1>
          <p className="hide-md">Realistic text to handwriting</p>
        </div>
      </div>

      <div className="qb-divider" aria-hidden="true" />

      <button type="button" className={`qb-btn qb-pill${s.combineFonts ? ' on' : ''}`} aria-pressed={s.combineFonts} onClick={() => onSettings({ combineFonts: !s.combineFonts })}>
        <Layers size={15} />Combine
      </button>

      <Dropdown id="font" label="Font" open={open} onToggle={setOpen} trigger={
        <button type="button" className="qb-btn qb-pill qb-font" onClick={() => setOpen(open === 'font' ? null : 'font')}>
          <Type size={15} /><span style={{ fontFamily: `'${s.fontFamily}'` }}>{font?.label ?? s.fontFamily}</span>
        </button>
      }>
        <div className="qb-menu-scroll">
          {HANDWRITING_FONTS.map((f) => (
            <button key={f.family} type="button" role="menuitemradio" aria-checked={f.family === s.fontFamily}
              className={`qb-item${f.family === s.fontFamily ? ' on' : ''}`}
              onClick={() => { onSettings({ fontFamily: f.family }); setOpen(null); }}>
              <span style={{ fontFamily: `'${f.family}'`, fontSize: 18 }}>{f.label}</span>
            </button>
          ))}
        </div>
      </Dropdown>

      <Stepper label="font size" value={s.fontSize} min={14} max={120} onChange={(v) => onSettings({ fontSize: v })} />

      <div className="qb-group qb-seg" role="group" aria-label="Text alignment">
        {aligns.map((a) => (
          <button key={a.id} type="button" className={`qb-btn${s.align === a.id ? ' on' : ''}`} aria-pressed={s.align === a.id} aria-label={`Align ${a.id}`} onClick={() => onSettings({ align: a.id })}>{a.icon}</button>
        ))}
      </div>

      <Dropdown id="ink" label="Ink" open={open} onToggle={setOpen} trigger={
        <button type="button" className="qb-btn qb-pill" onClick={() => setOpen(open === 'ink' ? null : 'ink')}>
          <span className="qb-dot" style={{ background: inkColor(s) }} aria-hidden="true" />
          <span className="qb-two"><strong>Ink</strong><small>{pen?.label ?? s.pen}</small></span>
        </button>
      }>
        <p className="qb-menu-label">Pen</p>
        <div className="qb-chips">
          {PENS.map((p) => (
            <button key={p.id} type="button" className={`qb-chip${s.pen === p.id ? ' on' : ''}`}
              onClick={() => onSettings({ pen: p.id, inkId: INK_PRESETS.find((i) => i.pen === p.id)?.id ?? s.inkId, customInk: null })}>{p.label}</button>
          ))}
        </div>
        <p className="qb-menu-label">Colour</p>
        <div className="qb-swatches">
          {INK_PRESETS.filter((i) => i.pen === s.pen).map((i) => (
            <button key={i.id} type="button" title={i.name} aria-label={i.name} aria-pressed={s.inkId === i.id && !s.customInk}
              className={`qb-swatch${s.inkId === i.id && !s.customInk ? ' on' : ''}`} style={{ background: i.color }}
              onClick={() => onSettings({ inkId: i.id, customInk: null })} />
          ))}
        </div>
      </Dropdown>

      <div className="qb-group qb-split qb-warm">
        <Dropdown id="mistake" label="Auto mistake" open={open} onToggle={setOpen} trigger={
          <button type="button" className="qb-btn qb-pill" onClick={() => setOpen(open === 'mistake' ? null : 'mistake')}>
            Auto Mistake: <span className="qb-badge">{rate ? `${rate}%` : 'Off'}</span>
          </button>
        }>
          <p className="qb-menu-label">Mistake frequency</p>
          <div className="qb-chips">
            {RATES.map((r) => (
              <button key={r} type="button" className={`qb-chip${rate === r ? ' on' : ''}`} onClick={() => setRate(r)}>
                {r === 0 ? 'Off' : `${r}%`}{r === 1 ? ' Light' : r === 5 ? ' Heavy' : ''}
              </button>
            ))}
          </div>
          <button type="button" className="qb-item" onClick={() => { onSettings({ autoMistake: true, mistakeSeed: s.mistakeSeed + 1 }); setOpen(null); }}>Shuffle mistake positions</button>
        </Dropdown>
        <button type="button" className="qb-btn" aria-label="Fewer mistakes" disabled={rate <= 0} onClick={() => setRate(rate - 1)}><Minus size={14} /></button>
        <button type="button" className="qb-btn" aria-label="More mistakes" disabled={rate >= 10} onClick={() => setRate(rate + 1)}><Plus size={14} /></button>
      </div>

    </nav>
    </div>
  );
}

export type ActionBarProps = Pick<
  QuickBarProps,
  'undo' | 'redo' | 'canUndo' | 'canRedo' | 'onAddDiagram' | 'diagramDisabled' | 'exportMenu' | 'onShuffle' | 'onHelp' | 'fullscreen' | 'onToggleFullscreen' | 'onReset'
>;

export function ActionBar({
  undo, redo, canUndo, canRedo, onAddDiagram, diagramDisabled, exportMenu, onShuffle, onHelp, fullscreen, onToggleFullscreen, onReset,
}: ActionBarProps) {
  return (
    <div className="am-actionbar" role="toolbar" aria-label="Document actions">
      <div className="am-btn-group">
        <button type="button" className="icon-button" onClick={undo} disabled={!canUndo} aria-label="Undo" title="Undo (Ctrl+Z)"><Undo2 size={16} /></button>
        <button type="button" className="icon-button" onClick={redo} disabled={!canRedo} aria-label="Redo" title="Redo (Ctrl+Y)" aria-keyshortcuts="Control+Y Control+Shift+Z"><Redo2 size={16} /></button>
      </div>

      <button type="button" className="btn secondary btn-sm" onClick={onAddDiagram} disabled={diagramDisabled}>
        <Layers size={15} /><span>Add diagram</span>
      </button>

      {exportMenu}

      <div className="am-actionbar-icons">
        <button type="button" className="icon-button" onClick={onShuffle} aria-label="Re-roll handwriting variation" title="Re-roll handwriting variation">
          <Shuffle size={16} />
        </button>
        <button type="button" className="icon-button" onClick={onHelp} aria-label="Help" title="Help">
          <CircleHelp size={16} />
        </button>
        <button type="button" className="icon-button hide-sm" onClick={onToggleFullscreen} aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
          {fullscreen ? <Minimize size={16} /> : <Expand size={16} />}
        </button>
        <button type="button" className="icon-button" onClick={onReset} aria-label="Reset document" title="Reset document">
          <RotateCcw size={16} />
        </button>
      </div>
    </div>
  );
}
