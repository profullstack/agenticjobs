/**
 * Credit codes and invites.
 *
 * Two house packages over this board's Postgres, and nothing else:
 *
 * - @profullstack/redeem-credits mints scarce codes (stored only as hashes)
 *   that grant credit, in US cents, to whoever redeems them. The board has no
 *   balance of its own, so the package's ledger is the balance.
 * - @profullstack/affiliates gives every account three single-use invites and
 *   one open ?ref= code, and records who brought whom.
 *
 * An accepted invite pays a small credit to both people, but only after the
 * checks below: the invitee's address was confirmed (the magic link was spent),
 * the account is new, the two are not the same mailbox, the inviter's account
 * is old enough, and the inviter is under a monthly cap.
 */

import type pg from 'pg';
import {
  Credits,
  postgresStore as creditStore,
  normalizeCode as normalizeCreditCode,
  type MintedCode,
  type RedeemResult,
} from '@profullstack/redeem-credits';
import {
  Affiliates,
  postgresStore as affiliateStore,
  normalizeCode as normalizeInviteCode,
  type Invite,
  type RedeemInviteResult,
} from '@profullstack/affiliates';
import type { Config } from '../config.ts';

export { REF_COOKIE } from '@profullstack/affiliates';

/** Credit is kept in US cents. */
export const CREDIT_UNIT = 'usd_cents';
/** Invites per account. Scarce on purpose: an invite says someone wanted you here. */
export const INVITE_QUOTA = 3;
/** Where an /i/<code> visit is remembered until the person signs up. */
export const INVITE_COOKIE = 'aj_invite';
/** Bonuses one inviter can earn in 30 days, whatever their quota is raised to. */
export const INVITER_MONTHLY_CAP = 10;

const DEFAULT_BONUS_CENTS = 100;
const DEFAULT_INVITER_MIN_AGE_HOURS = 24;

interface Services {
  credits: Credits;
  affiliates: Affiliates;
}

const services = new WeakMap<object, Services>();

/** One pair of services per pool, built on first use. */
export function creditServices(pool: pg.Pool): Services {
  let found = services.get(pool);
  if (found === undefined) {
    found = {
      credits: new Credits(creditStore(pool)),
      affiliates: new Affiliates(affiliateStore(pool), { defaultQuota: INVITE_QUOTA }),
    };
    services.set(pool, found);
  }
  return found;
}

// --- input ---------------------------------------------------------------

/**
 * A credit or invite code as typed, or null when it cannot be one. The
 * packages forgive case, spaces and dashes; this only keeps junk (and
 * anything long enough to be an attack on a log line) out.
 */
export function cleanCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > 48) return null;
  if (!/^[A-Za-z0-9 _-]+$/.test(trimmed)) return null;
  return trimmed;
}

/** An affiliate code from ?ref= or the cookie: short, letters and digits. */
export function cleanRef(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9]{4,32}$/.test(trimmed) ? trimmed.toUpperCase() : null;
}

// --- credit ----------------------------------------------------------------

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export const REDEEM_MESSAGES: Record<Exclude<RedeemResult, { ok: true }>['reason'], string> = {
  invalid: 'That code does not exist. Check it and try again.',
  expired: 'That code has expired.',
  used_up: 'That code has already been used.',
  already_redeemed: 'You have already redeemed that code.',
  revoked: 'That code has been withdrawn.',
};

export interface CreditEntry {
  cents: number;
  kind: 'grant' | 'spend';
  source: string;
  at: string;
}

export interface CreditSummary {
  unit: typeof CREDIT_UNIT;
  balanceCents: number;
  balance: string;
  history: CreditEntry[];
}

/** What a ledger source means to the person reading it. */
export function describeSource(source: string): string {
  if (source.startsWith('code:')) return 'Credit code';
  if (source.startsWith('invite:')) return 'Invite bonus';
  if (source === 'admin') return 'Granted by the board';
  return source;
}

export async function creditSummary(pool: pg.Pool, userId: string): Promise<CreditSummary> {
  const { credits } = creditServices(pool);
  const [balanceCents, history] = await Promise.all([
    credits.balance(userId, CREDIT_UNIT),
    credits.history(userId, CREDIT_UNIT),
  ]);
  return {
    unit: CREDIT_UNIT,
    balanceCents,
    balance: formatCents(balanceCents),
    history: history
      .slice(-20)
      .reverse()
      .map((entry) => ({
        cents: entry.amount,
        kind: entry.kind,
        source: describeSource(entry.source),
        at: new Date(entry.at).toISOString(),
      })),
  };
}

