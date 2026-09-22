/**
 * Landing pages: a search as a path.
 *
 * `/rust/remote` is the search for remote Rust jobs, and so is
 * `/remote/rust`. Every segment is a value, never a key, because every
 * filter's values are words that name only that filter: `remote` is a
 * workplace and nothing else, `contract` an employment type, `senior` a
 * seniority. Anything left is a tag. Keys would have made `/workplace/remote/
 * tags/rust`, which nobody would type and nobody would share.
 *
 * The three filters that are not words are spelled so that they are:
 * agent policy is `agents-welcome`, `agents-disclose` or `human-only`, and a
 * salary floor is `100k+`. Free text and an employer are not sluggable and
 * stay on the querystring.
 *
 * Every page has one canonical path, with the tags first and sorted, so
 * `/remote/rust` sends a crawler to `/rust/remote` rather than indexing two
 * copies of one list.
 */

import {
  AGENT_POLICIES,
  EMPLOYMENT_TYPES,
  SENIORITIES,
  WORKPLACES,
  type AgentPolicy,
  type EmploymentType,
  type Seniority,
  type Workplace,
} from '../schema/job.ts';
import { EMPTY_QUERY, type JobQuery } from '../schema/query.ts';

export const MAX_PATH_TAGS = 3;
const TAG = /^[a-z0-9][a-z0-9+_.-]{0,39}$/;
const SALARY = /^(\d{1,4})k\+$/;

const POLICY_SLUGS: Record<string, AgentPolicy> = {
  'agents-welcome': 'welcome',
  'agents-disclose': 'disclose',
  'human-only': 'human-only',
};
const POLICY_SLUG_OF: Record<AgentPolicy, string> = {
  welcome: 'agents-welcome',
  disclose: 'agents-disclose',
  'human-only': 'human-only',
};

/** A word that names a filter value rather than a tag. */
export function isFilterWord(segment: string): boolean {
  return (
    (WORKPLACES as readonly string[]).includes(segment) ||
    (EMPLOYMENT_TYPES as readonly string[]).includes(segment) ||
    (SENIORITIES as readonly string[]).includes(segment) ||
    segment in POLICY_SLUGS ||
    SALARY.test(segment)
  );
}

/**
 * Read a path into a query, or null when it is not a landing page.
 *
 * Null rather than a best effort: `/rust/remote/remote` and `/rust/whatever.js`
 * are not searches anybody meant, and answering them with a page would
 * duplicate a real one under a URL that should 404.
 */
export function queryFromPath(path: string): JobQuery | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length === 0 || segments.length > MAX_PATH_TAGS + 5) return null;

  const query: JobQuery = { ...EMPTY_QUERY, tags: [] };
  const tags: string[] = [];
  for (const raw of segments) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw).toLowerCase();
    } catch {
      return null;
    }
    if ((WORKPLACES as readonly string[]).includes(segment)) {
      if (query.workplace !== null) return null;
      query.workplace = segment as Workplace;
    } else if ((EMPLOYMENT_TYPES as readonly string[]).includes(segment)) {
      if (query.employmentType !== null) return null;
      query.employmentType = segment as EmploymentType;
    } else if ((SENIORITIES as readonly string[]).includes(segment)) {
      if (query.seniority !== null) return null;
      query.seniority = segment as Seniority;
    } else if (segment in POLICY_SLUGS) {
      if (query.agentPolicy !== null) return null;
      query.agentPolicy = POLICY_SLUGS[segment] as AgentPolicy;
    } else if (SALARY.test(segment)) {
      if (query.salaryMin !== null) return null;
      query.salaryMin = Number.parseInt(SALARY.exec(segment)?.[1] ?? '0', 10) * 1000;
    } else if (TAG.test(segment) && !segment.includes('.')) {
      if (tags.includes(segment) || tags.length >= MAX_PATH_TAGS) return null;
      tags.push(segment);
    } else {
      return null;
    }
  }
  query.tags = tags;
  return query;
}

/**
 * The canonical path for a query, or null when it cannot be a path.
 *
 * Free text, an employer, a sort, paging and more than three tags all mean
 * the querystring form is the honest one.
 */
export function pathForQuery(query: JobQuery): string | null {
  if (query.q !== null || query.org !== null) return null;
  if (
    query.tags.length === 0 &&
    query.workplace === null &&
    query.employmentType === null &&
    query.seniority === null &&
    query.agentPolicy === null &&
    query.salaryMin === null
  ) {
    return null;
  }
  if (query.tags.length > MAX_PATH_TAGS) return null;
  if (query.salaryMin !== null && (query.salaryMin % 1000 !== 0 || query.salaryMin > 9_999_000)) {
    return null;
  }
  const tags = [...query.tags].map((tag) => tag.toLowerCase());
  if (tags.some((tag) => !TAG.test(tag) || tag.includes('.') || isFilterWord(tag))) return null;
  tags.sort();

  const segments = [
    ...tags,
    ...(query.workplace === null ? [] : [query.workplace]),
    ...(query.employmentType === null ? [] : [query.employmentType]),
    ...(query.seniority === null ? [] : [query.seniority]),
    ...(query.agentPolicy === null ? [] : [POLICY_SLUG_OF[query.agentPolicy]]),
    ...(query.salaryMin === null ? [] : [`${query.salaryMin / 1000}k+`]),
  ];
  // `+` is literal in a path; only a form body reads it as a space.
  return `/${segments.map((segment) => encodeURIComponent(segment).replace(/%2B/g, '+')).join('/')}`;
}

function cap(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** "Remote senior Rust contract jobs" for a heading and a title tag. */
export function titleForQuery(query: JobQuery): string {
  const words: string[] = [];
  if (query.workplace !== null) words.push(query.workplace);
  if (query.seniority !== null) words.push(query.seniority);
  words.push(...query.tags.map((tag) => (tag.length <= 3 ? tag.toUpperCase() : cap(tag))));
  if (query.employmentType !== null) words.push(query.employmentType);
  let title = `${words.join(' ')} jobs`.trim();
  title = cap(title);
  if (query.agentPolicy === 'welcome') title += ', agents welcome';
  else if (query.agentPolicy === 'disclose') title += ' that ask agents to disclose';
  else if (query.agentPolicy === 'human-only') title += ' for people only';
  if (query.salaryMin !== null) title += ` paying ${query.salaryMin.toLocaleString('en-US')}+`;
  return title;
}

/** The three workplace variants of a tag page, for a footer or an index. */
export function workplaceLinks(tag: string): { workplace: Workplace; href: string }[] {
  return WORKPLACES.map((workplace) => ({
    workplace,
    href:
      pathForQuery({ ...EMPTY_QUERY, tags: [tag], workplace }) ??
      `/?tags=${encodeURIComponent(tag)}&workplace=${workplace}`,
  }));
}

export { AGENT_POLICIES };
