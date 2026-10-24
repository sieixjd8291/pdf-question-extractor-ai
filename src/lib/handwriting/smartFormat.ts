/**
 * Pre-formatter that runs before the Rust text preparer (engine.prepareText).
 *
 * The WASM preparer understands a small core of markdown and LaTeX. This pass
 * rewrites everything else people paste (full GitHub/ChatGPT markdown, LaTeX
 * documents, display math blocks, matrices, chemistry, emoji, HTML snippets)
 * into that core, so the handwriting comes out clean.
 *
 * U+200B is used as an "inert" marker to stop the Rust pass from treating a
 * line as a heading or stripping `**`/`__` inside code; callers must remove it
 * from the prepared output (see stripInertMarkers).
 */

export interface FormatOptions {
  latex: boolean;
  markdown: boolean;
}

const INERT = '\u200b';
const HEADING_MARK = '\u0004';
const PUA_BASE = 0xe000;
const PUA_RE = /[\ue000-\uf8ff]/g;

export function stripInertMarkers(prepared: string): string {
  return prepared.includes(INERT) ? prepared.replaceAll(INERT, '') : prepared;
}

export function normalizeAssignmentText(input: string, opts: FormatOptions): string {
  let text = input
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/[\u200b\u2060\ufeff]/g, '')
    .replace(PUA_RE, '');
  if (!opts.latex && !opts.markdown) return text;

  const store = new PlaceholderStore();

  if (opts.markdown) text = extractCode(text, store);
  if (opts.latex) {
    text = normalizeLatexDocument(text);
    text = bracketedMathToDelimiters(text);
    text = convertDollarDelimiters(text);
    text = normalizeMathCommands(text);
  }
  if (opts.markdown) {
    if (opts.latex) text = extractMath(text, store);
    text = normalizeMarkdown(text, opts.latex);
    text = cleanUnicode(text);
  }
  text = store.restore(text, opts);
  return text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
}

/* ------------------------------------------------------------------ */
/* Placeholders                                                        */
/* ------------------------------------------------------------------ */

type Stored = { kind: 'code' | 'codeblock' | 'math'; content: string };

class PlaceholderStore {
  private items: Stored[] = [];

  put(item: Stored): string {
    const id = this.items.length;
    this.items.push(item);
    return String.fromCharCode(PUA_BASE + id);
  }