export type RedeemOutcome =
  | { ok: true; cents: number; balanceCents: number }
  | { ok: false; reason: Exclude<RedeemResult, { ok: true }>['reason']; message: string };

export async function redeemCreditCode(
  pool: pg.Pool,
  userId: string,
  code: string,
): Promise<RedeemOutcome> {
  const { credits } = creditServices(pool);
  const result = await credits.redeem(code, userId);
  if (!result.ok)
    return { ok: false, reason: result.reason, message: REDEEM_MESSAGES[result.reason] };
  return {
    ok: true,
    cents: result.grant.unit === CREDIT_UNIT ? result.grant.amount : 0,
    balanceCents: await credits.balance(userId, CREDIT_UNIT),
  };
}

export interface MintRequest {
  cents: number;
  label: string;
  maxRedemptions?: number;
  expiresInDays?: number | null;
  createdBy?: string;
}

/** An operator mints a code. The plaintext is in the result and nowhere else. */
export async function mintCreditCode(pool: pg.Pool, request: MintRequest): Promise<MintedCode> {
  if (!Number.isInteger(request.cents) || request.cents <= 0 || request.cents > 1_000_000) {
    throw new Error('cents must be a whole number from 1 to 1000000');
  }
  const max = request.maxRedemptions ?? 1;
  if (!Number.isInteger(max) || max < 1 || max > 10_000) {
    throw new Error('maxRedemptions must be a whole number from 1 to 10000');
  }
  const days = request.expiresInDays ?? null;
  return creditServices(pool).credits.mint({
    grant: { unit: CREDIT_UNIT, amount: request.cents },
    label: request.label.trim().slice(0, 120) || 'agenticjobs credit',
    maxRedemptions: max,
    expiresAt: days === null ? null : Date.now() + days * 86_400_000,
    prefix: 'AJ',
    ...(request.createdBy === undefined ? {} : { createdBy: request.createdBy }),
  });
}

export { normalizeCreditCode };

// --- invites ---------------------------------------------------------------

export interface InviteView {
  id: string;
  note: string;
  createdAt: string;
  expiresAt: string | null;
  used: boolean;
  usedAt: string | null;
  revoked: boolean;
}

export interface InviteSummary {
  quota: { total: number; used: number; left: number };
  invites: InviteView[];
  affiliateCode: string;
  affiliateUrl: string;
  invitedCount: number;
}

function inviteView(invite: Omit<Invite, 'code'> & { revokedAt?: number | null }): InviteView {
  return {
    id: invite.id,
    note: invite.note,
    createdAt: new Date(invite.createdAt).toISOString(),
    expiresAt: invite.expiresAt === null ? null : new Date(invite.expiresAt).toISOString(),
    used: invite.usedBy !== null,
    usedAt: invite.usedAt === null ? null : new Date(invite.usedAt).toISOString(),
    revoked: (invite.revokedAt ?? null) !== null,
  };
}

export function inviteUrl(origin: string, code: string): string {
  return `${origin}/i/${encodeURIComponent(code)}`;
}

export async function inviteSummary(
  pool: pg.Pool,
  userId: string,
  origin: string,
): Promise<InviteSummary> {
  const { affiliates } = creditServices(pool);
  const [quota, invites, affiliateCode, invitees] = await Promise.all([
    affiliates.quota(userId),
    affiliates.invites(userId),
    affiliates.affiliateCode(userId),
    affiliates.invitees(userId),
  ]);
  return {
    quota,
    invites: invites.map(inviteView),
    affiliateCode,
    affiliateUrl: `${origin}/?ref=${affiliateCode}`,
    invitedCount: invitees.length,
  };
}

export type CreateInviteOutcome =
  | { ok: true; code: string; url: string; invite: InviteView; quota: InviteSummary['quota'] }
  | { ok: false; reason: 'no_invites_left' };

export async function createInvite(
  pool: pg.Pool,
  userId: string,
  note: string,
  origin: string,
): Promise<CreateInviteOutcome> {
  const { affiliates } = creditServices(pool);
  try {
    const invite = await affiliates.createInvite(userId, note.trim().slice(0, 120));
    return {
      ok: true,
      code: invite.code,
      url: inviteUrl(origin, invite.code),
      invite: inviteView(invite),
      quota: await affiliates.quota(userId),
    };
  } catch (error) {
    if (error instanceof Error && /no invites left/i.test(error.message)) {
      return { ok: false, reason: 'no_invites_left' };
    }
    throw error;
  }
}

