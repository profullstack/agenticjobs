/**
 * Everything this instance needs to know about itself, read once at boot.
 *
 * Reading `process.env` at the point of use is how one surface ends up on a
 * different port than another, so it happens here and nowhere else.
 */

import { createHash, randomBytes } from 'node:crypto';

export interface Config {
  databaseUrl: string;
  port: number;
  /** Interface to bind. `::` accepts IPv6 and IPv4-mapped addresses alike. */
  host: string;
  /** Public origin, no trailing slash. Every absolute URL is built from it. */
  publicUrl: string;
  boardName: string;
  boardTagline: string;
  topics: string[];
  /** Directory to announce to, or null to stay unlisted. */
  directoryUrl: string | null;
  announce: boolean;
  /** Whether this instance also runs a directory. */
  isDirectory: boolean;
  /** Resend API key, or null to print sign-in links instead of sending them. */
  resendApiKey: string | null;
  mailFrom: string;
  /**
   * Model keys for agent-assisted drafting on the post form.
   *
   * Whichever is set turns the feature on; neither leaves it off and absent
   * from the page rather than present and broken. Two providers because this
   * is software other people self-host, and a board that only works if you
   * bank with one vendor is not self-hostable.
   */
  anthropicApiKey: string | null;
  openaiApiKey: string | null;
  /** Overrides the per-provider default model. */
  writerModel: string | null;
  /**
   * CoinPay, for invoices sent through the inbox. Null leaves billing off and
   * absent from every page rather than present and broken.
   */
  coinpay: CoinPayConfig | null;
  version: string;
}

/**
 * Everything the board needs to settle an invoice on CoinPay.
 *
 * Two credentials for two jobs. The OAuth client is how a *person* connects
 * their own CoinPay account so the board can read which wallets they can be
 * paid to. The business key is the *board's*, and is what mints a payment
 * whose payee is that person's wallet: an OAuth token cannot create payments,
 * and a board that held its users' merchant keys would be a worse design than
 * one that holds its own.
 */
export interface CoinPayConfig {
  /** The portal's origin, no trailing slash. The API is under `/api`. */
  url: string;
  clientId: string;
  clientSecret: string;
  apiKey: string;
  businessId: string;
  /** Verifies webhooks. Null means status is learned by polling only. */
  webhookSecret: string | null;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * A From: address that is right by default on a real deploy.
 *
 * Resend rejects a sender whose domain is not verified, so the only address
 * with a chance of working is one on the domain the board is already served
 * from. A port in the host means a laptop, where nothing is sent anyway.
 */
function defaultMailFrom(publicUrl: string, boardName: string): string {
  let host: string;
  try {
    host = new URL(publicUrl).hostname;
  } catch {
    host = 'localhost';
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return 'jobs@localhost';
  // A display name containing a comma or a quote needs quoting to stay one
  // address, and quoting a name is never wrong, so it is always quoted.
  return `"${boardName.replace(/["\\]/g, '')}" <jobs@${host}>`;
}

/**
 * Are these two URLs the same board?
 *
 * Compared by origin because a trailing slash, an explicit `:443` and a
 * differing case in the host all name the same instance. Used to keep a board
 * out of its own directory: the flagship runs both roles, so it names itself
 * in DIRECTORY_URL and would otherwise announce its way into its own listing.
 */
export function sameOrigin(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  try {
    return new URL(a).origin.toLowerCase() === new URL(b).origin.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * The CoinPay block, or null.
 *
 * All four credentials or none: a board with a client id and no business key
 * could let people connect wallets nobody can ever pay, which is a feature
 * that looks finished and is not. A partial set is logged so the operator
 * finds out at boot rather than from a confused user.
 */
export function coinpayConfig(
  env: NodeJS.ProcessEnv,
  log: (message: string) => void = (message) => console.error(message),
): CoinPayConfig | null {
  const read = (name: string): string => env[name]?.trim() ?? '';
  const clientId = read('COINPAY_CLIENT_ID');
  const clientSecret = read('COINPAY_CLIENT_SECRET');
  const apiKey = read('COINPAY_API_KEY');
  const businessId = read('COINPAY_BUSINESS_ID');
  const present = [clientId, clientSecret, apiKey, businessId].filter((v) => v !== '').length;
  if (present === 0) return null;
  if (present < 4) {
    log(
      'coinpay: set all of COINPAY_CLIENT_ID, COINPAY_CLIENT_SECRET, COINPAY_API_KEY and COINPAY_BUSINESS_ID, or none. Billing is off.',
    );
    return null;
  }
  const webhookSecret = read('COINPAY_WEBHOOK_SECRET');
  return {
    url: trimSlash(read('COINPAY_URL') || 'https://coinpayportal.com'),
    clientId,
    clientSecret,
    apiKey,
    businessId,
    webhookSecret: webhookSecret === '' ? null : webhookSecret,
  };
}

function flag(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number.parseInt(env['PORT'] ?? '8787', 10) || 8787;
  const publicUrl = trimSlash(env['PUBLIC_URL']?.trim() || `http://localhost:${port}`);

  const directoryRaw = env['DIRECTORY_URL']?.trim() ?? '';
  const boardName = env['BOARD_NAME']?.trim() || 'Agentic Jobs';

  return {
    host: env['HOST']?.trim() || '0.0.0.0',
    databaseUrl:
      env['DATABASE_URL']?.trim() ||
      'postgres://agenticjobs:agenticjobs@localhost:5432/agenticjobs',
    port,
    publicUrl,
    boardName,
    boardTagline:
      env['BOARD_TAGLINE']?.trim() || 'Jobs posted here, not scraped from somewhere else.',
    topics: (env['BOARD_TOPICS'] ?? 'agentic,ai,engineering')
      .split(',')
      .map((topic) => topic.trim().toLowerCase())
      .filter((topic) => topic !== '')
      .slice(0, 12),
    directoryUrl: directoryRaw === '' ? null : trimSlash(directoryRaw),
    announce: flag(env['ANNOUNCE']),
    isDirectory: flag(env['DIRECTORY']),
    resendApiKey: env['RESEND_API_KEY']?.trim() || null,
    mailFrom: env['MAIL_FROM']?.trim() || defaultMailFrom(publicUrl, boardName),
    anthropicApiKey: env['ANTHROPIC_API_KEY']?.trim() || null,
    openaiApiKey: env['OPENAI_API_KEY']?.trim() || null,
    writerModel: env['WRITER_MODEL']?.trim() || null,
    coinpay: coinpayConfig(env),
    version: env['npm_package_version']?.trim() || VERSION,
  };
}

/** Kept in step with package.json by the release script. */
export const VERSION = '0.14.0';
export const SOFTWARE_NAME = 'agenticjobs';

/**
 * Tokens are stored as a hash of what was handed out, so this is the only
 * place that turns one into the other. Plain SHA-256 rather than a password
 * KDF on purpose: these are 256-bit random values, not something a person
 * chose, so there is no dictionary to slow an attacker down against.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function mintToken(): string {
  return randomBytes(32).toString('base64url');
}