  restore(text: string, opts: FormatOptions): string {
    if (!this.items.length) return text;
    let out = text;
    for (let pass = 0; pass < 3 && PUA_RE.test(out); pass++) {
      PUA_RE.lastIndex = 0;
      out = out.replace(PUA_RE, (ch) => {
        const item = this.items[ch.charCodeAt(0) - PUA_BASE];
        if (!item) return '';
        if (item.kind === 'math') return item.content;
        if (item.kind === 'code') return escapeCode(item.content, opts);
        return item.content
          .split('\n')
          .map((line) => {
            const esc = escapeCode(line, opts);
            return /^\s*(#|\*\*)/.test(esc) ? INERT + esc : esc;
          })
          .join('\n');
      });
    }
    PUA_RE.lastIndex = 0;
    return out;
  }
}

function escapeCode(code: string, opts: FormatOptions): string {
  let out = code.replaceAll('**', `*${INERT}*`).replaceAll('__', `_${INERT}_`);
  if (opts.latex) out = out.replace(/([$^_])/g, '\\$1');
  return out;
}

function extractCode(text: string, store: PlaceholderStore): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (!open) {
      out.push(lines[i]);
      continue;
    }
    const fence = open[1];
    const body: string[] = [];
    i++;
    while (i < lines.length && !new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(lines[i])) {
      body.push(lines[i]);
      i++;
    }
    while (body.length && !body[body.length - 1].trim()) body.pop();
    out.push(store.put({ kind: 'codeblock', content: body.join('\n') }));
  }
  return out
    .join('\n')
    .replace(/(`{1,2})([^`\n]+?)\1(?!`)/g, (_, _tick: string, code: string) => store.put({ kind: 'code', content: code.trim() }));
}

function extractMath(text: string, store: PlaceholderStore): string {
  return text.replace(/\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)/g, (m) => store.put({ kind: 'math', content: m }));
}

/* ------------------------------------------------------------------ */
/* LaTeX                                                               */
/* ------------------------------------------------------------------ */

/** Reads a balanced `{...}` group starting at (or after whitespace from) i. */
function readBraced(s: string, i: number): { content: string; end: number } | null {
  let j = i;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
  if (s[j] !== '{') return null;
  let depth = 0;
  for (let k = j; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\') {
      k++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return { content: s.slice(j + 1, k), end: k + 1 };
  }
  return null;
}

function readOptional(s: string, i: number): { content: string; end: number } | null {
  let j = i;
  while (j < s.length && s[j] === ' ') j++;
  if (s[j] !== '[') return null;
  const close = s.indexOf(']', j);
  return close === -1 ? null : { content: s.slice(j + 1, close), end: close + 1 };
}

/**
 * Replaces `\name[opt]{a}{b}` (balanced braces) using fn. Repeats so nested
 * uses of the same command are expanded too.
 */
function replaceCommand(
  text: string,
  names: string,
  argCount: number,
  fn: (args: string[], name: string, opt: string | null) => string,
  allowOptional = false,
): string {
  const re = new RegExp(`\\\\(${names})(?![A-Za-z])`, 'g');
  let current = text;
  for (let pass = 0; pass < 4; pass++) {
    let out = '';
    let last = 0;
    let changed = false;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(current))) {
      let pos = m.index + m[0].length;
      let opt: string | null = null;
      if (allowOptional) {
        const o = readOptional(current, pos);
        if (o) {
          opt = o.content;
          pos = o.end;
        }
      }
      const args: string[] = [];
      let ok = true;
      for (let a = 0; a < argCount; a++) {
        const g = readBraced(current, pos);
        if (!g) {
          ok = false;
          break;
        }
        args.push(g.content);
        pos = g.end;
      }
      if (!ok) continue;
      out += current.slice(last, m.index) + fn(args, m[1], opt);
      last = pos;
      re.lastIndex = pos;
      changed = true;
    }
    if (!changed) return current;
    current = out + current.slice(last);
  }
  return current;
}

const SECTION_LEVELS = 'part|chapter|section|subsection|subsubsection|paragraph|subparagraph|title';

/** Converts LaTeX document structure (sections, lists, preamble) into lines. */
function normalizeLatexDocument(text: string): string {
  const isDocument = /\\documentclass|\\begin\{document\}|\\(?:sub)*section\*?\{|\\begin\{(?:itemize|enumerate)\}/.test(text);
  if (!isDocument) return text;

  const stack: Array<{ numbered: boolean; n: number }> = [];
  const out: string[] = [];
  const fullDoc = /\\documentclass|\\begin\{document\}/.test(text);

  for (let raw of text.split('\n')) {
    if (fullDoc) raw = raw.replace(/(^|[^\\])%.*$/, '$1');
    const line = raw.trim();
    if (/^\\(documentclass|usepackage|maketitle|tableofcontents|newcommand|renewcommand|geometry|pagestyle|setlength|bibliographystyle|bibliography)\b/.test(line)) continue;
    if (/^\\(begin|end)\{document\}/.test(line)) continue;
    const begin = /^\\begin\{(itemize|enumerate|description)\}/.exec(line);
    if (begin) {
      stack.push({ numbered: begin[1] === 'enumerate', n: 0 });
      continue;
    }
    if (/^\\end\{(itemize|enumerate|description)\}/.test(line)) {
      stack.pop();
      continue;
    }
    const item = /^\\item(?:\s*\[([^\]]*)\])?\s*(.*)$/.exec(line);
    if (item) {
      const level = stack[stack.length - 1];
      const indent = '    '.repeat(Math.max(0, stack.length - 1));
      const marker = item[1] ? `${item[1]} ` : level?.numbered ? `${++level.n}. ` : '- ';
      out.push(indent + marker + item[2]);
      continue;
    }
    out.push(raw);
  }

  let result = out.join('\n');
  result = replaceCommand(result, `(?:${SECTION_LEVELS})\\*?`, 1, ([t]) => `\n${HEADING_MARK}${t}\n`);
  result = replaceCommand(result, 'author|date', 1, ([t]) => t);
  return result;
}

/** ChatGPT copies sometimes lose `\[`, leaving `[ \frac{a}{b} ]` lines. */
function bracketedMathToDelimiters(text: string): string {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const single = /^\[\s+(.*\\[A-Za-z].*)\s+\]$/.exec(t);
    if (single) {
      lines[i] = `\\[${single[1]}\\]`;
      continue;
    }
    if (t === '[') {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== ']' && j - i < 30) j++;
      if (j < lines.length && lines[j].trim() === ']' && /\\[A-Za-z]|[\^_]/.test(lines.slice(i + 1, j).join('\n'))) {
        lines[i] = '\\[';
        lines[j] = '\\]';
        i = j;
      }
    }
  }
  return lines.join('\n');
}

/**
 * Turns `$$..$$` into `\[..\]` and valid `$..$` into `\(..\)` using pandoc's
 * rules, so currency like "$5 and $10" stays literal (`\$`).
 */
function convertDollarDelimiters(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '\\' && i + 1 < n) {
      out += c + text[i + 1];
      i += 2;
      continue;
    }
    if (c !== '$') {
      out += c;
      i++;
      continue;
    }
    if (text[i + 1] === '$') {
      let k = i + 2;
      let close = -1;
      while (k < n) {
        if (text[k] === '\\') k += 2;
        else if (text[k] === '$' && text[k + 1] === '$') {
          close = k;
          break;
        } else k++;
      }
      if (close !== -1) {
        out += `\\[${text.slice(i + 2, close)}\\]`;
        i = close + 2;
      } else {
        out += '\\$\\$';
        i += 2;
      }
      continue;
    }
    const next = text[i + 1];
    let close = -1;
    if (next && !/\s/.test(next)) {
      for (let k = i + 1; k < n && text[k] !== '\n'; k++) {
        if (text[k] === '\\') {
          k++;
          continue;
        }
        if (text[k] === '$' && k > i + 1 && !/\s/.test(text[k - 1]) && !/\d/.test(text[k + 1] ?? '')) {
          close = k;
          break;
        }
      }
    }
    if (close !== -1) {
      out += `\\(${text.slice(i + 1, close)}\\)`;
      i = close + 1;
    } else {
      out += '\\$';
      i++;
    }
  }
  return out;
}

const MATRIX_DELIMS: Record<string, [string, string]> = {
  '': ['', ''],
  small: ['', ''],
  p: ['(', ')'],
  b: ['[', ']'],
  B: ['\\{', '\\}'],
  v: ['|', '|'],
  V: ['‖', '‖'],
};

const ROW_SPLIT = /\\\\(?:\s*\[[^\]]*\])?|\n/;
const CELL_SPLIT = /(?<!\\)&/;

function splitRows(body: string): string[][] {
  return body
    .split(ROW_SPLIT)
    .map((r) => r.replace(/\\hline/g, '').trim())
    .filter(Boolean)
    .map((r) => r.split(CELL_SPLIT).map((c) => c.trim()));
}

const BLACKBOARD: Record<string, string> = { R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', P: 'ℙ', H: 'ℍ', F: '𝔽' };

const EXTRA_SYMBOLS: Record<string, string> = {
  lbrace: '\\{', rbrace: '\\}', lvert: '|', rvert: '|', lVert: '‖', rVert: '‖', Vert: '‖',
  lt: '<', gt: '>', leqslant: '≤', leqq: '≤', geqslant: '≥', geqq: '≥', nleq: '≰', ngeq: '≱',
  nless: '≮', ngtr: '≯', lesssim: '≲', gtrsim: '≳', ncong: '≇', nsim: '≁', approxeq: '≊',
  Longrightarrow: '⟹', longrightarrow: '⟶', Longleftarrow: '⟸', longleftarrow: '⟵',
  Longleftrightarrow: '⟺', longleftrightarrow: '⟷', longmapsto: '⟼', rightleftharpoons: '⇌',
  leftrightharpoons: '⇋', rightharpoonup: '⇀', hookrightarrow: '↪', hookleftarrow: '↩',
  nearrow: '↗', searrow: '↘', nwarrow: '↖', swarrow: '↙', Uparrow: '⇑', Downarrow: '⇓',
  updownarrow: '↕', checkmark: '✓', ddots: '⋱', cdotp: '·', ldotp: '.', colon: ':',
  top: '⊤', bot: '⊥', odot: '⊙', ominus: '⊖', oslash: '⊘', sqcup: '⊔', sqcap: '⊓', uplus: '⊎',
  bigcup: '⋃', bigcap: '⋂', bigoplus: '⨁', bigotimes: '⨂', coprod: '∐', iiint: '∭',
  doteq: '≐', asymp: '≍', prec: '≺', succ: '≻', preceq: '⪯', succeq: '⪰', models: '⊨',
  vdash: '⊢', dashv: '⊣', Box: '□', Diamond: '◇', diamond: '⋄', lozenge: '◊',
  measuredangle: '∡', sphericalangle: '∢', nexists: '∄', complement: '∁', subsetneq: '⊊',
  supsetneq: '⊋', nsubseteq: '⊈', nsupseteq: '⊉', nmid: '∤', varpropto: '∝', backslash: '∖',
  setminus: '∖', wp: '℘', imath: 'ı', jmath: 'ȷ', celsius: '°C', ohm: 'Ω', micro: 'µ',
  AA: 'Å', textdegree: '°', textmu: 'µ', textbackslash: '∖', S: '§', P: '¶', copyright: '©',
  pounds: '£', euro: '€', yen: '¥', textless: '<', textgreater: '>', textasciitilde: '~',
  textunderscore: '\\_', dag: '†', ddag: '‡', ddagger: '‡', textendash: '–', textemdash: '—',
  varkappa: 'ϰ', varrho: 'ϱ', omicron: 'ο', Alpha: 'A', Beta: 'B', Epsilon: 'E', Zeta: 'Z',
  Eta: 'H', Iota: 'I', Kappa: 'K', Mu: 'M', Nu: 'N', Omicron: 'O', Rho: 'P', Tau: 'T', Chi: 'X',
  enspace: ' ', thinspace: ' ', negthinspace: '', hfill: ' ', hline: '', toprule: '',
  midrule: '', bottomrule: '', nonumber: '', notag: '', mathstrut: '', strut: '', tiny: '',
  scriptsize: '', footnotesize: '', small: '', normalsize: '', large: '', Large: '', LARGE: '',
  huge: '', Huge: '', bf: '', it: '', rm: '', sf: '', tt: '', medskip: '', bigskip: '',
  smallskip: '', vfill: '', centering: '', raggedright: '', par: '\n', ast: '*', lnot: '¬',
  qty: '', differential: 'd', dd: 'd',
};

function convertChem(s: string): string {
  return s
    .replace(/<=>|<->|⇌/g, ' ⇌ ')
    .replace(/->|→/g, ' → ')
    .replace(/<-/g, ' ← ')
    .replace(/\^\{?(\d*[+-])\}?/g, '^{$1}')
    .replace(/([A-Za-z)\]])(\d+)/g, '$1_{$2}')
    .replace(/([A-Za-z)\]}])([+-])(?=\s|$)/g, '$1^{$2}')
    .replace(/(\s)v(?=\s|$)/g, '$1↓')
    .replace(/(\s)\^(?=\s|$)/g, '$1↑')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizeMathCommands(text: string): string {
  let t = text;

  // Row breaks followed by a real newline would otherwise leave blank lines.
  t = t.replace(/\\\\(?:\s*\[[^\]\n]*\])?[ \t]*\n/g, '\n');
  t = t.replace(/\\\\\s*\[[\d.]+\s*[a-z]{2}\]/g, '\\\\');

  t = t.replace(/\\begin\{([pbBvV]?|small)matrix\}([\s\S]*?)\\end\{\1matrix\}/g, (_, kind: string, body: string) => {
    const [l, r] = MATRIX_DELIMS[kind] ?? ['', ''];
    return splitRows(body)
      .map((cells) => `${l} ${cells.join(' \\quad ')} ${r}`.trim())
      .join('\n');
  });

  t = t.replace(/\\begin\{(?:array|tabular)\}\s*\{[^}]*\}([\s\S]*?)\\end\{(?:array|tabular)\}/g, (_, body: string) =>
    splitRows(body).map((cells) => cells.join(' \\quad ')).join('\n'),
  );

  t = t.replace(/\\begin\{[dr]?cases\*?\}([\s\S]*?)\\end\{[dr]?cases\*?\}/g, (_, body: string) =>
    splitRows(body)
      .map((cells, idx) => `${idx === 0 ? '\\{ ' : '\\quad '}${cells.filter(Boolean).join(' \\quad ')}`)
      .join('\n'),
  );

  t = t.replace(
    /\\begin\{(equation|align|gather|multline|eqnarray|flalign|alignat|displaymath|math)(\*?)\}(?:\{\d+\})?([\s\S]*?)\\end\{\1\2\}/g,
    (_, _env, _star, body: string) => `\\[${body.replace(CELL_SPLIT_GLOBAL, '').trim()}\\]`,
  );
  t = t.replace(
    /\\begin\{(aligned|gathered|split|alignedat|subequations|center)\}(?:\{\d+\})?([\s\S]*?)\\end\{\1\}/g,
    (_, _env, body: string) => body.replace(CELL_SPLIT_GLOBAL, '').trim(),
  );

  // Clean display blocks: drop alignment &, join `\[` / `\]` onto content.
  t = t.replace(/\\\[([\s\S]*?)\\\]/g, (_, body: string) => {
    const inner = body
      .replace(CELL_SPLIT_GLOBAL, '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n');
    return `\\[${inner}\\]`;
  });

  t = t.replace(/\\operatorname\*/g, '\\operatorname');
  t = t.replace(/\\not\s*=/g, '≠').replace(/\\not\s*\\in(?![A-Za-z])/g, '∉').replace(/\\not\s*\\subset(?![A-Za-z])/g, '⊄');
  t = t.replace(/\\bmod(?![A-Za-z])/g, ' mod ');

  t = replaceCommand(t, 'ce|pu', 1, ([c]) => convertChem(c));
  t = replaceCommand(t, 'SI|qty|SIrange', 2, ([v, u]) => `${v}\\,${u}`, true);
  t = replaceCommand(t, 'si|unit|num', 1, ([v]) => v, true);
  t = replaceCommand(t, 'ang', 1, ([v]) => `${v}°`);
  t = replaceCommand(t, '[dt]?binom', 2, ([a, b]) => `^{${a}}C_{${b}}`);
  t = t.replace(/\{([^{}]+?)\\choose([^{}]+?)\}/g, '^{$1}C_{$2}');
  t = t.replace(/\{([^{}]+?)\\over([^{}]+?)\}/g, '\\frac{$1}{$2}');
  t = replaceCommand(t, 'boxed|fbox|framebox|cancel|bcancel|xcancel|sout|underbrace|overbrace|smash|hbox|vbox|vb|bm|pmb', 1, ([a]) => a);
  t = replaceCommand(t, 'dv', 2, ([f, x]) => `\\frac{d${f}}{d${x}}`);
  t = replaceCommand(t, 'pdv', 2, ([f, x]) => `\\frac{∂${f}}{∂${x}}`);
  t = replaceCommand(t, 'abs', 1, ([a]) => `|${a}|`);
  t = replaceCommand(t, 'norm', 1, ([a]) => `‖${a}‖`);
  t = replaceCommand(t, 'cancelto', 2, ([, a]) => a);
  t = replaceCommand(t, 'textcolor|colorbox', 2, ([, a]) => a);
  t = replaceCommand(t, 'color', 1, () => '');
  t = replaceCommand(t, 'overrightarrow|overleftarrow|overleftrightarrow|vv', 1, ([a]) => `\\vec{${a}}`);
  t = replaceCommand(t, 'xrightarrow|xRightarrow', 1, ([a]) => ` →^{${a}} `, true);
  t = replaceCommand(t, 'xleftarrow|xLeftarrow', 1, ([a]) => ` ←^{${a}} `, true);
  t = replaceCommand(t, 'xrightleftharpoons', 1, ([a]) => ` ⇌^{${a}} `, true);
  t = replaceCommand(t, 'mathbb|mathds|mathbbm', 1, ([a]) => (a.length === 1 && BLACKBOARD[a]) || a);
  t = replaceCommand(t, 'pmod', 1, ([a]) => ` (mod ${a})`);
  t = replaceCommand(t, 'pod', 1, ([a]) => ` (${a})`);
  t = replaceCommand(t, 'tag\\*?', 1, ([a]) => `\\quad (${a})`);
  t = replaceCommand(t, 'eqref', 1, ([a]) => `(${a})`);
  t = replaceCommand(t, 'ref|cite', 1, ([a]) => `[${a}]`);
  t = replaceCommand(t, 'footnote', 1, ([a]) => ` (${a})`);
  t = replaceCommand(t, 'url', 1, ([a]) => a);
  t = replaceCommand(t, 'href', 2, ([, a]) => a);
  t = replaceCommand(t, 'hspace\\*?', 1, () => ' ');
  t = replaceCommand(t, 'vspace\\*?|label|phantom|hphantom|vphantom|index', 1, () => '');
  t = replaceCommand(t, 'stackrel|overset', 2, ([top, base]) => `${base}^{${top}}`);
  t = replaceCommand(t, 'underset', 2, ([bottom, base]) => `${base}_{${bottom}}`);

  t = t.replace(/\\([A-Za-z]+)(?![A-Za-z])/g, (m, name: string) => (name in EXTRA_SYMBOLS ? EXTRA_SYMBOLS[name] : m));
  return t;
}

const CELL_SPLIT_GLOBAL = /(?<!\\)&/g;

/* ------------------------------------------------------------------ */
/* Markdown                                                            */
/* ------------------------------------------------------------------ */

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const LIST_LINE = /^\s*([-*+•]|\d+[.)])\s+/;
const HTML_TAGS =
  'b|strong|i|em|u|s|strike|del|ins|mark|small|big|span|div|p|font|code|kbd|samp|var|details|summary|center|a|img|ul|ol|li|h[1-6]|table|thead|tbody|tfoot|tr|td|th|blockquote|pre|abbr|cite|q|section|article|header|footer|figure|figcaption|label';

function splitTableRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", mdash: '—', ndash: '–',
    hellip: '...', times: '×', divide: '÷', deg: '°', plusmn: '±', le: '≤', ge: '≥', ne: '≠',
    rarr: '→', larr: '←', harr: '↔', rArr: '⇒', lArr: '⇐', hArr: '⇔', middot: '·', bull: '•',
    copy: '©', reg: '®', trade: '™', micro: 'µ', para: '¶', sect: '§', infin: '∞', asymp: '≈',
    minus: '−', sup2: '²', sup3: '³', frac12: '½', frac14: '¼', frac34: '¾', pi: 'π',
  };
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-zA-Z0-9]+);/g, (m, name: string) => named[name] ?? m);
}

function inlineMarkdown(line: string, latex: boolean): string {
  let s = line;
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<sup>([\s\S]*?)<\/sup>/gi, (_, x: string) => (latex ? `^{${x}}` : x));
  s = s.replace(/<sub>([\s\S]*?)<\/sub>/gi, (_, x: string) => (latex ? `_{${x}}` : x));
  s = s.replace(/<(?:b|strong)>([\s\S]*?)<\/(?:b|strong)>/gi, '**$1**');
  s = s.replace(new RegExp(`</?(?:${HTML_TAGS})(?:\\s[^<>]*)?/?>`, 'gi'), '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = decodeEntities(s);

  s = s.replace(/!\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g, '');
  s = s.replace(/\[\^([^\]]+)\]/g, (_, n: string) => (latex ? `^{${n}}` : ''));
  s = s.replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
  s = s.replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/g, '$1');

  s = s.replace(/\*\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*\*/g, '**$1**');
  s = s.replace(/___(?=\S)([^_\n]+?)(?<=\S)___/g, '**$1**');
  s = s.replace(/~~(?=\S)([^~\n]+?)(?<=\S)~~/g, '$1');
  s = s.replace(/==(?=\S)([^=\n]+?)(?<=\S)==/g, '$1');
  s = s.replace(/(^|[\s(\["'])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?=[\s).,;:!?'"\]]|$)/g, '$1$2');
  s = s.replace(/(^|[\s(\["'])_(?=[^\s_])([^_\n]*?[^\s_])_(?=[\s).,;:!?'"\]]|$)/g, '$1$2');
  s = s.replace(/\\([*_~`#>|!\-+.])/g, (m, ch: string) => (latex && (ch === '_' || ch === '#') ? m : ch));
  return s;
}

function normalizeMarkdown(text: string, latex: boolean): string {
  const lines = text.split('\n');
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1])) {
      const rows: string[][] = [splitTableRow(line)];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      i--;
      if (out.length && out[out.length - 1].trim()) out.push('');
      rows.forEach((cells, r) => {
        const row = cells.map((c) => inlineMarkdown(c, latex)).join('  |  ');
        out.push(r === 0 ? `**${row.replace(/\*\*/g, '')}**` : row);
      });
      out.push('');
      continue;
    }

    const next = lines[i + 1];
    const prevBlank = !line.trim();
    if (!prevBlank && next !== undefined && !LIST_LINE.test(line) && !line.includes('|')) {
      if (/^\s*=+\s*$/.test(next)) {
        out.push(`# ${inlineMarkdown(line.trim(), latex)}`);
        i++;
        continue;
      }
      if (/^\s*-{2,}\s*$/.test(next) && !/^\s*#/.test(line)) {
        out.push(`## ${inlineMarkdown(line.trim(), latex)}`);
        i++;
        continue;
      }
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('');
      continue;
    }

    line = line.replace(/^\s*(?:>\s?)+/, '');

    const footnote = /^\s*\[\^([^\]]+)\]:\s*(.*)$/.exec(line);
    if (footnote) {
      out.push(`${latex ? `^{${footnote[1]}}` : `${footnote[1]}.`} ${inlineMarkdown(footnote[2], latex)}`);
      continue;
    }
    if (/^\s*\[[^\]]+\]:\s*\S+/.test(line)) continue;

    line = line.replace(/^(\s*)[-*+]\s+\[( |x|X)\]\s+/, (_, ws: string, mark: string) => `${ws}${mark === ' ' ? '☐' : '☑'} `);
    line = line.replace(/^(\s*)[*+•●▪◦‣∙]\s+/, '$1- ');

    const heading = /^(\s*)(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      out.push(`${heading[2]} ${inlineMarkdown(heading[3], latex)}`);
      continue;
    }
    if (/^\s*#[^\s#]/.test(line)) line = INERT + line;

    out.push(inlineMarkdown(line, latex));
  }

  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* Unicode cleanup                                                     */
