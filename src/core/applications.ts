/**
 * Applications.
 *
 * The board's own application form is the one an agent can complete, so this
 * is where the "agentic" part of the board is actually load-bearing: the same
 * validator runs whether the answers arrived from an HTML form, a REST call or
 * an MCP tool, and the agent disclosure is a first-class field rather than a
 * sentence someone might write in the cover letter.
 */

import type pg from 'pg';
import {
  APPLICATION_STATUSES,
  type AgentDisclosure,
  type Application,
  type ApplicationStatus,
  type ApplySchema,
  type Job,
} from '../schema/index.ts';
import { clean } from '../schema/text.ts';

interface ApplicationRow {
  id: string;
  job_id: string;
  answers: Record<string, string>;
  agent: AgentDisclosure | null;
  status: string;
  created_at: string;
  submitted_at?: string | null;
}

function toApplication(row: ApplicationRow): Application {
  return {
    id: row.id,
    jobId: row.job_id,
    answers: row.answers ?? {},
    agent: row.agent,
    status: (APPLICATION_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as ApplicationStatus)
      : 'new',
    submittedAt: row.submitted_at ?? null,
    createdAt: row.created_at,
  };
}

export interface ValidationProblem {
  field: string;
  message: string;
}

export interface ValidatedApplication {
  answers: Record<string, string>;
  agent: AgentDisclosure | null;
}

/**
 * Check answers against the schema the job published.
 *
 * Every problem is collected rather than thrown at the first one. A caller
 * that is a model gets one round trip to fix everything instead of one per
 * mistake, and a caller that is a person gets a form that does not lose four
 * fields to reveal a fifth.
 */
export function validateApplication(
  schema: ApplySchema,
  input: Record<string, unknown>,
  policy: Job['agentPolicy'],
): { ok: true; value: ValidatedApplication } | { ok: false; problems: ValidationProblem[] } {
  const problems: ValidationProblem[] = [];
  const answers: Record<string, string> = {};

  for (const field of schema.fields) {
    const raw = input[field.name];
    const value = clean(raw, field.maxLength ?? 2000);

    if (value === '') {
      if (field.required) problems.push({ field: field.name, message: `${field.label} is required.` });
      continue;
    }

    if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      problems.push({ field: field.name, message: `${field.label} is not a valid email address.` });
      continue;
    }
    if (field.type === 'url') {
      try {
        const url = new URL(value.includes('://') ? value : `https://${value}`);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('scheme');
        answers[field.name] = url.toString();
        continue;
      } catch {
        problems.push({ field: field.name, message: `${field.label} is not a valid link.` });
        continue;
      }
    }
    if (field.type === 'select' && field.options !== undefined && field.options.length > 0) {
      const match = field.options.find((option) => option.toLowerCase() === value.toLowerCase());
      if (match === undefined) {
        problems.push({
          field: field.name,
          message: `${field.label} must be one of: ${field.options.join(', ')}.`,
        });
        continue;
      }
      answers[field.name] = match;
      continue;
    }

    answers[field.name] = value;
  }

  const agent = parseDisclosure(input['agent']);

  // The policy is enforced here rather than at the edge so that it holds for
  // the HTML form and the API alike. `human-only` is a request, not a
  // technical control, and saying so plainly is more honest than pretending
  // the board can tell.
  if (policy === 'disclose' && agent === null && input['agent'] !== undefined) {
    problems.push({
      field: 'agent',
      message: 'This employer asks applications written with an agent to say so.',
    });
  }
  if (policy === 'human-only' && agent !== null) {
    problems.push({
      field: 'agent',
      message: 'This employer asks for applications written by a person.',
    });
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: { answers, agent } };
}

function parseDisclosure(value: unknown): AgentDisclosure | null {
  if (value === null || value === undefined || value === false || value === '') return null;
  if (typeof value === 'string') {
    const name = clean(value, 120);
    return name === '' ? null : { name, supervised: false };
  }
  if (typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const name = clean(record['name'], 120);
  if (name === '') return null;
  return { name, supervised: record['supervised'] === true };
}

/**
 * Create an application, sent or held.
 *
 * `submit: false` writes a draft: an agent has prepared it and the candidate
 * has not released it yet. A draft is not an application - the employer never
 * sees one - which is the point. It is the same seam a job posting has, where
 * an employer's agent writes the listing and a person publishes it.
 */
export async function createApplication(
  pool: pg.Pool,
  jobId: string,
  value: ValidatedApplication,
  options: { submit?: boolean } = {},
): Promise<Application> {
  const submit = options.submit !== false;
  const result = await pool.query<ApplicationRow>(
    `insert into applications (job_id, answers, agent, status, submitted_at)
     values ($1, $2::jsonb, $3::jsonb, $4, case when $5 then now() else null end)
     returning id, job_id, answers, agent, status, created_at, submitted_at`,
    [
      jobId,
      JSON.stringify(value.answers),
      value.agent === null ? null : JSON.stringify(value.agent),
      submit ? 'new' : 'draft',
      submit,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('application insert returned no row');
  return toApplication(row);
}

/**
 * Release a draft the candidate has read.
 *
 * Scoped to the owner and to the draft state in one statement, so a second
 * click cannot send it twice and nobody can release someone else's.
 */
export async function submitApplication(
  pool: pg.Pool,
  id: string,
  userId: string,
): Promise<boolean> {
  const result = await pool.query(
    `update applications
        set status = 'new', submitted_at = now()
      where id = $1 and user_id = $2 and submitted_at is null`,
    [id, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listDraftApplications(
  pool: pg.Pool,
  userId: string,
): Promise<(Application & { jobTitle: string; jobSlug: string })[]> {
  const result = await pool.query<ApplicationRow & { job_title: string; job_slug: string }>(
    `select a.id, a.job_id, a.answers, a.agent, a.status, a.created_at, a.submitted_at,
            j.title as job_title, j.slug as job_slug
       from applications a join jobs j on j.id = a.job_id
      where a.user_id = $1 and a.submitted_at is null
      order by a.created_at desc limit 100`,
    [userId],
  );
  return result.rows.map((row) => ({
    ...toApplication(row),
    jobTitle: row.job_title,
    jobSlug: row.job_slug,
  }));
}

export async function listApplications(
  pool: pg.Pool,
  jobId: string,
  limit = 100,
): Promise<Application[]> {
  const result = await pool.query<ApplicationRow>(
    `select id, job_id, answers, agent, status, created_at, submitted_at
       from applications
      where job_id = $1 and submitted_at is not null
      order by created_at desc
      limit $2`,
    [jobId, Math.min(500, Math.max(1, limit))],
  );
  return result.rows.map(toApplication);
}

export async function setApplicationStatus(
  pool: pg.Pool,
  id: string,
  status: ApplicationStatus,
): Promise<boolean> {
  const result = await pool.query(`update applications set status = $2 where id = $1`, [id, status]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * How many applications an address has sent to one board recently.
 *
 * Used as a rate limit. Counting by the answer to the email field rather than
 * by IP is deliberate: an agent applying on someone's behalf legitimately runs
 * from a different address every time, and the thing worth limiting is one
 * person flooding a board, not one network.
 */
export async function recentApplicationCount(
  pool: pg.Pool,
  email: string,
  withinMinutes = 60,
): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `select count(*)::bigint as count
       from applications
      where created_at > now() - ($2 || ' minutes')::interval
        and submitted_at is not null
        and lower(answers ->> 'email') = lower($1)`,
    [email, String(withinMinutes)],
  );
  return result.rows[0]?.count ?? 0;
}
