/**
 * Turning a sentence into a draft listing.
 *
 * The board's thesis is agents hiring agents with a person in control at both
 * ends, and this is that seam on the employer side for somebody who does not
 * have an agent of their own. It fills the form and stops. Nothing is saved,
 * nothing is published, and the person who asked reads every word before the
 * listing exists. A model writing straight into the database would be the one
 * shape this board has said it will not ship.
 *
 * Two providers, because this is MIT software other people self-host and a
 * board that only works if you bank with one vendor is not self-hostable. The
 * key that is set decides; when neither is set the feature is simply absent
 * from the page rather than present and broken.
 *
 * Written against the two REST APIs directly rather than either vendor SDK.
 * One dependency per provider to fill in a form is a poor trade for a package
 * that reads a .docx by unzipping it by hand, and the request shapes here are
 * small enough to read in full.
 */

import type pg from 'pg';
import type { Config } from '../config.ts';
import {
  AGENT_POLICIES,
  EMPLOYMENT_TYPES,
  SALARY_PERIODS,
  SENIORITIES,
  WORKPLACES,
} from '../schema/job.ts';

/** The model was asked and could not answer. Never fatal to the page. */
export class AgentWriterProblem extends Error {}

export type WriterProvider = 'anthropic' | 'openai';

/**
 * Which provider this instance can use, or null for none.
 *
 * Anthropic first when both are set, for no better reason than that a board
 * with both keys has to pick one and a coin flip at request time would make
 * the same brief produce different listings.
 */
export function writerProvider(config: Config): WriterProvider | null {
  if (config.anthropicApiKey !== null) return 'anthropic';
  if (config.openaiApiKey !== null) return 'openai';
  return null;
}

/**
 * What the model is asked for, and what it is asked not to do.
 *
 * The pay rules are the ones that matter. An invented salary range is worse
 * than an empty one: the employer may not notice it, and a candidate who
 * applies because of a number nobody agreed to has been misled by this board.
 * So pay comes from the brief or not at all, and "unpaid" has to be stated
 * rather than inferred from silence.
 */
const SYSTEM = [
  'You write job listings for a job board. You are given a short brief from the',
  'employer and you expand it into a complete listing.',
  '',
  'Return a single JSON object and nothing else. Every field is optional; leave',
  'out anything the brief does not support.',
  '',
  '  title                a specific role title, under 80 characters',
  '  description          Markdown. What the work is, who it suits, how the team',
  '                       operates. Write in the employer\'s voice, second person',
  '                       to the reader. No headings above level 2. 150-350 words.',
  '  requirements         array of short strings',
  '  responsibilities     array of short strings',
  '  tags                 array of lowercase topic words',
  '  stack                array of lowercase technology names',
  '  employmentType       one of: full-time, part-time, contract, internship, temporary',
  '  workplace            one of: remote, hybrid, onsite',
  '  seniority            one of: intern, junior, mid, senior, staff, principal, lead',
  '  location             free text, only if the brief gives one',
  '  salaryMin            integer, ONLY if the brief states pay',
  '  salaryMax            integer, ONLY if the brief states pay',
  '  salaryPeriod         one of: hour, day, week, month, year',
  '  salaryUnpaid         true ONLY if the brief says the role is unpaid',
  '',
  'Rules you do not break:',
  '- Never invent compensation. If the brief says nothing about pay, omit every',
  '  salary field. A number nobody agreed to is worse than no number.',
  '- Never invent a company name, a benefit, a funding stage, or a headcount.',
  '- Do not write "competitive salary", "rockstar", "ninja", or "fast-paced".',
  '- Do not address the reader as a candidate in the description title.',
].join('\n');

interface Context {
  boardName: string;
  orgName: string | null;
}

/**
 * A brief, expanded into values the post form can be rendered with.
 *
 * Returns form values rather than a job, because the next thing that happens
 * is that a person looks at them. They go through the same `normaliseInput`
 * every other posting path goes through when the form is finally submitted,
 * so nothing here can put a listing into a state a hand-typed one could not
 * reach.
 */
