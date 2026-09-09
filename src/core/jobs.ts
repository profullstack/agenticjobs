/**
 * Reading and writing jobs.
 *
 * Every surface goes through here, and all of them get the same rows: the
 * pages, the REST API, MCP, the CLI, the TUI and a federated search arriving
 * from another instance. There is deliberately no second read path.
 */

import type pg from 'pg';
import {
  DEFAULT_APPLY_SCHEMA,
  isAgentPolicy,
  isEmploymentType,
  isSeniority,
  isSalaryPeriod,
  isWorkplace,
  type AgentPolicy,
  type ApplyMethod,
  type ApplySchema,
  type EmploymentType,
  type Job,
  type JobPage,
  type JobQuery,
  type JobStatus,
  type Organisation,
  type Seniority,
  type Workplace,
} from '../schema/index.ts';
import { clean, parseList, slugify, suffix } from '../schema/text.ts';

interface JobRow {
  id: string;
  slug: string;
  title: string;
  description: string;
  employment_type: string;
  workplace: string;
  seniority: string | null;
  location: string | null;
  remote_regions: string[];
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string;
  salary_period: string;
  salary_equity: string | null;
  salary_unpaid: boolean | null;
  tags: string[];
  stack: string[];
  requirements: string[];
  responsibilities: string[];
  agent_policy: string;
  apply_via: string;
  apply_url: string | null;
  apply_source_url: string | null;
  apply_email: string | null;
  apply_schema: ApplySchema | null;
  status: string;
  published_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  org_id: string;
  org_slug: string;
  org_name: string;
  org_website: string | null;
  org_logo_url: string | null;
  org_description: string | null;
  org_created_at: string;
}

const SELECT = `
  select j.id, j.slug, j.title, j.description, j.employment_type, j.workplace, j.seniority,
         j.location, j.remote_regions, j.salary_min, j.salary_max, j.salary_currency,
         j.salary_period, j.salary_equity, j.salary_unpaid, j.tags, j.stack, j.requirements, j.responsibilities,
         j.agent_policy, j.apply_via, j.apply_url, j.apply_email, j.apply_schema,
         j.apply_source_url, j.status,
         j.published_at, j.expires_at, j.created_at, j.updated_at,
         o.id as org_id, o.slug as org_slug, o.name as org_name, o.website as org_website,
         o.logo_url as org_logo_url, o.description as org_description,
         o.created_at as org_created_at
  from jobs j
  join organisations o on o.id = j.org_id
`;

function toOrganisation(row: JobRow): Organisation {
  return {
    id: row.org_id,
    slug: row.org_slug,
    name: row.org_name,
    website: row.org_website,
    logoUrl: row.org_logo_url,
    description: row.org_description,
    createdAt: row.org_created_at,
  };
}

/**
 * Every job is applied to here.
 *
 * Rows written before offsite applications were removed still carry
 * `apply_via = 'url'` or `'email'`, and they read back as board applications:
 * the migration rewrites the column, and this is what makes a row the
 * migration has not reached yet safe to serve. The board's own form is the one
 * target that cannot go missing.
 */
function toApplyMethod(row: JobRow): ApplyMethod {
  return { via: 'board', schema: row.apply_schema ?? DEFAULT_APPLY_SCHEMA };
}

