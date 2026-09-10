/**
 * The inbox: private conversations between the people on this board.
 *
 * There is no public comment box anywhere on the site, and that is the design
 * rather than an omission. A board with one got used as the place to hand in
 * invoices, because an invoice has to go *somewhere* and a comment under a
 * listing was the only somewhere. A conversation here is between the people in
 * it and nobody else, and an invoice is a message in one with money attached
 * (see invoices.ts).
 *
 * Who can be written to is whoever has a page: a candidate with a published
 * resume, or an employer. Writing to an employer reaches every member of it.
 * Who can write is anybody signed in, which is the cheapest thing that keeps
 * the inbox from being a contact form for strangers: twenty new conversations
 * a day, per account, in the database, however the message arrived.
 */

import type pg from 'pg';
import { clean } from '../schema/text.ts';
import type { Mailer } from './mail.ts';
import { inboxMessage } from './mail.ts';

/** The most a message can say. */
export const MESSAGE_MAX = 4000;
export const SUBJECT_MAX = 140;
/** New conversations per person, per day. Replies are not counted. */
export const DAILY_THREADS = 20;
/** How long a thread stays quiet in somebody's email after they were told. */
const NOTIFY_GAP_MS = 60 * 60 * 1000;

/** Who a conversation is with. */
export type Counterparty =
  { kind: 'candidate'; userId: string } | { kind: 'employer'; orgId: string };

export interface Party {
  kind: 'candidate' | 'employer';
  name: string;
  /** Their page, when they have one. */
  slug: string | null;
}

export interface ThreadSummary {
  id: string;
  subject: string;
  job: { slug: string; title: string } | null;
  /** The other side, as the viewer sees it. */
  with: Party;
  lastMessageAt: string;
  /** Messages from the other side newer than the viewer last opened it. */
  unread: number;
  /** The start of the latest message. */
  preview: string;
}

export interface Message {
  id: string;
  kind: 'text' | 'invoice';
  body: string;
  invoiceId: string | null;
  createdAt: string;
  sender: { id: string; name: string; party: Party | null };
  /** Whether the viewer wrote it. */
  mine: boolean;
}

export interface Thread {
  id: string;
  subject: string;
  job: { slug: string; title: string } | null;
  with: Party;
  /** Everyone in it, for the page and for "who gets paid". */
  participants: { userId: string; name: string; orgId: string | null }[];
  messages: Message[];
  createdAt: string;
}

interface ParticipantRow {
  user_id: string;
  org_id: string | null;
  user_name: string | null;
  email: string;
  public_slug: string | null;
  org_name: string | null;
  org_slug: string | null;
}

/**
 * A participant, named for display.
 *
 * An employer's member shows as the employer: the other side wrote to Acme
 * and should see Acme answer. A person shows by the name on their account,
 * then the email they signed in with. The email is fine here where it is not
 * on an update: a conversation is between signed-in members, who can read the
 * contact block of a resume anyway.
 */
function partyOf(row: ParticipantRow): Party {
  if (row.org_id !== null) {
    return { kind: 'employer', name: row.org_name ?? 'An employer', slug: row.org_slug };
  }
  const name = (row.user_name ?? '').trim();
  return { kind: 'candidate', name: name === '' ? row.email : name, slug: row.public_slug };
}

function personName(row: ParticipantRow): string {
  const name = (row.user_name ?? '').trim();
  return name === '' ? row.email : name;
}

const PARTICIPANTS = `
  select tp.thread_id, tp.user_id, tp.org_id, tp.last_read_at,
         u.name as user_name, u.email,
         (select r.public_slug from resumes r
           where r.user_id = tp.user_id and r.public_slug is not null
             and r.visibility in ('link', 'public')
           order by r.updated_at desc limit 1) as public_slug,
         o.name as org_name, o.slug as org_slug
    from thread_participants tp
    join users u on u.id = tp.user_id
    left join organisations o on o.id = tp.org_id`;

/**
 * The other side of a thread, from one participant's point of view.
 *
 * When the other side is an employer, every member is a participant and they
 * are all the same party, so the first is as good as any.
 */
function otherParty(rows: ParticipantRow[], viewerId: string): Party {
  const mine = rows.find((row) => row.user_id === viewerId);
  const others = rows.filter(
    (row) =>
      row.user_id !== viewerId &&
      // A member of the same employer as the viewer is on the viewer's side.
      (mine?.org_id === null || mine?.org_id === undefined || row.org_id !== mine.org_id),
  );
  const first = others[0];
  if (first === undefined) return { kind: 'candidate', name: 'Nobody', slug: null };
  return partyOf(first);
}

