import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Minus, Plus, RotateCcw } from 'lucide-react';

export function Section({ title, badge, children, tone, defaultOpen = true }: { title: string; badge?: ReactNode; children: ReactNode; tone?: 'warm'; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <section className={`am-section${tone ? ` am-section-${tone}` : ''}${open ? '' : ' collapsed'}`}>
      <header className="am-section-head">
        <h3>{title}</h3>
        <div className="am-section-tools">
          {badge}
          <button
            type="button"
            className="am-section-toggle"
            aria-expanded={open}
            aria-controls={bodyId}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${title}`}
            onClick={() => setOpen((o) => !o)}
          >
            <ChevronDown size={16} aria-hidden />
          </button>
        </div>
      </header>
      {open && <div id={bodyId} className="am-section-body">{children}</div>}
    </section>
  );
}

export function Toggle({ checked, onChange, label, description }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: string }) {
  const id = useId();
  return (
    <div className="am-toggle-row">
      <div>
        <label htmlFor={id}>{label}</label>
        {description && <p>{description}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        className={`am-switch${checked ? ' on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  );
}

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  defaultValue?: number;
  stepper?: boolean;
  onDragChange?: (dragging: boolean) => void;
}

export function SliderField({ label, value, min, max, step = 1, onChange, format, defaultValue, stepper, onDragChange }: SliderProps) {
  const id = useId();
  const pulseTimer = useRef(0);
  const draggingRef = useRef(false);
  const onDragRef = useRef(onDragChange);
  onDragRef.current = onDragChange;

  const setDragging = (next: boolean) => {
    window.clearTimeout(pulseTimer.current);
    if (draggingRef.current === next) return;
    draggingRef.current = next;
    onDragRef.current?.(next);
  };

  const pulseDrag = () => {
    if (!onDragRef.current) return;
    window.clearTimeout(pulseTimer.current);
    if (!draggingRef.current) {
      draggingRef.current = true;
      onDragRef.current(true);
    }
    pulseTimer.current = window.setTimeout(() => {
      draggingRef.current = false;
      onDragRef.current?.(false);
    }, 550);
  };

  useEffect(() => {
    return () => {
      window.clearTimeout(pulseTimer.current);
      if (draggingRef.current) {
        draggingRef.current = false;
        onDragRef.current?.(false);
      }
    };
  }, []);

  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  const display = format ? format(value) : String(Math.round(value * 100) / 100);
  const pct = Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));

  return (
    <div className="am-slider">
      <div className="am-slider-head">
        <label htmlFor={id}>{label}</label>
        <span className="am-slider-value">{display}</span>
        {defaultValue !== undefined && Math.abs(value - defaultValue) > step / 2 && (
          <button
            type="button"
            className="am-mini-btn"
            onClick={() => {
              pulseDrag();
              onChange(defaultValue);
            }}
            aria-label={`Reset ${label}`}
            title={`Reset ${label}`}
          >
            <RotateCcw size={12} />
          </button>
        )}
      </div>
      <div className="am-slider-row">
        {stepper && (
          <button
            type="button"
            className="am-step-btn"
            onClick={() => {
              pulseDrag();
              onChange(clamp(value - step));
            }}
            aria-label={`Decrease ${label}`}
          >
            <Minus size={14} />
          </button>
        )}
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onPointerDown={() => {
            setDragging(true);
            const end = () => {
              window.removeEventListener('pointerup', end);
              window.removeEventListener('pointercancel', end);
              setDragging(false);
            };
            window.addEventListener('pointerup', end);
            window.addEventListener('pointercancel', end);
          }}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{ ['--fill' as string]: `${pct}%` }}
        />
        {stepper && (
          <button
            type="button"
            className="am-step-btn"
            onClick={() => {
              pulseDrag();
              onChange(clamp(value + step));
            }}
            aria-label={`Increase ${label}`}
          >
            <Plus size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

export function Segmented<T extends string | number>({ options, value, onChange, label, columns }: {
  options: Array<{ value: T; label: ReactNode; title?: string }>;
  value: T;
  onChange: (v: T) => void;
  label: string;
  columns?: number;
}) {
  return (
    <div className="am-seg" role="radiogroup" aria-label={label} style={columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          className={o.value === value ? 'active' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
