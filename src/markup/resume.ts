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

/**
 * The headline, cleaned of markup — and never an email address.
 *
 * Stripping emphasis only at the ends left the middle in place, so a resume
 * opening `**Operated by:** DevilX (someone@example.com)` was listed publicly
 * with the literal `**` still in it *and* with an address in the headline. The
 * candidate directory is explicit that the contact block is kept out of the
 * summary, because a page listing a hundred addresses is a mailing list for
 * whoever fetches it once — a headline that smuggles one past that check
 * defeats it just as thoroughly, and it was live.
 *
 * A headline containing an address is dropped rather than redacted. What is
 * left after cutting the address out of "Operated by: X (a@b.com)" is not a
 * headline anybody wrote, and the resume body still says whatever it says to
 * a signed-in reader.
 */
function cleanHeadline(line: string): string | null {
  const stripped = line
    .trim()
    // Emphasis anywhere, not just at the ends.
    .replace(/\*\*|__/g, '')
    .replace(/^[*_]+|[*_]+$/g, '')
    .trim();
  if (stripped === '') return null;
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(stripped)) return null;
  return stripped;
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
  return parseDocument(source).resume;
}

/** The original body, with only lines promoted to the rendered header removed. */
export function resumeBodyMarkdown(source: string): string {
  return parseDocument(source).body;
}

