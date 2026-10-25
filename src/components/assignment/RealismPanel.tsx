import { Dices, RotateCcw } from 'lucide-react';
import { VARIATION_STRENGTHS } from '../../lib/handwriting/variation';
import {
  DEFAULT_ADJUST,
  isNeutralAdjust,
  type ActiveGuide,
  type AssignmentSettings,
  type PageNumberFormat,
  type PageNumberPosition,
} from '../../lib/handwriting/catalog';
import { Section, SliderField, Toggle } from './controls';
import { AdjustFields } from './AdjustFields';

const POSITIONS: Array<{ id: PageNumberPosition; label: string; short: string }> = [
  { id: 'top-left', label: 'Top Left', short: 'Top L' },
  { id: 'top-center', label: 'Top Center', short: 'Top C' },
  { id: 'top-right', label: 'Top Right', short: 'Top R' },
  { id: 'bottom-left', label: 'Bottom Left', short: 'Bot L' },
  { id: 'bottom-center', label: 'Bottom Center', short: 'Bot C' },
  { id: 'bottom-right', label: 'Bottom Right', short: 'Bot R' },
];

const FORMATS: Array<{ id: PageNumberFormat; label: string; sample: string }> = [
  { id: 'page', label: 'Page 1', sample: 'Page 1' },
  { id: 'number', label: 'Number only', sample: '1' },
  { id: 'slash', label: '1 / Total', sample: '1 / 3' },
  { id: 'dash', label: 'Dashed', sample: '- 1 -' },
  { id: 'pg', label: 'Pg. 1', sample: 'Pg. 1' },
  { id: 'circled', label: 'Circled', sample: '( 1 )' },
];