/** The canonical spelling, for a cookie and a URL. Null when it cannot be an invite. */
export function canonicalInvite(value: unknown): string | null {
  const cleaned = cleanCode(value);
  if (cleaned === null) return null;
  const normal = normalizeInviteCode(cleaned);
  return /^INV-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(normal) ? normal : null;
}

/**
 * One mailbox under two spellings: case, a +tag, and Gmail's dots. Someone
 * inviting themselves to collect both halves of a bonus is the abuse this
 * catches; a second domain is not caught and is what the cap is for.
 */
export function sameMailbox(a: string, b: string): boolean {
  const canonical = (email: string): string => {
    const [rawLocal = '', rawDomain = ''] = email.trim().toLowerCase().split('@');
    let domain = rawDomain;
    let local = rawLocal.split('+')[0] ?? '';
    if (domain === 'googlemail.com') domain = 'gmail.com';
    if (domain === 'gmail.com') local = local.replaceAll('.', '');
    return `${local}@${domain}`;
  };
  return canonical(a) === canonical(b);
}

export type BonusStatus =
  'granted' | 'disabled' | 'same_mailbox' | 'inviter_too_new' | 'inviter_cap' | 'already';

export interface AcceptOutcome {
  invite: RedeemInviteResult;
  bonus: BonusStatus | null;
  cents: number;
}

/**
 * Accept an invite for an account that was created by this sign-in.
 *
 * The caller is the magic-link callback, so the invitee's address is
 * confirmed by construction. The invite is spent whatever the bonus decides:
 * who invited whom is recorded even when nothing is paid for it.
 */
export async function acceptInvite(
  pool: pg.Pool,
  config: Pick<Config, 'invites'>,
  code: string,
  invitee: { id: string; email: string },
): Promise<AcceptOutcome> {
  const { affiliates, credits } = creditServices(pool);
  const invite = await affiliates.redeemInvite(code, invitee.id);
  if (!invite.ok) return { invite, bonus: null, cents: 0 };

  const bonusCents = config.invites?.bonusCents ?? DEFAULT_BONUS_CENTS;
  const minAgeHours = config.invites?.inviterMinAgeHours ?? DEFAULT_INVITER_MIN_AGE_HOURS;

  const inviterRow = await pool.query<{ email: string; age_hours: number; recent: number }>(
    `select u.email,
            extract(epoch from (now() - u.created_at)) / 3600 as age_hours,
            (select count(*)::int from invite_bonuses b
              where b.user_id = u.id and b.role = 'inviter' and b.status = 'granted'
                and b.created_at > now() - interval '30 days') as recent
       from users u where u.id = $1`,
    [invite.inviterId],
  );
  const inviter = inviterRow.rows[0];

  let status: BonusStatus = 'granted';
  if (bonusCents <= 0) status = 'disabled';
  else if (inviter === undefined) status = 'disabled';
  else if (sameMailbox(inviter.email, invitee.email)) status = 'same_mailbox';
  else if (Number(inviter.age_hours) < minAgeHours) status = 'inviter_too_new';
  else if (inviter.recent >= INVITER_MONTHLY_CAP) status = 'inviter_cap';

  const cents = status === 'granted' ? bonusCents : 0;
  const pairs: [string, 'inviter' | 'invitee'][] = [
    [invitee.id, 'invitee'],
    ...(inviter === undefined ? [] : ([[invite.inviterId, 'inviter']] as [string, 'inviter'][])),
  ];
  let paid = 0;
  for (const [userId, role] of pairs) {
    // The row is claimed first, so a retry of this callback never pays twice.
    const claimed = await pool.query(
      `insert into invite_bonuses (invite_id, user_id, role, cents, status)
       values ($1, $2, $3, $4, $5)
       on conflict do nothing returning invite_id`,
      [invite.inviteId, userId, role, cents, status === 'granted' ? 'pending' : status],
    );
    if (claimed.rowCount === 0 || status !== 'granted') continue;
    await credits.grant(userId, { unit: CREDIT_UNIT, amount: cents }, `invite:${invite.inviteId}`);
    await pool.query(
      `update invite_bonuses set status = 'granted' where invite_id = $1 and user_id = $2`,
      [invite.inviteId, userId],
    );
    if (role === 'invitee') paid = cents;
  }
  return { invite, bonus: status, cents: paid };
}

/** First touch: an account already attributed keeps its first affiliate. */
export async function attributeRef(
  pool: pg.Pool,
  ref: string,
  userId: string,
): Promise<{ ok: boolean; affiliateId?: string }> {
  return creditServices(pool).affiliates.attribute(ref, userId);
}
