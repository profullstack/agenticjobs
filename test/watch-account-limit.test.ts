import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { createWatch, WATCHES_PER_ACCOUNT } from '../src/core/watches.ts';
import { EMPTY_QUERY } from '../src/schema/query.ts';

const database = process.env['TEST_DATABASE_URL'];

test(
  'concurrent distinct watches respect the account cap and existing saves stay idempotent',
  { skip: !database },
  async () => {
    const schema = `watch_limit_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: database });
    const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
    try {
      await admin.query(`create schema ${schema}`);
      await pool.query('create table users (id uuid primary key)');
      await pool.query(
        await readFile(new URL('../migrations/0020_watches.sql', import.meta.url), 'utf8'),
      );
      const userId = randomUUID();
      await pool.query('insert into users values ($1)', [userId]);
      for (let i = 0; i < WATCHES_PER_ACCOUNT - 1; i += 1) {
        await createWatch(pool, userId, { ...EMPTY_QUERY, q: `existing ${i}` }, {}, () => null);
      }
      // Make overlapping inserts deterministic without replacing database locking
      // with a mock: the old count-then-insert path lets both counts see 19.
      await pool.query(`create function delay_watch_insert() returns trigger language plpgsql as $$
        begin perform pg_sleep(0.2); return NEW; end $$`);
      await pool.query(`create trigger delay_watch before insert on watches
        for each row execute function delay_watch_insert()`);
      const results = await Promise.all(
        ['rust', 'typescript'].map((q) =>
          createWatch(pool, userId, { ...EMPTY_QUERY, q }, {}, () => null),
        ),
      );
      assert.equal(results.filter((result) => typeof result !== 'string').length, 1);
      assert.equal(results.filter((result) => typeof result === 'string').length, 1);
      const count = await pool.query('select count(*)::int as n from watches');
      assert.equal(count.rows[0].n, WATCHES_PER_ACCOUNT);
      const saved = results.find((result) => typeof result !== 'string');
      assert.ok(saved && typeof saved !== 'string');
      const again = await createWatch(pool, userId, saved.watch.query, {}, () => null);
      assert.ok(typeof again !== 'string');
      assert.equal(again.created, false);
      assert.equal(again.watch.id, saved.watch.id);
    } finally {
      await pool.end();
      await admin.query(`drop schema if exists ${schema} cascade`);
      await admin.end();
    }
  },
);
