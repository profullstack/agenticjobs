/**
 * The directory: which instances exist.
 *
 * An instance announces itself by sending nothing but its own URL. The
 * directory then fetches that URL's descriptor itself and records what it
 * actually read. nixamp's stream directory trusts the announcement body, which
 * is right for a stream whose only claim is "I am playing something"; here an
 * announcement carries a name, a topic list and a job count, and a board that
 * could announce someone else's name with its own URL underneath would be a
 * phishing primitive on day one.
 */

import type pg from 'pg';
import {
  MAX_FAILURES,
  ONLINE_TTL_MS,
  publishable,
  type InstanceDescriptor,
  type InstanceListing,
} from '../schema/instance.ts';
import { fetchDescriptor, FetchProblem } from './fetch.ts';

interface InstanceRow {
  id: string;
  url: string;
  descriptor: InstanceDescriptor;
  first_seen_at: string;
  checked_at: string;
  failures: number;
  blocked: boolean;
}

function toListing(row: InstanceRow, now = Date.now()): InstanceListing {
  return {
    id: row.id,
    url: row.url,
    descriptor: row.descriptor,
    updatedAt: row.checked_at,
    firstSeenAt: row.first_seen_at,
    failures: row.failures,
    online: now - Date.parse(row.checked_at) < ONLINE_TTL_MS && row.failures === 0,
  };
}

export class Blocked extends Error {}

/**
 * Record an announcement.
 *
 * Idempotent per origin: an instance that heartbeats every ten minutes updates
 * one row forever rather than accumulating a history of itself.
 */
export async function announce(pool: pg.Pool, rawUrl: string): Promise<InstanceListing> {
  const origin = publishable(rawUrl);
  if (origin === null) throw new FetchProblem(`${rawUrl} is not an address we will list`);
  const url = origin.origin;

  const existing = await pool.query<{ blocked: boolean; blocked_reason: string | null }>(
    `select blocked, blocked_reason from instances where url = $1`,
    [url],
  );
  const row = existing.rows[0];
  if (row?.blocked === true) {
    throw new Blocked(row.blocked_reason ?? 'This instance is not accepted here.');
  }

  const descriptor = await fetchDescriptor(url);

  const saved = await pool.query<InstanceRow>(
    `insert into instances (url, descriptor, checked_at, failures)
     values ($1, $2::jsonb, now(), 0)
     on conflict (url) do update
       set descriptor = excluded.descriptor,
           checked_at = now(),
           failures = 0
     returning id, url, descriptor, first_seen_at, checked_at, failures, blocked`,
    [url, JSON.stringify(descriptor)],
  );
  const result = saved.rows[0];
  if (result === undefined) throw new Error('instance upsert returned no row');
  return toListing(result);
}

export interface ListOptions {
  topic?: string | null;
  q?: string | null;
  onlineOnly?: boolean;
  limit?: number;
  offset?: number;
}

export async function listInstances(
  pool: pg.Pool,
  options: ListOptions = {},
): Promise<InstanceListing[]> {
  const params: unknown[] = [];
  const where: string[] = ['blocked = false'];

  if (options.onlineOnly === true) {
    params.push(String(ONLINE_TTL_MS));
    where.push(`checked_at > now() - ($${params.length} || ' milliseconds')::interval`);
    where.push('failures = 0');
  }
  if (options.topic) {
    params.push(options.topic.toLowerCase());
    where.push(`descriptor -> 'topics' ? $${params.length}`);
  }
  if (options.q) {
    params.push(`%${options.q.toLowerCase()}%`);
    where.push(
      `(lower(descriptor ->> 'name') like $${params.length} or lower(descriptor ->> 'tagline') like $${params.length} or url like $${params.length})`,
    );
  }

  params.push(Math.min(500, Math.max(1, options.limit ?? 100)));
  params.push(Math.max(0, options.offset ?? 0));

  const result = await pool.query<InstanceRow>(
    `select id, url, descriptor, first_seen_at, checked_at, failures, blocked
       from instances
      where ${where.join(' and ')}
      order by failures asc,
               (descriptor -> 'jobs' ->> 'open')::int desc nulls last,
               checked_at desc
      limit $${params.length - 1} offset $${params.length}`,
    params,
  );
  const now = Date.now();
  return result.rows.map((row) => toListing(row, now));
}

