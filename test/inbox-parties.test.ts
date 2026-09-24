import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startThread } from '../dist/core/inbox.js';

/**
 * A participant row is one per (thread, user); `org_id` on it says whether the
 * person is in that thread as themselves (null) or speaking for an employer.
 * `startThread` continues the existing conversation between the same two
 * parties, and the sender's party is part of that match: a message written
 * "as Org B" must not land in a thread whose sender side is Org A or nobody.
 *
 * The fake pool answers the handful of statements `startThread`/`sendMessage`
 * run, applying the same semantics Postgres would - including `is not
 * distinct from` for the sender's org identity when the statement carries it.
 */

interface Participant {
  thread_id: string;
  user_id: string;
  org_id: string | null;
  last_read_at: number | null;
}

function makePool() {
  const model = {
    memberships: [] as { user_id: string; org_id: string }[],
    threads: [] as {
      id: string;
      subject: string;
      job_id: string | null;
      created_by: string;
      last_message_at: number;
    }[],
    participants: [] as Participant[],
    messages: [] as {
      id: string;
      thread_id: string;
      sender_id: string;
      kind: string;
      body: string;
      created_at: number;
    }[],
  };
  let serial = 0;
  const nextId = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`;
  const now = () => ++serial + 1_000_000;

  const query = async (sql: string, params: unknown[] = []) => {
    if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [] };

    // sendMessage's CTE: insert + touch last_message_at + mark sender read.
    if (sql.includes('with m as (')) {
      const [threadId, senderId, kind, body, invoiceId] = params as [
        string, string, string, string, string | null,
      ];
      const created_at = now();
      const id = nextId();
      model.messages.push({ id, thread_id: threadId, sender_id: senderId, kind, body, created_at });
      void invoiceId;
      const thread = model.threads.find((t) => t.id === threadId);
      if (thread) thread.last_message_at = created_at;
      const me = model.participants.find(
        (p) => p.thread_id === threadId && p.user_id === senderId,
      );
      if (me) me.last_read_at = created_at;
      return { rows: [{ id, created_at }] };
    }

    // `as` membership check.
    if (sql.includes('from memberships where user_id')) {
      const [userId, orgId] = params as [string, string];
      return {
        rows: model.memberships.filter((m) => m.user_id === userId && m.org_id === orgId),
      };
    }

    // The same-parties lookup. Applies `me.org_id is not distinct from $4`
    // only when the statement asks for it - that is the behaviour under test.
    if (sql.includes('from threads t') && sql.includes('thread_participants me')) {
      const [senderId, other, jobId, asOrg] = params as [
        string, string, string | null, string | null,
      ];
      const checkOrg = sql.includes('me.org_id is not distinct from');
      const forCandidate = sql.includes('them.user_id = $2 and them.org_id is null');
      const matches = model.threads
        .filter((t) => t.job_id === jobId)
        .filter((t) =>
          model.participants.some(
            (p) =>
              p.thread_id === t.id &&
              p.user_id === senderId &&
              (!checkOrg || p.org_id === asOrg),
          ),
        )
        .filter((t) =>
          model.participants.some(
            (p) =>
              p.thread_id === t.id &&
              (forCandidate
                ? p.user_id === other && p.org_id === null
                : p.org_id === other),
          ),
        )
        .sort((a, b) => b.last_message_at - a.last_message_at);
      const found = matches[0];
      return { rows: found === undefined ? [] : [{ id: found.id }] };
    }

    if (sql.includes('count(*)::int as count from threads')) {
      const [createdBy] = params as [string];
      return {
        rows: [{ count: model.threads.filter((t) => t.created_by === createdBy).length }],
      };
    }

    if (sql.includes('insert into threads')) {
      const [subject, jobId, createdBy] = params as [string, string | null, string];
      const id = nextId();
      model.threads.push({
        id,
        subject,
        job_id: jobId,
        created_by: createdBy,
        last_message_at: now(),
      });
      return { rows: [{ id }] };
    }

    if (sql.includes('insert into thread_participants')) {
      const threadId = params[0] as string;
      const add = (userId: string, orgId: string | null, lastRead: number | null) => {
        if (
          !model.participants.some((p) => p.thread_id === threadId && p.user_id === userId)
        ) {
          model.participants.push({
            thread_id: threadId,
            user_id: userId,
            org_id: orgId,
            last_read_at: lastRead,
          });
        }
      };
      if (sql.includes('from memberships')) {
        const orgId = params[1] as string;
        for (const m of model.memberships.filter((m) => m.org_id === orgId)) {
          const isSender = sql.includes('case when m.user_id = $3') && m.user_id === params[2];
          add(m.user_id, orgId, isSender ? now() : null);
        }
      } else {
        add(params[1] as string, null, sql.includes('now()') ? now() : null);
      }
      return { rows: [] };
    }

    if (sql.includes('insert into messages')) {
      const [threadId, senderId, body] = params as [string, string, string];
      const id = nextId();
      model.messages.push({
        id,
        thread_id: threadId,
        sender_id: senderId,
        kind: 'text',
        body,
        created_at: now(),
      });
      return { rows: [{ id }] };
    }

    if (sql.includes('select 1 from thread_participants')) {
      const [threadId, userId] = params as [string, string];
      return {
        rows: model.participants.filter(
          (p) => p.thread_id === threadId && p.user_id === userId,
        ),
      };
    }

    throw new Error(`unhandled statement: ${sql}`);
  };

  const pool = {
    query,
    connect: async () => ({ query, release: () => {} }),
  };
  return { pool, model };
}

const alice = 'aaaaaaaa-0000-4000-8000-000000000001';
const bob = 'aaaaaaaa-0000-4000-8000-000000000002';
const carol = 'aaaaaaaa-0000-4000-8000-000000000003';
const orgA = 'bbbbbbbb-0000-4000-8000-000000000001';
const orgB = 'bbbbbbbb-0000-4000-8000-000000000002';

function seed(pool: ReturnType<typeof makePool>) {
  pool.model.memberships.push(
    { user_id: alice, org_id: orgA },
    { user_id: bob, org_id: orgA },
    { user_id: alice, org_id: orgB },
  );
}

test('a message written as one employer does not land in another employer\u2019s thread', async () => {
  const { pool, model } = makePool();
  seed({ pool, model });

  // Carol writes to Org A. Alice and Bob are in the thread as Org A.
  const first = await startThread(pool as never, carol, { kind: 'employer', orgId: orgA }, {
    subject: 'Applying', body: 'Hello Org A', as: null,
  });
  assert.notEqual(typeof first, 'string');
  if (typeof first === 'string') return;
  assert.equal(first.created, true);

  // Alice now writes to Carol as Org B. Without the sender's party in the
  // match this is delivered into the Org A thread, shown as Org A and read
  // by everyone at Org A.
  const second = await startThread(pool as never, alice, { kind: 'candidate', userId: carol }, {
    subject: '', body: 'Writing for Org B', as: orgB,
  });
  assert.notEqual(typeof second, 'string');
  if (typeof second === 'string') return;
  assert.equal(second.created, true);
  assert.notEqual(second.threadId, first.threadId);
  assert.deepEqual(
    model.participants
      .filter((p) => p.thread_id === second.threadId)
      .map((p) => [p.user_id, p.org_id]),
    [
      [alice, orgB],
      [carol, null],
    ],
  );

  // Writing as Org B again continues the Org B thread, not a new one.
  const again = await startThread(pool as never, alice, { kind: 'candidate', userId: carol }, {
    subject: '', body: 'Still for Org B', as: orgB,
  });
  assert.notEqual(typeof again, 'string');
  if (typeof again === 'string') return;
  assert.equal(again.created, false);
  assert.equal(again.threadId, second.threadId);
});

test('a member\u2019s personal message does not land in their employer\u2019s thread', async () => {
  const { pool, model } = makePool();
  seed({ pool, model });

  const first = await startThread(pool as never, carol, { kind: 'employer', orgId: orgA }, {
    subject: 'Applying', body: 'Hello Org A', as: null,
  });
  assert.notEqual(typeof first, 'string');
  if (typeof first === 'string') return;

  const personal = await startThread(pool as never, bob, { kind: 'candidate', userId: carol }, {
    subject: '', body: 'Just me, not the company', as: null,
  });
  assert.notEqual(typeof personal, 'string');
  if (typeof personal === 'string') return;
  assert.equal(personal.created, true);
  assert.notEqual(personal.threadId, first.threadId);
});

test('writing as the employer the thread is with still finds it', async () => {
  const { pool, model } = makePool();
  seed({ pool, model });

  const first = await startThread(pool as never, carol, { kind: 'employer', orgId: orgA }, {
    subject: 'Applying', body: 'Hello Org A', as: null,
  });
  assert.notEqual(typeof first, 'string');
  if (typeof first === 'string') return;

  const reply = await startThread(pool as never, alice, { kind: 'candidate', userId: carol }, {
    subject: '', body: 'Org A replying', as: orgA,
  });
  assert.notEqual(typeof reply, 'string');
  if (typeof reply === 'string') return;
  assert.equal(reply.created, false);
  assert.equal(reply.threadId, first.threadId);
});

test('a body-derived subject never carries a lone surrogate into the insert', async () => {
  const { pool, model } = makePool();
  seed({ pool, model });

  // 116 BMP characters then an astral one: the 117-unit preview cap lands
  // between the halves of the surrogate pair and leaves the high half
  // dangling. Postgres rejects a lone surrogate as invalid UTF-8, so the
  // threads insert failed and the message never sent.
  const body = `${'a'.repeat(116)}\u{1f600} the rest of the message`;
  const result = await startThread(pool as never, carol, { kind: 'candidate', userId: alice }, {
    subject: '', body, as: null,
  });
  assert.notEqual(typeof result, 'string');
  if (typeof result === 'string') return;

  const thread = model.threads.find((t) => t.id === result.threadId);
  assert.ok(thread);
  assert.ok(!/[\uD800-\uDFFF]/.test(thread.subject), `lone surrogate in ${JSON.stringify(thread.subject.slice(-8))}`);
  assert.ok(thread.subject.endsWith('...'));
});
