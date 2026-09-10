/**
 * Turning a job posting somewhere else into a listing here.
 *
 * This is what a URL is for now: applications are taken on the board, so a
 * link to a job elsewhere is a source to import, never a destination to send
 * an applicant to.
 *
 * Two paths, in this order:
 *
 *  1. **schema.org JobPosting in JSON-LD.** Most boards emit it, Google asks
 *     for it, and it is structured, so it is worth trying first and worth
 *     trusting when it is there.
 *  2. **The page itself.** og:title and the readable text. Everything a page
 *     does not say stays unset rather than being guessed at.
 *
 * An import is always a DRAFT. Extraction from a page nobody designed for it
 * is approximate, and this board's whole seam is that a machine prepares and a
 * person releases. A silently published import would be a scraped listing on a
 * board whose pitch is that nothing here is scraped.
 */

import { EMPLOYMENT_TYPES, WORKPLACES, type EmploymentType, type Workplace } from '../schema/job.ts';

export interface ImportedJob {
  title: string;
  description: string;
  sourceUrl: string;
  employmentType?: EmploymentType;
  workplace?: Workplace;
  location?: string;
  /** Which path produced this, so the caller can say so rather than imply more. */
  via: 'jsonld' | 'page';
  /** What could not be read, in words a person can act on. */
  warnings: string[];
}

export class JobImportProblem extends Error {}

/**
 * Elements whose contents are never the job.
 *
 * The first group carries no readable text at all. The second is site
 * furniture: a page without a <main> falls back to the whole <body>, and
 * without this the listing ends up carrying "Back to gigs", the view counter,
 * a testimonials block and an advertisement. That is what happened on the
 * first real import, so this is not hypothetical tidying.
 */
const DEAD =
  /<(script|style|template|noscript|svg|nav|header|footer|aside|form|button|select)[^>]*>[\s\S]*?<\/\1>/gi;

function stripTags(html: string): string {
  return html
    .replace(DEAD, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ');
}

/** The five named entities plus numeric ones; enough for text nobody will re-parse. */
function decode(text: string): string {
  return text
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
      const named: Record<string, string> = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
        nbsp: ' ',
        '#39': "'",
      };
      const key = body.toLowerCase();
      if (named[key] !== undefined) return named[key];
      if (body.startsWith('#x') || body.startsWith('#X')) {
        const code = Number.parseInt(body.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      if (body.startsWith('#')) {
        const code = Number.parseInt(body.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      return whole;
    })
    .replace(/ /g, ' ');
}

function tidy(text: string): string {
  return decode(text)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
    .join('\n')
    .trim();
}

function metaContent(html: string, key: string): string | null {
  // Attribute order varies, so both orders are tried rather than assumed.
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${key}["']`, 'i'),
  ];
  for (const pattern of patterns) {
    const found = pattern.exec(html)?.[1];
    if (found !== undefined && found.trim() !== '') return decode(found.trim());
  }
  return null;
}

/** JSON-LD blocks, including the @graph wrapper a lot of CMSes emit. */
function jsonLdNodes(html: string): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const blocks = html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const block of blocks) {
    const source = block[1] ?? '';
    let parsed: unknown;
    try {
      // Entities inside valid JSON belong to its values. Decoding first can
      // turn &quot; into JSON syntax or escaped description text into tags.
      parsed = JSON.parse(source);
    } catch {
      try {
        // Keep accepting pages that escaped the entire block as HTML.
        parsed = JSON.parse(decode(source));
      } catch {
        // A malformed block is not a reason to abandon the import; there is
        // usually more than one and the page still has readable text.
        continue;
      }
    }
    const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
    while (queue.length > 0) {
      const node = queue.shift();
      if (typeof node !== 'object' || node === null) continue;
      const record = node as Record<string, unknown>;
      const graph = record['@graph'];
      if (Array.isArray(graph)) queue.push(...graph);
      nodes.push(record);
    }
  }
  return nodes;
}

function typeOf(node: Record<string, unknown>): string[] {
  const raw = node['@type'];
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === 'string');
  return [];
}

