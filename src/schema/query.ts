/**
 * One query shape, used by the page, the API, MCP, the CLI and the federated
 * search across instances.
 *
 * Federation is the reason this is a declared type rather than whatever
 * querystring each surface felt like parsing: a search fanned out to twelve
 * instances has to mean the same thing on all of them, and an instance running
 * an older release has to be able to ignore a field it does not know without
 * silently returning the wrong set.
 */

import {
  isAgentPolicy,
  isEmploymentType,
  isSeniority,
  isWorkplace,
  type AgentPolicy,
  type EmploymentType,
  type Seniority,
  type Workplace,
} from './job.ts';

export const SORTS = ['recent', 'relevant', 'salary'] as const;
export type Sort = (typeof SORTS)[number];

export interface JobQuery {
  /** Full text over title, description, tags and stack. */
  q: string | null;
  employmentType: EmploymentType | null;
  workplace: Workplace | null;
  seniority: Seniority | null;
  agentPolicy: AgentPolicy | null;
  tags: string[];
  /** Minimum annualised salary, in the instance's currency. */
  salaryMin: number | null;
  org: string | null;
  sort: Sort;
  limit: number;
  offset: number;
}

export const MAX_LIMIT = 100;

export const EMPTY_QUERY: JobQuery = {
  q: null,
  employmentType: null,
  workplace: null,
  seniority: null,
  agentPolicy: null,
  tags: [],
  salaryMin: null,
  org: null,
  sort: 'recent',
  limit: 25,
  offset: 0,
};

function one(params: URLSearchParams, key: string): string | null {
  const value = params.get(key);
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function integer(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || !/^[+-]?\d+$/.test(value)) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Parse a querystring into a query.
 *
 * Unknown values are dropped rather than rejected. A filter this instance does
 * not understand must not turn a federated search into an error on one node
 * and a result set on the rest — the user would see a shorter list and no
 * explanation.
 */
export function parseQuery(params: URLSearchParams): JobQuery {
  const employmentType = one(params, 'employmentType');
  const workplace = one(params, 'workplace');
  const seniority = one(params, 'seniority');
  const agentPolicy = one(params, 'agentPolicy');
  const sort = one(params, 'sort');
  const salaryMin = one(params, 'salaryMin');

  return {
    q: one(params, 'q'),
    employmentType: isEmploymentType(employmentType) ? employmentType : null,
    workplace: isWorkplace(workplace) ? workplace : null,
    seniority: isSeniority(seniority) ? seniority : null,
    agentPolicy: isAgentPolicy(agentPolicy) ? agentPolicy : null,
    // `tag=a&tag=b` and `tags=a,b` mean the same thing. The second is what a
    // badge links to and what a person types; the first is what the CLI's
    // repeatable --tag produces.
    tags: [...params.getAll('tag'), ...params.getAll('tags')]
      .flatMap((value) => value.split(','))
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value !== '')
      .slice(0, 10),
    salaryMin: salaryMin === null ? null : integer(salaryMin, 0, 0, 100_000_000) || null,
    org: one(params, 'org'),
    sort: sort !== null && (SORTS as readonly string[]).includes(sort) ? (sort as Sort) : 'recent',
    limit: integer(one(params, 'limit'), 25, 1, MAX_LIMIT),
    offset: integer(one(params, 'offset'), 0, 0, 100_000),
  };
}

/** The inverse, so a client can rebuild a link to the search it just ran. */
export function queryToParams(query: JobQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.employmentType) params.set('employmentType', query.employmentType);
  if (query.workplace) params.set('workplace', query.workplace);
  if (query.seniority) params.set('seniority', query.seniority);
  if (query.agentPolicy) params.set('agentPolicy', query.agentPolicy);
  // Written back in the comma form, so a link a person can read is what ends
  // up in the address bar and in anything that copies it.
  if (query.tags.length > 0) params.set('tags', query.tags.join(','));
  if (query.salaryMin !== null) params.set('salaryMin', String(query.salaryMin));
  if (query.org) params.set('org', query.org);
  if (query.sort !== 'recent') params.set('sort', query.sort);
  if (query.limit !== 25) params.set('limit', String(query.limit));
  if (query.offset !== 0) params.set('offset', String(query.offset));
  return params;
}

export interface JobPage<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
