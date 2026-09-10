/**
 * Updates, and following the people who post them.
 *
 * A short post from an employer or a candidate: we shipped this, we are hiring
 * two more, I finished a contract and I am free in March. It is the thing a
 * job board is missing between "posted a job" and silence, and the reason to
 * follow anybody here.
 *
 * The whole design question is how not to become a spam feed, and the answer
 * is that posting is expensive on purpose:
 *
 *  - You post as an employer you belong to, or as yourself. There is no third
 *    option, so every update has a page behind it that can be read and judged.
 *  - Five a day, and no two the same. The rate limit is per author, in the
 *    database, so it holds however the update arrived.
 *  - 600 characters, one link. Long enough for news, short enough that nobody
 *    tries to publish an article here.
 *  - The body is text. Not Markdown, not HTML: the link is a column, so the
 *    one thing worth linking is already structured and nothing has to be
 *    sanitised out of prose.
 */

import type pg from 'pg';
import { clean } from '../schema/text.ts';
import { publishable } from '../schema/instance.ts';

/** The most an update can say. */
export const BODY_MAX = 600;
/**
 * The least. A three-word post with a link is an ad, and the floor is the
 * cheapest thing that discourages one.
 */
export const BODY_MIN = 12;
/** Per author, per day. */
export const DAILY_LIMIT = 5;

export type UpdateAuthorKind = 'employer' | 'candidate';

export interface UpdateAuthor {
  kind: UpdateAuthorKind;
  /** The slug of the employer, or of the author's public resume. */
  slug: string | null;
  name: string;
}

export interface Update {
  id: string;
  body: string;
  link: string | null;
  createdAt: string;
  author: UpdateAuthor;
}

/** Who an update is posted as, and who is followed. */
export type Target = { kind: 'employer'; orgId: string } | { kind: 'candidate'; userId: string };

interface UpdateRow {
  id: string;
  body: string;
  link: string | null;
  created_at: string;
  org_id: string | null;
  org_slug: string | null;
  org_name: string | null;
  user_id: string | null;
  user_name: string | null;
  public_slug: string | null;
  resume_name: string | null;
  resume_title: string | null;
}

/**
 * The author, resolved for display.
 *
 * A candidate with no published resume has no page to link to, so the slug is
 * null and the name still renders. Their email is never the fallback name: an
 * update is public, and publishing one should not publish an address.
 */
function authorOf(row: UpdateRow): UpdateAuthor {
  if (row.org_id !== null) {
    return { kind: 'employer', slug: row.org_slug, name: row.org_name ?? 'An employer' };
  }
  return {
    kind: 'candidate',
    slug: row.public_slug,
    name: candidateName(row.resume_name, row.user_name, row.resume_title),
  };
}

/**
 * The longest a name can be before it is not one. The same limit the
 * candidate directory applies, for the same reason: a resume whose Markdown
 * lost its line breaks parses as one h1 holding the entire document.
 */
const NAME_MAX = 80;

/**
 * A candidate's display name, from the same place their directory card gets it.
 *
 * Nothing on this board ever asks a person for their name: sign-in is a
 * magic link to an address, and `users.name` is null for almost everyone. So
 * the name is read off the resume they published - its heading, then its
 * title - and only then off the account. It never falls back to the email,
 * because these names are printed on public pages. "A candidate" is what is
 * left when a person has nothing published, which is the one case where the
 * board genuinely has no name for them.
 */
export function candidateName(
  resumeName: string | null | undefined,
  accountName: string | null | undefined,
  resumeTitle: string | null | undefined,
): string {
  for (const candidate of [resumeName, accountName, resumeTitle]) {
    const trimmed = (candidate ?? '').trim();
    if (trimmed !== '' && trimmed.length <= NAME_MAX) return trimmed;
  }
  return 'A candidate';
}

function toUpdate(row: UpdateRow): Update {
  return {
    id: row.id,
    body: row.body,
    link: row.link,
    createdAt: row.created_at,
    author: authorOf(row),
  };
}

/**
 * One join, used by every listing.
 *
 * A candidate's page is their public resume, so the slug comes from the
 * resume they chose to list rather than from a second profile table. The
 * `visibility` test is what keeps an update from linking to a private one.
 *
 * The source is a parameter because an insert reads back through the same
 * join, and a data-modifying CTE is NOT visible to the rest of its own
 * statement: `select ... from updates` beside `insert into updates` sees the
 * snapshot from before the insert and comes back empty. The row has to be
 * read out of the CTE itself.
 */
