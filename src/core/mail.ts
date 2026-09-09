/**
 * Sending the one email this board sends: a sign-in link.
 *
 * Delivery is optional and always has been - a laptop run has no mail
 * provider, and the link is printed instead. What was wrong before is that
 * *every* instance took that path, because the config had an SMTP_URL nobody
 * ever read. `delivered` is a fact about a send that happened now, not a
 * restatement of which environment variables are set.
 *
 * @profullstack/emailer wraps Resend's HTTP API with no runtime dependencies:
 * a fetch is the whole client, so there is no connection to hold and no port
 * to be blocked.
 */

import { createEmailer } from '@profullstack/emailer';
import { escapeHtml } from '../markup/escape.ts';
import { MAGIC_TTL_MS } from './auth.ts';
import type { Config } from '../config.ts';

/** How long a link lasts, in minutes, taken from the TTL that enforces it. */
export const MAGIC_LINK_MINUTES = Math.round(MAGIC_TTL_MS / 60_000);

export interface Message {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface Mailer {
  send: (message: Message) => Promise<boolean>;
}

/**
 * A mailer, or null when this instance is not configured to send.
 *
 * Null is a supported state, not a failure: it is what makes `pnpm dev` work
 * without an account anywhere.
 */
export function createMailer(
  config: Config,
  log: (message: string) => void = (message) => console.error(message),
): Mailer | null {
  if (config.resendApiKey === null) return null;
  const emailer = createEmailer({ resendApiKey: config.resendApiKey, defaultFrom: config.mailFrom });

  return {
    send: async (message) => {
      try {
        const result = await emailer.send({
          from: config.mailFrom,
          to: message.to,
          subject: message.subject,
          html: message.html,
          text: message.text,
        });
        // An unverified sending domain is a 403 whatever the key is, and a
        // dead key is a 401. Both arrive here as `sent: false` with the
        // provider's own sentence, which is the thing worth logging.
        if (!result.sent) log(`mail: ${message.to} not sent: ${result.error ?? 'unknown error'}`);
        return result.sent;
      } catch (error) {
        // A provider outage must not turn a sign-in attempt into a 500. The
        // link is already minted and still works; the person just has to ask
        // for another one.
        log(`mail: ${message.to} failed: ${(error as Error).message}`);
        return false;
      }
    },
  };
}

/** The `code` a /device redirect carries, so the email can show it. */
function deviceCodeOf(redirect: string | null): string | null {
  if (redirect === null || !redirect.startsWith('/device')) return null;
  const query = redirect.indexOf('?');
  if (query === -1) return null;
  const code = new URLSearchParams(redirect.slice(query + 1)).get('code');
  return code === null || code.trim() === '' ? null : code.trim();
}

/**
 * The sign-in email.
 *
 * When the link came from a terminal it carries that terminal's code, and the
 * email says so and shows it. That is not decoration: a device flow where the
 * mail cannot be matched to the request in front of you is one where a link
 * phished out of an inbox approves an attacker's terminal instead.
 */
export function magicLinkMessage(options: {
  to: string;
  url: string;
  boardName: string;
  redirect: string | null;
  minutes: number;
}): Message {
  const code = deviceCodeOf(options.redirect);
  const board = options.boardName;
  const subject = code === null ? `Sign in to ${board}` : `Approve your terminal on ${board}`;

  const lead =
    code === null
      ? `Use the link below to sign in to ${board}. There is no password.`
      : `A terminal asked to sign in to ${board} with the code ${code}. Open the link below to approve it.`;
  const caution =
    code === null
      ? `If you did not ask to sign in, ignore this email. Nobody can use the link but you.`
      : `If that code is not the one your terminal is showing, do not open the link.`;

  const text = [
    lead,
    '',
    options.url,
    '',
    `The link lasts ${options.minutes} minutes and works once.`,
    caution,
  ].join('\n');

  const url = escapeHtml(options.url);
  const html = [
    `<p>${escapeHtml(lead)}</p>`,
    `<p><a href="${url}">${url}</a></p>`,
    `<p style="color:#666;font-size:12px">The link lasts ${options.minutes} minutes and works once. ${escapeHtml(caution)}</p>`,
  ].join('');

  return { to: options.to, subject, html, text };
}

/**
 * Send the sign-in link, or fall back to the server log.
 *
 * The log is the fallback for both "no provider configured" and "the provider
 * refused": the link is minted either way and is the only way into the
 * account, so an operator being able to read it out of their own logs beats
 * losing it. It goes to the *log*, never to the browser - a page that shows
 * the link to whoever typed the address is not a sign-in, it is a way to take
 * over any address you can spell.
 */
export async function deliverMagicLink(options: {
  mailer: Mailer | null;
  boardName: string;
  email: string;
  url: string;
  redirect: string | null;
}): Promise<boolean> {
  if (options.mailer !== null) {
    const sent = await options.mailer.send(
      magicLinkMessage({
        to: options.email,
        url: options.url,
        boardName: options.boardName,
        redirect: options.redirect,
        minutes: MAGIC_LINK_MINUTES,
      }),
    );
    if (sent) return true;
  }
  console.log(`magic link for ${options.email}: ${options.url}`);
  return false;
}
