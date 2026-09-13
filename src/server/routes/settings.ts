import { Hono } from 'hono';
import {
  KEEP_REVISIONS,
  handleGet,
  handlePut,
  handleRevisions,
  type Snapshot,
  type SnapshotStore,
  type StoredSnapshot,
} from '@profullstack/synconfig/server';
import type { AppEnv } from '../deps.ts';

/**
 * Settings sync: a member's agenticjobs settings (the boards they use, the
 * directories they discover through) as one snapshot under a revision, so
 * `agenticjobs sync load` on another machine gets them. The handlers and
 * the conflict rule are @profullstack/synconfig's; this is the store over
 * this board's Postgres and the three routes, mounted at /api/v1/settings.
 *
 * The board never reads a snapshot's files: it stores what the client sent
 * and hands it back. A token is never in one, by the client's policy.
 */

interface Pool {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

interface Row {
  revision: number;
  digest: string;
  host: string | null;
  version: string | null;
  size: number;
  body: Snapshot | string;
  created_at: string | Date;
}

const shape = (row: Row): StoredSnapshot => ({
  revision: Number(row.revision),
  digest: row.digest,
  host: row.host,
  version: row.version,
  size: Number(row.size),
  body: (typeof row.body === 'string' ? JSON.parse(row.body) : row.body) as Snapshot,
  savedAt: new Date(row.created_at).toISOString(),
});

/** The package's SnapshotStore over the board's pool. */
export function settingsStore(pool: Pool): SnapshotStore {
  return {
    async latest(userId) {
      const { rows } = await pool.query(
        'select revision, digest, host, version, size, body, created_at from settings_snapshots where user_id = $1 order by revision desc limit 1',
        [userId],
      );
      return rows[0] ? shape(rows[0] as unknown as Row) : null;
    },

    // The revision is chosen inside the INSERT and the precondition is
    // checked there, by a HAVING on the same aggregate, so two machines
    // saving at once produce one revision and one conflict. The unique
    // constraint is the backstop.
    async insert(userId, entry, ifRevision) {
      let rows: Record<string, unknown>[];
      try {
        ({ rows } = await pool.query(
          `insert into settings_snapshots (user_id, revision, digest, host, version, size, body)
           select $1, coalesce(max(revision), 0) + 1, $2, $3, $4, $5, $6::jsonb
             from settings_snapshots where user_id = $1
           having $7::int is null or coalesce(max(revision), 0) = $7::int
           returning revision, created_at`,
          [userId, entry.digest, entry.host, entry.version, entry.size, JSON.stringify(entry.body), ifRevision],
        ));
      } catch (error) {
        if (/duplicate key|unique/i.test(String((error as Error).message))) rows = [];
        else throw error;
      }
      if (!rows[0]) {
        const current = await this.latest(userId);
        return { conflict: true, revision: current?.revision ?? 0 };
      }
      const revision = Number(rows[0]['revision']);
      await pool.query('delete from settings_snapshots where user_id = $1 and revision <= $2', [userId, revision - KEEP_REVISIONS]);
      return { revision, savedAt: new Date(rows[0]['created_at'] as string | Date).toISOString() };
    },

    async list(userId, limit) {
      const { rows } = await pool.query(
        'select revision, digest, host, version, size, created_at from settings_snapshots where user_id = $1 order by revision desc limit $2',
        [userId, limit],
      );
      return rows.map((row) => {
        const { body: _body, ...rest } = shape({ ...(row as unknown as Row), body: '{}' });
        void _body;
        return rest;
      });
    },
  };
}

export function settingsRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const unauthenticated = (c: { json: (body: unknown, status: 401) => Response }) =>
    c.json({ error: { message: 'No token, or it has expired.', code: 'unauthenticated' } }, 401);

  app.get('/', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === null) return unauthenticated(c);
    const reply = await handleGet(settingsStore(c.get('deps').pool), viewer.id, { emptyStatus: 200 });
    return c.json(reply.body, reply.status as 200);
  });

  app.put('/', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === null) return unauthenticated(c);
    const body = await c.req.json().catch(() => ({}));
    const reply = await handlePut(settingsStore(c.get('deps').pool), viewer.id, body);
    return c.json(reply.body, reply.status as 200);
  });

  app.get('/revisions', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === null) return unauthenticated(c);
    const reply = await handleRevisions(settingsStore(c.get('deps').pool), viewer.id);
    return c.json(reply.body, reply.status as 200);
  });

  return app;
}
