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
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+#-]*)\s*$/.exec(line);
    if (fence !== null) {
      // The closing fence needs the same character and at least the opening
      // length, or a shorter fence inside the content would end the block
      // early — CommonMark's rule, and the reason four backticks exist.
      const opening = fence[1] ?? '```';
      const marker = opening.startsWith('`') ? '`' : '~';
      const language = fence[2] ?? '';
      const closing = new RegExp(`^\\s{0,3}${marker}{${opening.length},}\\s*$`);
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

    // Closing hashes require a preceding space or tab; the hash in C# is text.
    const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)[ \t]*(?:(?<=[ \t])#+)?[ \t]*)?$/.exec(line);
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
    /^ {0,3}#{1,6}(?:[ \t]|$)/.test(line) ||
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
  // GFM requires the header and delimiter rows to have the same number of
  // cells. A mismatch is ordinary text, rather than a table.
  if (head.length !== aligns.length) return null;
  const rows: string[][] = [];
  let index = start + 2;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim() === '' || !line.includes('|') || startsBlock(line)) break;
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
  const trimmed = line.trim();
  const cells: string[] = [];
  let cell = '';
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index] ?? '';
    if (character !== '|') {
      cell += character;
      continue;
    }
    if (index > 0 && trimmed[index - 1] === '\\') {
      cell = cell.slice(0, -1) + '|';
      continue;
    }
    cells.push(cell.trim());
    cell = '';
  }
  cells.push(cell.trim());
  if (trimmed.startsWith('|')) cells.shift();
  if (trimmed.endsWith('|') && trimmed[trimmed.length - 2] !== '\\') cells.pop();
  return cells;
}

function tryList(lines: string[], start: number, options: MarkdownOptions): Block | null {
  const first = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(lines[start] ?? '');
  if (first === null) return null;

  const firstMarker = first[2] ?? '';
  const ordered = /\d/.test(firstMarker);
  const orderedStart = ordered ? Number.parseInt(firstMarker, 10) : 1;
  const indent = (first[1] ?? '').length;
  const items: string[][] = [];
  let contentIndent = indent + 2;
  let index = start;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const match = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);

    if (match !== null && (match[1] ?? '').length <= indent) {
      // A different marker type at the same level starts a new list rather
      // than silently continuing this one.
      if (/\d/.test(match[2] ?? '') !== ordered) break;
      const content = match[3] ?? '';
      // Each item may have a different marker width (for example 9. then 10.)
      // or padding. Remove exactly that prefix from its continuation lines.
      contentIndent = line.length - content.length;
      items.push([content]);
      index += 1;
      continue;
    }

    const current = items[items.length - 1];
    if (current === undefined) break;
    if (line.trim() === '') {
      // A blank run continues the item only when followed by indented content.
      // Keep it in the item so fenced code does not end at its first blank line.
      let next = index + 1;
      while (next < lines.length && (lines[next] ?? '').trim() === '') next += 1;
      const following = lines[next] ?? '';
      if (
        next === lines.length ||
        following.length - following.trimStart().length < contentIndent
      ) {
        break;
      }
      while (index < next) {
        current.push((lines[index] ?? '').slice(contentIndent));
        index += 1;
      }
      continue;
    }
    // A deeper marker, or a plain continuation line, belongs to the item above.
    if (match !== null || /^\s+\S/.test(line)) {
      const strip = Math.min(line.length - line.trimStart().length, contentIndent);
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
      let inner = item.length === 1 ? renderInline(body, options) : renderMarkdown(body, options);
      // Unwrap only a single paragraph. A multi-block item can start and end
      // with different paragraphs; removing those outer tags leaves both incomplete.
      if (
        item.length > 1 &&
        inner.startsWith('<p>') &&
        inner.indexOf('</p>') === inner.length - 4
      ) {
        inner = inner.slice(3, -4);
      }
      return `<li>${inner}</li>`;
    })
    .join('');

  const tag = ordered ? 'ol' : 'ul';
  const startAttribute = ordered && orderedStart !== 1 ? ` start="${orderedStart}"` : '';
  return { html: `<${tag}${startAttribute}>${rendered}</${tag}>`, next: index };
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

  let text = protectCodeSpans(source, codes);

  text = escapeHtml(text);

  text = replaceInlineLinks(text, options, rel, codes);

  // Bare URLs. Trailing punctuation is left outside the link, because a URL at
  // the end of a sentence is the common case and the full stop is not part of
  // it. The character class also excludes the MARK sentinel, so a code span or
  // emitted link sitting at the end of a URL is not swallowed into the href.
  text = text.replace(
    /(^|[\s(])(https?:\/\/[^\s<>"'\x00]+)/g,
    (_whole, lead: string, href: string) => {
      // The match ran on escaped text, so decode before trimming: an entity's
      // own `;` would otherwise count as trailing punctuation and corrupt it.
      const decoded = unescapeUrl(href);
      const trimmed = trimBareUrl(decoded);
      const tail = decoded.slice(trimmed.length);
      const url = safeUrl(trimmed);
      if (url === null) return `${lead}${href}`;
      // Emitted like code spans are: the anchor goes behind a sentinel so the
      // emphasis pass below cannot put markup inside the tag or its label.
      codes.push(`<a href="${escapeHtml(url)}" rel="${rel}">${escapeHtml(trimmed)}</a>`);
      return `${lead}${MARK}${codes.length - 1}${MARK}${tail}`;
    },
  );

  text = emphasis(text);

  return text.replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (_whole, id: string) => {
    return codes[Number(id)] ?? '';
  });
}

/**
 * Emphasis, strikethrough and strong, in one place so a link label can be
 * given the same treatment the rest of the line gets.
 */
function emphasis(text: string): string {
  return text
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w_])__([^_\n]+)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/(^|[^\w_])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
}