export function RealismPanel({
  settings: s,
  onSettings,
  onActiveGuide,
}: {
  settings: AssignmentSettings;
  onSettings: (p: Partial<AssignmentSettings>) => void;
  onActiveGuide?: (guide: ActiveGuide) => void;
}) {
  const pos = s.pageNumberPosition ?? 'top-right';
  const fmt = s.pageNumberFormat ?? 'page';
  const ox = s.pageNumberOffsetX ?? 0;
  const oy = s.pageNumberOffsetY ?? 0;
  const hasOffset = ox !== 0 || oy !== 0;
  const adjust = s.adjust ?? DEFAULT_ADJUST;
  const variation = s.variation ?? 'off';
  const isSpiralPhoto = s.paper?.kind === 'stock' && s.paper.id === 'spiral-notebook';

  const pulsePageNumGuide = () => {
    if (!onActiveGuide) return;
    onActiveGuide('pageNumber');
    window.setTimeout(() => onActiveGuide(null), 650);
  };

  return (
    <Section title="Realism" defaultOpen={false}>
      <div className="am-pnum-card">
        <div className="am-pnum-head">
          <span className="am-label" id="am-variation-label">Page variations</span>
          {variation !== 'off' && (
            <button
              type="button"
              className="am-pnum-reset"
              onClick={() => onSettings({ variationSeed: 1 + Math.floor(Math.random() * 999_999_999) })}
              title="Give every unlocked page a fresh look"
            >
              <Dices size={11} />Re-roll
            </button>
          )}
        </div>
        <div className="am-seg" role="radiogroup" aria-labelledby="am-variation-label">
          {VARIATION_STRENGTHS.map((v) => (
            <button
              key={v.id}
              type="button"
              role="radio"
              aria-checked={variation === v.id}
              className={variation === v.id ? 'active' : ''}
              onClick={() => onSettings({ variation: v.id })}
            >
              {v.label}
            </button>
          ))}
        </div>
        <p className="am-pnum-hint">
          Your chosen paper stays unchanged until you click Re-roll. Strength only sets how much the look varies.
          Re-roll all pages in Default page layout, or just one from its layout or adjust button.
        </p>
      </div>
      <Toggle
        checked={s.photoFilter}
        onChange={(v) => onSettings({ photoFilter: v })}
        label="Realistic photo filter"
        description="Warm light, soft shadow and grain — like a phone photo"
      />
      {s.photoFilter && (
        <SliderField
          label="Filter strength"
          value={s.photoStrength}
          min={0.1}
          max={1}
          step={0.05}
          onChange={(v) => onSettings({ photoStrength: v })}
          onDragChange={(d) => onActiveGuide?.(d ? 'photoStrength' : null)}
          format={(v) => `${Math.round(v * 100)}%`}
          defaultValue={0.6}
        />
      )}
      <div className="am-pnum-card">
        <div className="am-pnum-head">
          <span className="am-label">Image adjustments</span>
          {!isNeutralAdjust(adjust) && (
            <button
              type="button"
              className="am-pnum-reset"
              onClick={() => onSettings({ adjust: DEFAULT_ADJUST })}
              title="Reset brightness, contrast, saturation and sharpness"
            >
              <RotateCcw size={11} />Reset
            </button>
          )}
        </div>
        <AdjustFields
          value={adjust}
          onChange={(patch) => onSettings({ adjust: { ...adjust, ...patch } })}
          onActiveGuide={onActiveGuide}
        />
        <p className="am-pnum-hint">Applies to every page. Use the adjust button above a page to fine-tune just that page.</p>
      </div>
      <Toggle
        checked={s.underlineHeadings}
        onChange={(v) => onSettings({ underlineHeadings: v })}
        label="Underline headings"
        description="Lines starting with # are written larger and underlined"
      />
      <Toggle
        checked={s.pageNumbers}
        onChange={(v) => {
          if (v && isSpiralPhoto && s.pageNumberFormat === 'page' && ox === 0 && oy === 0) {
            // Spiral Notebook Photo already has "Page ____" printed in the top-right box
            onSettings({ pageNumbers: true, pageNumberFormat: 'number', pageNumberPosition: 'top-right' });
          } else {
            onSettings({ pageNumbers: v });
          }
          if (v) pulsePageNumGuide();
        }}
        label="Handwritten page numbers"
        description="Aligned to header/footer rules or placed with custom X/Y sliders"
      />

      {s.pageNumbers && (
        <div className="am-pnum-card">
          <div className="am-pnum-head">
            <span className="am-label">Page number placement</span>
            {hasOffset && (
              <button
                type="button"
                className="am-pnum-reset"
                onClick={() => {
                  onSettings({ pageNumberOffsetX: 0, pageNumberOffsetY: 0 });
                  pulsePageNumGuide();
                }}
                title="Snap back to preset alignment"
              >
                <RotateCcw size={11} />Reset offset
              </button>
            )}
          </div>

          <div className="am-pnum-pos-grid" role="radiogroup" aria-label="Page number position">
            {POSITIONS.map((p) => {
              const active = pos === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`am-pnum-pos-btn${active ? ' active' : ''}`}
                  onClick={() => {
                    onSettings({ pageNumberPosition: p.id, pageNumberOffsetX: 0, pageNumberOffsetY: 0 });
                    pulsePageNumGuide();
                  }}
                  title={p.label}
                >
                  <span className={`am-pnum-dot am-pnum-dot-${p.id}`} aria-hidden="true" />
                  <span>{p.short}</span>
                </button>
              );
            })}
          </div>

          {isSpiralPhoto && (
            <button
              type="button"
              className={`am-chip-btn am-full${pos === 'top-right' && fmt === 'number' && !hasOffset ? ' active' : ''}`}
              onClick={() => {
                onSettings({
                  pageNumberPosition: 'top-right',
                  pageNumberFormat: 'number',
                  pageNumberOffsetX: 0,
                  pageNumberOffsetY: 0,
                });
                pulsePageNumGuide();
              }}
            >
              Fit inside printed &ldquo;Page ___&rdquo; box
            </button>
          )}

          <p className="am-label">Number style</p>
          <div className="am-pnum-fmt-grid" role="radiogroup" aria-label="Page number style">
            {FORMATS.map((f) => {
              const active = fmt === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`am-pnum-fmt-btn${active ? ' active' : ''}`}
                  onClick={() => {
                    onSettings({ pageNumberFormat: f.id });
                    pulsePageNumGuide();
                  }}
                  title={f.label}
                >
                  <strong>{f.sample}</strong>
                  <small>{f.label}</small>
                </button>
              );
            })}
          </div>

          <SliderField
            label="Horizontal position (X)"
            value={ox}
            min={-600}
            max={600}
            step={1}
            onChange={(v) => onSettings({ pageNumberOffsetX: v })}
            onDragChange={(d) => onActiveGuide?.(d ? 'pageNumber' : null)}
            format={(v) => (v > 0 ? `+${v}px` : `${v}px`)}
            defaultValue={0}
            stepper
          />
          <SliderField
            label="Vertical position (Y)"
            value={oy}
            min={-600}
            max={600}
            step={1}
            onChange={(v) => onSettings({ pageNumberOffsetY: v })}
            onDragChange={(d) => onActiveGuide?.(d ? 'pageNumber' : null)}
            format={(v) => (v > 0 ? `+${v}px` : `${v}px`)}
            defaultValue={0}
            stepper
          />
          <SliderField
            label="Number size"
            value={s.pageNumberScale ?? 0.82}
            min={0.5}
            max={1.35}
            step={0.02}
            onChange={(v) => onSettings({ pageNumberScale: v })}
            onDragChange={(d) => onActiveGuide?.(d ? 'pageNumber' : null)}
            format={(v) => `${Math.round(v * 100)}%`}
            defaultValue={0.82}
            stepper
          />
          <SliderField
            label="Start from page #"
            value={s.pageNumberStart ?? 1}
            min={1}
            max={50}
            step={1}
            onChange={(v) => onSettings({ pageNumberStart: v })}
            onDragChange={(d) => onActiveGuide?.(d ? 'pageNumber' : null)}
            format={(v) => `#${v}`}
            defaultValue={1}
            stepper
          />
          <p className="am-pnum-hint">
            Tip: You can also drag the page number directly on the page preview to position it anywhere.
          </p>
        </div>
      )}
    </Section>
  );
}