export async function getInstance(pool: pg.Pool, url: string): Promise<InstanceListing | null> {
  const origin = publishable(url);
  if (origin === null) return null;
  const result = await pool.query<InstanceRow>(
    `select id, url, descriptor, first_seen_at, checked_at, failures, blocked
       from instances where url = $1`,
    [origin.origin],
  );
  const row = result.rows[0];
  return row === undefined ? null : toListing(row);
}

/** Every topic the directory knows about, most-used first. */
export async function listTopics(pool: pg.Pool): Promise<{ topic: string; instances: number }[]> {
  const result = await pool.query<{ topic: string; instances: number }>(
    `select topic, count(*)::bigint as instances
       from instances, jsonb_array_elements_text(descriptor -> 'topics') as topic
      where blocked = false
      group by topic
      order by instances desc, topic asc
      limit 100`,
  );
  return result.rows;
}

export interface SweepResult {
  checked: number;
  ok: number;
  failed: number;
  dropped: number;
}

/**
 * Re-read every instance the directory knows about.
 *
 * A failure raises a counter rather than deleting the row: an instance is
 * allowed to be down for a redeploy without losing its place, and the URL only
 * goes away after MAX_FAILURES consecutive misses, which at the sweep interval
 * is the better part of a day.
 */
export async function sweep(
  pool: pg.Pool,
  options: { limit?: number; concurrency?: number; self?: string } = {},
): Promise<SweepResult> {
  // A board that announced itself before it learned not to still has a row
  // saying so, and refusing new self-announcements does not remove it. The
  // sweep is where the directory reconciles what it holds with what is true,
  // so this is where that row goes - which also means a board that turns the
  // guard on later heals itself rather than needing the row deleted by hand.
  let removedSelf = 0;
  const self = options.self === undefined ? null : publishable(options.self);
  if (self !== null) {
    const gone = await pool.query(`delete from instances where url = $1`, [self.origin]);
    removedSelf = gone.rowCount ?? 0;
  }

  const due = await pool.query<{ url: string }>(
    `select url from instances
      where blocked = false
      order by checked_at asc
      limit $1`,
    [Math.min(500, Math.max(1, options.limit ?? 100))],
  );

  const urls = due.rows.map((row) => row.url);
  const result: SweepResult = {
    checked: urls.length,
    ok: 0,
    failed: 0,
    dropped: removedSelf,
  };
  const concurrency = Math.min(16, Math.max(1, options.concurrency ?? 8));

  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const url = urls[index];
      if (url === undefined) return;
      try {
        const descriptor = await fetchDescriptor(url);
        await pool.query(
          `update instances set descriptor = $2::jsonb, checked_at = now(), failures = 0
            where url = $1`,
          [url, JSON.stringify(descriptor)],
        );
        result.ok += 1;
      } catch {
        const bumped = await pool.query<{ failures: number }>(
          `update instances set failures = failures + 1 where url = $1 returning failures`,
          [url],
        );
        result.failed += 1;
        if ((bumped.rows[0]?.failures ?? 0) >= MAX_FAILURES) {
          await pool.query(`delete from instances where url = $1`, [url]);
          result.dropped += 1;
        }
      }
    }
  });

  await Promise.all(workers);
  return result;
}

export async function blockInstance(
  pool: pg.Pool,
  url: string,
  reason: string,
): Promise<boolean> {
  const origin = publishable(url);
  if (origin === null) return false;
  const result = await pool.query(
    `insert into instances (url, descriptor, blocked, blocked_reason)
     values ($1, '{}'::jsonb, true, $2)
     on conflict (url) do update set blocked = true, blocked_reason = $2`,
    [origin.origin, reason.slice(0, 300)],
  );
  return (result.rowCount ?? 0) > 0;
}