function selectFrom(source: string): string {
  return `
  select u.id, u.body, u.link, u.created_at,
         u.org_id, o.slug as org_slug, o.name as org_name,
         u.user_id, p.name as user_name,
         r.public_slug, r.parsed->>'name' as resume_name, r.title as resume_title
    from ${source} u
    left join organisations o on o.id = u.org_id
    left join users p on p.id = u.user_id
    left join lateral (
      select public_slug, parsed, title from resumes
       where user_id = u.user_id and public_slug is not null and visibility = 'public'
       order by updated_at desc limit 1
    ) r on true`;
}

const SELECT = selectFrom('updates');

/**
 * A link an update is allowed to carry.
 *
 * The host rules are the directory's, because the question is the same one:
 * can somebody else's browser actually go there. `publishable` keeps only an
 * origin, so it is used as the test and the full URL is what is stored; a
 * link to a blog post is the normal case and stripping its path would make
 * the field useless.
 */
export function normaliseLink(value: unknown): string | null {
  const raw = clean(value, 500);
  if (raw === '') return null;
  const withScheme = raw.includes('://') ? raw : `https://${raw}`;
  if (publishable(withScheme) === null) return null;
  const url = new URL(withScheme);
  // Credentials in a URL are for a fetcher, never for a link somebody clicks.
  url.username = '';
  url.password = '';
  return url.toString();
}

export interface UpdateInput {
  body: unknown;
  link?: unknown;
}

/**
 * Post an update.
 *
 * Returns the update, or a sentence explaining why not. Every caller here is
 * either a person looking at a form or a model reading an error body, and
 * both can act on a sentence.
 */
export async function postUpdate(
  pool: pg.Pool,
  authorId: string,
  target: Target,
  input: UpdateInput,
): Promise<Update | string> {
  const body = clean(input.body, BODY_MAX, { multiline: true });
  if (body.length < BODY_MIN) {
    return `An update needs at least ${BODY_MIN} characters. Say what happened.`;
  }

  const link = normaliseLink(input.link);
  if (link === null && clean(input.link, 500) !== '') {
    return 'That link is not a public http(s) URL, so nobody else could open it.';
  }

  // The author has to be allowed to post as this target. An org post needs
  // membership; a candidate post can only ever be your own.
  if (target.kind === 'employer') {
    const member = await pool.query(`select 1 from memberships where user_id = $1 and org_id = $2`, [
      authorId,
      target.orgId,
    ]);
    if (member.rows.length === 0) return 'You do not post for that employer.';
  } else if (target.userId !== authorId) {
    return 'You can only post updates as yourself.';
  }

  const column = target.kind === 'employer' ? 'org_id' : 'user_id';
  const owner = target.kind === 'employer' ? target.orgId : target.userId;

  // The rate limit and the duplicate check are one round trip, and both are
  // asked of the AUTHOR rather than of the target: posting the same thing to
  // four employers you belong to is the spam this is here to stop.
  const recent = await pool.query<{ today: string; same: string }>(
    `select count(*) filter (where created_at > now() - interval '24 hours') as today,
            count(*) filter (where body = $2 and created_at > now() - interval '30 days') as same
       from updates where author_id = $1`,
    [authorId, body],
  );
  const today = Number(recent.rows[0]?.today ?? 0);
  const same = Number(recent.rows[0]?.same ?? 0);
  if (today >= DAILY_LIMIT) {
    return `That is ${DAILY_LIMIT} updates today, which is the limit. Tomorrow.`;
  }
  if (same > 0) return 'You already posted that. Say something else, or link it again later.';

  const created = await pool.query<UpdateRow>(
    `with inserted as (
       insert into updates (${column}, author_id, body, link)
       values ($1, $2, $3, $4)
       returning id, body, link, created_at, org_id, user_id
     )
     ${selectFrom('inserted')}`,
    [owner, authorId, body, link],
  );
  const row = created.rows[0];
  if (row === undefined) throw new Error('update insert returned no row');
  return toUpdate(row);
}

function cap(limit: number): number {
  return Math.min(200, Math.max(1, Math.trunc(limit)));
}