/**
 * An image description is plain text (CommonMark renders `![*x*]` as alt="x"),
 * never markup: tags inside an attribute are not emphasis, they are broken
 * HTML. Code spans read as their text.
 */
function plainTextLabel(label: string, codes: string[]): string {
  const resolved = label.replace(
    new RegExp(`${MARK}(\\d+)${MARK}`, 'g'),
    (_whole, id: string) => (codes[Number(id)] ?? '').replace(/<\/?code>/g, ''),
  );
  return emphasis(resolved).replace(/<\/?(?:em|strong|del)>/g, '');
}

/** Keep balanced URL parentheses; only surrounding prose belongs outside the link. */
function trimBareUrl(url: string): string {
  let excessClosers = 0;
  for (const character of url) {
    if (character === ')') excessClosers += 1;
    else if (character === '(') excessClosers -= 1;
  }
  let end = url.length;
  while (end > 0) {
    const last = url[end - 1] ?? '';
    if (/[.,;:!?]/.test(last)) {
      end -= 1;
    } else if (last === ')' && excessClosers > 0) {
      end -= 1;
      excessClosers -= 1;
    } else {
      break;
    }
  }
  return url.slice(0, end);
}

function replaceInlineLinks(
  text: string,
  options: MarkdownOptions,
  rel: string,
  codes: string[],
): string {
  let result = '';
  let cursor = 0;
  for (let index = 0; index < text.length; index += 1) {
    const image = text.startsWith('![', index);
    const link = text[index] === '[';
    if (!image && !link) continue;
    const labelStart = image ? index + 2 : index + 1;
    const labelEnd = text.indexOf(']', labelStart);
    if (labelEnd < labelStart || text[labelEnd + 1] !== '(') continue;
    if (!image && labelEnd === labelStart) continue;
    const parsed = parseLinkDestination(text, labelEnd + 1);
    if (parsed === null) continue;
    const label = text.slice(labelStart, labelEnd);
    const url = safeUrl(unescapeUrl(parsed.href));
    if (url === null) continue;
    result += text.slice(cursor, index);
    // Emitted markup goes behind a sentinel, like a code span: the bare-URL
    // and emphasis passes run after this one, and a match inside the tag, the
    // label or the alt text would nest anchors or corrupt the attribute.
    if (image) {
      codes.push(
        options.noImages === true
          ? `<a href="${escapeHtml(url)}" rel="${rel}">${label === '' ? escapeHtml(url) : emphasis(label)}</a>`
          : `<img src="${escapeHtml(url)}" alt="${plainTextLabel(label, codes)}" loading="lazy" />`,
      );
    } else {
      codes.push(`<a href="${escapeHtml(url)}" rel="${rel}">${emphasis(label)}</a>`);
    }
    result += `${MARK}${codes.length - 1}${MARK}`;
    cursor = parsed.end + 1;
    index = parsed.end;
  }
  return result + text.slice(cursor);
}

interface ParsedLinkDestination {
  href: string;
  end: number;
}

