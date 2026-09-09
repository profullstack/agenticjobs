/**
 * Asking listed candidates to state their swarm capacity.
 *
 * The convention in `capacity.ts` is new, so every resume published before it
 * has nothing to show and the directory says "capacity not stated" on almost
 * every card. Backfilling was the alternative and it is the wrong one: nobody
 * here knows whether a given candidate is one agent or ten, and inventing an
 * answer would put a made-up price on a real person's profile. So we ask.
 *
 * Two rules this module exists to enforce, both of which are easy to get wrong
 * when a send is one function call away:
 *
 *   - **It only ever writes to people who are actually missing it.** The set
 *     is computed from the same parser the directory renders with, so "who
 *     needs asking" and "whose card looks empty" can never drift apart.
 *   - **It does not send unless asked to.** `plan` is the default and returns
 *     the recipients without contacting anybody, because the cost of a bug in
 *     an outbound loop is paid by other people's inboxes and cannot be undone.
 */

import type pg from 'pg';
import { escapeHtml } from '../markup/escape.ts';
import { parseCapacity } from './capacity.ts';
import type { Mailer, Message } from './mail.ts';
import type { OpenResume } from '../markup/resume.ts';

export interface CapacityAlertTarget {
  userId: string;
  email: string;
  /** The name on the resume, for the greeting. */
  name: string;
  /** Board-wide slug, so the mail can link the profile being talked about. */
  publicSlug: string;
  /** The owner's own slug, which is what /me/resumes/<slug> wants. */
  slug: string;
}

interface TargetRow {
  user_id: string;
  email: string;
  title: string;
  slug: string;
  public_slug: string;
  parsed: OpenResume | null;
}

/**
 * Listed candidates whose resume states no capacity.
 *
 * Only `public` resumes: a private resume is not in the directory, so nothing
 * about it is missing and its owner has not asked to be in this conversation.
 *
 * One row per person, not per resume. A candidate with three public resumes
 * has one inbox, and three emails saying the same thing is how a useful
 * request becomes spam. The most recently touched resume is the one named,
 * because it is the one they are most likely to still be editing.
 */
export async function candidatesMissingCapacity(pool: pg.Pool): Promise<CapacityAlertTarget[]> {
  const result = await pool.query<TargetRow>(
    `select distinct on (r.user_id)
            r.user_id, u.email, r.title, r.slug, r.public_slug, r.parsed
       from resumes r
       join users u on u.id = r.user_id
      where r.visibility = 'public'
        and r.public_slug is not null
        and u.email is not null
      order by r.user_id, r.updated_at desc`,
  );

  const out: CapacityAlertTarget[] = [];
  for (const row of result.rows) {
    // The same parser the card uses. If this ever disagrees with the directory
    // we would be mailing people whose profile already looks complete.
    if (parseCapacity(row.parsed?.contact ?? []) !== null) continue;
    const name = row.parsed?.name?.trim();
    out.push({
      userId: row.user_id,
      email: row.email,
      name: name === undefined || name === '' || name.length > 80 ? row.title : name,
      publicSlug: row.public_slug,
      slug: row.slug,
    });
  }
  return out;
}

/**
 * The ask.
 *
 * It shows the two lines to paste rather than describing them, because the
 * whole convention *is* two lines and a person who has to go and read a spec
 * to answer a one-question email mostly does not answer it. Both shapes are
 * given — a single agent and a swarm — since "I am one agent" is a real answer
 * and an email that only demonstrates the swarm case reads as though it is not.
 */
export function capacityAlertMessage(options: {
  to: string;
  name: string;
  boardName: string;
  profileUrl: string;
  editUrl: string;
  specUrl: string;
}): Message {
  const subject = `Add your agent capacity to ${options.boardName}`;

  const lines = [
    `Hi ${options.name},`,
    '',
    `Your profile is listed on ${options.boardName}, and employers browsing it cannot`,
    `tell one thing they care about: whether you are a single agent, or whether you`,
    `run several in parallel — and what that costs.`,
    '',
    `Add two lines to the contact block at the top of your resume:`,
    '',
    `  - **Agents**: 10`,
    `  - **Rate**: $100/hour/agent`,
    '',
    `Your profile would then read "10 agents · $100/hr each · $1,000/hr total".`,
    '',
    `If you are a single agent, that is a real answer and worth stating:`,
    '',
    `  - **Agents**: 1`,
    `  - **Rate**: $100/hour`,
    '',
    `Edit it here: ${options.editUrl}`,
    `Your public profile: ${options.profileUrl}`,
    `The convention: ${options.specUrl}`,
    '',
    `Nothing is removed if you skip this — your profile stays listed and simply`,
    `says the capacity is not stated.`,
  ];

  const code = (text: string) => `<code>${escapeHtml(text)}</code>`;
  const link = (url: string, label: string) =>
    `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;

  const html = [
    `<p>Hi ${escapeHtml(options.name)},</p>`,
    `<p>Your profile is listed on ${escapeHtml(options.boardName)}, and employers browsing it cannot tell one thing they care about: whether you are a single agent, or whether you run several in parallel &mdash; and what that costs.</p>`,
    `<p>Add two lines to the contact block at the top of your resume:</p>`,
    `<pre style="background:#f6f6f6;padding:12px;border-radius:6px">${code('- **Agents**: 10\n- **Rate**: $100/hour/agent')}</pre>`,
    `<p>Your profile would then read &ldquo;10 agents &middot; $100/hr each &middot; $1,000/hr total&rdquo;.</p>`,
    `<p>If you are a single agent, that is a real answer and worth stating:</p>`,
    `<pre style="background:#f6f6f6;padding:12px;border-radius:6px">${code('- **Agents**: 1\n- **Rate**: $100/hour')}</pre>`,
    `<p>${link(options.editUrl, 'Edit your resume')} &middot; ${link(options.profileUrl, 'your public profile')} &middot; ${link(options.specUrl, 'the convention')}</p>`,
    `<p style="color:#666;font-size:12px">Nothing is removed if you skip this &mdash; your profile stays listed and simply says the capacity is not stated.</p>`,
  ].join('');

  return { to: options.to, subject, html, text: lines.join('\n') };
}

export interface CapacityAlertResult {
  target: CapacityAlertTarget;
  /** False when the provider refused, null when this was a plan-only run. */
  sent: boolean | null;
}

/**
 * Work the list.
 *
 * `send` has to be passed explicitly. A default of "yes, mail everyone" is the
 * kind of default that turns a typo in a WHERE clause into an apology, and
 * this is the one function in the module that can do that.
 *
 * Sends are sequential. The list is small by construction — it is the people
 * listed on one board who have not filled in one field — and a provider that
 * rate-limits a burst would report failures that mean nothing about the
 * recipient.
 */
export async function runCapacityAlerts(options: {
  pool: pg.Pool;
  mailer: Mailer | null;
  boardName: string;
  publicUrl: string;
  send: boolean;
}): Promise<CapacityAlertResult[]> {
  const targets = await candidatesMissingCapacity(options.pool);
  const base = options.publicUrl.replace(/\/+$/, '');

  const out: CapacityAlertResult[] = [];
  for (const target of targets) {
    if (!options.send || options.mailer === null) {
      out.push({ target, sent: null });
      continue;
    }
    const sent = await options.mailer.send(
      capacityAlertMessage({
        to: target.email,
        name: target.name,
        boardName: options.boardName,
        profileUrl: `${base}/candidates/${target.publicSlug}`,
        editUrl: `${base}/me/resumes/${target.slug}`,
        specUrl: `${base}/docs/openresume#capacity`,
      }),
    );
    out.push({ target, sent });
  }
  return out;
}
