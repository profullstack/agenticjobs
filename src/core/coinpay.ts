/**
 * CoinPay: connecting a person's account, and minting the payments that settle
 * an invoice to their wallet.
 *
 * Two credentials do two jobs, and it matters which is which:
 *
 *  - A person connects their own CoinPay account over OAuth. The board asks for
 *    `wallet:read` and uses the token for exactly one call, `userinfo`, which
 *    returns the wallets they can be paid to. That is all the token can do;
 *    CoinPay's OAuth has no scope for creating anything. So the board keeps
 *    the wallets (addresses, not secrets) and throws the token away in the
 *    same request: nothing on this server can act as the person on CoinPay.
 *    "Refresh wallets" is a fresh consent, not a stored token.
 *  - The board has a business key of its own. That is what creates a payment,
 *    with the payee's address as `merchant_wallet_address`, and CoinPay records
 *    who authorised the third-party payout. The board never holds funds.
 *
 * `wallet:read` is checked on the scope the token came back with, not on the
 * scope that was asked for. CoinPay narrows a grant to what the client was
 * registered for without an error, and a board that trusts its own request
 * ends up showing "Connected" beside an account it cannot read a wallet from.
 *
 * Everything here goes through one `fetch`, injected, so the suite can stand
 * in for CoinPay without a network.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import type { CoinPayConfig } from '../config.ts';

export const REQUIRED_SCOPE = 'wallet:read';
export const SCOPES = ['openid', 'profile', 'email', REQUIRED_SCOPE];
/** An authorization has this long to come back. */
const STATE_TTL_MS = 10 * 60 * 1000;
/** Refresh a token this close to expiry rather than using it. */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export interface Wallet {
  address: string;
  /** CoinPay's spelling: BTC, ETH, SOL, USDC_POL ... */
  chain: string;
  label: string | null;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  scope: string[];
  expiresAt: string;
}

export interface UserInfo {
  sub: string;
  email: string | null;
  name: string | null;
  wallets: Wallet[];
}

export interface Payment {
  id: string;
  address: string | null;
  amountCrypto: string | null;
  currency: string | null;
  status: string;
  expiresAt: string | null;
  txHash: string | null;
}

