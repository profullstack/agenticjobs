/**
 * A resume, reduced to what a directory row needs.
 *
 * Everything here is read out of the parsed resume rather than asked for
 * again. A candidate should not have to fill in a profile that restates the
 * document they already wrote, and a second copy of the same facts is a second
 * copy to keep in step.
 */

import type { Resume } from './resumes.ts';
import type { CandidateSummary } from '../views/candidates.tsx';
import { type OpenResume, parseResume, redactContactChannels } from '../markup/resume.ts';

/** Contact keys that read as a place rather than an address. */
const LOCATION_KEYS = /^(location|based|city|where|region)$/i;

/**
 * Skills, from the section a resume marks as skills.
 *
 * Takes the bullets under the heading, and splits a comma-separated line,
 * because both are how people write that section. Capped, because a directory
 * row is a summary and some resumes list sixty.
 */
function skillsOf(resume: Resume, limit = 8): string[] {
  const section = resume.parsed?.sections.find((item) => item.kind === 'skills');
  if (section === undefined) return [];

  const fromBullets = section.markdown
    .split('\n')
    .map((line) => line.replace(/^\s*[-*]\s+/, '').trim())
    // A skills bullet is very often "**Languages:** JavaScript, Go", and the
    // label is a category rather than a skill. Without dropping it the first
    // badge on the card reads "**Languages:** JavaScript".
    .map((line) => line.replace(/^\*{0,2}[^*:]{1,40}:\*{0,2}\s*/, ''))
    .filter((line) => line !== '' && !line.startsWith('#'));

  const flattened = fromBullets.flatMap((line) =>
    line.includes(',') ? line.split(',').map((part) => part.trim()) : [line],
  );

  const seen = new Set<string>();
  const out: string[] = [];
  for (const skill of flattened) {
    // A sentence is prose that happened to be in the skills section, not a
    // skill, and a badge is the wrong shape for it.
    const cleaned = skill.replace(/\*\*/g, '').replace(/^`|`$/g, '').trim();
    if (cleaned === '' || cleaned.length > 40) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= limit) break;
  }
  return out;
}

function locationOf(resume: Resume): string | null {
  const found = resume.parsed?.contact.find((item) => LOCATION_KEYS.test(item.key));
  return found?.value ?? null;
}

/**
 * The longest a person's name is allowed to be before it is not one.
 *
 * A resume whose Markdown lost its line breaks parses as a single h1 holding
 * the entire document, and the "name" then comes back as three thousand
 * characters of resume. That happened, and it produced a candidate card
 * captioned with a whole CV and a URL to match, so the length is checked
 * rather than assumed.
 */
const NAME_MAX = 80;

/**
 * The name shown in the directory.
 *
 * A resume with no usable h1 falls back to its title, which its owner wrote
 * and which is at least theirs. It never falls back to an email address:
 * publishing a resume should not mean publishing an address as the headline.
 */
export function nameOf(resume: Resume): string {
  const parsed = resume.parsed?.name?.trim();
  if (parsed !== undefined && parsed !== '' && parsed.length <= NAME_MAX) return parsed;
  const title = resume.title.trim();
  return title === '' || title.length > NAME_MAX ? 'Candidate' : title;
}

/** One resume as a given viewer is allowed to see it. */
export interface ResumeView {
  markdown: string;
  parsed: OpenResume | null;
  /** True when contact channels were withheld from this copy. */
  redacted: boolean;
}

/**
 * The copy of a resume to serve, given whether anybody is signed in.
 *
 * Every representation goes through here: the page, the JSON, the RSS, and
 * each of the four download formats. They all render the same Markdown, so
 * gating in one of them and forgetting another is how the address ends up
 * public in the PDF while the page looks careful.
 *
 * Signed in is the whole test, and it is deliberately not "signed in and
 * approved". A person browsing with a session and an agent holding a device
 * token are the same caller here, because an agent reading resumes on its
 * owner's behalf is the traffic this board exists to serve. What changes is
 * that there is now an account behind the read, which is the thing a scraper
 * does not want to have.
 */
export function resumeForViewer(
  resume: { markdown: string; parsed: OpenResume | null },
  signedIn: boolean,
): ResumeView {
  if (signedIn) return { markdown: resume.markdown, parsed: resume.parsed, redacted: false };

  const { markdown, redacted } = redactContactChannels(resume.markdown);
  // Nothing to withhold: hand back the original parse rather than paying for
  // a second one, and report honestly that this copy is whole.
  if (!redacted) return { markdown: resume.markdown, parsed: resume.parsed, redacted: false };

  return { markdown, parsed: parseResume(markdown), redacted: true };
}

export function toCandidateSummary(resume: Resume): CandidateSummary {
  return {
    slug: resume.publicSlug ?? '',
    name: nameOf(resume),
    headline: resume.parsed?.headline ?? null,
    location: locationOf(resume),
    skills: skillsOf(resume),
    updatedAt: resume.updatedAt,
  };
}

/**
 * Read `tags=javascript,react,node.js` into a list.
 *
 * `skill=` is accepted as a one-tag alias, because that is what the first
 * version of the badge links used and those URLs are already out there.
 */
export function tagsFrom(params: URLSearchParams): string[] {
  const raw = params.get('tags') ?? params.get('skill') ?? '';
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const tag = part.trim();
    if (tag === '') continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/**
 * The candidates who list ALL of these tags.
 *
 * Narrowing rather than widening: someone asking for javascript, react and
 * node.js together is describing one person's skill set, not three separate
 * searches. A single tag behaves the same either way.
 *
 * Matched on the whole tag rather than as a substring, because that is what
 * the badge links to: "Go" must not match "MongoDB".
 */
export function withTags(candidates: CandidateSummary[], tags: string[]): CandidateSummary[] {
  if (tags.length === 0) return candidates;
  const wanted = tags.map((tag) => tag.toLowerCase());
  return candidates.filter((candidate) => {
    const has = new Set(candidate.skills.map((skill) => skill.toLowerCase()));
    return wanted.every((tag) => has.has(tag));
  });
}

/** Every tag anybody lists, most common first, for a browsable index. */
export function allTags(candidates: CandidateSummary[]): { tag: string; count: number }[] {
  const counts = new Map<string, { tag: string; count: number }>();
  for (const candidate of candidates) {
    for (const skill of candidate.skills) {
      const key = skill.toLowerCase();
      const seen = counts.get(key);
      if (seen === undefined) counts.set(key, { tag: skill, count: 1 });
      else seen.count += 1;
    }
  }
  return [...counts.values()].sort(
    (a, b) => b.count - a.count || a.tag.localeCompare(b.tag),
  );
}
