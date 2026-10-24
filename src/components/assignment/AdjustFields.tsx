import type { ActiveGuide, ImageAdjust } from '../../lib/handwriting/catalog';
import { SliderField } from './controls';

const FIELDS: Array<{ key: keyof ImageAdjust; label: string }> = [
  { key: 'brightness', label: 'Brightness' },
  { key: 'contrast', label: 'Contrast' },
  { key: 'saturation', label: 'Saturation' },
  { key: 'sharpness', label: 'Sharpness' },
];

const signed = (v: number) => (v > 0 ? `+${v}` : `${v}`);

export function AdjustFields({
  value,
  onChange,
  onActiveGuide,
}: {
  value: ImageAdjust;
  onChange: (patch: Partial<ImageAdjust>) => void;
  onActiveGuide?: (guide: ActiveGuide) => void;
}) {
  return (
    <>
      {FIELDS.map((f) => (
        <SliderField
          key={f.key}
          label={f.label}
          value={value[f.key]}
          min={-100}
          max={100}
          step={1}
          onChange={(v) => onChange({ [f.key]: v })}
          onDragChange={(d) => onActiveGuide?.(d ? 'adjust' : null)}
          format={signed}
          defaultValue={0}
          stepper
        />
      ))}
    </>
  );
}
