/**
 * One Postgres pool for the process.
 *
 * `pg` is CommonJS, so the named exports have to come off the default import;
 * destructuring them in the import statement fails under NodeNext with a
 * message about the module having no such export, which is misleading.
 */

import pg from 'pg';

const { Pool, types } = pg;

export type { PoolClient, QueryResult } from 'pg';
export type Pool = pg.Pool;

// `timestamptz` (OID 1184) and `timestamp` (1114) arrive as JS Dates by
// default, which then serialise differently depending on which surface does
// the serialising. Everything in this codebase treats a time as an ISO string,
// so the conversion happens once, here.
types.setTypeParser(1184, (value: string) => new Date(value).toISOString());
types.setTypeParser(1114, (value: string) => new Date(`${value}Z`).toISOString());
// `int8` comes back as a string so that large values survive. Every count in
// this schema is comfortably inside Number.MAX_SAFE_INTEGER.
types.setTypeParser(20, (value: string) => Number.parseInt(value, 10));

let pool: pg.Pool | null = null;

export function getPool(databaseUrl: string): pg.Pool {
  if (pool !== null) return pool;
  pool = new Pool({
    connectionString: databaseUrl,
    max: Number.parseInt(process.env['PG_POOL_MAX'] ?? '10', 10) || 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Managed Postgres almost always presents a certificate this process has
    // no root for. Refusing to connect would be correct and would also mean
    // nobody can deploy, so verification is opt-in through PGSSLMODE.
    ...(needsSsl(databaseUrl) ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  // A pool that emits an error with no listener takes the process down, and
  // the common cause is a database restart the app could simply reconnect
  // through.
  pool.on('error', (error: Error) => {
    console.error('postgres pool error', error.message);
  });

  return pool;
}

function needsSsl(databaseUrl: string): boolean {
  const mode = process.env['PGSSLMODE']?.trim().toLowerCase();
  if (mode === 'disable') return false;
  if (mode !== undefined && mode !== '') return true;
  try {
    const url = new URL(databaseUrl);
    if (url.searchParams.get('sslmode') === 'disable') return false;
    if (url.searchParams.has('sslmode')) return true;
    // A local database is the only one where plaintext is the sane default.
    return !['localhost', '127.0.0.1', '::1', 'postgres', 'db'].includes(url.hostname);
  } catch {
    return false;
  }
}

/** For tests and for `agenticjobs` subcommands that exit when they are done. */
export async function closePool(): Promise<void> {
  if (pool === null) return;
  const closing = pool;
  pool = null;
  await closing.end();
}