function preview(body: string): string {
  const line = body.replace(/\s+/g, ' ').trim();
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

async function isParticipant(pool: pg.Pool, threadId: string, userId: string): Promise<boolean> {
  const result = await pool.query(
    `select 1 from thread_participants where thread_id = $1 and user_id = $2`,
    [threadId, userId],
  );
  return result.rows.length > 0;
}

/**
 * Start a conversation, or continue the one that already exists.
 *
 * The same two parties about the same listing (or about nothing in
 * particular) is one conversation, not one per click: a second "message"
 * from a candidate page lands as a new message in the thread they already
 * have, which is what the person meant. Returns the thread id, or a sentence
 * saying why not.
 *
 * `as` lets a member write as their employer, so the candidate sees the
 * company they applied to rather than a name they do not know. It has to be
 * an employer the sender belongs to, checked here rather than trusted.
 */
export async function startThread(
  pool: pg.Pool,
  senderId: string,
  to: Counterparty,
  input: { subject: unknown; body: unknown; jobId?: string | null; as?: string | null },
): Promise<{ threadId: string; messageId: string; created: boolean } | string> {
  const subject = clean(input.subject, SUBJECT_MAX);
  const body = clean(input.body, MESSAGE_MAX, { multiline: true });
  if (body === '') return 'Write something.';
  if (to.kind === 'candidate' && to.userId === senderId) return 'That is you.';

  const asOrg = input.as ?? null;
  if (asOrg !== null) {
    const member = await pool.query(
      `select 1 from memberships where user_id = $1 and org_id = $2`,
      [senderId, asOrg],
    );
    if (member.rows.length === 0) return 'You can only write as an employer you belong to.';
    if (to.kind === 'employer' && to.orgId === asOrg) return 'That is you.';
  }

  const jobId = input.jobId ?? null;

  // Find the existing conversation between these parties about this listing.
  const existing = await pool.query<{ id: string }>(
    `select t.id from threads t
      where t.job_id is not distinct from $3
        and exists (select 1 from thread_participants me
                     where me.thread_id = t.id and me.user_id = $1)
        and exists (select 1 from thread_participants them
                     where them.thread_id = t.id
                       and ${to.kind === 'candidate' ? 'them.user_id = $2 and them.org_id is null' : 'them.org_id = $2'})
      order by t.last_message_at desc limit 1`,
    [senderId, to.kind === 'candidate' ? to.userId : to.orgId, jobId],
  );
  const found = existing.rows[0];
  if (found !== undefined) {
    const message = await sendMessage(pool, found.id, senderId, body);
    if (typeof message === 'string') return message;
    return { threadId: found.id, messageId: message.id, created: false };
  }

  // The limit is on *new* conversations: replying in one you already have is
  // never what a spammer is doing.
  const recent = await pool.query<{ count: number }>(
    `select count(*)::int as count from threads
      where created_by = $1 and created_at > now() - interval '1 day'`,
    [senderId],
  );
  if ((recent.rows[0]?.count ?? 0) >= DAILY_THREADS) {
    return `That is ${DAILY_THREADS} new conversations today. Reply in one you have, or come back tomorrow.`;
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const thread = await client.query<{ id: string }>(
      `insert into threads (subject, job_id, created_by) values ($1, $2, $3) returning id`,
      [subject === '' ? preview(body).slice(0, SUBJECT_MAX) : subject, jobId, senderId],
    );
    const threadId = thread.rows[0]!.id;

    // The sender, as themselves or as every member of their employer.
    if (asOrg === null) {
      await client.query(
        `insert into thread_participants (thread_id, user_id, org_id, last_read_at)
         values ($1, $2, null, now())`,
        [threadId, senderId],
      );
    } else {
      await client.query(
        `insert into thread_participants (thread_id, user_id, org_id, last_read_at)
         select $1, m.user_id, $2, case when m.user_id = $3 then now() else null end
           from memberships m where m.org_id = $2`,
        [threadId, asOrg, senderId],
      );
    }

    // The other side.
    if (to.kind === 'candidate') {
      await client.query(
        `insert into thread_participants (thread_id, user_id, org_id) values ($1, $2, null)
         on conflict do nothing`,
        [threadId, to.userId],
      );
    } else {
      await client.query(
        `insert into thread_participants (thread_id, user_id, org_id)
         select $1, m.user_id, $2 from memberships m where m.org_id = $2
         on conflict do nothing`,
        [threadId, to.orgId],
      );
    }

    const message = await client.query<{ id: string }>(
      `insert into messages (thread_id, sender_id, kind, body) values ($1, $2, 'text', $3)
       returning id`,
      [threadId, senderId, body],
    );
    await client.query('commit');
    return { threadId, messageId: message.rows[0]!.id, created: true };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Reply. Only a participant can, and the reply marks the thread read for
 * them: you have seen what you are answering.
 */
export async function sendMessage(
  pool: pg.Pool,
  threadId: string,
  senderId: string,
  rawBody: unknown,
  invoice: { id: string } | null = null,
): Promise<{ id: string; createdAt: string } | string> {
  const body = clean(rawBody, MESSAGE_MAX, { multiline: true });
  if (body === '') return 'Write something.';
  if (!(await isParticipant(pool, threadId, senderId))) return 'You are not in that conversation.';

  const inserted = await pool.query<{ id: string; created_at: string }>(
    `with m as (
       insert into messages (thread_id, sender_id, kind, body, invoice_id)
       values ($1, $2, $3, $4, $5)
       returning id, created_at
     ), t as (
       update threads set last_message_at = (select created_at from m) where id = $1
     ), r as (
       update thread_participants set last_read_at = (select created_at from m)
        where thread_id = $1 and user_id = $2
     )
     select id, created_at from m`,
    [threadId, senderId, invoice === null ? 'text' : 'invoice', body, invoice?.id ?? null],
  );
  const row = inserted.rows[0]!;
  return { id: row.id, createdAt: row.created_at };
}

/** Everything the viewer is in, newest activity first. */
export async function listThreads(pool: pg.Pool, viewerId: string): Promise<ThreadSummary[]> {
  const threads = await pool.query<{
    id: string;
    subject: string;
    last_message_at: string;
    job_slug: string | null;
    job_title: string | null;
    unread: number;
    preview: string | null;
  }>(
    `select t.id, t.subject, t.last_message_at, j.slug as job_slug, j.title as job_title,
            (select count(*)::int from messages m
              where m.thread_id = t.id and m.sender_id <> $1
                and m.created_at > coalesce(me.last_read_at, 'epoch'::timestamptz)) as unread,
            (select m.body from messages m where m.thread_id = t.id
              order by m.created_at desc limit 1) as preview
       from threads t
       join thread_participants me on me.thread_id = t.id and me.user_id = $1
       left join jobs j on j.id = t.job_id
      order by t.last_message_at desc
      limit 200`,
    [viewerId],
  );
  if (threads.rows.length === 0) return [];

  const ids = threads.rows.map((row) => row.id);
  const participants = await pool.query<ParticipantRow & { thread_id: string }>(
    `${PARTICIPANTS} where tp.thread_id = any($1::uuid[])`,
    [ids],
  );
  const byThread = new Map<string, ParticipantRow[]>();
  for (const row of participants.rows) {
    const list = byThread.get(row.thread_id) ?? [];
    list.push(row);
    byThread.set(row.thread_id, list);
  }

  return threads.rows.map((row) => ({
    id: row.id,
    subject: row.subject,
    job:
      row.job_slug === null ? null : { slug: row.job_slug, title: row.job_title ?? row.job_slug },
    with: otherParty(byThread.get(row.id) ?? [], viewerId),
    lastMessageAt: row.last_message_at,
    unread: row.unread,
    preview: preview(row.preview ?? ''),
  }));
}

/**
 * One conversation, for a participant. Null for anybody else, and null rather
 * than 403 so the existence of a conversation is not itself something a
 * stranger can learn by guessing ids.
 */
export async function getThread(
  pool: pg.Pool,
  threadId: string,
  viewerId: string,
): Promise<Thread | null> {
  const participants = await pool.query<ParticipantRow>(`${PARTICIPANTS} where tp.thread_id = $1`, [
    threadId,
  ]);
  if (!participants.rows.some((row) => row.user_id === viewerId)) return null;

  const head = await pool.query<{
    id: string;
    subject: string;
    created_at: string;
    job_slug: string | null;
    job_title: string | null;
  }>(
    `select t.id, t.subject, t.created_at, j.slug as job_slug, j.title as job_title
       from threads t left join jobs j on j.id = t.job_id where t.id = $1`,
    [threadId],
  );
  const row = head.rows[0];
  if (row === undefined) return null;

  const messages = await pool.query<{
    id: string;
    kind: 'text' | 'invoice';
    body: string;
    invoice_id: string | null;
    created_at: string;
    sender_id: string;
  }>(
    `select id, kind, body, invoice_id, created_at, sender_id
       from messages where thread_id = $1 order by created_at asc limit 500`,
    [threadId],
  );

  const byUser = new Map(participants.rows.map((p) => [p.user_id, p]));
  return {
    id: row.id,
    subject: row.subject,
    createdAt: row.created_at,
    job:
      row.job_slug === null ? null : { slug: row.job_slug, title: row.job_title ?? row.job_slug },
    with: otherParty(participants.rows, viewerId),
    participants: participants.rows.map((p) => ({
      userId: p.user_id,
      name: personName(p),
      orgId: p.org_id,
    })),
    messages: messages.rows.map((m) => {
      const sender = byUser.get(m.sender_id);
      return {
        id: m.id,
        kind: m.kind,
        body: m.body,
        invoiceId: m.invoice_id,
        createdAt: m.created_at,
        sender: {
          id: m.sender_id,
          name: sender === undefined ? 'Someone who left' : personName(sender),
          party: sender === undefined ? null : partyOf(sender),
        },
        mine: m.sender_id === viewerId,
      };
    }),
  };
}

/** Opening a thread is reading it. */
export async function markRead(pool: pg.Pool, threadId: string, viewerId: string): Promise<void> {
  await pool.query(
    `update thread_participants set last_read_at = now() where thread_id = $1 and user_id = $2`,
    [threadId, viewerId],
  );
}

/** Threads with something the viewer has not seen, for the nav. */
export async function unreadThreads(pool: pg.Pool, viewerId: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `select count(*)::int as count from thread_participants me
      where me.user_id = $1
        and exists (select 1 from messages m
                     where m.thread_id = me.thread_id and m.sender_id <> $1
                       and m.created_at > coalesce(me.last_read_at, 'epoch'::timestamptz))`,
    [viewerId],
  );
  return result.rows[0]?.count ?? 0;
}

/**
 * Tell the other participants there is something to read.
 *
 * One email per person per hour per thread, and none to anyone who has the
 * thread open (their last read is newer than the message). The email says
 * who wrote and that there is a message; it does not carry the body, because
 * an inbox on this board is private and somebody else's mail server is not.
 */
export async function notifyParticipants(
  pool: pg.Pool,
  options: {
    mailer: Mailer | null;
    boardName: string;
    publicUrl: string;
    threadId: string;
    senderId: string;
    kind: 'text' | 'invoice';
  },
): Promise<number> {
  if (options.mailer === null) return 0;
  const due = await pool.query<ParticipantRow & { thread_subject: string }>(
    `${PARTICIPANTS}
       join threads t on t.id = tp.thread_id
      where tp.thread_id = $1 and tp.user_id <> $2
        and (tp.notified_at is null or tp.notified_at < now() - make_interval(secs => $3))
        and (tp.last_read_at is null or tp.last_read_at < t.last_message_at)`,
    [options.threadId, options.senderId, NOTIFY_GAP_MS / 1000],
  );
  if (due.rows.length === 0) return 0;

  const sender = await pool.query<ParticipantRow>(
    `${PARTICIPANTS} where tp.thread_id = $1 and tp.user_id = $2`,
    [options.threadId, options.senderId],
  );
  const from = sender.rows[0];
  const fromName = from === undefined ? 'Someone' : partyOf(from).name;
  const subject = (
    await pool.query<{ subject: string }>(`select subject from threads where id = $1`, [
      options.threadId,
    ])
  ).rows[0]?.subject;

  let sent = 0;
  for (const row of due.rows) {
    const ok = await options.mailer.send(
      inboxMessage({
        to: row.email,
        boardName: options.boardName,
        from: fromName,
        subject: subject ?? '',
        url: `${options.publicUrl}/inbox/${options.threadId}`,
        kind: options.kind,
      }),
    );
    if (ok) {
      sent += 1;
      await pool.query(
        `update thread_participants set notified_at = now() where thread_id = $1 and user_id = $2`,
        [options.threadId, row.user_id],
      );
    }
  }
  return sent;
}

/**
 * Resolve who a new message is for from the slugs a URL or a body carries.
 *
 * Exactly one of the two, and it has to be somebody with a page: a candidate
 * who published a resume, or an employer. Null means "no such person", and is
 * the same null for a private resume as for a typo, on purpose.
 */
export async function counterpartyFrom(
  pool: pg.Pool,
  input: { candidate?: string | null; employer?: string | null },
): Promise<Counterparty | null> {
  const candidate = (input.candidate ?? '').trim();
  const employer = (input.employer ?? '').trim();
  if (candidate !== '') {
    const result = await pool.query<{ user_id: string }>(
      `select user_id from resumes
        where public_slug = $1 and visibility in ('link', 'public') limit 1`,
      [candidate],
    );
    const userId = result.rows[0]?.user_id;
    return userId === undefined ? null : { kind: 'candidate', userId };
  }
  if (employer !== '') {
    const result = await pool.query<{ id: string }>(
      `select id from organisations where slug = $1`,
      [employer],
    );
    const orgId = result.rows[0]?.id;
    return orgId === undefined ? null : { kind: 'employer', orgId };
  }
  return null;
}