function parseLinkDestination(text: string, open: number): ParsedLinkDestination | null {
  let depth = 0;
  let index = open + 1;
  while (index < text.length) {
    const character = text[index] ?? '';
    if (character === '\\' && index + 1 < text.length) {
      index += 2;
      continue;
    }
    if (character === '(') {
      depth += 1;
    } else if (/\s/.test(character)) {
      if (depth !== 0) return null;
      const href = text.slice(open + 1, index);
      const titleStart = text.slice(index).search(/\S/);
      if (titleStart < 0) return null;
      const title = index + titleStart;
      if (!text.startsWith('&quot;', title)) return null;
      const titleEnd = text.indexOf('&quot;', title + 6);
      if (titleEnd < 0) return null;
      let close = titleEnd + 6;
      while (/\s/.test(text[close] ?? '')) close += 1;
      return text[close] === ')' && href !== '' ? { href, end: close } : null;
    } else if (character === ')') {
      if (depth === 0) {
        const inner = text.slice(open + 1, index);
        const match = /^(\S+?)(?:\s+&quot;[^&]*&quot;)?$/.exec(inner);
        return match === null ? null : { href: match[1] ?? '', end: index };
      }
      depth -= 1;
    }
    index += 1;
  }
  return null;
}

const HTML_UNESCAPES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
};

/**
 * Hrefs are captured after escapeHtml, so every `&` in the source arrives as
 * `&amp;`. Emitted like that it would be escaped a second time — `&amp;amp;`
 * decodes back to `&amp;`, and a query like `?a=1&b=2` reaches the server as
 * one parameter instead of two. Decode the five entities escapeHtml produces
 * in a single pass; matching `&amp;` in the alternation keeps a literal `&lt;`
 * in the source as `&lt;` rather than decoding it twice to `<`.
 */
function unescapeUrl(href: string): string {
  return href
    .replace(/\\([()])/g, '$1')
    .replace(/&(amp|lt|gt|quot|#39);/g, (whole, entity: string) => HTML_UNESCAPES[entity] ?? whole);
}

function protectCodeSpans(source: string, codes: string[]): string {
  const runs = [...source.matchAll(/`+/g)].map((match) => ({
    start: match.index,
    length: match[0].length,
    next: -1,
  }));
  // Precompute matching runs so unmatched openers do not rescan the suffix.
  const nextByLength = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i]!;
    run.next = nextByLength.get(run.length) ?? -1;
    nextByLength.set(run.length, i);
  }

  const parts: string[] = [];
  let cursor = 0;
  for (let i = 0; i < runs.length; i += 1) {
    const open = runs[i]!;
    if (open.next === -1) continue;
    const close = runs[open.next]!;
    const body = source.slice(open.start + open.length, close.start);
    codes.push(`<code>${escapeHtml(normalizeCodeSpanBody(body))}</code>`);
    parts.push(source.slice(cursor, open.start), `${MARK}${codes.length - 1}${MARK}`);
    cursor = close.start + close.length;
    i = open.next;
  }
  parts.push(source.slice(cursor));
  return parts.join('');
}

function normalizeCodeSpanBody(body: string): string {
  const normalized = body.replace(/\r\n?|\n/g, ' ');
  if (
    normalized.length >= 2 &&
    normalized.startsWith(' ') &&
    normalized.endsWith(' ') &&
    /[^ ]/.test(normalized)
  ) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

/** Plain text, for meta descriptions, feeds, the TUI and search snippets. */
export function toPlainText(source: string, limit = 300): string {
  const text = source
    .replace(
      /(`{3,}|~{3,})[^\n]*\n([\s\S]*?)(?:\n\s{0,3}(`{3,}|~{3,})\s*(?=\n|$)|$)/g,
      (whole, open: string, _body: string, close?: string) =>
        close !== undefined && close[0] === open[0] && close.length >= open.length ? ' ' : whole,
    )
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // A hash in C#, an issue number or a URL fragment is text. Only remove
    // ATX heading markers, including optional closing hashes and quoted headings.
    .replace(
      /^([ \t]{0,3}(?:>[ \t]*)*)#{1,6}(?:[ \t]+|$)(.*?)[ \t]*(?:(?<=[ \t])#+)?[ \t]*$/gm,
      '$1$2',
    )
    .replace(/[>*_~`|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const effectiveLimit = Number.isNaN(limit) ? 300 : Math.max(0, Math.floor(limit));
  if (text.length <= effectiveLimit) return text;
  if (effectiveLimit <= 3) return '.'.repeat(effectiveLimit);
  let prefix = text.slice(0, effectiveLimit - 3);
  if (/^[\uD800-\uDBFF]$/.test(prefix.slice(-1))) prefix = prefix.slice(0, -1);
  prefix = prefix.replace(/\s+\S*$/, '');
  return `${prefix}...`;
}
