/**
 * Watches: a search somebody wants to hear about, and the notifications it
 * produces.
 *
 * A watch is the same JobQuery the page and the API run, minus the parts
 * that describe a screenful (limit, offset, sort). When a listing is
 * published it is checked against every watch by the search's own where
 * clause, and each match becomes three things: a notification row the
 * person sees on the board, an email if the watch asked for one, and a push
 * message to any browser that subscribed. The email is rate limited per
 * watch, so an employer publishing ten listings in one sitting sends one
 * email, not ten; the ten notifications are still all on the board.
 */

import type pg from 'pg';
import type { Job, JobQuery } from '../schema/index.ts';
import { EMPTY_QUERY, parseQuery, queryToParams } from '../schema/query.ts';
import { jobMatchesQuery } from './jobs.ts';
import type { Mailer, Message } from './mail.ts';
import { escapeHtml } from '../markup/escape.ts';
import { formatPayShort, payOfJob } from '../schema/pay.ts';
import { clean } from '../schema/text.ts';

export const WATCHES_PER_ACCOUNT = 20;
export const NOTIFICATIONS_KEPT = 200;
const EMAIL_GAP_MS = 60 * 60 * 1000;

export interface Watch {
  id: string;
  query: JobQuery;
  label: string;
  email: boolean;
  /** `/rust/remote` when the query has a landing page, else `/?...`. */
  path: string;
  createdAt: string;
  lastNotifiedAt: string | null;
}

export interface Notification {
  id: string;
  kind: string;
  title: string;
  body: string;
  url: string | null;
  createdAt: string;
  readAt: string | null;
}

/** The part of a query that is a search, not a screenful of one. */
export function watchQuery(query: JobQuery): JobQuery {
  return { ...query, sort: 'recent', limit: EMPTY_QUERY.limit, offset: 0 };
}

/** Is there anything to watch? A watch on everything is a feed, not a watch. */
export function isWatchable(query: JobQuery): boolean {
  const q = watchQuery(query);
  return (
    q.q !== null ||
    q.tags.length > 0 ||
    q.workplace !== null ||
    q.employmentType !== null ||
    q.seniority !== null ||
    q.agentPolicy !== null ||
    q.salaryMin !== null ||
    q.org !== null
  );
}

/** "remote senior rust contract jobs, agents welcome" from a query. */
export function labelFor(query: JobQuery): string {
  const bits: string[] = [];
  if (query.workplace !== null) bits.push(query.workplace);
  if (query.seniority !== null) bits.push(query.seniority);
  bits.push(...query.tags);
  if (query.q !== null) bits.push(`"${query.q}"`);
  if (query.employmentType !== null) bits.push(query.employmentType);
  let label = `${bits.join(' ')} jobs`.trim();
  const extras: string[] = [];
  if (query.agentPolicy === 'welcome') extras.push('agents welcome');
  if (query.agentPolicy === 'disclose') extras.push('agents disclosed');
  if (query.agentPolicy === 'human-only') extras.push('human-only');
  if (query.salaryMin !== null) extras.push(`${query.salaryMin.toLocaleString('en-US')}+`);
  if (query.org !== null) extras.push(`at ${query.org}`);
  if (extras.length > 0) label += `, ${extras.join(', ')}`;
  return label === 'jobs' ? 'all jobs' : label;
}

/** Where the watch's search lives: its slug page when it has one. */
export function watchPath(query: JobQuery, slugPath: (query: JobQuery) => string | null): string {
  const path = slugPath(query);
  if (path !== null) return path;
  const params = queryToParams(watchQuery(query));
  const search = params.toString();
  return search === '' ? '/' : `/?${search}`;
}

interface WatchRow {
  id: string;
  query: Record<string, unknown>;
  label: string;
  email: boolean;
  created_at: string;
  last_notified_at: string | null;
}

function fromStored(stored: Record<string, unknown>): JobQuery {
  // Stored as the querystring form, so a query written by an older release
  // is re-read by the current parser rather than trusted field by field.
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(stored)) {
    if (typeof value === 'string') params.set(key, value);
  }
  return watchQuery(parseQuery(params));
}

function toStored(query: JobQuery): Record<string, string> {
  return Object.fromEntries(queryToParams(watchQuery(query)).entries());
}

function toWatch(row: WatchRow, slugPath: (query: JobQuery) => string | null): Watch {
  const query = fromStored(row.query);
  return {
    id: row.id,
    query,
    label: row.label,
    email: row.email,
    path: watchPath(query, slugPath),
    createdAt: row.created_at,
    lastNotifiedAt: row.last_notified_at,
  };
}

