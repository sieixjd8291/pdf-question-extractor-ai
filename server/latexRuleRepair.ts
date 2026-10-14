export type LatexLogError = { line: number | null; message: string; context: string[] };
export type RuleRepair = { source: string; summary: string };

const MAX_PRINT_LINE = 79;
const errorStart = /^(?:\.\/)?[^\s:]+\.(?:tex|sty|cls|ltx):(\d+): (.*)$|^! (.*)$/;

/** Parses TeX errors in both `! message` and `-file-line-error` formats, unwrapping 79-column lines. */
export function parseLatexErrors(log: string): LatexLogError[] {
  const lines = log.replace(/\r\n?/g, '\n').split('\n');
  const errors: LatexLogError[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(errorStart);
    if (!match) continue;
    let message = (match[2] ?? match[3] ?? '').trimEnd();
    let raw = lines[i];
    while (raw.length >= MAX_PRINT_LINE && i + 1 < lines.length) {
      raw = lines[++i];
      message += raw.trimEnd();
    }
    const context: string[] = [];
    let line = match[1] ? Number(match[1]) : null;
    for (let j = i + 1; j < Math.min(lines.length, i + 14); j++) {
      if (errorStart.test(lines[j])) break;
      context.push(lines[j]);
      const at = lines[j].match(/^l\.(\d+)/);
      if (at) {
        line ??= Number(at[1]);
        if (lines[j + 1] !== undefined) context.push(lines[j + 1]);
        break;
      }
    }
    if (/^Emergency stop|^==> Fatal error|^Here is how much/.test(message)) continue;
    errors.push({ line, message, context });
  }
  return errors;
}

