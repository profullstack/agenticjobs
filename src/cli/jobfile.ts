/**
 * A job as a file.
 *
 * Front matter for the structured fields, Markdown below it for the
 * description - the shape everybody already writes posts in, so a listing can
 * live in a repository, go through review, and be posted by CI.
 *
 * The parser is deliberately not YAML. It handles `key: value`, `key: [a, b]`
 * and block lists, which is the whole vocabulary a job posting needs, and it
 * cannot execute anything or pull in a parser with its own CVE history.
 */

export interface JobDocument extends Record<string, unknown> {
  description: string;
}

function firstHeading(text: string): { title: string; start: number; end: number } | null {
  let offset = 0;
  let fence: { marker: string; length: number } | null = null;
  for (const line of text.split('\n')) {
    if (fence !== null) {
      const close = new RegExp(`^ {0,3}${fence.marker}{${fence.length},}[ \\t]*$`);
      if (close.test(line)) fence = null;
    } else {
      const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (opening !== null) {
        const run = opening[1] ?? '```';
        fence = { marker: run[0] ?? '`', length: run.length };
      } else {
        const heading = /^ {0,3}#\s+(.+)$/.exec(line);
        if (heading !== null) {
          // A closing run of hashes after a space, or a heading made only of
          // them, is heading syntax, as the Markdown renderer reads it; a hash
          // attached to a word (C#) is text.
          const title = (heading[1] ?? '').trim().replace(/(?:^|[ \t]+)#+$/, '');
          return { title, start: offset, end: offset + line.length };
        }
      }
    }
    offset += line.length + 1;
  }
  return null;
}

export function parseJobDocument(source: string): JobDocument {
  // UTF-8 readers retain the leading byte-order marker; it is not document content.
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);

  if (match === null) {
    // No front matter: the whole file is the description, and its first
    // heading is the title, so a plain Markdown file still posts.
    const title = firstHeading(text)?.title;
    return {
      description: text.trim(),
      ...(title === undefined ? {} : { title }),
    };
  }

  const front = parseFrontMatter(match[1] ?? '');
  // Remove blank opening lines without turning indented code into a heading
  // or a code fence. Indentation on the first content line is Markdown syntax.
  const body = text.slice(match[0].length).replace(/^(?:[ \t]*\n)+/, '').trimEnd();
  const heading = firstHeading(body);
  const title = front['title'] ?? heading?.title;
  let description = body;
  if (front['title'] === undefined && heading !== null) {
    const before = body.slice(0, heading.start).replace(/(?:\n[ \t]*)+$/, '');
    const after = body.slice(heading.end).replace(/^\n(?:[ \t]*\n)*/, '');
    description = [before, after].filter((part) => part !== '').join('\n\n');
  }

  return {
    ...front,
    ...(title === undefined ? {} : { title }),
    // The h1 is dropped from the body when it became the title, so the page
    // does not show the same line twice.
    description,
  };
}

function parseFrontMatter(block: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const lines = block.split('\n');
  let key: string | null = null;
  let list: string[] | null = null;

  const flush = (): void => {
    if (key !== null && list !== null) out[key] = list;
    list = null;
  };

  for (const line of lines) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item !== null && key !== null) {
      list ??= [];
      list.push(unquote(item[1] ?? ''));
      continue;
    }

    const pair = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (pair === null) continue;
    flush();

    key = camel(pair[1] ?? '');
    const value = (pair[2] ?? '').trim();

    if (value === '') {
      // An empty value opens a block list on the following lines.
      list = [];
      continue;
    }
    const inline = /^\[(.*)\]$/.exec(value);
    if (inline !== null) {
      out[key] = splitInlineList(inline[1] ?? '')
        .map((entry) => unquote(entry.trim()))
        .filter((entry) => entry !== '');
      key = null;
      continue;
    }
    out[key] = unquote(value);
    key = null;
  }
  flush();
  return out;
}

/** Split list items without splitting commas inside wrapping quotes. */
function splitInlineList(value: string): string[] {
  const entries: string[] = [];
  let start = 0;
  let quote: string | null = null;
  let entryStarted = false;

  for (let index = 0; index < value.length; index++) {
    const character = value.charAt(index);
    if (quote !== null) {
      if (character === '\\' && quote === '"') {
        index++;
      } else if (character === quote) {
        if (value.charAt(index + 1) === quote) index++;
        else quote = null;
      }
      continue;
    }
    if (character === ',') {
      entries.push(value.slice(start, index));
      start = index + 1;
      entryStarted = false;
    } else if (!entryStarted && character.trim() !== '') {
      if (character === '"' || character === "'") quote = character;
      entryStarted = true;
    }
  }

  // Retain the existing permissive handling of an unmatched opening quote.
  if (quote !== null) return value.split(',');
  entries.push(value.slice(start));
  return entries;
}

/** `salary_min` and `salary-min` both mean `salaryMin`. */
function camel(key: string): string {
  return key.replace(/[_-]([a-z])/g, (_whole, letter: string) => letter.toUpperCase());
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
