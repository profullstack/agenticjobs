/**
 * Who someone is, established four ways: a magic link, a passkey, an existing
 * session cookie, or the device flow for anything without a browser.
 *
 * No passwords anywhere. That is the house rule and it is also the reason the
 * device flow exists: a terminal cannot follow a magic link, so it asks the
 * board for a short code instead and a browser approves it.
 */

import type pg from 'pg';
import { hashToken, mintToken } from '../config.ts';
import { clean } from '../schema/text.ts';

export interface Viewer {
  id: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
  /**
   * True when the caller authenticated with a device-flow token rather than a
   * browser session. Such a caller is never an administrator, whatever the
   * account says — see `requireAdmin`.
   */
  viaToken: boolean;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Exported so the sign-in email can state the same number it enforces. */
export const MAGIC_TTL_MS = 15 * 60 * 1000;
const DEVICE_TTL_MS = 10 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export const SESSION_COOKIE = 'aj_session';

export function normaliseEmail(value: unknown): string | null {
  const email = clean(value, 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  is_admin: boolean;
}

/**
 * Find or create the account for an address.
 *
 * The first account on a board becomes its administrator. Any other rule
 * requires a setup step someone has to be told about, and an installer that
 * leaves the operator locked out of their own board is not an installer.
 */
export async function ensureUser(pool: pg.Pool, email: string, name?: string): Promise<UserRow> {
  const existing = await pool.query<UserRow>(
    `select id, email, name, is_admin from users where lower(email) = lower($1)`,
    [email],
  );
  const found = existing.rows[0];
  if (found !== undefined) return found;

  const created = await pool.query<UserRow>(
    `insert into users (email, name, is_admin)
     values ($1, $2, (select count(*) = 0 from users))
     returning id, email, name, is_admin`,
    [email, name === undefined ? null : clean(name, 120) || null],
  );
  const row = created.rows[0];
  if (row === undefined) throw new Error('user insert returned no row');
  return row;
}

export async function createSession(
  pool: pg.Pool,
  userId: string,
  options: { label?: string; viaToken?: boolean; ttlMs?: number } = {},
): Promise<string> {
  const token = mintToken();
  await pool.query(
    `insert into sessions (user_id, token_hash, label, via_token, expires_at)
     values ($1, $2, $3, $4, now() + ($5 || ' milliseconds')::interval)`,
    [
      userId,
      hashToken(token),
      clean(options.label, 80) || 'session',
      options.viaToken === true,
      String(options.ttlMs ?? SESSION_TTL_MS),
    ],
  );
  return token;
}

export async function viewerFromToken(pool: pg.Pool, token: string): Promise<Viewer | null> {
  if (token.trim() === '') return null;
  const result = await pool.query<UserRow & { via_token: boolean; session_id: string }>(
    `select u.id, u.email, u.name, u.is_admin, s.via_token, s.id as session_id
       from sessions s
       join users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now()
      limit 1`,
    [hashToken(token)],
  );
  const row = result.rows[0];
  if (row === undefined) return null;

  // Best effort: a failed touch must not cost the caller their request.
  void pool
    .query(`update sessions set last_used_at = now() where id = $1`, [row.session_id])
    .catch(() => undefined);

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    // A device-flow token is never an administrator, and that is enforced HERE
    // rather than only at the routes: the token was typed into a terminal and
    // lives in a file on disk, while a browser session was established in
    // front of the person it belongs to. Reporting `isAdmin: true` for one and
    // relying on every call site to also check `viaToken` is how the third
    // call site gets it wrong.
    isAdmin: row.is_admin && !row.via_token,
    viaToken: row.via_token,
  };
}

export async function revokeSession(pool: pg.Pool, token: string): Promise<void> {
  await pool.query(`delete from sessions where token_hash = $1`, [hashToken(token)]);
}

/**
 * A device-flow token is never an administrator.
 *
 * The token was typed into a terminal and lives in a file on disk; a browser
 * session was established in front of the person it belongs to. Treating them
 * as equivalent would make every CLI token a full admin credential.
 */
export function requireAdmin(viewer: Viewer | null): viewer is Viewer {
  return viewer !== null && viewer.isAdmin && !viewer.viaToken;
}

// --- magic links --------------------------------------------------------

export interface MagicLink {
  token: string;
  expiresAt: string;
}

/** Only same-origin paths. An open redirect on a login link is a phish. */
export function safeRedirect(value: unknown): string | null {
  const raw = clean(value, 500);
  if (raw === '' || !raw.startsWith('/') || raw.startsWith('//')) return null;
  return raw;
}

export async function startMagicLink(
  pool: pg.Pool,
  email: string,
  redirect: string | null,
): Promise<MagicLink> {
  const token = mintToken();
  const result = await pool.query<{ expires_at: string }>(
    `insert into magic_links (token_hash, email, redirect, expires_at)
     values ($1, $2, $3, now() + ($4 || ' milliseconds')::interval)
     returning expires_at`,
    [hashToken(token), email, redirect, String(MAGIC_TTL_MS)],
  );
  return { token, expiresAt: result.rows[0]?.expires_at ?? new Date().toISOString() };
}

export interface ConsumedLink {
  user: UserRow;
  redirect: string | null;
}

/**
 * Spend a magic link.
 *
 * The update is what claims it, not a read followed by a write: two clicks
 * arriving together (a mail client prefetching the link, then the person
 * clicking it) would both pass a read-then-write check.
 */
export async function consumeMagicLink(
  pool: pg.Pool,
  token: string,
): Promise<ConsumedLink | null> {
  const claimed = await pool.query<{ email: string; redirect: string | null }>(
    `update magic_links
        set used_at = now()
      where token_hash = $1 and used_at is null and expires_at > now()
      returning email, redirect`,
    [hashToken(token)],
  );
  const row = claimed.rows[0];
  if (row === undefined) return null;
  const user = await ensureUser(pool, row.email);
  return { user, redirect: row.redirect };
}

// --- the device flow ----------------------------------------------------

export interface DeviceGrant {
  deviceCode: string;
  userCode: string;
  verifyUrl: string;
  interval: number;
  expiresAt: number;
}

/** No characters that look like each other when read off a screen. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function userCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let index = 0; index < bytes.length; index += 1) {
    if (index === 4) out += '-';
    out += CODE_ALPHABET[(bytes[index] ?? 0) % CODE_ALPHABET.length];
  }
  return out;
}

export async function startDeviceAuth(
  pool: pg.Pool,
  label: string,
  publicUrl: string,
): Promise<DeviceGrant> {
  const deviceCode = mintToken();
  const code = userCode();
  const result = await pool.query<{ expires_at: string }>(
    `insert into device_codes (device_code_hash, user_code, label, expires_at)
     values ($1, $2, $3, now() + ($4 || ' milliseconds')::interval)
     returning expires_at`,
    [hashToken(deviceCode), code, clean(label, 80) || 'terminal', String(DEVICE_TTL_MS)],
  );
  return {
    deviceCode,
    userCode: code,
    // The code travels in the URL, so approving is one click rather than a
    // page that asks for a code the person then has to find in their terminal.
    // The page still accepts a typed one, for a browser on another machine.
    verifyUrl: `${publicUrl}/device?code=${code}`,
    interval: 2,
    expiresAt: Date.parse(result.rows[0]?.expires_at ?? '') || Date.now() + DEVICE_TTL_MS,
  };
}

export type DevicePoll =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'approved'; token: string };

/**
 * Collect the token for an approved code.
 *
 * The token is cleared in the same statement that returns it, so it is handed
 * over exactly once: a second poll with the same device code gets nothing,
 * which is what makes a leaked poll response useless.
 *
 * An unknown or expired code reports `expired` rather than `pending`. A client
 * told `pending` for a code the server has forgotten polls until its own
 * timeout with no way to tell that it is waiting for nothing.
 */
export async function pollDeviceAuth(pool: pg.Pool, deviceCode: string): Promise<DevicePoll> {
  const hash = hashToken(deviceCode);
  // The token has to be read as it was BEFORE the update, and Postgres
  // RETURNING gives post-update values - so a plain
  // `update ... set token = null ... returning token` hands back the null it
  // just wrote and the terminal waits forever. The CTE holds the old row (and
  // locks it, so two polls cannot both claim), and RETURNING reads from that.
  const claimed = await pool.query<{ token: string | null }>(
    `with claimed as (
       select device_code_hash, token
         from device_codes
        where device_code_hash = $1 and status = 'approved' and token is not null
        for update
     )
     update device_codes d
        set token = null, status = 'collected'
       from claimed
      where d.device_code_hash = claimed.device_code_hash
      returning claimed.token`,
    [hash],
  );
  const token = claimed.rows[0]?.token;
  if (typeof token === 'string') return { status: 'approved', token };

  const pending = await pool.query<{ status: string }>(
    `select status from device_codes
      where device_code_hash = $1 and expires_at > now() and status = 'pending'`,
    [hash],
  );
  return pending.rows.length > 0 ? { status: 'pending' } : { status: 'expired' };
}

export interface PendingDevice {
  userCode: string;
  label: string;
}

export async function findDeviceCode(
  pool: pg.Pool,
  code: string,
): Promise<PendingDevice | null> {
  const result = await pool.query<{ user_code: string; label: string }>(
    `select user_code, label from device_codes
      where user_code = $1 and status = 'pending' and expires_at > now()`,
    [code.trim().toUpperCase()],
  );
  const row = result.rows[0];
  return row === undefined ? null : { userCode: row.user_code, label: row.label };
}

export async function approveDeviceCode(
  pool: pg.Pool,
  code: string,
  userId: string,
): Promise<boolean> {
  const label = await findDeviceCode(pool, code);
  if (label === null) return false;
  // The terminal's token is marked via_token, which is what keeps it out of
  // the admin routes for the rest of its life.
  const token = await createSession(pool, userId, {
    label: `terminal: ${label.label}`,
    viaToken: true,
  });
  const updated = await pool.query(
    `update device_codes
        set status = 'approved', user_id = $2, token = $3
      where user_code = $1 and status = 'pending' and expires_at > now()`,
    [code.trim().toUpperCase(), userId, token],
  );
  return (updated.rowCount ?? 0) > 0;
}

// --- webauthn challenges ------------------------------------------------

export async function storeChallenge(
  pool: pg.Pool,
  challenge: string,
  purpose: 'register' | 'login',
  who: { email?: string; userId?: string },
): Promise<void> {
  await pool.query(
    `insert into webauthn_challenges (challenge, email, user_id, purpose, expires_at)
     values ($1, $2, $3, $4, now() + ($5 || ' milliseconds')::interval)
     on conflict (challenge) do nothing`,
    [
      challenge,
      who.email ?? null,
      who.userId ?? null,
      purpose,
      String(CHALLENGE_TTL_MS),
    ],
  );
}

export interface StoredChallenge {
  challenge: string;
  email: string | null;
  userId: string | null;
  purpose: string;
}

/** Claimed on read: a challenge is single use by definition. */
export async function takeChallenge(
  pool: pg.Pool,
  challenge: string,
): Promise<StoredChallenge | null> {
  const result = await pool.query<{
    challenge: string;
    email: string | null;
    user_id: string | null;
    purpose: string;
  }>(
    `delete from webauthn_challenges
      where challenge = $1 and expires_at > now()
      returning challenge, email, user_id, purpose`,
    [challenge],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    challenge: row.challenge,
    email: row.email,
    userId: row.user_id,
    purpose: row.purpose,
  };
}

/** Swept opportunistically rather than on a timer, so there is no worker. */
export async function sweepExpired(pool: pg.Pool): Promise<void> {
  await pool.query(`delete from sessions where expires_at < now()`);
  await pool.query(`delete from magic_links where expires_at < now()`);
  await pool.query(`delete from device_codes where expires_at < now() - interval '1 hour'`);
  await pool.query(`delete from webauthn_challenges where expires_at < now()`);
}
