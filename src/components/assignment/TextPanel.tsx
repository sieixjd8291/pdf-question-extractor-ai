import { useRef } from 'react';
import { BookOpenText, Eraser, FileUp, SeparatorHorizontal } from 'lucide-react';
import { SAMPLE_TEXT, type AssignmentSettings } from '../../lib/handwriting/catalog';
import { Section, Toggle } from './controls';

export function TextPanel({ text, pages, settings, onText, onSettings }: {
  text: string;
  pages: number;
  settings: AssignmentSettings;
  onText: (t: string, coalesce?: boolean) => void;
  onSettings: (p: Partial<AssignmentSettings>) => void;
}) {
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  const insertAtCursor = (snippet: string) => {
    const el = areaRef.current;
    if (!el) return onText(text + snippet, false);
    const start = el.selectionStart;
    const next = text.slice(0, start) + snippet + text.slice(el.selectionEnd);
    onText(next, false);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + snippet.length;
    });
  };

  return (
    <Section title="Write & edit text">
      <textarea
        ref={areaRef}
        className="am-textarea"
        value={text}
        onChange={(e) => onText(e.target.value)}
        placeholder={'Type or paste your text here (including math formulas or LaTeX like \\frac{1}{2}, \\sqrt{x})…'}
        aria-label="Assignment text"
        spellCheck
      />
      <div className="am-text-stats" aria-live="polite">
        <span>{words.toLocaleString()} words</span>
        <span>{text.length.toLocaleString()} chars</span>
        <span>{pages} {pages === 1 ? 'page' : 'pages'}</span>
      </div>
      <div className="am-chip-row">
        <button type="button" className="btn quiet btn-sm" onClick={() => insertAtCursor('\n\\newpage\n')}>
          <SeparatorHorizontal size={14} />Page break
        </button>
        <button type="button" className="btn quiet btn-sm" onClick={() => fileRef.current?.click()}>
          <FileUp size={14} />Import .txt
        </button>
        <button type="button" className="btn quiet btn-sm" onClick={() => onText(SAMPLE_TEXT, false)}>
          <BookOpenText size={14} />Sample
        </button>
        <button type="button" className="btn danger btn-sm" onClick={() => onText('', false)} disabled={!text}>
          <Eraser size={14} />Clear
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".txt,.md,.tex,text/plain"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onText(await f.text(), false);
        }}
      />
      <Toggle checked={settings.latex} onChange={(v) => onSettings({ latex: v })} label="Math & LaTeX" description="\frac, \sqrt, x^2, H_2O, Greek letters" />
      <Toggle checked={settings.markdown} onChange={(v) => onSettings({ markdown: v })} label="Clean ChatGPT formatting" description="Strips **bold**, # headings become titles" />
    </Section>
  );
}
