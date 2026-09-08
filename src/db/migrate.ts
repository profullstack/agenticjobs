/**
 * Forward-only migrations, applied at boot.
 *
 * Every `.sql` file in `migrations/` runs once, in filename order, inside its
 * own transaction, and is recorded by name. Files are never edited after they
 * have shipped: a change to an applied file is invisible to every database
 * that already ran it.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/**
 * A boot-time migration and more than one process starting at once is a race
 * every deployment of this shape eventually hits: the web process and the
 * worker come up together, both see an unapplied file, and the loser fails on
 * a duplicate object. A session-level advisory lock serialises them; the
 * number is arbitrary but must never change.
 */
const LOCK_ID = 8_274_119;

export function migrationsDir(): string {
  // dist/db/migrate.js -> package root -> migrations
  return join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'migrations');
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: number;
}

export async function migrate(pool: pg.Pool, dir = migrationsDir()): Promise<MigrationResult> {
  const files = (await readdir(dir))
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'));

  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_ID]);

    await client.query(`
      create table if not exists schema_migrations (
        name       text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const done = await client.query<{ name: string }>('select name from schema_migrations');
    const seen = new Set(done.rows.map((row) => row.name));

    for (const name of files) {
      if (seen.has(name)) continue;
      const sql = await readFile(join(dir, name), 'utf8');
      try {
        await client.query('begin');
        // Sent whole, never split on semicolons: a plpgsql function body
        // contains its own statements and splitting cuts one in half.
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [name]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw new Error(
          `migration ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      applied.push(name);
    }

    return { applied, alreadyApplied: seen.size };
  } finally {
    // Released explicitly rather than by disconnecting, because the client is
    // going back into the pool with the session-level lock still held.
    await client.query('select pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    client.release();
  }
}
