/**
 * Markdown, rendered to HTML without ever passing raw HTML through.
 *
 * Everything a person or an agent writes on this board is Markdown: job
 * descriptions, employer profiles, cover letters and whole resumes. One
 * renderer serves all of them, so a table in a resume and a table in a job
 * description behave the same, and neither can introduce a tag.
 *
 * The grammar is CommonMark's common subset plus GitHub tables and
 * strikethrough. It is not a complete CommonMark implementation and does not
 * try to be: the constructs left out are either unsafe here (raw HTML) or
 * unused by the documents this board actually stores.
 */

import { escapeHtml, safeUrl } from './escape.ts';

export interface MarkdownOptions {
  /**
   * Added to every heading level, so a document embedded in a page whose h1
   * is the job title does not emit a second h1.
   */
  headingOffset?: number;
  /** Rendered as links but never as images. Resumes are read by strangers. */
  noImages?: boolean;
  /** Appended to every link. */
  linkRel?: string;
}

const DEFAULT_REL = 'nofollow ugc noopener noreferrer';

export function renderMarkdown(source: string, options: MarkdownOptions = {}): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    // Fenced code, taken first so nothing inside a fence is parsed as markup.
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/.exec(line);
    if (fence !== null) {
      const marker = (fence[1] ?? '```').startsWith('`') ? '`{3,}' : '~{3,}';
      const language = fence[2] ?? '';
      const closing = new RegExp(`^\\s{0,3}${marker}\\s*$`);
      const body: string[] = [];
      index += 1;
      while (index < lines.length) {
        const current = lines[index] ?? '';
        if (closing.test(current)) {
          index += 1;
          break;
        }
        body.push(current);
        index += 1;
      }
      const className = language === '' ? '' : ` class="language-${escapeHtml(language)}"`;
      out.push(`<pre><code${className}>${escapeHtml(body.join('\n'))}\n</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      const raw = (heading[1] ?? '#').length + (options.headingOffset ?? 0);
      const level = Math.min(6, Math.max(1, raw));
      out.push(`<h${level}>${renderInline(heading[2] ?? '', options)}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(line)) {
      out.push('<hr />');
      index += 1;
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index] ?? '')) {
        body.push((lines[index] ?? '').replace(/^\s{0,3}>\s?/, ''));
        index += 1;
      }
      // Recursing means a quote can hold a list or a code block, which is what
      // people actually paste into one.
      out.push(`<blockquote>${renderMarkdown(body.join('\n'), options)}</blockquote>`);
      continue;
    }

    const table = tryTable(lines, index, options);
    if (table !== null) {
      out.push(table.html);
      index = table.next;
      continue;
    }

    const list = tryList(lines, index, options);
    if (list !== null) {
      out.push(list.html);
      index = list.next;
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      // Block probes also match syntax the individual parsers may not accept,
      // such as a fence with extra info. Consume it as text when no parser took
      // this line; stopping an empty paragraph would retry it forever.
      if (current.trim() === '' || (paragraph.length > 0 && startsBlock(current))) break;
      paragraph.push(current);
      index += 1;
    }
    if (paragraph.length > 0) {
      // A single newline inside a paragraph becomes a break. GitHub does this,
      // and every resume in the wild is written assuming it.
      out.push(`<p>${paragraph.map((text) => renderInline(text, options)).join('<br />')}</p>`);
    }
  }

  return out.join('\n');
}