export async function listWatches(
  pool: pg.Pool,
  userId: string,
  slugPath: (query: JobQuery) => string | null,
): Promise<Watch[]> {
  const rows = await pool.query<WatchRow>(
    `select id, query, label, email, created_at, last_notified_at
       from watches where user_id = $1 order by created_at asc`,
    [userId],
  );
  return rows.rows.map((row) => toWatch(row, slugPath));
}

/**
 * Watch a search. The same search twice returns the existing watch.
 * Returns a string when the request is refused, in words the caller can show.
 */
export async function createWatch(
  pool: pg.Pool,
  userId: string,
  query: JobQuery,
  options: { email?: boolean },
  slugPath: (query: JobQuery) => string | null,
): Promise<{ watch: Watch; created: boolean } | string> {
  if (!isWatchable(query)) {
    return 'Narrow the search first: a watch on every listing is the /feed, and it already exists.';
  }
  const stored = toStored(query);
  const existing = await pool.query<WatchRow>(
    `select id, query, label, email, created_at, last_notified_at
       from watches where user_id = $1 and query = $2::jsonb`,
    [userId, JSON.stringify(stored)],
  );
  const found = existing.rows[0];
  if (found !== undefined) return { watch: toWatch(found, slugPath), created: false };

  const count = await pool.query<{ n: number }>(
    `select count(*)::int as n from watches where user_id = $1`,
    [userId],
  );
  if ((count.rows[0]?.n ?? 0) >= WATCHES_PER_ACCOUNT) {
    return `You are watching ${WATCHES_PER_ACCOUNT} searches already. Remove one to add another.`;
  }
  const inserted = await pool.query<WatchRow>(
    `insert into watches (user_id, query, label, email) values ($1, $2::jsonb, $3, $4)
     returning id, query, label, email, created_at, last_notified_at`,
    [userId, JSON.stringify(stored), labelFor(watchQuery(query)), options.email !== false],
  );
  const row = inserted.rows[0];
  if (row === undefined) throw new Error('watch insert returned no row');
  return { watch: toWatch(row, slugPath), created: true };
}

export async function deleteWatch(pool: pg.Pool, userId: string, id: string): Promise<boolean> {
  const result = await pool.query(`delete from watches where id = $1 and user_id = $2`, [
    id,
    userId,
  ]);
  return (result.rowCount ?? 0) > 0;
}

// --- notifications ----------------------------------------------------------

export async function listNotifications(
  pool: pg.Pool,
  userId: string,
  options: { limit?: number; unreadOnly?: boolean } = {},
): Promise<Notification[]> {
  const rows = await pool.query<{
    id: string;
    kind: string;
    title: string;
    body: string;
    url: string | null;
    created_at: string;
    read_at: string | null;
  }>(
    `select id, kind, title, body, url, created_at, read_at from notifications
      where user_id = $1 ${options.unreadOnly === true ? 'and read_at is null' : ''}
      order by created_at desc limit $2`,
    [userId, Math.min(NOTIFICATIONS_KEPT, Math.max(1, options.limit ?? 50))],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    url: row.url,
    createdAt: row.created_at,
    readAt: row.read_at,
  }));
}

export async function unreadNotifications(pool: pg.Pool, userId: string): Promise<number> {
  const rows = await pool.query<{ n: number }>(
    `select count(*)::int as n from notifications where user_id = $1 and read_at is null`,
    [userId],
  );
  return rows.rows[0]?.n ?? 0;
}

/** Mark everything read, or one. Returns how many changed. */
export async function markNotificationsRead(
  pool: pg.Pool,
  userId: string,
  id?: string,
): Promise<number> {
  const result =
    id === undefined
      ? await pool.query(
          `update notifications set read_at = now() where user_id = $1 and read_at is null`,
          [userId],
        )
      : await pool.query(
          `update notifications set read_at = now() where user_id = $1 and id = $2 and read_at is null`,
          [userId, id],
        );
  return result.rowCount ?? 0;
}

export async function addNotification(
  pool: pg.Pool,
  userId: string,
  input: { kind: string; title: string; body?: string; url?: string | null },
): Promise<Notification> {
  const inserted = await pool.query<{ id: string; created_at: string }>(
    `insert into notifications (user_id, kind, title, body, url) values ($1, $2, $3, $4, $5)
     returning id, created_at`,
    [
      userId,
      input.kind,
      clean(input.title, 200),
      clean(input.body ?? '', 1000),
      input.url ?? null,
    ],
  );
  // Keep the table bounded per person; nobody reads notification 201.
  await pool.query(
    `delete from notifications where user_id = $1 and id in (
       select id from notifications where user_id = $1 order by created_at desc offset $2)`,
    [userId, NOTIFICATIONS_KEPT],
  );
  const row = inserted.rows[0];
  if (row === undefined) throw new Error('notification insert returned no row');
  return {
    id: row.id,
    kind: input.kind,
    title: input.title,
    body: input.body ?? '',
    url: input.url ?? null,
    createdAt: row.created_at,
    readAt: null,
  };
}