/** Everything anybody posted, newest first. The board's news page. */
export async function listUpdates(pool: pg.Pool, limit = 50): Promise<Update[]> {
  const result = await pool.query<UpdateRow>(
    `${SELECT} order by u.created_at desc limit $1`,
    [cap(limit)],
  );
  return result.rows.map(toUpdate);
}

export async function listUpdatesFor(
  pool: pg.Pool,
  target: Target,
  limit = 20,
): Promise<Update[]> {
  const column = target.kind === 'employer' ? 'u.org_id' : 'u.user_id';
  const owner = target.kind === 'employer' ? target.orgId : target.userId;
  const result = await pool.query<UpdateRow>(
    `${SELECT} where ${column} = $1 order by u.created_at desc limit $2`,
    [owner, cap(limit)],
  );
  return result.rows.map(toUpdate);
}

/**
 * The updates from everyone one person follows.
 *
 * This is the only reason follows exist, so it is one query rather than a
 * list of ids fetched and then looped over.
 */
export async function listFollowedUpdates(
  pool: pg.Pool,
  followerId: string,
  limit = 50,
): Promise<Update[]> {
  const result = await pool.query<UpdateRow>(
    `${SELECT}
      where exists (
        select 1 from follows f
         where f.follower_id = $1
           and ((f.org_id is not null and f.org_id = u.org_id)
             or (f.user_id is not null and f.user_id = u.user_id))
      )
      order by u.created_at desc limit $2`,
    [followerId, cap(limit)],
  );
  return result.rows.map(toUpdate);
}

/**
 * Delete an update.
 *
 * Whoever wrote it, or anybody who posts for that employer: a person who
 * leaves a company should not leave a post nobody there can take down.
 */
export async function deleteUpdate(
  pool: pg.Pool,
  viewerId: string,
  id: string,
): Promise<boolean> {
  const result = await pool.query(
    `delete from updates u
      where u.id = $1
        and (u.author_id = $2
             or (u.org_id is not null and exists (
                   select 1 from memberships m
                    where m.org_id = u.org_id and m.user_id = $2)))`,
    [id, viewerId],
  );
  return (result.rowCount ?? 0) > 0;
}

// --- following ----------------------------------------------------------

/**
 * Follow. Following twice is following once.
 *
 * The unique index does the work, so a double-submitted form and a retried
 * API call are both no-ops rather than an error the caller has to read.
 */
export async function follow(pool: pg.Pool, followerId: string, target: Target): Promise<boolean> {
  const column = target.kind === 'employer' ? 'org_id' : 'user_id';
  const owner = target.kind === 'employer' ? target.orgId : target.userId;
  if (target.kind === 'candidate' && target.userId === followerId) return false;
  await pool.query(
    `insert into follows (follower_id, ${column}) values ($1, $2)
     on conflict do nothing`,
    [followerId, owner],
  );
  return true;
}

export async function unfollow(pool: pg.Pool, followerId: string, target: Target): Promise<void> {
  const column = target.kind === 'employer' ? 'org_id' : 'user_id';
  const owner = target.kind === 'employer' ? target.orgId : target.userId;
  await pool.query(`delete from follows where follower_id = $1 and ${column} = $2`, [
    followerId,
    owner,
  ]);
}

export async function isFollowing(
  pool: pg.Pool,
  followerId: string,
  target: Target,
): Promise<boolean> {
  const column = target.kind === 'employer' ? 'org_id' : 'user_id';
  const owner = target.kind === 'employer' ? target.orgId : target.userId;
  const result = await pool.query(
    `select 1 from follows where follower_id = $1 and ${column} = $2`,
    [followerId, owner],
  );
  return result.rows.length > 0;
}