export async function draftListing(
  brief: string,
  context: Context,
  config: Config,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, string>> {
  const trimmed = brief.trim();
  if (trimmed.length < 10) {
    throw new AgentWriterProblem('Say a little more about the role, and I will draft it.');
  }

  const provider = writerProvider(config);
  if (provider === null) {
    throw new AgentWriterProblem('This board has no model configured.');
  }

  const prompt = [
    `Board: ${context.boardName}.`,
    context.orgName === null ? null : `Employer: ${context.orgName}.`,
    '',
    'The brief:',
    trimmed.slice(0, 4000),
  ]
    .filter((line) => line !== null)
    .join('\n');

  const raw =
    provider === 'anthropic'
      ? await askAnthropic(prompt, config, fetchImpl)
      : await askOpenAi(prompt, config, fetchImpl);

  return fieldsFromModelJson(raw);
}

/**
 * The Messages API, by hand.
 *
 * Thinking is on by default on this model and `effort: low` is right for
 * filling in a form: the work is recall and phrasing, not reasoning, and the
 * person is waiting on a page for it.
 */
async function askAnthropic(
  prompt: string,
  config: Config,
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.anthropicApiKey ?? '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.writerModel ?? 'claude-opus-5',
      max_tokens: 4000,
      output_config: { effort: 'low' },
      system: SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) throw await problemFor(response, 'Anthropic');

  const body = (await response.json()) as {
    content?: { type: string; text?: string }[];
    stop_reason?: string;
  };
  // A refusal arrives as a 200 with nothing usable in it, so the status alone
  // is not evidence that there is text to read.
  if (body.stop_reason === 'refusal') {
    throw new AgentWriterProblem('The model declined to write that one.');
  }
  const text = (body.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
  if (text.trim() === '') throw new AgentWriterProblem('The model returned nothing.');
  return text;
}

/**
 * Chat completions, by hand.
 *
 * `max_completion_tokens`, not `max_tokens`: the current models reject the
 * older name. `json_object` is what keeps the reply parseable without asking
 * the model nicely twice.
 */
async function askOpenAi(
  prompt: string,
  config: Config,
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.openaiApiKey ?? ''}`,
    },
    body: JSON.stringify({
      model: config.writerModel ?? 'gpt-5.2',
      max_completion_tokens: 4000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!response.ok) throw await problemFor(response, 'OpenAI');

  const body = (await response.json()) as {
    choices?: { message?: { content?: string | null; refusal?: string | null } }[];
  };
  const choice = body.choices?.[0]?.message;
  if (typeof choice?.refusal === 'string' && choice.refusal !== '') {
    throw new AgentWriterProblem('The model declined to write that one.');
  }
  const text = choice?.content ?? '';
  if (text.trim() === '') throw new AgentWriterProblem('The model returned nothing.');
  return text;
}

/**
 * An HTTP failure, said in words a person on a form can act on.
 *
 * The provider's own message is deliberately not shown: it is written for
 * whoever holds the key, not for the employer typing a brief, and it can
 * carry account details that do not belong on a public page.
 */
async function problemFor(response: Response, provider: string): Promise<AgentWriterProblem> {
  // Read and discard, so the connection is not left hanging on a body nobody
  // consumed.
  await response.text().catch(() => '');
  if (response.status === 401 || response.status === 403) {
    return new AgentWriterProblem(`This board's ${provider} key was rejected.`);
  }
  if (response.status === 429) {
    return new AgentWriterProblem('The model is rate limited right now. Try again shortly.');
  }
  return new AgentWriterProblem(`${provider} could not be reached. Try again shortly.`);
}

/**
 * The model's JSON, reduced to form values this board will accept.
 *
 * Everything is checked against the same lists the form's own selects are
 * built from, and anything unrecognised is dropped rather than corrected. A
 * model that invents an employment type should leave that field blank for a
 * person to fill in, not have its answer bent into the nearest legal value:
 * the second one looks like the employer chose it.
 *
 * Exported because this is the part worth testing, and testing it needs no
 * network and no key.
 */
