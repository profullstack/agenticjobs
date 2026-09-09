/**
 * OpenResume.md.
 *
 * A resume is a Markdown document, and the Markdown is the canonical copy.
 * Everything else - the structured object below, the HTML on the page, a PDF
 * someone exports - is derived from it and regenerated, never edited beside
 * it. That is the whole point of choosing Markdown over a form: the candidate
 * owns a file they can read, diff, and paste into any other tool, and an agent
 * can write one without a schema-shaped API.
 *
 * The convention is deliberately thin, because a resume that fails to parse
 * must still be a usable resume. Every rule here degrades: an unrecognised
 * section is kept verbatim, a missing date is simply absent, and a document
 * with nothing but an h1 and some prose is valid.
 *
 *   # Name                      <- exactly one h1, the person
 *   - **Email**: a@b.com        <- the list right after it is the contact block
 *   ## Experience               <- h2 opens a section
 *   ### Company | Location      <- h3 opens an entry
 *   Role (Mar 2020 - Present)   <- the line under an entry is its subtitle
 *   - Did a thing               <- bullets are highlights
 *
 * The full specification is in docs/openresume.md.
 */

export interface ResumeContact {
  key: string;
  value: string;
  /** Set when the value is a URL or an email we can link. */
  href: string | null;
}

export interface ResumeEntry {
  /** The h3 text, with a `|` split into title and place. */
  title: string;
  place: string | null;
  /** The line under the heading: a role, a degree, a one-line description. */
  subtitle: string | null;
  /** Parsed out of the subtitle when it ends in a bracketed range. */
  start: string | null;
  end: string | null;
  /** True when the range ends in "present", "now" or "current". */
  current: boolean;
  highlights: string[];
  /** Everything under the entry, verbatim, so nothing is ever lost. */
  markdown: string;
}

export interface ResumeSection {
  /** The h2 text as written. */
  title: string;
  /** Lowercased and normalised, for matching. */
  kind: string;
  entries: ResumeEntry[];
  /** Prose and bullets that sat directly under the h2. */
  markdown: string;
}

export interface OpenResume {
  name: string | null;
  headline: string | null;
  contact: ResumeContact[];
  sections: ResumeSection[];
  /** The document as supplied. Always the source of truth. */
  markdown: string;
  /** Things a candidate would probably want to fix. Never fatal. */
  warnings: string[];
}

/** Section names we normalise, so "Work Experience" and "Experience" match. */
const KINDS: [RegExp, string][] = [
  [/^(work\s+)?experience$|^employment$|^work\s+history$/i, 'experience'],
  [/^education$|^academic/i, 'education'],
  // "Core Skills" and "Key Skills" are as common as the bare word, and a
  // resume that used one of them had an empty skills list on its candidate
  // card while the section sat right there in the document.
  [
    /^(core\s+|key\s+|technical\s+|primary\s+)?skills?$|^areas?\s+of\s+expertise$|^skills?\s+&?\s*(tools|technologies)$/i,
    'skills',
  ],
  [/^projects?$|^open\s+source$/i, 'projects'],
  [/^summary$|^about$|^profile$|^objective$/i, 'summary'],
  [/^links?$|^elsewhere$|^profiles?$/i, 'links'],
  [/^certification|^licen[cs]e/i, 'certifications'],
  [/^languages?$/i, 'languages'],
  [/^publications?$|^talks?$|^writing$/i, 'publications'],
  [/^awards?$|^honou?rs?$/i, 'awards'],
];

function kindOf(title: string): string {
  for (const [pattern, kind] of KINDS) {
    if (pattern.test(title.trim())) return kind;
  }
  return title.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40) || 'section';
}

const PRESENT = /\b(present|now|current|ongoing)\b/i;

export function parseResume(source: string): OpenResume {
  const markdown = source.replace(/\r\n?/g, '\n').trim();
  const lines = markdown.split('\n');
  const warnings: string[] = [];

  let name: string | null = null;
  let headline: string | null = null;
  const contact: ResumeContact[] = [];
  const sections: ResumeSection[] = [];

  let section: ResumeSection | null = null;
  let entry: ResumeEntry | null = null;
  let seenH1 = false;
  let inPreamble = false;

  const flushEntry = (): void => {
    if (entry !== null && section !== null) {
      entry.markdown = entry.markdown.trim();
      section.entries.push(entry);
    }
    entry = null;
  };
  const flushSection = (): void => {
    flushEntry();
    if (section !== null) {
      section.markdown = section.markdown.trim();
      sections.push(section);
    }
    section = null;
  };

  for (const line of lines) {
    const h1 = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (h1 !== null) {
      if (seenH1) {
        warnings.push('More than one top-level heading; the first one is used as the name.');
      } else {
        name = (h1[1] ?? '').trim();
        seenH1 = true;
        inPreamble = true;
      }
      continue;
    }

    const h2 = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h2 !== null) {
      flushSection();
      inPreamble = false;
      const title = (h2[1] ?? '').trim();
      section = { title, kind: kindOf(title), entries: [], markdown: '' };
      continue;
    }

    const h3 = /^###\s+(.+?)\s*#*\s*$/.exec(line);
    if (h3 !== null && section !== null) {
      flushEntry();
      const raw = (h3[1] ?? '').trim();
      const parts = raw.split('|').map((part) => part.trim());
      entry = {
        title: parts[0] ?? raw,
        place: parts.length > 1 ? parts.slice(1).join(' | ') : null,
        subtitle: null,
        start: null,
        end: null,
        current: false,
        highlights: [],
        markdown: '',
      };
      continue;
    }

    if (inPreamble) {
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      if (bullet !== null) {
        const field = parseContact(bullet[1] ?? '');
        if (field !== null) contact.push(field);
        continue;
      }
      if (line.trim() !== '' && headline === null && !line.startsWith('#')) {
        // A single prose line under the name, before any section, reads as a
        // headline on every resume that has one.
        headline = line.trim().replace(/^[*_]+|[*_]+$/g, '');
      }
      continue;
    }

    if (entry !== null) {
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      if (bullet !== null) {
        entry.highlights.push((bullet[1] ?? '').trim());
      } else if (entry.subtitle === null && line.trim() !== '') {
        const subtitle = line.trim();
        entry.subtitle = subtitle;
        const range = parseRange(subtitle);
        entry.start = range.start;
        entry.end = range.end;
        entry.current = range.current;
      }
      entry.markdown += `${line}\n`;
      continue;
    }

    if (section !== null) section.markdown += `${line}\n`;
  }

  flushSection();

  if (name === null) warnings.push('No name: the document should start with "# Your Name".');
  if (contact.length === 0) {
    warnings.push('No contact details: add a bullet list under the name, e.g. "- Email: you@example.com".');
  }
  if (!sections.some((item) => item.kind === 'experience')) {
    warnings.push('No experience section found. Employers filter on it.');
  }

  return { name, headline, contact, sections, markdown, warnings };
}

