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

export function parseJobDocument(source: string): JobDocument {
  const text = source.replace(/\r\n?/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);

  if (match === null) {
    // No front matter: the whole file is the description, and its first
    // heading is the title, so a plain Markdown file still posts.
    const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
    return {
      description: text.trim(),
      ...(title === undefined ? {} : { title }),
    };
  }

  const front = parseFrontMatter(match[1] ?? '');
  const body = text.slice(match[0].length).trim();
  const title = front['title'] ?? /^#\s+(.+)$/m.exec(body)?.[1]?.trim();

  return {
    ...front,
    ...(title === undefined ? {} : { title }),
    // The h1 is dropped from the body when it became the title, so the page
    // does not show the same line twice.
    description: title !== undefined && front['title'] === undefined
      ? body.replace(/^#\s+.+\n?/, '').trim()
      : body,
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
      out[key] = (inline[1] ?? '')
        .split(',')
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