function parseDocument(source: string): { resume: OpenResume; body: string } {
  const markdown = source.replace(/\r\n?/g, '\n').trim();
  const lines = markdown.split('\n');
  const headerLines = new Set<number>();
  const warnings: string[] = [];

  let name: string | null = null;
  let headline: string | null = null;
  const contact: ResumeContact[] = [];
  const sections: ResumeSection[] = [];

  let section: ResumeSection | null = null;
  let entry: ResumeEntry | null = null;
  let seenH1 = false;
  let inPreamble = false;
  let fenceEnd: RegExp | null = null;

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

  for (const [index, line] of lines.entries()) {
    // Code examples may contain every resume marker. Keep the block in its
    // current body without interpreting headings, contacts, roles or bullets.
    const opening: RegExpExecArray | null = fenceEnd === null ? /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line) : null;
    const marker: string = opening?.[1] ?? '';
    const opensFence = opening !== null &&
      (marker.startsWith('~') || !(opening[2] ?? '').includes('`'));
    if (fenceEnd !== null || opensFence) {
      if (fenceEnd !== null) {
        if (fenceEnd.test(line)) fenceEnd = null;
      } else {
        // A shorter marker, a different character, or trailing text belongs
        // to the example rather than closing it.
        fenceEnd = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`);
      }
      if (entry !== null) entry.markdown += `${line}\n`;
      else if (section !== null) section.markdown += `${line}\n`;
      continue;
    }

    const h1 = /^#\s+(.+?)\s*(?:(?<=[ \t])#+)?\s*$/.exec(line);
    if (h1 !== null) {
      if (seenH1) {
        warnings.push('More than one top-level heading; the first one is used as the name.');
      } else {
        name = (h1[1] ?? '').trim();
        seenH1 = true;
        inPreamble = true;
        headerLines.add(index);
      }
      continue;
    }

    const h2 = /^##\s+(.+?)\s*(?:(?<=[ \t])#+)?\s*$/.exec(line);
    if (h2 !== null) {
      flushSection();
      inPreamble = false;
      const title = (h2[1] ?? '').trim();
      section = { title, kind: kindOf(title), entries: [], markdown: '' };
      continue;
    }

    const h3 = /^###\s+(.+?)\s*(?:(?<=[ \t])#+)?\s*$/.exec(line);
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
        if (field !== null) {
          contact.push(field);
          headerLines.add(index);
        }
        continue;
      }
      if (line.trim() !== '' && headline === null && !line.startsWith('#')) {
        // A single prose line under the name, before any section, reads as a
        // headline on every resume that has one.
        headline = cleanHeadline(line);
        if (headline !== null) headerLines.add(index);
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

  return {
    resume: { name, headline, contact, sections, markdown, warnings },
    body: lines.filter((_, index) => !headerLines.has(index)).join('\n'),
  };
}

/** Read a Markdown link without mistaking a parenthesis in its URL for the closing one. */
export function parseMarkdownLink(text: string): { label: string; href: string; end: number } | null {
  const opening = /^\[([^\]]+)\]\(/.exec(text);
  if (opening === null) return null;
  const angleDestination = /^\[([^\]]+)\]\(<((?:\\.|[^<>\\\n])*)>(?:\s+"[^"]*")?\)/.exec(
    text,
  );
  if (angleDestination !== null) {
    const href = (angleDestination[2] ?? '').replace(/\\([()<>\\])/g, '$1');
    if (href === '') return null;
    return {
      label: angleDestination[1] ?? '',
      href,
      end: angleDestination[0].length - 1,
    };
  }
  let href = '';
  let depth = 0;
  for (let index = opening[0].length; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (character === '\\' && /[()]/.test(text[index + 1] ?? '')) {
      href += text[++index];
    } else if (character === '(') {
      depth += 1;
      href += character;
    } else if (character === ')') {
      if (depth > 0) {
        depth -= 1;
        href += character;
      } else {
        return href === '' ? null : { label: opening[1] ?? '', href, end: index };
      }
    } else if (/\s/.test(character)) {
      // An optional link title follows the URL; it is not part of the account.
      const title = /^\s+"[^"]*"\s*\)/.exec(text.slice(index));
      return title === null || href === ''
        ? null
        : { label: opening[1] ?? '', href, end: index + title[0].length - 1 };
    } else {
      href += character;
    }
  }
  return null;
}

/** `- **Email**: a@b.com`, `- Email: a@b.com`, `- [GitHub](https://...)`. */
function parseContact(raw: string): ResumeContact | null {
  const text = raw.trim();
  if (text === '') return null;

  const link = parseMarkdownLink(text);
  if (link !== null && link.end === text.length - 1) {
    return { key: link.label.trim(), value: link.label.trim(), href: link.href };
  }

  // "- **Tel:** +49" closes the bold after the colon, and "- **Tel: +49**"
  // wraps the whole bullet. Both are common ways to write the same field, and
  // either leaves a `**` inside the value — where it is treated as data,
  // channel detection fails, and the line slips past redaction still carrying
  // the number or URL it was meant to withhold.
  const unwrapped = /^(\*{1,2})([^*][\s\S]*?)\1$/.exec(text);
  const body = unwrapped?.[2] ?? text;
  const boldPair = /^\*{1,2}([^:*]{1,40}?):\*{1,2}\s*(.+)$/.exec(body);
  const pair = boldPair ?? /^\*{0,2}([^:*]{1,40})\*{0,2}\s*:\s*(.+)$/.exec(body);
  if (pair === null) {
    return { key: 'note', value: stripMarkdown(text), href: hrefFor(stripMarkdown(text)) };
  }
  const key = (pair[1] ?? '').trim();
  const rawValue = (pair[2] ?? '').trim();
  const inner = parseMarkdownLink(rawValue);
  if (inner !== null && inner.end === rawValue.length - 1) {
    return { key, value: inner.label.trim(), href: inner.href };
  }
  const value = stripMarkdown(rawValue);
  return { key, value, href: hrefFor(value) };
}

function stripMarkdown(value: string): string {
  let text = value.trim();
  for (;;) {
    // Formatting may wrap a contact value, but punctuation inside an address
    // is data: deleting it changes the mailbox or URL we link to.
    const code = /^(`+)([\s\S]*?)\1$/.exec(text);
    if (code !== null) return (code[2] ?? '').trim();
    const emphasis = /^(\*{1,3}|_{1,3})(?=\S)([\s\S]*\S)\1$/.exec(text);
    if (emphasis === null) return text;
    text = emphasis[2] ?? '';
  }
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
  // Separators in an undated role (e.g. Assistant to Director) are prose,
  // not date endpoints. The convention only reads a trailing bracketed range.
  if (bracketed === null) return { start: null, end: null, current: false };
  const candidate = bracketed[1] ?? '';
  // An en dash, an em dash and a hyphen all show up in real resumes.
  // Typographic dashes also appear without spaces (2019–2021). Keep
  // whitespace required around ASCII hyphens so ISO dates stay intact.
  const split = candidate.split(/\s+(?:to|-)\s+|\s*[–—]\s*/i);
  if (split.length < 2) {
    if (candidate.trim() !== '') {
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
      parts.push(
        entry.title,
        entry.place ?? '',
        entry.markdown.trim() === ''
          ? [entry.subtitle ?? '', ...entry.highlights].filter((part) => part !== '').join('\n')
          : entry.markdown,
      );
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

/** What replaces the withheld bullets, so a redacted block says it is one. */
export const CONTACT_WITHHELD = 'shared with signed-in members';

/**
 * An email address sitting in prose rather than in a contact bullet.
 *
 * Global, because a line may carry more than one and replacing only the first
 * withholds nothing.
 */
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * A diallable number written into prose. The contact block withholds `tel:`
 * fields already; a number in a sentence is the same channel and gets the
 * same scrub. Three shapes: an international `+` number, a parenthesised
 * area code, and the plain 3-3-4 split. Anything looser - "2019-2024",
 * "06 12 34 56 78" - is left alone rather than guessed at, because a wrong
 * redaction corrupts a document its owner cannot see break.
 */
const PHONE_IN_TEXT =
  /(?:\+\d[\d ()./-]{6,}\d|\(\d{3}\)[\d ()./-]{5,}\d|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b)/g;

/** Whether plain summary text contains a channel the public resume withholds. */
export function hasContactChannel(text: string): boolean {
  return (
    new RegExp(EMAIL_IN_TEXT.source).test(text) ||
    new RegExp(PHONE_IN_TEXT.source).test(text)
  );
}

/**
 * The contact block, minus every way to actually reach the person.
 *
 * A published resume is a document its owner chose to make public, but the
 * contact block inside it is the part worth harvesting on its own. An
 * anonymous crawler that walks /candidates and follows each link gets a
 * mailing list with phone numbers attached, and somebody who published a
 * resume in order to be hired did not agree to that.
 *
 * The rule falls out of the parse rather than out of a list of key names,
 * which is what keeps it from going stale as people invent new fields. A
 * contact field that produced an `href` is a channel: mailto, tel, or a
 * profile somewhere. One that did not is a plain fact, like "Location:
 * Berlin" or "Work Authorization: EU Citizen", and those stay. The directory
 * already prints the location on every card and filtering on it is the point,
 * so withholding it here would be theatre.
 *
 * The withheld bullets are replaced by one saying so rather than removed
 * silently. A caller that cannot tell a redacted document from a resume with
 * no contact details will read the second as the first, and this is the one
 * place where being quietly wrong is worse than being unhelpful.
 *
 * Markdown in, Markdown out. The caller re-parses the result instead of being
 * handed a doctored parse, so the document and the parse of it can never
 * disagree about what was withheld. That is the rule the rest of OpenResume
 * runs on: the Markdown is the canonical copy.
 */
export function redactContactChannels(source: string): { markdown: string; redacted: boolean } {
  const markdown = source.replace(/\r\n?/g, '\n');
  const out: string[] = [];
  let seenH1 = false;
  let inPreamble = false;
  let redacted = false;

  for (const line of markdown.split('\n')) {
    // Headings only set flags here; the line itself still falls through to the
    // address check below. Pushing a heading verbatim let a name or a section
    // title carry an address straight past the redaction.
    if (/^#\s+(.+?)\s*#*\s*$/.test(line)) {
      if (!seenH1) {
        seenH1 = true;
        inPreamble = true;
      }
    } else if (/^##\s+(.+?)\s*#*\s*$/.test(line)) {
      inPreamble = false;
    } else if (inPreamble) {
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      if (bullet !== null) {
        const field = parseContact(bullet[1] ?? '');
        if (field !== null && field.href !== null) {
          // The first one withheld becomes the notice, so the block keeps its
          // shape and its place instead of collapsing to nothing.
          if (!redacted) out.push(`- **Contact**: ${CONTACT_WITHHELD}`);
          redacted = true;
          continue;
        }
        // A bullet with no channel to withhold is still prose: an address in
        // "Note: mail me at <address>" is scrubbed like any other line.
      }
    }

    // An address anywhere in the document, not only in the contact block.
    //
    // Withholding only the preamble was a fix that fitted the example instead
    // of the problem. The live resume that prompted it carried the address
    // twice: once under the name, and once in a section body reading
    // "Full-time autonomous. Contact: <address>". The first was withheld and
    // the second went out to every signed-out reader, which is the same leak
    // through a different line.
    //
    // A section body is not a special case to be enumerated. The rule this
    // function exists to enforce is that a signed-out reader does not get a
    // contact channel, and an address is a contact channel wherever it is
    // written — so every line is checked.
    //
    // Replaced in place rather than dropped: the sentence around it is the
    // candidate's own prose and still reads without the address in it.
    //
    // `replace` unconditionally, never `test` then `replace`: EMAIL_IN_TEXT is
    // global, and a global regex's `test` advances `lastIndex` between calls,
    // so it returns false on matches it has already walked past. That is how a
    // redaction skips lines at random and still passes a one-line unit test.
    const scrubbed = line
      .replace(EMAIL_IN_TEXT, CONTACT_WITHHELD)
      .replace(PHONE_IN_TEXT, CONTACT_WITHHELD);
    if (scrubbed !== line) {
      out.push(scrubbed);
      redacted = true;
      continue;
    }

    out.push(line);
  }

  return redacted ? { markdown: out.join('\n'), redacted } : { markdown, redacted };
}