/** `- **Email**: a@b.com`, `- Email: a@b.com`, `- [GitHub](https://...)`. */
function parseContact(raw: string): ResumeContact | null {
  const text = raw.trim();
  if (text === '') return null;

  const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(text);
  if (link !== null) {
    return { key: (link[1] ?? '').trim(), value: (link[1] ?? '').trim(), href: link[2] ?? null };
  }

  const pair = /^\*{0,2}([^:*]{1,40})\*{0,2}\s*:\s*(.+)$/.exec(text);
  if (pair === null) {
    return { key: 'note', value: stripMarkdown(text), href: hrefFor(stripMarkdown(text)) };
  }
  const key = (pair[1] ?? '').trim();
  const rawValue = (pair[2] ?? '').trim();
  const inner = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(rawValue);
  if (inner !== null) {
    return { key, value: (inner[1] ?? '').trim(), href: inner[2] ?? null };
  }
  const value = stripMarkdown(rawValue);
  return { key, value, href: hrefFor(value) };
}

function stripMarkdown(value: string): string {
  return value.replace(/[*_`]/g, '').trim();
}

function hrefFor(value: string): string | null {
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return `mailto:${value}`;
  if (/^\+?[\d\s().-]{7,}$/.test(value)) return `tel:${value.replace(/[^\d+]/g, '')}`;
  // A bare domain, with or without a path. "Web: example.com" is how most
  // people write it, and an earlier version of this required a trailing slash
  // and so linked none of them.
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}(\/\S*)?$/i.test(value)) return `https://${value}`;
  return null;
}

/** "Full Stack Engineer (Mar 2020 - Present)" -> start, end, current. */
function parseRange(subtitle: string): { start: string | null; end: string | null; current: boolean } {
  const bracketed = /\(([^)]*)\)\s*$/.exec(subtitle);
  const candidate = bracketed?.[1] ?? subtitle;
  // An en dash, an em dash and a hyphen all show up in real resumes.
  const split = candidate.split(/\s+(?:to|-|–|—)\s+/i);
  if (split.length < 2) {
    if (bracketed !== null && candidate.trim() !== '') {
      return { start: candidate.trim(), end: null, current: PRESENT.test(candidate) };
    }
    return { start: null, end: null, current: false };
  }
  const start = (split[0] ?? '').trim();
  const end = (split[1] ?? '').trim();
  return {
    start: start === '' ? null : start,
    end: end === '' ? null : end,
    current: PRESENT.test(end),
  };
}

/**
 * Everything an employer would filter on, flattened for the search index.
 * Derived, never stored as the truth: regenerated from the Markdown on save.
 */
export function resumeSearchText(resume: OpenResume): string {
  const parts: string[] = [resume.name ?? '', resume.headline ?? ''];
  for (const section of resume.sections) {
    parts.push(section.title, section.markdown);
    for (const entry of section.entries) {
      parts.push(entry.title, entry.place ?? '', entry.subtitle ?? '', ...entry.highlights);
    }
  }
  return parts.filter((part) => part !== '').join('\n');
}

/** A starting document, so nobody faces an empty box. */
export function resumeTemplate(name = 'Your Name'): string {
  return [
    `# ${name}`,
    '',
    '- **Email**: you@example.com',
    '- **Location**: City, Country',
    '- **Web**: https://example.com',
    '',
    'One line on what you do and what you are looking for.',
    '',
    '## Experience',
    '',
    '### Company | Remote',
    'Your Role (Jan 2024 - Present)',
    '',
    '- What you built, and what changed because you built it.',
    '- Numbers where you have them.',
    '',
    '## Skills',
    '',
    '- Languages: ',
    '- Tools: ',
    '',
    '## Education',
    '',
    '### School',
    'Degree (Year)',
    '',
  ].join('\n');
}
