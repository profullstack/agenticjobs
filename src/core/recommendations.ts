/**
 * Recommendations: what somebody who worked with you says about you, on
 * your page once you have agreed to it.
 *
 * Not a rating. A star out of five from a stranger who paid you once is a
 * number that says nothing and cannot be answered, and it is the thing that
 * turns a profile into a scoreboard. A recommendation is a paragraph with a
 * name on it, and it goes on your page only when you approve it. Reject it
 * and nothing is shown, to anybody. That is the model LinkedIn settled on,
 * and it is the right one for a board where every profile is a person's own
 * document.
 *
 * Both directions, because the board is symmetric: an employer recommends a
 * candidate it hired, and a candidate recommends an employer they worked
 * for. Each side is a person or an employer, exactly as a message is, and
 * for the same reason: a recommendation from "Acme" outlives the member who
 * typed it, and one from a person has a page behind it that can be read.
 *
 * What keeps this honest:
 *
 *  - The author has a page. A person recommends as themselves only with a
 *    published resume; an employer's member recommends as the employer. A
 *    recommendation from an account made this morning is not worth showing
 *    and is not accepted.
 *  - One per author per subject. Writing it again replaces the words and
 *    goes back to pending for the subject to read again.
 *  - Ten a day per person, whichever side they wrote for.
 *  - The subject decides, and can change their mind: an approved one can be
 *    taken down later, and a rejected one stays rejected until the author
 *    rewrites it.
 */

import type pg from 'pg';
import { clean } from '../schema/text.ts';
import { candidateName } from './updates.ts';
import type { Mailer } from './mail.ts';
import { escapeHtml } from '../markup/escape.ts';

export const BODY_MIN = 20;
export const BODY_MAX = 2000;
export const RELATIONSHIP_MAX = 120;
/** Per person, per day. */
export const DAILY_LIMIT = 10;

export type RecommendationStatus = 'pending' | 'approved' | 'rejected';
export type Party = { kind: 'candidate'; userId: string } | { kind: 'employer'; orgId: string };

export interface RecommendationParty {
  kind: 'candidate' | 'employer';
  name: string;
  /** The page, or null when the party has none any more. */
  slug: string | null;
}

export interface Recommendation {
  id: string;
  body: string;
  relationship: string | null;
  status: RecommendationStatus;
  author: RecommendationParty;
  subject: RecommendationParty;
  createdAt: string;
  decidedAt: string | null;
}

interface Row {
  id: string;
  body: string;
  relationship: string | null;
  status: string;
  created_at: string;
  decided_at: string | null;
  author_user_id: string | null;
  author_org_id: string | null;
  user_id: string | null;
  org_id: string | null;
  a_org_slug: string | null;
  a_org_name: string | null;
  s_org_slug: string | null;
  s_org_name: string | null;
  a_user_name: string | null;
  a_resume_name: string | null;
  a_resume_title: string | null;
  a_resume_slug: string | null;
  s_user_name: string | null;
  s_resume_name: string | null;
  s_resume_title: string | null;
  s_resume_slug: string | null;
}

/**
 * Both sides resolved for display, the same way an update's author is: an
 * employer by name and slug, a person by the resume they published. A
 * person whose resume has since gone private keeps their name on what they
 * wrote and loses the link, which is what "no page" should look like.
 */
const SELECT = `
  select r.id, r.body, r.relationship, r.status, r.created_at, r.decided_at,
         r.author_user_id, r.author_org_id, r.user_id, r.org_id,
         ao.slug as a_org_slug, ao.name as a_org_name,
         so.slug as s_org_slug, so.name as s_org_name,
         au.name as a_user_name, ar.parsed->>'name' as a_resume_name, ar.title as a_resume_title,
         ar.public_slug as a_resume_slug,
         su.name as s_user_name, sr.parsed->>'name' as s_resume_name, sr.title as s_resume_title,
         sr.public_slug as s_resume_slug
    from recommendations r
    left join organisations ao on ao.id = r.author_org_id
    left join organisations so on so.id = r.org_id
    left join users au on au.id = r.author_user_id
    left join users su on su.id = r.user_id
    left join lateral (
      select public_slug, parsed, title from resumes
       where user_id = r.author_user_id and public_slug is not null and visibility = 'public'
       order by updated_at desc limit 1
    ) ar on true
    left join lateral (
      select public_slug, parsed, title from resumes
       where user_id = r.user_id and public_slug is not null and visibility = 'public'
       order by updated_at desc limit 1
    ) sr on true`;