/* ------------------------------------------------------------------ */

function cleanUnicode(text: string): string {
  return text
    .replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"')
    .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'")
    .replace(/\u2026/g, '...')
    .replace(/[\u2705\u2714\u2611]\ufe0f?/g, '✓')
    .replace(/[\u274c\u2716\u274e]\ufe0f?/g, '✗')
    .replace(/\u27a1\ufe0f?/g, '→')
    .replace(/\u2b05\ufe0f?/g, '←')
    .replace(/\u200d(?=[\u{1f000}-\u{1faff}\u2600-\u27bf])/gu, '')
    .replace(/[ \t]?[\u{1f000}-\u{1faff}][\u{1f3fb}-\u{1f3ff}]?(?=[ \t]*$)/gmu, '')
    .replace(/[\u{1f000}-\u{1faff}][\u{1f3fb}-\u{1f3ff}]?[ \t]?/gu, '')
    .replace(/[ \t]?[\u2728\u2b50\u26a1\u26a0\u2757\u2753\u2755\u2754\u203c\u2049\u23f0\u231b\u23f3](?=[ \t]*$)/gm, '')
    .replace(/[\u2728\u2b50\u26a1\u26a0\u2757\u2753\u2755\u2754\u203c\u2049\u23f0\u231b\u23f3][ \t]?/g, '')
    .replace(/[\ufe0f\u20e3]/g, '');
}