export async function followerCount(pool: pg.Pool, target: Target): Promise<number> {
  const column = target.kind === 'employer' ? 'org_id' : 'user_id';
  const owner = target.kind === 'employer' ? target.orgId : target.userId;
  const result = await pool.query<{ count: string }>(
    `select count(*) as count from follows where ${column} = $1`,
    [owner],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export interface Following {
  kind: UpdateAuthorKind;
  slug: string | null;
  name: string;
  since: string;
}

/** Who one person follows, for their own dashboard. */
export async function listFollowing(pool: pg.Pool, followerId: string): Promise<Following[]> {
  const result = await pool.query<{
    kind: UpdateAuthorKind;
    slug: string | null;
    name: string | null;
    resume_name: string | null;
    resume_title: string | null;
    since: string;
  }>(
    `select 'employer'::text as kind, o.slug, o.name,
            null::text as resume_name, null::text as resume_title, f.created_at as since
       from follows f join organisations o on o.id = f.org_id
      where f.follower_id = $1
      union all
     select 'candidate'::text as kind, r.public_slug as slug, p.name,
            r.parsed->>'name' as resume_name, r.title as resume_title, f.created_at as since
       from follows f
       join users p on p.id = f.user_id
       left join lateral (
         select public_slug, parsed, title from resumes
          where user_id = f.user_id and public_slug is not null and visibility = 'public'
          order by updated_at desc limit 1
       ) r on true
      where f.follower_id = $1
      order by since desc`,
    [followerId],
  );
  return result.rows.map((row) => ({
    kind: row.kind,
    slug: row.slug,
    name:
      row.kind === 'employer'
        ? (row.name ?? '').trim() || 'An employer'
        : candidateName(row.resume_name, row.name, row.resume_title),
    since: row.since,
  }));
}

/**
 * One author, or everybody.
 *
 * Every representation of the updates takes the same two parameters, so the
 * resolution happens once here rather than four times in four routes drifting
 * apart. `unknown` is a slug nobody has: it is not the same as "no filter",
 * and answering it with the whole board would be answering a question nobody
 * asked.
 */
export type Scope =
  | { kind: 'all' }
  | { kind: 'author'; target: Target; author: UpdateAuthorKind; slug: string; name: string }
  | { kind: 'unknown'; slug: string };

export async function scopeFrom(pool: pg.Pool, params: URLSearchParams): Promise<Scope> {
  const org = (params.get('org') ?? '').trim();
  const candidate = (params.get('candidate') ?? '').trim();

  if (org !== '') {
    const row = await pool.query<{ id: string; name: string }>(
      `select id, name from organisations where slug = $1`,
      [org],
    );
    const found = row.rows[0];
    if (found === undefined) return { kind: 'unknown', slug: org };
    return {
      kind: 'author',
      target: { kind: 'employer', orgId: found.id },
      author: 'employer',
      slug: org,
      name: found.name,
    };
  }

  if (candidate !== '') {
    const userId = await userForCandidate(pool, candidate);
    if (userId === null) return { kind: 'unknown', slug: candidate };
    const row = await pool.query<{ name: string | null }>(`select name from users where id = $1`, [
      userId,
    ]);
    const name = (row.rows[0]?.name ?? '').trim();
    return {
      kind: 'author',
      target: { kind: 'candidate', userId },
      author: 'candidate',
      slug: candidate,
      name: name === '' ? 'A candidate' : name,
    };
  }

  return { kind: 'all' };
}

/** The updates a scope describes. An unknown author has none, not all. */
export async function listScoped(pool: pg.Pool, scope: Scope, limit = 50): Promise<Update[]> {
  if (scope.kind === 'unknown') return [];
  if (scope.kind === 'author') return listUpdatesFor(pool, scope.target, limit);
  return listUpdates(pool, limit);
}

/**
 * The page a person's own updates would appear on, if they have one.
 *
 * Posting as yourself requires a listed resume. It is the cheapest useful
 * gate: an update whose author has no page is an anonymous post, and an
 * account made this morning has nothing to lose by spamming from one.
 */
export async function candidateSlugFor(pool: pg.Pool, userId: string): Promise<string | null> {
  const result = await pool.query<{ public_slug: string }>(
    `select public_slug from resumes
      where user_id = $1 and public_slug is not null and visibility = 'public'
      order by updated_at desc limit 1`,
    [userId],
  );
  return result.rows[0]?.public_slug ?? null;
}

/**
 * The user behind a public resume slug.
 *
 * Following a candidate follows the person, not the document, so a resume
 * rewritten or replaced does not drop their followers.
 */
export async function userForCandidate(pool: pg.Pool, slug: string): Promise<string | null> {
  // Matches what /candidates/:slug actually serves, so a page a person can
  // open is a page they can follow.
  const result = await pool.query<{ user_id: string }>(
    `select user_id from resumes
      where public_slug = $1 and visibility in ('link', 'public') limit 1`,
    [slug],
  );
  return result.rows[0]?.user_id ?? null;
}