/** schema.org spells it MONTHLY, PART_TIME and so on. */
function employmentTypeOf(value: unknown): EmploymentType | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const normalised = raw.toLowerCase().replace(/_/g, '-').trim();
  return (EMPLOYMENT_TYPES as readonly string[]).includes(normalised)
    ? (normalised as EmploymentType)
    : undefined;
}

function workplaceOf(node: Record<string, unknown>): Workplace | undefined {
  const remote = node['jobLocationType'];
  if (typeof remote === 'string' && remote.toUpperCase().includes('TELECOMMUTE')) return 'remote';
  const raw = node['workplace'];
  if (typeof raw === 'string' && (WORKPLACES as readonly string[]).includes(raw.toLowerCase())) {
    return raw.toLowerCase() as Workplace;
  }
  return undefined;
}

function locationOf(node: Record<string, unknown>): string | undefined {
  const place = Array.isArray(node['jobLocation']) ? node['jobLocation'][0] : node['jobLocation'];
  if (typeof place !== 'object' || place === null) return undefined;
  const address = (place as Record<string, unknown>)['address'];
  if (typeof address === 'string') return address;
  if (typeof address !== 'object' || address === null) return undefined;
  const parts = ['addressLocality', 'addressRegion', 'addressCountry']
    .map((key) => (address as Record<string, unknown>)[key])
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '');
  return parts.length === 0 ? undefined : parts.join(', ');
}

/**
 * The readable body of a page, without the furniture.
 *
 * Not a reader-mode implementation: it takes `<main>` or `<article>` when the
 * page marks one, because a page that says where its content is should be
 * believed, and otherwise the whole body. The result is a person's starting
 * point, which is why the import is a draft.
 */
function readableText(html: string): string {
  const main =
    /<main[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ??
    /<article[^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1] ??
    /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ??
    html;
  return tidy(stripTags(main));
}

/** A page title usually carries the site name; the listing should not. */
function trimSiteName(title: string): string {
  return title.split(/\s+[|·—–]\s+/)[0]?.trim() || title.trim();
}

export function extractJob(html: string, sourceUrl: string): ImportedJob {
  const warnings: string[] = [];

  const posting = jsonLdNodes(html).find((node) => typeOf(node).includes('JobPosting'));
  if (posting !== undefined) {
    const title = typeof posting['title'] === 'string' ? posting['title'].trim() : '';
    const rawDescription =
      typeof posting['description'] === 'string' ? posting['description'] : '';
    const description = tidy(stripTags(rawDescription));
    if (title !== '' && description !== '') {
      const employmentType = employmentTypeOf(posting['employmentType']);
      const workplace = workplaceOf(posting);
      const location = locationOf(posting);
      if (employmentType === undefined) warnings.push('No employment type in the posting.');
      if (workplace === undefined) warnings.push('No workplace, so it was left unset.');
      return {
        title,
        description,
        sourceUrl,
        via: 'jsonld',
        warnings,
        ...(employmentType === undefined ? {} : { employmentType }),
        ...(workplace === undefined ? {} : { workplace }),
        ...(location === undefined ? {} : { location }),
      };
    }
    warnings.push('The page had a JobPosting but it was missing a title or a description.');
  }

  // Decoding a missing or blank heading returns an empty string, not null.
  // Keep trying the next source until there is a readable title.
  const title = trimSiteName(
    metaContent(html, 'og:title')?.trim() ||
      decode(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1]?.replace(/<[^>]+>/g, '') ?? '').trim() ||
      decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim(),
  );
  if (title === '') throw new JobImportProblem('That page has no title, so there is nothing to import.');

  const body = readableText(html);
  const description = body === '' ? (metaContent(html, 'og:description') ?? '') : body;
  if (description === '') {
    throw new JobImportProblem('That page has no readable text, so there is nothing to import.');
  }

  warnings.push(
    'That page publishes no JobPosting data, so this was read off the page itself. Check every field before publishing.',
  );
  return { title, description, sourceUrl, via: 'page', warnings };
}