export class CoinPayProblem extends Error {
  /** CoinPay's HTTP status, or undefined when CoinPay never answered. */
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** The site every payment here is for, as CoinPay records it (`property`). */
export const PROPERTY = 'agenticjobs.work';

export interface CoinPayClient {
  readonly config: CoinPayConfig;
  authorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string;
  exchangeCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<TokenSet>;
  refresh(refreshToken: string): Promise<TokenSet>;
  userinfo(accessToken: string): Promise<UserInfo>;
  createPayment(input: {
    amountUsd: string;
    chain: string;
    payeeAddress: string;
    description: string;
    redirectUrl: string;
    idempotencyKey: string;
    metadata: Record<string, string>;
    /** Who is paying: their email and agenticjobs user id. Sent top-level and in metadata. */
    customerEmail?: string | null;
    accountId?: string | null;
    /** Who is being paid: the payee's agenticjobs user id. */
    payeeId?: string | null;
  }): Promise<Payment>;
  getPayment(id: string): Promise<Payment | null>;
  /** Where a payer goes to pay. */
  payUrl(paymentId: string): string;
  /** True when a webhook body was signed with this board's secret. */
  verifyWebhook(rawBody: string, signature: string | undefined, now?: number): boolean;
}

type Fetch = typeof fetch;

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** The wallets claim, as userinfo returns it: `{ address, chain, label }`. */
export function normaliseWallets(value: unknown): Wallet[] {
  if (!Array.isArray(value)) return [];
  const out: Wallet[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const address = str(record['address']);
    const chain = str(record['chain']) ?? str(record['cryptocurrency']);
    if (address === null || chain === null) continue;
    out.push({ address, chain: chain.toUpperCase(), label: str(record['label']) });
  }
  return out;
}

export function hasScope(scope: string[] | string, wanted = REQUIRED_SCOPE): boolean {
  const list = Array.isArray(scope) ? scope : scope.split(/\s+/).filter(Boolean);
  return list.includes(wanted);
}

function tokenSet(body: Record<string, unknown>): TokenSet {
  const accessToken = str(body['access_token']);
  if (accessToken === null) throw new CoinPayProblem('CoinPay returned no access token.');
  const expiresIn = typeof body['expires_in'] === 'number' ? body['expires_in'] : 3600;
  return {
    accessToken,
    refreshToken: str(body['refresh_token']),
    scope: (str(body['scope']) ?? '').split(/\s+/).filter(Boolean),
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

function payment(body: Record<string, unknown>): Payment {
  const id = str(body['id']);
  if (id === null) throw new CoinPayProblem('CoinPay returned a payment with no id.');
  const crypto = body['amount_crypto'] ?? body['crypto_amount'];
  return {
    id,
    address: str(body['payment_address']),
    amountCrypto: crypto === undefined || crypto === null ? null : String(crypto),
    currency: (str(body['currency']) ?? str(body['blockchain']))?.toUpperCase() ?? null,
    status: str(body['status']) ?? 'pending',
    expiresAt: str(body['expires_at']),
    txHash: str(body['tx_hash']),
  };
}

export function createCoinPay(config: CoinPayConfig, fetchImpl: Fetch = fetch): CoinPayClient {
  const api = `${config.url}/api`;

  async function call(
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    let response: Response;
    try {
      response = await fetchImpl(`${api}${path}`, {
        method: init.method ?? 'GET',
        headers: init.headers ?? {},
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new CoinPayProblem(`CoinPay is not answering: ${(error as Error).message}`);
    }
    const text = await response.text();
    let parsed: unknown = {};
    try {
      parsed = text === '' ? {} : JSON.parse(text);
    } catch {
      // An HTML error page, usually a wrong COINPAY_URL. Say so.
      throw new CoinPayProblem(
        `CoinPay answered ${response.status} with something that is not JSON.`,
        response.status,
      );
    }
    return {
      status: response.status,
      body:
        typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {},
    };
  }

  function errorOf(body: Record<string, unknown>, fallback: string): string {
    const error = body['error'];
    if (typeof error === 'string') return error;
    if (typeof error === 'object' && error !== null) {
      const message = (error as Record<string, unknown>)['message'];
      if (typeof message === 'string') return message;
    }
    return typeof body['error_description'] === 'string' ? body['error_description'] : fallback;
  }

  async function token(params: Record<string, string>): Promise<TokenSet> {
    const result = await call('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...params,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }).toString(),
    });
    if (result.status !== 200) {
      throw new CoinPayProblem(
        errorOf(result.body, 'CoinPay refused the token request.'),
        result.status,
      );
    }
    return tokenSet(result.body);
  }

  return {
    config,

    authorizeUrl({ state, codeChallenge, redirectUri }) {
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES.join(' '),
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
      return `${api}/oauth/authorize?${params.toString()}`;
    },

    exchangeCode({ code, redirectUri, codeVerifier }) {
      return token({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      });
    },

    refresh(refreshToken) {
      return token({ grant_type: 'refresh_token', refresh_token: refreshToken });
    },

    async userinfo(accessToken) {
      const result = await call('/oauth/userinfo', {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (result.status !== 200) {
        throw new CoinPayProblem(
          errorOf(result.body, 'CoinPay would not say who that token is.'),
          result.status,
        );
      }
      const sub = str(result.body['sub']);
      if (sub === null) throw new CoinPayProblem('CoinPay returned a user with no id.');
      return {
        sub,
        email: str(result.body['email']),
        name: str(result.body['name']),
        wallets: normaliseWallets(result.body['wallets']),
      };
    },

    async createPayment(input) {
      const result = await call('/payments/create', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          business_id: config.businessId,
          amount_usd: Number(input.amountUsd),
          payment_method: 'crypto',
          blockchain: input.chain,
          merchant_wallet_address: input.payeeAddress,
          description: input.description,
          redirect_url: input.redirectUrl,
          // Optional on /payments/create: a malformed one is dropped by CoinPay, never a 400.
          ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
          ...(input.accountId ? { account_id: input.accountId } : {}),
          property: PROPERTY,
          metadata: {
            ...input.metadata,
            property: PROPERTY,
            ...(input.accountId ? { account_id: input.accountId } : {}),
            ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
            ...(input.payeeId ? { payee_id: input.payeeId } : {}),
            idempotency_key: input.idempotencyKey,
          },
        }),
      });
      if (result.status !== 200 && result.status !== 201) {
        throw new CoinPayProblem(errorOf(result.body, 'CoinPay would not create the payment.'));
      }
      const body = result.body['payment'];
      if (typeof body !== 'object' || body === null) {
        throw new CoinPayProblem('CoinPay returned no payment.');
      }
      return payment(body as Record<string, unknown>);
    },

    async getPayment(id) {
      const result = await call(`/payments/${encodeURIComponent(id)}`, {});
      if (result.status === 404) return null;
      if (result.status !== 200) {
        throw new CoinPayProblem(errorOf(result.body, 'CoinPay would not return the payment.'));
      }
      const body = result.body['payment'];
      if (typeof body !== 'object' || body === null) return null;
      return payment(body as Record<string, unknown>);
    },

    payUrl(paymentId) {
      return `${config.url}/pay/${encodeURIComponent(paymentId)}`;
    },

    verifyWebhook(rawBody, signature, now = Date.now()) {
      if (config.webhookSecret === null || signature === undefined) return false;
      // `t=<unix seconds>,v1=<hex>`, HMAC-SHA256 over `<t>.<body>`.
      const parts = new Map<string, string>();
      for (const part of signature.split(',')) {
        const at = part.indexOf('=');
        if (at === -1) continue;
        parts.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
      }
      const t = parts.get('t');
      const v1 = parts.get('v1');
      if (t === undefined || v1 === undefined || !/^\d+$/.test(t) || !/^[0-9a-f]+$/i.test(v1)) {
        return false;
      }
      if (Math.abs(Math.floor(now / 1000) - Number(t)) > 300) return false;
      const expected = createHmac('sha256', config.webhookSecret)
        .update(`${t}.${rawBody}`)
        .digest();
      const received = Buffer.from(v1, 'hex');
      return received.length === expected.length && timingSafeEqual(received, expected);
    },
  };
}

// --- a person's connection ------------------------------------------------

export interface Account {
  userId: string;
  sub: string;
  email: string | null;
  name: string | null;
  scope: string[];
  wallets: Wallet[];
  connectedAt: string;
  updatedAt: string;
  /** When `wallets` was last read from CoinPay (connect, reconnect or the legacy sweep). */
  walletsSyncedAt: string | null;
  /** False when the grant could not read wallets: the person has to reconnect. */
  usable: boolean;
}

interface AccountRow {
  user_id: string;
  coinpay_sub: string;
  email: string | null;
  name: string | null;
  /** Legacy only (before 0026): plaintext tokens, migrated away by `sweepLegacyTokens`. */
  access_token: string | null;
  refresh_token: string | null;
  scope: string;
  expires_at: string | null;
  wallets: unknown;
  wallets_synced_at: string | null;
  connected_at: string;
  updated_at: string;
}

function toAccount(row: AccountRow): Account {
  const scope = row.scope.split(/\s+/).filter(Boolean);
  return {
    userId: row.user_id,
    sub: row.coinpay_sub,
    email: row.email,
    name: row.name,
    scope,
    wallets: normaliseWallets(row.wallets),
    connectedAt: row.connected_at,
    updatedAt: row.updated_at,
    walletsSyncedAt: row.wallets_synced_at,
    // The wallets were read under a grant that had wallet:read. No token is
    // needed to pay to them, so none is kept.
    usable: hasScope(scope),
  };
}

export async function getAccount(pool: pg.Pool, userId: string): Promise<Account | null> {
  const result = await pool.query<AccountRow>(`select * from coinpay_accounts where user_id = $1`, [
    userId,
  ]);
  const row = result.rows[0];
  return row === undefined ? null : toAccount(row);
}

/**
 * Begin connecting. Returns the URL to send the person to.
 *
 * The state and the PKCE verifier live in the database, not a cookie, so the
 * callback can be completed from any session of the same person and a state
 * is used up by being deleted.
 */
export async function beginConnect(
  pool: pg.Pool,
  coinpay: CoinPayClient,
  userId: string,
  redirectUri: string,
  next: string | null,
): Promise<string> {
  const { verifier, challenge } = pkcePair();
  const state = base64url(randomBytes(24));
  await pool.query(`delete from coinpay_oauth_states where expires_at < now()`);
  await pool.query(
    `insert into coinpay_oauth_states (state, user_id, code_verifier, redirect, expires_at)
     values ($1, $2, $3, $4, $5)`,
    [state, userId, verifier, next, new Date(Date.now() + STATE_TTL_MS).toISOString()],
  );
  return coinpay.authorizeUrl({ state, codeChallenge: challenge, redirectUri });
}

/**
 * Finish connecting. Returns where to send the person, or a sentence.
 *
 * The account is attached to whoever *started* the flow, read off the state,
 * not to whoever is signed in when the callback lands: those are the same
 * person in every honest case and a different one in the case this protects
 * against.
 */
export async function finishConnect(
  pool: pg.Pool,
  coinpay: CoinPayClient,
  input: { state: string; code: string; redirectUri: string },
): Promise<{ userId: string; redirect: string | null; account: Account } | string> {
  // The state travels into a SQL parameter, and a NUL byte is not text:
  // PostgreSQL refuses it outright, so `?state=%00` on
  // GET /api/v1/coinpay/callback answered 500 where every state that matches
  // no pending flow answers "expired". Drop the byte; a state that cleans
  // away to nothing matches nothing.
  const state = input.state.replace(/\0/g, '').trim();
  const claimed = await pool.query<{
    user_id: string;
    code_verifier: string;
    redirect: string | null;
  }>(
    `delete from coinpay_oauth_states where state = $1 and expires_at > now()
     returning user_id, code_verifier, redirect`,
    [state],
  );
  const pending = claimed.rows[0];
  if (pending === undefined) return 'That connection attempt has expired. Start again.';

  let tokens: TokenSet;
  let info: UserInfo;
  try {
    tokens = await coinpay.exchangeCode({
      code: input.code,
      redirectUri: input.redirectUri,
      codeVerifier: pending.code_verifier,
    });
    info = await coinpay.userinfo(tokens.accessToken);
  } catch (error) {
    if (error instanceof CoinPayProblem) return error.message;
    throw error;
  }

  if (!hasScope(tokens.scope)) {
    return `CoinPay connected the account but did not grant ${REQUIRED_SCOPE}, so no wallet can be read. Check the OAuth client's registered scopes on CoinPay.`;
  }

  // One CoinPay account, one person here.
  const holder = await pool.query<{ user_id: string }>(
    `select user_id from coinpay_accounts where coinpay_sub = $1 and user_id <> $2`,
    [info.sub, pending.user_id],
  );
  if (holder.rows.length > 0) {
    return 'That CoinPay account is already connected to a different account on this board. Disconnect it there first.';
  }

  // The wallets are what the board needs; the tokens are not stored at all.
  // A reconnect over a legacy row clears its old tokens in the same write.
  const saved = await pool.query<AccountRow>(
    `insert into coinpay_accounts
       (user_id, coinpay_sub, email, name, access_token, refresh_token, scope, expires_at,
        wallets, wallets_synced_at)
     values ($1, $2, $3, $4, null, null, $5, null, $6::jsonb, now())
     on conflict (user_id) do update set
       coinpay_sub = excluded.coinpay_sub, email = excluded.email, name = excluded.name,
       access_token = null, refresh_token = null, expires_at = null,
       scope = excluded.scope, wallets = excluded.wallets,
       wallets_synced_at = now(), updated_at = now()
     returning *`,
    [
      pending.user_id,
      info.sub,
      info.email,
      info.name,
      tokens.scope.join(' '),
      JSON.stringify(info.wallets),
    ],
  );
  return {
    userId: pending.user_id,
    redirect: pending.redirect,
    account: toAccount(saved.rows[0]!),
  };
}

// --- legacy tokens ---------------------------------------------------------

/**
 * Before 0026 the board kept each person's CoinPay access and refresh tokens
 * in plaintext, readable by anyone with the database or root on the box. The
 * only thing they were ever used for was re-reading wallets, so each legacy
 * row is converted once: one refresh, one `userinfo`, the wallets written and
 * every token column nulled in the same update.
 *
 *  - CoinPay refuses the refresh or the read (invalid_grant, 401, 403): the
 *    tokens are deleted anyway. The wallets read at connect time stay, so
 *    invoices keep working; "Refresh wallets" is a reconnect.
 *  - CoinPay is down or answers 5xx: nothing changes, the next sweep retries.
 *  - `legacy: false` (LEGACY_KEY_MIGRATION=off): legacy tokens are never sent
 *    anywhere again; the sweep just deletes them.
 */
export type LegacyOutcome = 'migrated' | 'refused' | 'deferred' | 'dropped';

export interface LegacySweep {
  migrated: number;
  refused: number;
  deferred: number;
  dropped: number;
  /** Rows still holding a token after this sweep. */
  remaining: number;
}

const DROP_TOKENS = `access_token = null, refresh_token = null, expires_at = null`;

function refusedByCoinPay(error: unknown): boolean {
  return (
    error instanceof CoinPayProblem &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500
  );
}

export async function migrateLegacyToken(
  pool: pg.Pool,
  coinpay: CoinPayClient | null,
  row: Pick<AccountRow, 'user_id' | 'access_token' | 'refresh_token' | 'expires_at'>,
  options: { legacy: boolean },
): Promise<LegacyOutcome> {
  if (!options.legacy || coinpay === null) {
    await pool.query(
      `update coinpay_accounts set ${DROP_TOKENS}, updated_at = now() where user_id = $1`,
      [row.user_id],
    );
    return 'dropped';
  }
  try {
    let access = row.access_token;
    let scope: string[] | null = null;
    const expired =
      row.expires_at === null ||
      new Date(row.expires_at).getTime() - Date.now() <= EXPIRY_BUFFER_MS;
    if (access === null || access === '' || expired) {
      if (row.refresh_token === null || row.refresh_token === '') {
        throw new CoinPayProblem('No refresh token.', 400);
      }
      const tokens = await coinpay.refresh(row.refresh_token);
      access = tokens.accessToken;
      scope = tokens.scope;
    }
    const info = await coinpay.userinfo(access);
    const usable = scope === null || hasScope(scope);
    await pool.query(
      `update coinpay_accounts set ${DROP_TOKENS},
              wallets = case when $2 then $3::jsonb else wallets end,
              wallets_synced_at = case when $2 then now() else wallets_synced_at end,
              scope = coalesce($4, scope),
              email = coalesce($5, email), name = coalesce($6, name), updated_at = now()
        where user_id = $1`,
      [
        row.user_id,
        usable,
        JSON.stringify(info.wallets),
        scope === null ? null : scope.join(' '),
        info.email,
        info.name,
      ],
    );
    return 'migrated';
  } catch (error) {
    if (refusedByCoinPay(error)) {
      await pool.query(
        `update coinpay_accounts set ${DROP_TOKENS}, updated_at = now() where user_id = $1`,
        [row.user_id],
      );
      return 'refused';
    }
    if (error instanceof CoinPayProblem) return 'deferred';
    throw error;
  }
}

/** How many rows still hold a CoinPay token. Zero once the migration is done. */
export async function legacyTokenCount(pool: pg.Pool): Promise<number> {
  const result = await pool.query<{ n: number }>(
    `select count(*)::int as n from coinpay_accounts
      where access_token is not null or refresh_token is not null`,
  );
  return result.rows[0]?.n ?? 0;
}

/** Convert every legacy row. Safe to run any number of times. */
export async function sweepLegacyTokens(
  pool: pg.Pool,
  coinpay: CoinPayClient | null,
  options: { legacy: boolean },
): Promise<LegacySweep> {
  const rows = await pool.query<
    Pick<AccountRow, 'user_id' | 'access_token' | 'refresh_token' | 'expires_at'>
  >(
    `select user_id, access_token, refresh_token, expires_at from coinpay_accounts
      where access_token is not null or refresh_token is not null`,
  );
  const out: LegacySweep = { migrated: 0, refused: 0, deferred: 0, dropped: 0, remaining: 0 };
  for (const row of rows.rows) {
    out[await migrateLegacyToken(pool, coinpay, row, options)] += 1;
  }
  out.remaining = await legacyTokenCount(pool);
  return out;
}

/**
 * Forget the connection. CoinPay publishes no revocation endpoint, so deleting
 * the row is the whole of what can be done; invoices already sent keep the
 * address they were sent with and are unaffected.
 */
export async function disconnect(pool: pg.Pool, userId: string): Promise<boolean> {
  const result = await pool.query(`delete from coinpay_accounts where user_id = $1`, [userId]);
  return (result.rowCount ?? 0) > 0;
}