function partyOf(row: Row, side: 'a' | 's'): RecommendationParty {
  const orgId = side === 'a' ? row.author_org_id : row.org_id;
  if (orgId !== null) {
    return {
      kind: 'employer',
      name: row[`${side}_org_name`] ?? 'An employer',
      slug: row[`${side}_org_slug`],
    };
  }
  return {
    kind: 'candidate',
    name: candidateName(row[`${side}_resume_name`], row[`${side}_user_name`], row[`${side}_resume_title`]),
    slug: row[`${side}_resume_slug`],
  };
}

function toRecommendation(row: Row): Recommendation {
  return {
    id: row.id,
    body: row.body,
    relationship: row.relationship,
    status: isStatus(row.status) ? row.status : 'pending',
    author: partyOf(row, 'a'),
    subject: partyOf(row, 's'),
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

export function isStatus(value: unknown): value is RecommendationStatus {
  return value === 'pending' || value === 'approved' || value === 'rejected';
}

// --- reading ------------------------------------------------------------

/** What is on somebody's page: approved only, newest decision first. */
export async function listApproved(pool: pg.Pool, subject: Party): Promise<Recommendation[]> {
  const column = subject.kind === 'employer' ? 'r.org_id' : 'r.user_id';
  const id = subject.kind === 'employer' ? subject.orgId : subject.userId;
  const result = await pool.query<Row>(
    `${SELECT} where ${column} = $1 and r.status = 'approved' order by r.decided_at desc nulls last, r.created_at desc`,
    [id],
  );
  return result.rows.map(toRecommendation);
}

/** Subjects the viewer decides for: themselves, and every employer they belong to. */
const OWNS_SUBJECT = `(
  r.user_id = $1
  or exists (select 1 from memberships ms where ms.user_id = $1 and ms.org_id = r.org_id)
)`;

/** Authors the viewer speaks for: themselves, and every employer they belong to. */
const IS_AUTHOR = `(
  r.author_user_id = $1
  or exists (select 1 from memberships ms where ms.user_id = $1 and ms.org_id = r.author_org_id)
)`;

/**
 * Everything written about the viewer or their employers, every status.
 * Pending first, because that is what needs a decision.
 */
export async function listReceived(pool: pg.Pool, viewerId: string): Promise<Recommendation[]> {
  const result = await pool.query<Row>(
    `${SELECT} where ${OWNS_SUBJECT}
      order by case r.status when 'pending' then 0 when 'approved' then 1 else 2 end, r.created_at desc`,
    [viewerId],
  );
  return result.rows.map(toRecommendation);
}

/** Everything the viewer wrote, as themselves or as an employer. */
export async function listGiven(pool: pg.Pool, viewerId: string): Promise<Recommendation[]> {
  const result = await pool.query<Row>(`${SELECT} where ${IS_AUTHOR} order by r.created_at desc`, [viewerId]);
  return result.rows.map(toRecommendation);
}

export async function pendingCount(pool: pg.Pool, viewerId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `select count(*) as count from recommendations r where ${OWNS_SUBJECT} and r.status = 'pending'`,
    [viewerId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

// --- writing ------------------------------------------------------------

export interface WriteInput {
  as: Party;
  subject: Party;
  body: unknown;
  relationship: unknown;
}

function sameParty(a: Party, b: Party): boolean {
  if (a.kind === 'candidate' && b.kind === 'candidate') return a.userId === b.userId;
  if (a.kind === 'employer' && b.kind === 'employer') return a.orgId === b.orgId;
  return false;
}

/**
 * Write one, or rewrite the one already written about this subject.
 *
 * Returns the recommendation, or a sentence saying why not. A rewrite goes
 * back to pending: the subject approved the earlier words, not whatever
 * comes next.
 */
export async function writeRecommendation(
  pool: pg.Pool,
  viewerId: string,
  input: WriteInput,
): Promise<Recommendation | string> {
  const body = clean(input.body, BODY_MAX, { multiline: true });
  if (body.length < BODY_MIN) {
    return `Say more than that: a recommendation is at least ${BODY_MIN} characters, and it is shown with your name on it.`;
  }
  const relationship = clean(input.relationship, RELATIONSHIP_MAX) || null;
  if (sameParty(input.as, input.subject)) return 'You cannot recommend yourself.';

  const today = await pool.query<{ count: string }>(
    `select count(*) as count from recommendations
      where written_by = $1 and created_at > now() - interval '1 day'`,
    [viewerId],
  );
  if (Number(today.rows[0]?.count ?? 0) >= DAILY_LIMIT) {
    return `That is ${DAILY_LIMIT} recommendations today, which is the limit.`;
  }

  const result = await pool.query<{ id: string }>(
    `insert into recommendations (author_user_id, author_org_id, written_by, user_id, org_id, body, relationship)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (author_user_id, user_id) where author_user_id is not null and user_id is not null
       do update set body = excluded.body, relationship = excluded.relationship,
                     written_by = excluded.written_by, status = 'pending',
                     decided_at = null, updated_at = now()
     returning id`,
    [
      input.as.kind === 'candidate' ? input.as.userId : null,
      input.as.kind === 'employer' ? input.as.orgId : null,
      viewerId,
      input.subject.kind === 'candidate' ? input.subject.userId : null,
      input.subject.kind === 'employer' ? input.subject.orgId : null,
      body,
      relationship,
    ],
  ).catch(async (error: unknown) => {
    // Postgres lets ON CONFLICT name only one arbiter index, and there are
    // four partial ones. The person-to-person case is the common one and is
    // named above; the other three are handled by finding the row and
    // updating it, which is the same result one round trip later.
    if (!(error instanceof Error) || !/duplicate key/.test(error.message)) throw error;
    return pool.query<{ id: string }>(
      `update recommendations
          set body = $6, relationship = $7, written_by = $3, status = 'pending',
              decided_at = null, updated_at = now()
        where author_user_id is not distinct from $1 and author_org_id is not distinct from $2
          and user_id is not distinct from $4 and org_id is not distinct from $5
        returning id`,
      [
        input.as.kind === 'candidate' ? input.as.userId : null,
        input.as.kind === 'employer' ? input.as.orgId : null,
        viewerId,
        input.subject.kind === 'candidate' ? input.subject.userId : null,
        input.subject.kind === 'employer' ? input.subject.orgId : null,
        body,
        relationship,
      ],
    );
  });
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('recommendation insert returned no row');
  const written = await getRecommendation(pool, id);
  if (written === null) throw new Error('recommendation could not be read back');
  return written;
}

export async function getRecommendation(pool: pg.Pool, id: string): Promise<Recommendation | null> {
  if (!isUuid(id)) return null;
  const result = await pool.query<Row>(`${SELECT} where r.id = $1`, [id]);
  const row = result.rows[0];
  return row === undefined ? null : toRecommendation(row);
}

/**
 * The subject's decision. Approve, or reject; either can be changed later,
 * because taking down a recommendation you approved last year is a thing
 * people need to do. The ownership test is in the update's `where`, so a
 * caller who does not own the subject changes nothing and learns nothing.
 */
export async function decide(
  pool: pg.Pool,
  viewerId: string,
  id: string,
  decision: 'approved' | 'rejected',
): Promise<Recommendation | null> {
  if (!isUuid(id)) return null;
  const result = await pool.query<{ id: string }>(
    `update recommendations r
        set status = $3, decided_at = now(), updated_at = now()
      where r.id = $2 and ${OWNS_SUBJECT}
      returning r.id`,
    [viewerId, id, decision],
  );
  if (result.rows.length === 0) return null;
  return getRecommendation(pool, id);
}

/** The author takes it back. Gone, not hidden: it was theirs to say. */
export async function withdraw(pool: pg.Pool, viewerId: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const result = await pool.query(
    `delete from recommendations r where r.id = $2 and ${IS_AUTHOR}`,
    [viewerId, id],
  );
  return (result.rowCount ?? 0) > 0;
}

// --- who may write, and about whom -------------------------------------

export interface Resolved {
  as: Party;
  asParty: RecommendationParty;
  subject: Party;
  subjectParty: RecommendationParty;
  /** The employers the writer could write as, for a form's select. */
  asOptions: { slug: string; name: string }[];
  /** True when the writer has a published resume and may write as themselves. */
  canWriteAsSelf: boolean;
}

/**
 * Who is writing, and about whom, from a candidate slug or an employer
 * slug plus an optional `as`. A person writes as themselves only with a
 * published resume, so the recommendation has a page behind it; without
 * one, and without an employer to write as, there is nobody to sign it.
 */
export async function resolve(
  pool: pg.Pool,
  viewerId: string,
  params: { candidate?: string; org?: string; as?: string },
): Promise<Resolved | string> {
  const candidate = (params.candidate ?? '').trim();
  const org = (params.org ?? '').trim();
  const asSlug = (params.as ?? '').trim();

  const asOptions = (
    await pool.query<{ slug: string; name: string }>(
      `select o.slug, o.name from organisations o
         join memberships ms on ms.org_id = o.id
        where ms.user_id = $1 order by o.name`,
      [viewerId],
    )
  ).rows;
  const self = await pool.query<{ public_slug: string; name: string | null; resume_name: string | null; title: string }>(
    `select r.public_slug, u.name, r.parsed->>'name' as resume_name, r.title
       from resumes r join users u on u.id = r.user_id
      where r.user_id = $1 and r.public_slug is not null and r.visibility = 'public'
      order by r.updated_at desc limit 1`,
    [viewerId],
  );
  const selfPage = self.rows[0] ?? null;

  let subject: Party;
  let subjectParty: RecommendationParty;
  if (candidate !== '') {
    const row = await pool.query<{ user_id: string; name: string | null; title: string; resume_name: string | null }>(
      `select r.user_id, u.name, r.title, r.parsed->>'name' as resume_name
         from resumes r join users u on u.id = r.user_id
        where r.public_slug = $1 and r.visibility in ('link', 'public') limit 1`,
      [candidate],
    );
    const found = row.rows[0];
    if (found === undefined) return `Nobody here is "${candidate}".`;
    subject = { kind: 'candidate', userId: found.user_id };
    subjectParty = { kind: 'candidate', name: candidateName(found.resume_name, found.name, found.title), slug: candidate };
  } else if (org !== '') {
    const row = await pool.query<{ id: string; name: string }>(`select id, name from organisations where slug = $1`, [org]);
    const found = row.rows[0];
    if (found === undefined) return `No employer here is "${org}".`;
    subject = { kind: 'employer', orgId: found.id };
    subjectParty = { kind: 'employer', name: found.name, slug: org };
  } else {
    return 'Say who it is about: a candidate or an employer.';
  }

  let as: Party;
  let asParty: RecommendationParty;
  if (asSlug !== '') {
    const mine = asOptions.find((option) => option.slug === asSlug);
    if (mine === undefined) return `You do not post for "${asSlug}".`;
    const orgRow = await pool.query<{ id: string }>(`select id from organisations where slug = $1`, [asSlug]);
    as = { kind: 'employer', orgId: orgRow.rows[0]?.id ?? '' };
    asParty = { kind: 'employer', name: mine.name, slug: mine.slug };
  } else {
    if (selfPage === null) {
      return asOptions.length > 0
        ? 'Say which employer this is from, as "as": a recommendation is signed by a page, and you have not published a resume to sign it with.'
        : 'Publish a resume first, so the recommendation has your page behind it.';
    }
    as = { kind: 'candidate', userId: viewerId };
    asParty = {
      kind: 'candidate',
      name: candidateName(selfPage.resume_name, selfPage.name, selfPage.title),
      slug: selfPage.public_slug,
    };
  }

  if (sameParty(as, subject)) return 'You cannot recommend yourself.';
  if (subject.kind === 'employer') {
    const member = await pool.query(`select 1 from memberships where org_id = $1 and user_id = $2`, [subject.orgId, viewerId]);
    if (member.rows.length > 0) return 'That is your own employer.';
  }

  return { as, asParty, subject, subjectParty, asOptions, canWriteAsSelf: selfPage !== null };
}

// --- telling the subject ------------------------------------------------

/** Who decides on a recommendation about this subject. */
async function deciders(pool: pg.Pool, subject: Party): Promise<{ email: string }[]> {
  if (subject.kind === 'candidate') {
    const row = await pool.query<{ email: string }>(`select email from users where id = $1`, [subject.userId]);
    return row.rows;
  }
  const rows = await pool.query<{ email: string }>(
    `select u.email from memberships ms join users u on u.id = ms.user_id where ms.org_id = $1`,
    [subject.orgId],
  );
  return rows.rows;
}

/**
 * Tell the subject there is something to approve. The words travel in the
 * mail, so the decision can be made from it, and the link goes to the place
 * the buttons are.
 */
export async function notifySubject(options: {
  pool: pg.Pool;
  mailer: Mailer | null;
  boardName: string;
  publicUrl: string;
  recommendation: Recommendation;
  subject: Party;
}): Promise<number> {
  if (options.mailer === null) return 0;
  const { recommendation } = options;
  const url = `${options.publicUrl}/me#recommendations`;
  const subject = `${recommendation.author.name} recommended you on ${options.boardName}`;
  const text = [
    `${recommendation.author.name} wrote a recommendation for ${recommendation.subject.name}:`,
    '',
    recommendation.body,
    '',
    'It is not on your page until you approve it. Approve or reject it here:',
    url,
  ].join('\n');
  const html = [
    `<p><strong>${escapeHtml(recommendation.author.name)}</strong> wrote a recommendation for ${escapeHtml(recommendation.subject.name)}:</p>`,
    `<blockquote style="border-left:3px solid #ccc;margin:0;padding:0 0 0 12px;white-space:pre-wrap">${escapeHtml(recommendation.body)}</blockquote>`,
    `<p>It is not on your page until you approve it. <a href="${escapeHtml(url)}">Approve or reject it</a>.</p>`,
  ].join('');
  let sent = 0;
  for (const recipient of await deciders(options.pool, options.subject)) {
    if (await options.mailer.send({ to: recipient.email, subject, html, text })) sent += 1;
  }
  return sent;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return UUID.test(value);
}
