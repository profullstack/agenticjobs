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
  secret: string;
  /** Directory to announce to, or null to stay unlisted. */
  directoryUrl: string | null;
  announce: boolean;
  /** Whether this instance also runs a directory. */
  isDirectory: boolean;
  smtpUrl: string | null;
  mailFrom: string;
  version: string;
  /** True when SECRET was generated rather than supplied. */
  ephemeralSecret: boolean;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function flag(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number.parseInt(env['PORT'] ?? '8787', 10) || 8787;
  const publicUrl = trimSlash(env['PUBLIC_URL']?.trim() || `http://localhost:${port}`);

  const supplied = env['SECRET']?.trim() ?? '';
  // A missing secret is survivable for a laptop run and fatal for a deploy:
  // every session and device code minted before a restart stops verifying.
  // Generating one keeps `pnpm dev` working without making the failure quiet.
  const ephemeralSecret = supplied === '';
  const secret = ephemeralSecret ? randomBytes(32).toString('hex') : supplied;

  const directoryRaw = env['DIRECTORY_URL']?.trim() ?? '';

  return {
    host: env['HOST']?.trim() || '0.0.0.0',
    databaseUrl:
      env['DATABASE_URL']?.trim() ||
      'postgres://agenticjobs:agenticjobs@localhost:5432/agenticjobs',
    port,
    publicUrl,
    boardName: env['BOARD_NAME']?.trim() || 'Agentic Jobs',
    boardTagline:
      env['BOARD_TAGLINE']?.trim() || 'Jobs posted here, not scraped from somewhere else.',
    topics: (env['BOARD_TOPICS'] ?? 'agentic,ai,engineering')
      .split(',')
      .map((topic) => topic.trim().toLowerCase())
      .filter((topic) => topic !== '')
      .slice(0, 12),
    secret,
    ephemeralSecret,
    directoryUrl: directoryRaw === '' ? null : trimSlash(directoryRaw),
    announce: flag(env['ANNOUNCE']),
    isDirectory: flag(env['DIRECTORY']),
    smtpUrl: env['SMTP_URL']?.trim() || null,
    mailFrom: env['MAIL_FROM']?.trim() || 'jobs@localhost',
    version: env['npm_package_version']?.trim() || VERSION,
  };
}

/** Kept in step with package.json by the release script. */
export const VERSION = '0.1.1';
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
