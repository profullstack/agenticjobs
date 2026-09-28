import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWatch } from '../src/core/watches.ts';
import { EMPTY_QUERY } from '../src/schema/query.ts';

test('concurrent saves of one search return the same watch instead of a database error', async () => {
  type StoredWatch = {
    id: string;
    query: Record<string, string>;
    label: string;
    email: boolean;
    created_at: string;
    last_notified_at: null;
  };

  let stored: StoredWatch | null = null;
  let lockTail = Promise.resolve();

  const pool = {
    async connect() {
      let unlock: (() => void) | undefined;
      return {
        async query(sql: string, params: unknown[] = []) {
          if (sql === 'begin') return { rows: [] };
          if (sql === 'select id from users where id = $1 for update') {
            const previous = lockTail;
            lockTail = new Promise<void>((resolve) => {
              unlock = resolve;
            });
            await previous;
            return { rows: [{ id: params[0] }] };
          }
          if (sql === 'commit' || sql === 'rollback') {
            unlock?.();
            return { rows: [] };
          }
          return pool.query(sql, params);
        },
        release() {
          unlock?.();
        },
      };
    },
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes('from watches where user_id = $1 and query = $2::jsonb')) {
        const snapshot =
          stored !== null && JSON.stringify(stored.query) === params[1] ? { ...stored } : null;
        return { rows: snapshot === null ? [] : [snapshot], rowCount: snapshot === null ? 0 : 1 };
      }
      if (sql.includes('select count(*)::int as n from watches')) {
        return { rows: [{ n: stored === null ? 0 : 1 }], rowCount: 1 };
      }
      if (sql.startsWith('insert into watches')) {
        if (stored !== null) {
          if (sql.includes('on conflict')) return { rows: [], rowCount: 0 };
          throw Object.assign(new Error('duplicate key value violates unique constraint'), {
            code: '23505',
          });
        }
        stored = {
          id: 'watch-1',
          query: JSON.parse(params[1] as string) as Record<string, string>,
          label: String(params[2]),
          email: Boolean(params[3]),
          created_at: '2026-09-24T00:00:00.000Z',
          last_notified_at: null,
        };
        return { rows: [{ ...stored }], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };

  const results = await Promise.all([
    createWatch(pool as never, 'user-1', { ...EMPTY_QUERY, tags: ['rust'] }, {}, () => null),
    createWatch(pool as never, 'user-1', { ...EMPTY_QUERY, tags: ['rust'] }, {}, () => null),
  ]);

  assert.ok(results.every((result) => typeof result !== 'string'));
  if (results.some((result) => typeof result === 'string')) return;
  assert.deepEqual(results.map((result) => result.created).sort(), [false, true]);
  assert.deepEqual(
    results.map((result) => result.watch.id),
    ['watch-1', 'watch-1'],
  );
});