export function fieldsFromModelJson(raw: string): Record<string, string> {
  const parsed = parseLoose(raw);
  if (parsed === null) throw new AgentWriterProblem('The model did not return a listing.');

  const out: Record<string, string> = {};
  const put = (key: string, value: string): void => {
    if (value.trim() !== '') out[key] = value.trim();
  };

  put('title', text(parsed['title'], 140));
  put('description', text(parsed['description'], 20_000));
  put('location', text(parsed['location'], 120));

  put('employmentType', oneOf(parsed['employmentType'], EMPLOYMENT_TYPES));
  put('workplace', oneOf(parsed['workplace'], WORKPLACES));
  put('seniority', oneOf(parsed['seniority'], SENIORITIES));
  put('salaryPeriod', oneOf(parsed['salaryPeriod'], SALARY_PERIODS));
  put('agentPolicy', oneOf(parsed['agentPolicy'], AGENT_POLICIES));

  put('tags', list(parsed['tags'], 12));
  put('stack', list(parsed['stack'], 20));
  put('requirements', bullets(parsed['requirements']));
  put('responsibilities', bullets(parsed['responsibilities']));

  // Pay only survives if the model actually returned a number. "Unpaid" and a
  // range are mutually exclusive here for the same reason they are everywhere
  // else on the board.
  if (parsed['salaryUnpaid'] === true) {
    out['salaryUnpaid'] = 'on';
  } else {
    put('salaryMin', amount(parsed['salaryMin']));
    put('salaryMax', amount(parsed['salaryMax']));
  }

  if (out['title'] === undefined && out['description'] === undefined) {
    throw new AgentWriterProblem('The model did not return a listing.');
  }
  return out;
}

/**
 * JSON, whether or not it arrived alone.
 *
 * Both providers were asked for a bare object and both usually send one, but a
 * model that wraps it in a ```json fence has still done the job, and failing
 * the whole request over a fence would be the wrong place to be strict.
 */
function parseLoose(raw: string): Record<string, unknown> | null {
  const attempts = [raw];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  if (fenced !== null) attempts.push(fenced[1] ?? '');
  const braced = /\{[\s\S]*\}/.exec(raw);
  if (braced !== null) attempts.push(braced[0]);

  for (const attempt of attempts) {
    try {
      const value: unknown = JSON.parse(attempt);
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // Try the next shape.
    }
  }
  return null;
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function oneOf(value: unknown, allowed: readonly string[]): string {
  if (typeof value !== 'string') return '';
  const found = allowed.find((item) => item === value.trim().toLowerCase());
  return found ?? '';
}

function amount(value: unknown): string {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return '';
  return String(Math.min(100_000_000, Math.round(parsed)));
}

/** The form takes these comma separated, which is how a person edits them. */
function list(value: unknown, max: number): string {
  if (!Array.isArray(value)) return typeof value === 'string' ? value : '';
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '' && item.length <= 40)
    .slice(0, max)
    .join(', ');
}

/** And these one per line. */
function bullets(value: unknown): string {
  if (!Array.isArray(value)) return typeof value === 'string' ? value : '';
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().replace(/^[-*]\s*/, ''))
    .filter((item) => item !== '')
    .slice(0, 20)
    .join('\n');
}

/**
 * How many drafts this account has asked for in the last hour.
 *
 * The ceiling is per account rather than per board: one employer writing four
 * listings in an afternoon is the use case, and a shared board-wide limit
 * would let one of them lock out everybody else.
 */
export const DRAFTS_PER_HOUR = 10;

export async function recentDraftCount(pool: pg.Pool, userId: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `select count(*)::int as count
       from agent_drafts
      where user_id = $1
        and created_at > now() - interval '1 hour'`,
    [userId],
  );
  return result.rows[0]?.count ?? 0;
}

/**
 * Recorded before the model is called, not after.
 *
 * A request that fails still cost the board something and still came from
 * somebody, so counting only the successes would leave the cheapest way to
 * burn the key uncounted.
 */
export async function recordDraft(pool: pg.Pool, userId: string): Promise<void> {
  await pool.query(`insert into agent_drafts (user_id) values ($1)`, [userId]);
}