function startsBlock(line: string): boolean {
  return (
    /^\s{0,3}(`{3,}|~{3,})/.test(line) ||
    /^#{1,6}\s/.test(line) ||
    /^\s{0,3}>/.test(line) ||
    /^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(line) ||
    /^\s{0,3}([-*+]|\d{1,9}[.)])\s+/.test(line)
  );
}

interface Block {
  html: string;
  next: number;
}

/** GitHub-style tables. Resumes and compensation bands both use them. */
function tryTable(lines: string[], start: number, options: MarkdownOptions): Block | null {
  const header = lines[start] ?? '';
  const divider = lines[start + 1] ?? '';
  if (!header.includes('|')) return null;
  if (!/^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(divider)) return null;

  const aligns = splitRow(divider).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return ' style="text-align:center"';
    if (right) return ' style="text-align:right"';
    return '';
  });

  const head = splitRow(header);
  const rows: string[][] = [];
  let index = start + 2;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim() === '' || !line.includes('|')) break;
    rows.push(splitRow(line));
    index += 1;
  }

  const th = head
    .map((cell, column) => `<th${aligns[column] ?? ''}>${renderInline(cell, options)}</th>`)
    .join('');
  const tbody = rows
    .map((row) => {
      const cells = head
        .map(
          (_, column) =>
            `<td${aligns[column] ?? ''}>${renderInline(row[column] ?? '', options)}</td>`,
        )
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');

  // Wrapped so a wide table scrolls inside itself instead of making the whole
  // page scroll sideways on a phone.
  return {
    html: `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tbody}</tbody></table></div>`,
    next: index,
  };
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function tryList(lines: string[], start: number, options: MarkdownOptions): Block | null {
  const first = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(lines[start] ?? '');
  if (first === null) return null;

  const ordered = /\d/.test(first[2] ?? '');
  const indent = (first[1] ?? '').length;
  const items: string[][] = [];
  let index = start;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const match = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);

    if (match !== null && (match[1] ?? '').length <= indent) {
      // A different marker type at the same level starts a new list rather
      // than silently continuing this one.
      if (/\d/.test(match[2] ?? '') !== ordered) break;
      items.push([match[3] ?? '']);
      index += 1;
      continue;
    }

    const current = items[items.length - 1];
    if (current === undefined) break;
    // A deeper marker, or a plain continuation line, belongs to the item above.
    if (match !== null || /^\s+\S/.test(line)) {
      const strip = Math.min(line.length - line.trimStart().length, indent + 2);
      current.push(line.slice(strip));
      index += 1;
      continue;
    }
    break;
  }

  if (items.length === 0) return null;

  const rendered = items
    .map((item) => {
      const body = item.join('\n');
      // A one-line item stays inline, so a bullet list does not gain a
      // paragraph's worth of vertical space per bullet.
      const inner =
        item.length === 1
          ? renderInline(body, options)
          : renderMarkdown(body, options).replace(/^<p>([\s\S]*)<\/p>$/, '$1');
      return `<li>${inner}</li>`;
    })
    .join('');

  const tag = ordered ? 'ol' : 'ul';
  return { html: `<${tag}>${rendered}</${tag}>`, next: index };
}

/** A sentinel that cannot survive escapeHtml, so it cannot be forged in input. */
const MARK = String.fromCharCode(0);

/**
 * Inline markup.
 *
 * Code spans are pulled out first and put back last, so a backticked
 * `**not bold**` stays literal and an asterisk inside code cannot open
 * emphasis that then runs off through the rest of the paragraph.
 */
export function renderInline(source: string, options: MarkdownOptions = {}): string {
  const codes: string[] = [];
  const rel = options.linkRel ?? DEFAULT_REL;

  let text = source.replace(/(`+)([\s\S]*?)\1/g, (_whole, _ticks: string, body: string) => {
    codes.push(`<code>${escapeHtml(body.trim())}</code>`);
    return `${MARK}${codes.length - 1}${MARK}`;
  });

  text = escapeHtml(text);

  // Images before links: the syntax differs only by the leading character.
  text = text.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (whole, alt: string, href: string) => {
      const url = safeUrl(unescapeUrl(href));
      if (url === null) return whole;
      if (options.noImages === true) {
        return `<a href="${escapeHtml(url)}" rel="${rel}">${alt === '' ? escapeHtml(url) : alt}</a>`;
      }
      return `<img src="${escapeHtml(url)}" alt="${alt}" loading="lazy" />`;
    },
  );

  text = text.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (whole, label: string, href: string) => {
      const url = safeUrl(unescapeUrl(href));
      if (url === null) return whole;
      return `<a href="${escapeHtml(url)}" rel="${rel}">${label}</a>`;
    },
  );

  // Bare URLs. Trailing punctuation is left outside the link, because a URL at
  // the end of a sentence is the common case and the full stop is not part of
  // it.
  text = text.replace(/(^|[\s(])(https?:\/\/[^\s<>"']+)/g, (_whole, lead: string, href: string) => {
    const trimmed = href.replace(/[.,;:!?)]+$/, '');
    const tail = href.slice(trimmed.length);
    const url = safeUrl(trimmed);
    if (url === null) return `${lead}${href}`;
    return `${lead}<a href="${escapeHtml(url)}" rel="${rel}">${escapeHtml(trimmed)}</a>${tail}`;
  });

  text = text
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w_])__([^_\n]+)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/(^|[^\w_])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  return text.replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (_whole, id: string) => {
    return codes[Number(id)] ?? '';
  });
}

/** Only `\(` and `\)` matter inside a link target. */
function unescapeUrl(href: string): string {
  return href.replace(/\\([()])/g, '$1');
}

/** Plain text, for meta descriptions, feeds, the TUI and search snippets. */
export function toPlainText(source: string, limit = 300): string {
  const text = source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~`|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).replace(/\s+\S*$/, '')}...`;
}
