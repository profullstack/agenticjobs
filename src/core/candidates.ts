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
    .filter((line) => line !== '' && !line.startsWith('#'));

  const flattened = fromBullets.flatMap((line) =>
    line.includes(',') ? line.split(',').map((part) => part.trim()) : [line],
  );

  const seen = new Set<string>();
  const out: string[] = [];
  for (const skill of flattened) {
    // A sentence is prose that happened to be in the skills section, not a
    // skill, and a badge is the wrong shape for it.
    if (skill === '' || skill.length > 40) continue;
    const key = skill.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(skill);
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