export function toJob(row: JobRow): Job {
  return {
    id: row.id,
    slug: row.slug,
    org: toOrganisation(row),
    title: row.title,
    description: row.description,
    employmentType: isEmploymentType(row.employment_type)
      ? row.employment_type
      : ('full-time' as EmploymentType),
    workplace: isWorkplace(row.workplace) ? row.workplace : ('remote' as Workplace),
    seniority: isSeniority(row.seniority) ? (row.seniority as Seniority) : null,
    location: row.location,
    remoteRegions: row.remote_regions ?? [],
    salary: {
      min: row.salary_min,
      max: row.salary_max,
      currency: row.salary_currency,
      period: isSalaryPeriod(row.salary_period) ? row.salary_period : 'year',
      equity: row.salary_equity,
      unpaid: row.salary_unpaid === true,
    },
    tags: row.tags ?? [],
    stack: row.stack ?? [],
    requirements: row.requirements ?? [],
    responsibilities: row.responsibilities ?? [],
    agentPolicy: isAgentPolicy(row.agent_policy) ? row.agent_policy : ('disclose' as AgentPolicy),
    apply: toApplyMethod(row),
    status: (['draft', 'published', 'closed'] as string[]).includes(row.status)
      ? (row.status as JobStatus)
      : 'draft',
    publishedAt: row.published_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Builds the where clause shared by search and count, so they cannot drift. */
function conditions(query: JobQuery, includeUnpublished: boolean): {
  sql: string;
  params: unknown[];
} {
  const params: unknown[] = [];
  const where: string[] = [];

  if (!includeUnpublished) {
    where.push(`j.status = 'published'`);
    where.push(`j.published_at is not null and j.published_at <= now()`);
    // An expired listing stops appearing without anyone having to run a sweep.
    where.push(`(j.expires_at is null or j.expires_at > now())`);
  }

  if (query.q !== null) {
    params.push(query.q);
    where.push(`j.search @@ websearch_to_tsquery('english', $${params.length})`);
  }
  if (query.employmentType !== null) {
    params.push(query.employmentType);
    where.push(`j.employment_type = $${params.length}`);
  }
  if (query.workplace !== null) {
    params.push(query.workplace);
    where.push(`j.workplace = $${params.length}`);
  }
  if (query.seniority !== null) {
    params.push(query.seniority);
    where.push(`j.seniority = $${params.length}`);
  }
  if (query.agentPolicy !== null) {
    params.push(query.agentPolicy);
    where.push(`j.agent_policy = $${params.length}`);
  }
  if (query.tags.length > 0) {
    params.push(query.tags);
    // Matching either list means "python" finds a job that called it a tag and
    // one that called it part of the stack.
    where.push(`(j.tags && $${params.length}::text[] or j.stack && $${params.length}::text[])`);
  }
  if (query.salaryMin !== null) {
    params.push(query.salaryMin);
    // Compared against the top of the range: a listing that says 90k-140k is a
    // match for someone who needs 120k, and one that says 90k-100k is not.
    where.push(`coalesce(j.salary_max, j.salary_min) >= $${params.length}`);
  }
  if (query.org !== null) {
    params.push(query.org);
    where.push(`o.slug = $${params.length}`);
  }

  return { sql: where.length === 0 ? '' : `where ${where.join(' and ')}`, params };
}

function orderBy(query: JobQuery): string {
  if (query.sort === 'salary') {
    return `order by coalesce(j.salary_max, j.salary_min, 0) desc, j.published_at desc nulls last`;
  }
  if (query.sort === 'relevant' && query.q !== null) {
    // ts_rank against the same tsquery the where clause used. Without a query
    // string there is nothing to rank against, so this falls through.
    return `order by ts_rank(j.search, websearch_to_tsquery('english', $1)) desc, j.published_at desc nulls last`;
  }
  return `order by j.published_at desc nulls last, j.created_at desc`;
}

export async function searchJobs(
  pool: pg.Pool,
  query: JobQuery,
  options: { includeUnpublished?: boolean } = {},
): Promise<JobPage<Job>> {
  const includeUnpublished = options.includeUnpublished === true;
  const { sql: whereSql, params } = conditions(query, includeUnpublished);

  const counted = await pool.query<{ total: number }>(
    `select count(*)::bigint as total from jobs j join organisations o on o.id = j.org_id ${whereSql}`,
    params,
  );

  const listParams = [...params, query.limit, query.offset];
  const rows = await pool.query<JobRow>(
    `${SELECT} ${whereSql} ${orderBy(query)} limit $${listParams.length - 1} offset $${listParams.length}`,
    listParams,
  );

  return {
    items: rows.rows.map(toJob),
    total: counted.rows[0]?.total ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

export async function getJobBySlug(
  pool: pg.Pool,
  slug: string,
  options: { includeUnpublished?: boolean } = {},
): Promise<Job | null> {
  const visible =
    options.includeUnpublished === true
      ? ''
      : `and j.status = 'published' and j.published_at is not null and j.published_at <= now()`;
  const result = await pool.query<JobRow>(`${SELECT} where j.slug = $1 ${visible} limit 1`, [slug]);
  const row = result.rows[0];
  return row === undefined ? null : toJob(row);
}

export async function getJobById(pool: pg.Pool, id: string): Promise<Job | null> {
  const result = await pool.query<JobRow>(`${SELECT} where j.id = $1 limit 1`, [id]);
  const row = result.rows[0];
  return row === undefined ? null : toJob(row);
}

export interface JobInput {
  orgId: string;
  title: string;
  description: string;
  employmentType: EmploymentType;
  workplace: Workplace;
  seniority: Seniority | null;
  location: string | null;
  remoteRegions: string[];
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string;
  salaryPeriod: string;
  salaryEquity: string | null;
  salaryUnpaid: boolean;
  tags: string[];
  stack: string[];
  requirements: string[];
  responsibilities: string[];
  agentPolicy: AgentPolicy;
  apply: ApplyMethod;
  expiresAt: string | null;
  /** Where this listing was imported from, if it was. Provenance, not a destination. */
  sourceUrl: string | null;
}

/**
 * Turn whatever a form, an API client or a model sent into a job we are
 * willing to store. Anything unrecognised falls back rather than throwing:
 * a posting rejected wholesale because one enum was misspelled is a posting
 * an agent cannot fix without a human.
 */
export function normaliseInput(input: Record<string, unknown>, orgId: string): JobInput | string {
  const title = clean(input['title'], 140);
  if (title.length < 3) return 'A title of at least 3 characters is required.';

  // Markdown, so the line breaks are the structure and must survive.
  const description = clean(input['description'], 20_000, { multiline: true });
  if (description.length < 20) return 'A description of at least 20 characters is required.';

  const employmentType = isEmploymentType(input['employmentType'])
    ? input['employmentType']
    : 'full-time';
  const workplace = isWorkplace(input['workplace']) ? input['workplace'] : 'remote';
  const seniority = isSeniority(input['seniority']) ? input['seniority'] : null;
  const agentPolicy = isAgentPolicy(input['agentPolicy']) ? input['agentPolicy'] : 'disclose';

  // Unpaid wins over any number that came with it. A form can post a stale
  // range alongside a ticked box, and "unpaid, $40k - $60k a year" is not a
  // listing anybody can act on.
  const salaryUnpaid = truthy(input['salaryUnpaid']);
  const salaryMin = salaryUnpaid ? null : money(input['salaryMin']);
  const salaryMax = salaryUnpaid ? null : money(input['salaryMax']);
  if (salaryMin !== null && salaryMax !== null && salaryMax < salaryMin) {
    return 'The top of the salary range is below the bottom of it.';
  }

  const apply = normaliseApply(input);
  if (typeof apply === 'string') return apply;

  const location = clean(input['location'], 120);

  return {
    orgId,
    title,
    description,
    employmentType,
    workplace,
    seniority,
    location: location === '' ? null : location,
    remoteRegions: parseList(input['remoteRegions'], 30, 8).map((code) => code.toUpperCase()),
    salaryMin,
    salaryMax,
    salaryCurrency: (clean(input['salaryCurrency'], 3) || 'USD').toUpperCase(),
    salaryPeriod: isSalaryPeriod(input['salaryPeriod']) ? input['salaryPeriod'] : 'year',
    salaryEquity: clean(input['salaryEquity'], 60) || null,
    salaryUnpaid,
    tags: parseList(input['tags'], 12),
    stack: parseList(input['stack'], 20),
    requirements: lines(input['requirements'], 20),
    responsibilities: lines(input['responsibilities'], 20),
    agentPolicy,
    apply,
    expiresAt: date(input['expiresAt']),
    // Set by the importer, never by a poster: it records where a listing was
    // read from, and a hand-typed one was read from nowhere.
    sourceUrl: null,
  };
}

function normaliseApply(input: Record<string, unknown>): ApplyMethod | string {
  // Applications happen here. A listing that points somewhere else is a link
  // to a job rather than a job, and an agent cannot complete a form it cannot
  // reach. Refused with the reason rather than silently rewritten to `board`,
  // because an employer who asked for an offsite link and got a board form
  // without being told would find out from the applications.
  const via = clean(input['applyVia'], 10) || 'board';
  if (via !== 'board') {
    return 'Applications are taken on this board. Import a job from a URL instead of linking out to one.';
  }
  const schema = input['applySchema'];
  if (schema !== undefined && schema !== null) {
    const parsed = normaliseApplySchema(schema);
    if (parsed !== null) return { via: 'board', schema: parsed };
  }
  return { via: 'board', schema: DEFAULT_APPLY_SCHEMA };
}

const FIELD_TYPES = ['text', 'textarea', 'email', 'url', 'select', 'file'] as const;

export function normaliseApplySchema(input: unknown): ApplySchema | null {
  if (typeof input !== 'object' || input === null) return null;
  const fields = (input as Record<string, unknown>)['fields'];
  if (!Array.isArray(fields)) return null;

  const seen = new Set<string>();
  const out = [];
  for (const raw of fields.slice(0, 25)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const field = raw as Record<string, unknown>;
    // The name becomes a form input name and a JSON key on the way back in,
    // so it is restricted rather than cleaned.
    const name = clean(field['name'], 40).replace(/[^a-zA-Z0-9_]/g, '');
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    const type = clean(field['type'], 10);
    out.push({
      name,
      label: clean(field['label'], 120) || name,
      type: (FIELD_TYPES as readonly string[]).includes(type)
        ? (type as (typeof FIELD_TYPES)[number])
        : 'text',
      required: field['required'] === true,
      ...(Array.isArray(field['options'])
        ? { options: parseList(field['options'], 30, 80) }
        : {}),
      ...(clean(field['help'], 200) ? { help: clean(field['help'], 200) } : {}),
      maxLength: Math.min(20_000, Math.max(1, Number(field['maxLength']) || 2000)),
    });
  }
  return out.length === 0 ? null : { fields: out };
}

/**
 * A boolean as it arrives from either surface.
 *
 * An HTML checkbox posts the string "on" and posts nothing at all when it is
 * clear, while the API sends a real boolean. Both have to mean the same thing,
 * and an absent field has to read as false rather than as "unchanged", or a
 * form that clears the box would never clear it.
 */
function truthy(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function money(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(String(value).replace(/[^0-9]/g, ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(100_000_000, parsed);
}

function date(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function lines(value: unknown, max: number): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/\r?\n/)
      : [];
  return raw
    .map((line) => clean(line, 300).replace(/^[-*]\s*/, ''))
    .filter((line) => line !== '')
    .slice(0, max);
}

/** Reserve a slug, adding a suffix only when the plain one is taken. */
async function uniqueSlug(pool: pg.Pool, title: string): Promise<string> {
  const base = slugify(title);
  const taken = await pool.query<{ slug: string }>(
    `select slug from jobs where slug = $1 or slug like $2`,
    [base, `${base}-%`],
  );
  if (!taken.rows.some((row) => row.slug === base)) return base;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = `${base}-${suffix()}`;
    if (!taken.rows.some((row) => row.slug === candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export async function createJob(pool: pg.Pool, input: JobInput): Promise<Job> {
  const slug = await uniqueSlug(pool, input.title);
  const result = await pool.query<{ id: string }>(
    `insert into jobs (
       slug, org_id, title, description, employment_type, workplace, seniority, location,
       remote_regions, salary_min, salary_max, salary_currency, salary_period, salary_equity,
       salary_unpaid, tags, stack, requirements, responsibilities, agent_policy, apply_via,
       apply_url, apply_email, apply_schema, apply_source_url, expires_at, status
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,'draft'
     ) returning id`,
    [
      slug,
      input.orgId,
      input.title,
      input.description,
      input.employmentType,
      input.workplace,
      input.seniority,
      input.location,
      input.remoteRegions,
      input.salaryMin,
      input.salaryMax,
      input.salaryCurrency,
      input.salaryPeriod,
      input.salaryEquity,
      input.salaryUnpaid,
      input.tags,
      input.stack,
      input.requirements,
      input.responsibilities,
      input.agentPolicy,
      input.apply.via,
      null,
      null,
      JSON.stringify(input.apply.schema),
      input.sourceUrl,
      input.expiresAt,
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('insert returned no row');
  const job = await getJobById(pool, id);
  if (job === null) throw new Error('inserted job could not be read back');
  return job;
}

export async function setStatus(
  pool: pg.Pool,
  id: string,
  status: JobStatus,
): Promise<Job | null> {
  await pool.query(
    `update jobs
        set status = $2,
            published_at = case
              when $2 = 'published' and published_at is null then now()
              else published_at
            end
      where id = $1`,
    [id, status],
  );
  return getJobById(pool, id);
}

/**
 * Refresh a listing from a re-import.
 *
 * Only the fields an import can actually supply are touched, and only when the
 * new value is present: a re-import that could not read a location must not
 * erase one a person typed in. Status is untouched, so refreshing a published
 * listing does not unpublish it and refreshing a draft does not publish it.
 */
export async function updateJobFromImport(
  pool: pg.Pool,
  id: string,
  fields: {
    title?: string;
    description?: string;
    employmentType?: EmploymentType;
    workplace?: Workplace;
    location?: string;
    sourceUrl?: string;
  },
): Promise<Job | null> {
  await pool.query(
    `update jobs
        set title = coalesce($2, title),
            description = coalesce($3, description),
            employment_type = coalesce($4, employment_type),
            workplace = coalesce($5, workplace),
            location = coalesce($6, location),
            apply_source_url = coalesce($7, apply_source_url),
            updated_at = now()
      where id = $1`,
    [
      id,
      fields.title ?? null,
      fields.description ?? null,
      fields.employmentType ?? null,
      fields.workplace ?? null,
      fields.location ?? null,
      fields.sourceUrl ?? null,
    ],
  );
  return getJobById(pool, id);
}

/**
 * Rewrite a listing's content.
 *
 * Takes the same shape `createJob` takes, so an edit cannot put a listing into
 * a state a post could not have created. Slug, status and org are untouched:
 * the slug is the listing's public URL and editing must not break links to it.
 */
export async function editJob(pool: pg.Pool, id: string, input: JobInput): Promise<Job | null> {
  await pool.query(
    `update jobs
        set title = $2, description = $3, employment_type = $4, workplace = $5,
            seniority = $6, location = $7, remote_regions = $8,
            salary_min = $9, salary_max = $10, salary_currency = $11,
            salary_period = $12, salary_equity = $13, salary_unpaid = $14,
            tags = $15, stack = $16, requirements = $17, responsibilities = $18,
            agent_policy = $19, expires_at = $20, updated_at = now()
      where id = $1`,
    [
      id,
      input.title,
      input.description,
      input.employmentType,
      input.workplace,
      input.seniority,
      input.location,
      input.remoteRegions,
      input.salaryMin,
      input.salaryMax,
      input.salaryCurrency,
      input.salaryPeriod,
      input.salaryEquity,
      input.salaryUnpaid,
      input.tags,
      input.stack,
      input.requirements,
      input.responsibilities,
      input.agentPolicy,
      input.expiresAt,
    ],
  );
  return getJobById(pool, id);
}

/** The listing imported from this URL, if there is one. */
export async function getJobBySourceUrl(pool: pg.Pool, url: string): Promise<Job | null> {
  const result = await pool.query<{ id: string }>(
    `select id from jobs where apply_source_url = $1 order by created_at desc limit 1`,
    [url],
  );
  const id = result.rows[0]?.id;
  return id === undefined ? null : getJobById(pool, id);
}

export async function countJobs(pool: pg.Pool): Promise<{ open: number; total: number }> {
  const result = await pool.query<{ open: number; total: number }>(
    `select
       count(*) filter (
         where status = 'published'
           and published_at is not null and published_at <= now()
           and (expires_at is null or expires_at > now())
       )::bigint as open,
       count(*)::bigint as total
     from jobs`,
  );
  return { open: result.rows[0]?.open ?? 0, total: result.rows[0]?.total ?? 0 };
}