/** Keeps the actionable parts of a long log so the first error is never cut off. */
export function condenseLatexLog(log: string, limit = 16000): string {
  const errors = parseLatexErrors(log);
  if (!errors.length) return log.slice(-limit);
  const text = errors.slice(0, 8).map(error => [
    `${error.line ? `line ${error.line}: ` : ''}${error.message}`,
    ...error.context.filter(line => !/^(?:See the |Type {2}H|Try typing|If that doesn't work|Your command was ignored|or {2}<return>|Type {2}I <command>)/.test(line)),
  ].join('\n')).join('\n\n');
  return text.slice(0, limit);
}

const COMMAND_PACKAGES: Record<string, string> = {};
const addCommands = (pkg: string, names: string) => { for (const name of names.split(' ')) COMMAND_PACKAGES[name] = pkg; };
addCommands('booktabs', 'toprule midrule bottomrule cmidrule addlinespace specialrule');
addCommands('xcolor', 'textcolor color definecolor colorbox fcolorbox colorlet pagecolor providecolor');
addCommands('colortbl', 'rowcolor cellcolor columncolor arrayrulecolor');
addCommands('graphicx', 'includegraphics rotatebox scalebox resizebox graphicspath reflectbox');
addCommands('hyperref', 'href url hypersetup autoref phantomsection nolinkurl');
addCommands('amsmath', 'text dfrac tfrac binom dbinom tbinom eqref boldsymbol xrightarrow xleftarrow overset underset operatorname DeclareMathOperator intertext numberwithin iint iiint substack genfrac cfrac lvert rvert lVert rVert implies impliedby');
addCommands('amssymb', 'mathbb checkmark therefore because square blacksquare lesssim gtrsim leqslant geqslant nexists varnothing mathfrak complement');
addCommands('siunitx', 'SI si num qty unit ang sisetup');
addCommands('mhchem', 'ce');
addCommands('multirow', 'multirow');
addCommands('array', 'arraybackslash newcolumntype');
addCommands('caption', 'captionof captionsetup');
addCommands('gensymb', 'degree celsius');
addCommands('cancel', 'cancel bcancel xcancel cancelto');
addCommands('soul', 'hl');
addCommands('ulem', 'sout uline uwave');
addCommands('makecell', 'makecell thead');
addCommands('enumitem', 'setlist');
addCommands('tcolorbox', 'tcbset newtcolorbox tcbox tcbuselibrary tcboxmath');
addCommands('tikz', 'tikz usetikzlibrary tikzset');
addCommands('mathrsfs', 'mathscr');
addCommands('bm', 'bm');
addCommands('lipsum', 'lipsum');
addCommands('setspace', 'onehalfspacing doublespacing singlespacing setstretch');
addCommands('fancyhdr', 'fancyhf fancyhead fancyfoot');
addCommands('titlesec', 'titleformat titlespacing');
addCommands('float', 'floatstyle restylefloat');
addCommands('multicol', 'columnbreak');
addCommands('xspace', 'xspace');
addCommands('pifont', 'ding');
addCommands('mathtools', 'coloneqq mathclap prescript');
addCommands('nicefrac', 'nicefrac');
addCommands('xfrac', 'sfrac');
addCommands('ragged2e', 'justifying RaggedRight Centering RaggedLeft');
addCommands('amsthm', 'theoremstyle qedhere');
addCommands('upgreek', 'upalpha upbeta upgamma updelta upmu uppi');

const ENVIRONMENT_PACKAGES: Record<string, string> = {};
const addEnvironments = (pkg: string, names: string) => { for (const name of names.split(' ')) ENVIRONMENT_PACKAGES[name] = pkg; };
addEnvironments('tabularx', 'tabularx');
addEnvironments('longtable', 'longtable');
addEnvironments('multicol', 'multicols multicols*');
addEnvironments('tikz', 'tikzpicture scope');
addEnvironments('pgfplots', 'axis');
addEnvironments('listings', 'lstlisting');
addEnvironments('amsmath', 'align align* gather gather* multline multline* split cases pmatrix bmatrix vmatrix Vmatrix matrix smallmatrix aligned gathered alignat alignat* flalign flalign* equation*');
addEnvironments('amsthm', 'proof');
addEnvironments('subcaption', 'subfigure subtable');
addEnvironments('wrapfig', 'wrapfigure wraptable');
addEnvironments('tcolorbox', 'tcolorbox');
addEnvironments('mdframed', 'mdframed');
addEnvironments('framed', 'framed shaded leftbar');
addEnvironments('pdflscape', 'landscape');
addEnvironments('setspace', 'spacing singlespace onehalfspace doublespace');
addEnvironments('adjustbox', 'adjustbox');
addEnvironments('comment', 'comment');
addEnvironments('ragged2e', 'FlushLeft FlushRight Center justify');
addEnvironments('tabu', 'tabu longtabu');

const PACKAGE_OPTIONS: Record<string, string> = { mhchem: '[version=4]', ulem: '[normalem]' };

const KNOWN_ENVIRONMENTS = [
  'document', 'itemize', 'enumerate', 'description', 'table', 'table*', 'figure', 'figure*', 'tabular', 'tabular*',
  'center', 'flushleft', 'flushright', 'equation', 'eqnarray', 'minipage', 'quote', 'quotation', 'abstract',
  'verbatim', 'array', 'thebibliography', 'titlepage', 'list', 'picture', 'displaymath', 'math', 'verse',
  ...Object.keys(ENVIRONMENT_PACKAGES),
];

const COLOR_HINTS: [RegExp, string][] = [
  [/navy/i, '1B2A4A'], [/teal/i, '0F766E'], [/cyan|aqua/i, '0E7490'], [/blue/i, '1D4ED8'], [/red|crimson|maroon/i, 'B91C1C'],
  [/green|emerald|olive/i, '15803D'], [/orange/i, 'C2410C'], [/purple|violet/i, '6D28D9'], [/gold|yellow|amber/i, 'B45309'],
  [/pink|rose/i, 'BE185D'], [/brown/i, '7C4A1E'], [/gray|grey|slate|muted/i, '4B5563'], [/black|ink|dark/i, '111827'],
  [/white|light/i, 'F3F4F6'],
];

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function preambleEnd(source: string) {
  const index = source.indexOf('\\begin{document}');
  return index >= 0 ? index : -1;
}

function packageLoaded(source: string, pkg: string) {
  const preamble = source.slice(0, Math.max(0, preambleEnd(source)));
  return new RegExp(`\\\\(?:usepackage|RequirePackage)\\s*(?:\\[[^\\]]*\\])?\\s*\\{[^}]*\\b${escapeRegExp(pkg)}\\b[^}]*\\}`).test(preamble);
}

function insertInPreamble(source: string, text: string) {
  const end = preambleEnd(source);
  if (end < 0) return null;
  return `${source.slice(0, end)}${text}\n${source.slice(end)}`;
}

function addPackage(source: string, pkg: string): RuleRepair | null {
  if (packageLoaded(source, pkg)) return null;
  const next = insertInPreamble(source, `\\usepackage${PACKAGE_OPTIONS[pkg] ?? ''}{${pkg}}`);
  return next ? { source: next, summary: `Loaded the missing \`${pkg}\` package.` } : null;
}

function editDistance(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

function declaredEnvironments(source: string) {
  const names = new Set<string>();
  for (const match of source.matchAll(/\\(?:newenvironment|renewenvironment|newtcolorbox|newtheorem|NewDocumentEnvironment|newmdenv|DeclareTColorBox)\s*\*?\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
    names.add(match[1].trim());
  }
  return names;
}

function closestEnvironment(name: string, source: string) {
  let best: { name: string; distance: number } | null = null;
  for (const candidate of [...KNOWN_ENVIRONMENTS, ...declaredEnvironments(source)]) {
    if (candidate === name) continue;
    const distance = editDistance(name, candidate);
    if (distance <= 2 && distance < name.length / 2 && (!best || distance < best.distance)) best = { name: candidate, distance };
  }
  return best?.name ?? null;
}

/** Replaces `from` with `to` on the reported line, falling back to a unique match anywhere in the source. */
function replaceNearLine(source: string, line: number | null, from: string, to: string): string | null {
  const lines = source.split('\n');
  if (line && lines[line - 1]?.includes(from)) {
    lines[line - 1] = lines[line - 1].replace(from, to);
    return lines.join('\n');
  }
  const first = source.indexOf(from);
  if (first < 0 || source.indexOf(from, first + 1) >= 0) return null;
  return source.slice(0, first) + to + source.slice(first + from.length);
}

function undefinedCommand(error: LatexLogError) {
  for (const line of error.context) {
    if (/^(?:See the |Type {2}H| \.\.\.)/.test(line) || !line.trim()) continue;
    const match = line.match(/\\([A-Za-z@]+)\s*$/);
    return match?.[1] ?? null;
  }
  return null;
}

function commandDefined(source: string, name: string) {
  const escaped = escapeRegExp(name);
  return new RegExp(`\\\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|NewDocumentCommand|DeclareMathOperator)\\s*\\*?\\s*\\{?\\\\${escaped}\\b|\\\\(?:def|gdef|edef|xdef|let)\\s*\\\\${escaped}\\b|\\\\newlength\\s*\\{?\\\\${escaped}\\b|\\\\newcounter\\s*\\{${escaped}\\}`).test(source);
}

function fixUndefinedCommand(source: string, error: LatexLogError): RuleRepair | null {
  const name = undefinedCommand(error);
  if (!name) return null;
  const pkg = COMMAND_PACKAGES[name];
  if (pkg) {
    if (pkg === 'colortbl' && !packageLoaded(source, 'xcolor') && !packageLoaded(source, 'colortbl')) {
      const next = insertInPreamble(source, '\\usepackage[table]{xcolor}');
      return next ? { source: next, summary: `Loaded \`xcolor\` with table support for \\${name}.` } : null;
    }
    return addPackage(source, pkg);
  }
  if (commandDefined(source, name)) return null;
  const next = insertInPreamble(source, `\\providecommand{\\${name}}{}`);
  return next ? { source: next, summary: `Declared the undefined command \\${name} so its text still renders.` } : null;
}

function fixUndefinedColor(source: string, name: string): RuleRepair | null {
  if (new RegExp(`\\\\(?:definecolor|colorlet|providecolor)\\s*(?:\\[[^\\]]*\\])?\\s*\\{${escapeRegExp(name)}\\}`).test(source)) return null;
  const hex = COLOR_HINTS.find(([pattern]) => pattern.test(name))?.[1] ?? '374151';
  const withXcolor = packageLoaded(source, 'xcolor') ? source : insertInPreamble(source, '\\usepackage{xcolor}');
  const next = withXcolor && insertInPreamble(withXcolor, `\\definecolor{${name}}{HTML}{${hex}}`);
  return next ? { source: next, summary: `Defined the missing color \`${name}\`.` } : null;
}

function fixMissingPackageFile(source: string, pkg: string): RuleRepair | null {
  const pattern = new RegExp(`^([ \\t]*)\\\\usepackage\\s*(\\[[^\\]]*\\])?\\s*\\{([^}]*)\\}`, 'm');
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(pattern);
    if (!match) continue;
    const names = match[3].split(',').map(name => name.trim()).filter(Boolean);
    if (!names.includes(pkg)) continue;
    const rest = names.filter(name => name !== pkg);
    lines[i] = rest.length
      ? lines[i].replace(match[0], `${match[1]}\\usepackage${match[2] ?? ''}{${rest.join(',')}}`)
      : `% ${lines[i].trim()} % unavailable on the compiler`;
    return { source: lines.join('\n'), summary: `Disabled the unavailable \`${pkg}\` package.` };
  }
  return null;
}

function fixMissingImage(source: string, file: string): RuleRepair | null {
  const base = file.replace(/\.(?:png|jpe?g|pdf|eps)$/i, '');
  const pattern = new RegExp(`\\\\includegraphics\\s*(?:\\[[^\\]]*\\])?\\s*\\{\\s*${escapeRegExp(base)}(?:\\.(?:png|jpe?g|pdf|eps))?\\s*\\}`, 'g');
  if (!pattern.test(source)) return null;
  return {
    source: source.replace(pattern, `\\fbox{\\texttt{\\detokenize{Image not found: ${file}}}}`),
    summary: `Replaced the missing image \`${file}\` with a labeled placeholder.`,
  };
}

const UNICODE_REPLACEMENTS: Record<string, string> = {
  '2212': '\\ensuremath{-}', '2248': '\\ensuremath{\\approx}', '2264': '\\ensuremath{\\leq}', '2265': '\\ensuremath{\\geq}',
  '00D7': '\\ensuremath{\\times}', '00F7': '\\ensuremath{\\div}', '2192': '\\ensuremath{\\rightarrow}', '2190': '\\ensuremath{\\leftarrow}',
  '2194': '\\ensuremath{\\leftrightarrow}', '21CC': '\\ensuremath{\\rightleftharpoons}', '00B0': '\\ensuremath{^\\circ}', '00B1': '\\ensuremath{\\pm}',
  '2260': '\\ensuremath{\\neq}', '221E': '\\ensuremath{\\infty}', '2022': '\\textbullet{}', '2026': '\\ldots{}', '2013': '--', '2014': '---',
  '03B1': '\\ensuremath{\\alpha}', '03B2': '\\ensuremath{\\beta}', '03B3': '\\ensuremath{\\gamma}', '03B4': '\\ensuremath{\\delta}',
  '0394': '\\ensuremath{\\Delta}', '03BC': '\\ensuremath{\\mu}', '03C0': '\\ensuremath{\\pi}', '03BB': '\\ensuremath{\\lambda}',
  '03B8': '\\ensuremath{\\theta}', '03C3': '\\ensuremath{\\sigma}', '03C9': '\\ensuremath{\\omega}', '03A9': '\\ensuremath{\\Omega}',
  '2082': '\\ensuremath{_2}', '2083': '\\ensuremath{_3}', '00B2': '\\ensuremath{^2}', '00B3': '\\ensuremath{^3}', '2032': '\\ensuremath{\'}',
};

function fixUnicode(source: string, code: string): RuleRepair | null {
  const hex = code.toUpperCase().padStart(4, '0');
  if (source.includes(`\\DeclareUnicodeCharacter{${hex}}`)) return null;
  const next = insertInPreamble(source, `\\DeclareUnicodeCharacter{${hex}}{${UNICODE_REPLACEMENTS[hex] ?? '?'}}`);
  return next ? { source: next, summary: `Declared the unsupported Unicode character U+${hex}.` } : null;
}

function fixListOptions(source: string): RuleRepair | null {
  if (!/\\begin\{(?:itemize|enumerate|description)\}\s*\[/.test(source)) return null;
  return addPackage(source, 'enumitem');
}

/** Applies every rule-based fix for the log in one pass. Bottom-most errors are fixed first so line numbers stay valid. */
export function ruleBasedLatexRepairAll(source: string, log: string): RuleRepair | null {
  const errors = parseLatexErrors(log)
    .map((error, index) => ({ error, index }))
    .sort((a, b) => (b.error.line ?? -1) - (a.error.line ?? -1) || a.index - b.index);
  let current = source;
  const summaries: string[] = [];
  for (const { error } of errors) {
    const fix = ruleFixForError(current, error);
    if (!fix || fix.source.length > 500000) continue;
    current = fix.source;
    if (!summaries.includes(fix.summary)) summaries.push(fix.summary);
  }
  return current !== source ? { source: current, summary: summaries.join(' ') } : null;
}

function ruleFixForError(source: string, error: ReturnType<typeof parseLatexErrors>[number]): RuleRepair | null {
  {
    const { message, line } = error;
    let match: RegExpMatchArray | null;
    let fix: RuleRepair | null = null;
    if (/Undefined control sequence/.test(message)) fix = fixUndefinedCommand(source, error);
    else if ((match = message.match(/Undefined color [`'"]([^'"`]+)['"`]/))) fix = fixUndefinedColor(source, match[1]);
    else if ((match = message.match(/Environment (\S+) undefined/))) {
      const env = match[1];
      const pkg = ENVIRONMENT_PACKAGES[env];
      if (pkg) fix = addPackage(source, pkg);
      if (!fix) {
        const closest = closestEnvironment(env, source);
        const beginFix = closest && replaceNearLine(source, line, `\\begin{${env}}`, `\\begin{${closest}}`);
        const next = beginFix && (replaceNearLine(beginFix, null, `\\end{${env}}`, `\\end{${closest}}`) ?? beginFix);
        if (next) fix = { source: next, summary: `Corrected the misspelled environment \`${env}\` to \`${closest}\`.` };
      }
      if (!fix && !pkg && !declaredEnvironments(source).has(env) && /^[A-Za-z@*]+$/.test(env)) {
        const next = insertInPreamble(source, `\\newenvironment{${env}}{}{}`);
        if (next) fix = { source: next, summary: `Declared the undefined environment \`${env}\` so its content still renders.` };
      }
    } else if ((match = message.match(/\\begin\{([^}]+)\} on input line \d+ ended by \\end\{([^}]+)\}/))) {
      const [, opened, closed] = match;
      if (editDistance(opened, closed) <= 2) {
        const next = replaceNearLine(source, line, `\\end{${closed}}`, `\\end{${opened}}`);
        if (next) fix = { source: next, summary: `Corrected \\end{${closed}} to \\end{${opened}}.` };
      }
    } else if ((match = message.match(/File [`'"]([^'"`]+)\.sty['"`] not found/))) fix = fixMissingPackageFile(source, match[1]);
    else if ((match = message.match(/File [`'"]([^'"`]+\.(?:png|jpe?g|pdf|eps))['"`] not found/i))) fix = fixMissingImage(source, match[1]);
    else if ((match = message.match(/Unicode character .*\(U\+([0-9A-Fa-f]{2,6})\)/))) fix = fixUnicode(source, match[1]);
    else if (/Unknown float option [`'"]H['"`]/.test(message)) fix = addPackage(source, 'float');
    else if (/Something's wrong--perhaps a missing \\item/.test(message)) fix = fixListOptions(source);
    if (fix && fix.source !== source) return fix;
    return null;
  }
}
