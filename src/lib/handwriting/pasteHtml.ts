/**
 * Converts rich clipboard HTML (ChatGPT, Claude, Gemini, Wikipedia, Docs…)
 * back into markdown + LaTeX source. Rendered KaTeX/MathJax otherwise pastes
 * as garbled duplicated text such as "x2x^2x2".
 */

const RICH_HINT = /class="[^"]*(katex|MathJax|mjx)|<math[\s>]|<mjx-|<h[1-6][\s>]|<li[\s>]|<table[\s>]|<pre[\s>]|<blockquote[\s>]|<strong[\s>]|<b[\s>]/i;
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'BUTTON', 'SVG', 'NOSCRIPT', 'TEMPLATE', 'IMG', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME', 'META', 'LINK', 'TITLE', 'HEAD']);
const BLOCK_TAGS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'FIGURE', 'FIGCAPTION', 'DETAILS', 'SUMMARY', 'DL', 'DT', 'DD', 'ADDRESS', 'CENTER']);

export function shouldConvertHtml(html: string): boolean {
  return RICH_HINT.test(html);
}

function texOf(el: Element): string | null {
  const annotation = el.querySelector('annotation[encoding="application/x-tex"], annotation[encoding="TeX"]');
  if (annotation?.textContent) return annotation.textContent.trim();
  const script = el.querySelector('script[type^="math/tex"]');
  if (script?.textContent) return script.textContent.trim();
  const alt = el.getAttribute('data-tex') ?? el.getAttribute('alttext') ?? el.querySelector('[alttext]')?.getAttribute('alttext');
  return alt?.trim() || null;
}

function isMathElement(el: Element): boolean {
  const cls = typeof el.className === 'string' ? el.className : '';
  return (
    /(^|\s)(katex|katex-display|MathJax|MathJax_Display|MathJax_Preview|math-inline|math-display)(\s|$)/.test(cls) ||
    el.tagName === 'MJX-CONTAINER' ||
    el.tagName.toLowerCase() === 'math'
  );
}

function isDisplayMath(el: Element): boolean {
  const cls = typeof el.className === 'string' ? el.className : '';
  return (
    /katex-display|MathJax_Display|math-display/.test(cls) ||
    el.getAttribute('display') === 'block' ||
    el.getAttribute('display') === 'true' ||
    el.querySelector('math[display="block"]') !== null
  );
}

interface Ctx {
  latex: boolean;
  listDepth: number;
}

export function htmlToAssignmentText(html: string, opts: { latex: boolean }): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const ctx: Ctx = { latex: opts.latex, listDepth: 0 };
  const raw = walkChildren(doc.body, ctx);
  return raw
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n (?=\S)/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function walkChildren(node: Node, ctx: Ctx): string {
  let out = '';
  node.childNodes.forEach((child) => {
    out += walk(child, ctx);
  });
  return out;
}

const block = (s: string) => `\n\n${s.trim()}\n\n`;

function walk(node: Node, ctx: Ctx): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').replace(/\s+/g, ' ');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;
  const tag = el.tagName.toUpperCase();
  if (SKIP_TAGS.has(tag) || el.getAttribute('aria-hidden') === 'true' && !isMathElement(el)) return '';

  if (isMathElement(el)) {
    const display = isDisplayMath(el);
    const tex = ctx.latex ? texOf(el) : null;
    if (tex) return display ? `\n\n\\[${tex}\\]\n\n` : `\\(${tex}\\)`;
    const mathml = el.querySelector('.katex-mathml math, math') ?? el;
    const plain = (mathml.textContent ?? '').replace(/\s+/g, ' ').trim();
    return display ? block(plain) : plain;
  }

  switch (tag) {
    case 'BR':
      return '\n';
    case 'HR':
      return '\n\n---\n\n';
    case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
      const text = walkChildren(el, ctx).replace(/\s*\n\s*/g, ' ').replace(/\*\*/g, '').trim();
      return text ? block(`${'#'.repeat(Number(tag[1]))} ${text}`) : '';
    }
    case 'STRONG': case 'B': {
      const inner = walkChildren(el, ctx);
      const text = inner.trim();
      if (!text || text.includes('\n')) return inner;
      const lead = inner.match(/^\s*/)?.[0] ?? '';
      const trail = inner.match(/\s*$/)?.[0] ?? '';
      return `${lead}**${text.replace(/\*\*/g, '')}**${trail}`;
    }
    case 'SUP':
      return ctx.latex ? `^{${walkChildren(el, ctx).trim()}}` : walkChildren(el, ctx);
    case 'SUB':
      return ctx.latex ? `_{${walkChildren(el, ctx).trim()}}` : walkChildren(el, ctx);
    case 'CODE':
      if (el.closest('pre')) return el.textContent ?? '';
      return `\`${(el.textContent ?? '').replace(/`/g, "'")}\``;
    case 'PRE': {
      const code = (el.querySelector('code') ?? el).textContent ?? '';
      return `\n\n\`\`\`\n${code.replace(/\n+$/, '')}\n\`\`\`\n\n`;
    }
    case 'BLOCKQUOTE': {
      const inner = walkChildren(el, ctx).trim();
      return block(inner.split('\n').map((l) => (l.trim() ? `> ${l}` : '>')).join('\n'));
    }
    case 'UL': case 'OL':
      return listToText(el, ctx);
    case 'TABLE':
      return tableToText(el, ctx);
    default:
      if (BLOCK_TAGS.has(tag)) return block(walkChildren(el, ctx));
      return walkChildren(el, ctx);
  }
}

function listToText(list: Element, ctx: Ctx): string {
  const ordered = list.tagName.toUpperCase() === 'OL';
  let n = Number(list.getAttribute('start')) || 1;
  const indent = '    '.repeat(ctx.listDepth);
  const lines: string[] = [];
  ctx.listDepth++;
  for (const li of Array.from(list.children)) {
    if (li.tagName.toUpperCase() !== 'LI') continue;
    const marker = ordered ? `${n++}. ` : '- ';
    const body = walkChildren(li, ctx)
      .replace(/\n{2,}/g, '\n')
      .trim()
      .split('\n');
    const [first, ...rest] = body;
    lines.push(indent + marker + (first ?? '').trim());
    for (const line of rest) {
      if (!line.trim()) continue;
      lines.push(/^\s{4,}/.test(line) || /^\s*([-*]|\d+\.)\s/.test(line) && line.startsWith(' ') ? line : `${indent}    ${line.trim()}`);
    }
  }
  ctx.listDepth--;
  const text = lines.join('\n');
  return ctx.listDepth === 0 ? block(text) : `\n${text}\n`;
}

function tableToText(table: Element, ctx: Ctx): string {
  const rows = Array.from(table.querySelectorAll('tr'))
    .filter((tr) => tr.closest('table') === table)
    .map((tr) =>
      Array.from(tr.children)
        .filter((c) => /^T[DH]$/i.test(c.tagName))
        .map((c) => walkChildren(c, ctx).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim()),
    )
    .filter((cells) => cells.length);
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  const out = [line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)];
  return block(out.join('\n'));
}