// --- matching a published listing -----------------------------------------

export function watchMessage(options: {
  to: string;
  boardName: string;
  label: string;
  job: Job;
  url: string;
  watchUrl: string;
}): Message {
  const pay = formatPayShort(payOfJob(options.job));
  const subject = `${options.job.title} at ${options.job.org.name}: new on ${options.boardName}`;
  const lead = `A listing matching your watch on ${options.label} was just published.`;
  const line = `${options.job.title} at ${options.job.org.name}${pay === null ? '' : `, ${pay}`}`;
  const text = [
    lead,
    '',
    line,
    options.url,
    '',
    `Everything matching that watch: ${options.watchUrl}`,
    'Manage your watches on the board, under Notifications.',
  ].join('\n');
  const html = [
    `<p>${escapeHtml(lead)}</p>`,
    `<p><strong>${escapeHtml(line)}</strong><br><a href="${escapeHtml(options.url)}">${escapeHtml(options.url)}</a></p>`,
    `<p style="color:#666;font-size:12px">Everything matching that watch: <a href="${escapeHtml(options.watchUrl)}">${escapeHtml(options.watchUrl)}</a>. Manage your watches on the board, under Notifications.</p>`,
  ].join('');
  return { to: options.to, subject, html, text };
}

export interface WatchHit {
  watchId: string;
  userId: string;
  notified: boolean;
  emailed: boolean;
}

/**
 * Tell everybody whose watch a freshly published listing matches.
 *
 * Runs after the status change, never inside it: a mail provider being down
 * must not unpublish a job. Every failure is caught and reported in the
 * result rather than thrown.
 */
export async function notifyWatchers(
  pool: pg.Pool,
  job: Job,
  options: {
    mailer: Mailer | null;
    boardName: string;
    publicUrl: string;
    slugPath: (query: JobQuery) => string | null;
    push?:
      | ((userId: string, payload: { title: string; body: string; url: string }) => Promise<void>)
      | null;
  },
): Promise<WatchHit[]> {
  const rows = await pool.query<WatchRow & { user_id: string; email_address: string }>(
    `select w.id, w.user_id, w.query, w.label, w.email, w.created_at, w.last_notified_at,
            u.email as email_address
       from watches w join users u on u.id = w.user_id`,
  );
  if (rows.rows.length === 0) return [];

  // One SQL match per distinct query rather than per watch: fifty people
  // watching "remote rust" is one where clause, not fifty.
  const verdicts = new Map<string, boolean>();
  const hits: WatchHit[] = [];
  const url = `${options.publicUrl}/jobs/${job.slug}`;

  for (const row of rows.rows) {
    const key = JSON.stringify(row.query);
    let matched = verdicts.get(key);
    if (matched === undefined) {
      try {
        matched = await jobMatchesQuery(pool, job.id, fromStored(row.query));
      } catch {
        matched = false;
      }
      verdicts.set(key, matched);
    }
    if (!matched) continue;

    const hit: WatchHit = { watchId: row.id, userId: row.user_id, notified: false, emailed: false };
    const query = fromStored(row.query);
    const watchUrl = `${options.publicUrl}${watchPath(query, options.slugPath)}`;
    try {
      await addNotification(pool, row.user_id, {
        kind: 'watch',
        title: `${job.title} at ${job.org.name}`,
        body: `New listing matching ${row.label}.`,
        url: `/jobs/${job.slug}`,
      });
      hit.notified = true;
    } catch {
      // The row is the least important of the three; carry on.
    }

    const recently =
      row.last_notified_at !== null && Date.now() - Date.parse(row.last_notified_at) < EMAIL_GAP_MS;
    if (row.email && options.mailer !== null && !recently) {
      try {
        hit.emailed = await options.mailer.send(
          watchMessage({
            to: row.email_address,
            boardName: options.boardName,
            label: row.label,
            job,
            url,
            watchUrl,
          }),
        );
      } catch {
        hit.emailed = false;
      }
      if (hit.emailed) {
        await pool.query(`update watches set last_notified_at = now() where id = $1`, [row.id]);
      }
    }

    if (options.push) {
      try {
        await options.push(row.user_id, {
          title: `${job.title} at ${job.org.name}`,
          body: `New listing matching ${row.label}.`,
          url: `/jobs/${job.slug}`,
        });
      } catch {
        // Push is best effort by definition.
      }
    }
    hits.push(hit);
  }
  return hits;
}
