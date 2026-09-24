/**
 * addNotification caps the title at 200 and the body at 1000 UTF-16 units.
 * The title is composed for the row - `${job.title} at ${job.org.name}` -
 * from fields individually capped at 140 and 120, so even fully cleaned
 * inputs can run past 200 and the cap can land between the halves of a
 * surrogate pair. The lone surrogate it leaves is invalid UTF-8, Postgres
 * refuses the insert, the caller catches the failure, and the watcher
 * silently never gets the notification.
 *
 * The pool is faked: the check is which parameters get bound, not what a
 * database would answer.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addNotification } from '../src/core/watches.ts';

type Pool = Parameters<typeof addNotification>[0];

const LONE_HIGH = String.fromCharCode(0xd800);

function pool() {
  const asked: { text: string; values: unknown[] }[] = [];
  const fake = {
    asked,
    async query(text: string, values: unknown[] = []) {
      asked.push({ text, values });
      return { rows: [{ id: 'n1', created_at: '2026-01-01T00:00:00Z' }], rowCount: 1 };
    },
  };
  return fake as unknown as Pool & typeof fake;
}

async function bound(fake: ReturnType<typeof pool>, title: string, body?: string) {
  await addNotification(fake, 'u1', { kind: 'watch', title, body });
  const insert = fake.asked.find((call) => call.text.startsWith('insert into notifications'));
  assert.ok(insert, 'addNotification inserted nothing');
  return { title: insert.values[2], body: insert.values[3] };
}

test('a title capped mid-pair binds no dangling surrogate', async () => {
  const fake = pool();
  const { title } = await bound(fake, `${'a'.repeat(199)}🚀`);
  assert.equal(title, 'a'.repeat(199));
});

test('a smuggled lone surrogate in the title is dropped, not stored', async () => {
  const fake = pool();
  const { title } = await bound(fake, `remote ${LONE_HIGH}rust`);
  assert.equal(title, 'remote rust');
});

test('a body capped mid-pair binds no dangling surrogate', async () => {
  const fake = pool();
  const { body } = await bound(fake, 'watch hit', `${'b'.repeat(999)}🚀`);
  assert.equal(body, 'b'.repeat(999));
});

test('an ordinary notification still binds both fields', async () => {
  const fake = pool();
  const { title, body } = await bound(fake, 'rust job at acme', 'New listing matching rust.');
  assert.equal(title, 'rust job at acme');
  assert.equal(body, 'New listing matching rust.');
});
