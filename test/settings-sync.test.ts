/**
 * Settings sync: the projection that leaves the machine, and the store the
 * board keeps it in.
 *
 * Pure on both sides so the suite needs no database: the projection is a
 * function of the config, and the store is exercised over a pool that
 * records the SQL it was asked and answers from a script.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { applySettings, settingsFrom, SYNC_POLICY } = await import('../dist/client/sync.js');
const { settingsStore } = await import('../dist/server/routes/settings.js');
const { isSyncable } = await import('@profullstack/synconfig');
const { handleGet, handlePut } = await import('@profullstack/synconfig/server');

function pool(answers: Record<string, Record<string, unknown>[]> = {}) {
  const asked: { text: string; values: unknown[] }[] = [];
  return {
    asked,
    async query(text: string, values: unknown[] = []) {
      asked.push({ text, values });
      for (const [needle, rows] of Object.entries(answers)) {
        if (text.includes(needle)) return { rows };
      }
      return { rows: [] };
    },
  };
}

test('the projection leaves every token behind, and loading adds boards without one', () => {
  const config = {
    current: 'https://a.example',
    boards: {
      'https://a.example': { server: 'https://a.example', token: 'aj_secret_a', email: 'ada@example.com', name: 'A' },
      'https://b.example': { server: 'https://b.example', token: 'aj_secret_b' },
    },
    directories: ['https://dir.example'],
  };
  const settings = settingsFrom(config);
  assert.ok(!JSON.stringify(settings).includes('aj_secret'), 'a token reached the projection');
  assert.deepEqual(settings.boards['https://b.example'], { server: 'https://b.example' });
  assert.deepEqual(settings.directories, ['https://dir.example']);
  assert.equal(isSyncable(SYNC_POLICY, 'boards.json'), true);
  assert.equal(isSyncable(SYNC_POLICY, 'config.json'), false);

  const fresh = applySettings(settings, { current: null, boards: {}, directories: [] });
  assert.deepEqual(fresh.added.sort(), ['https://a.example', 'https://b.example']);
  assert.deepEqual(fresh.directoriesAdded, ['https://dir.example']);
  assert.equal(fresh.current, 'https://a.example');
  assert.equal(fresh.config.boards['https://a.example']?.token, null);
  assert.equal(fresh.config.boards['https://a.example']?.email, 'ada@example.com');

  const local = { current: 'https://b.example', boards: { 'https://b.example': { server: 'https://b.example', token: 'mine' } }, directories: ['https://dir.example'] };
  const kept = applySettings(settings, local);
  assert.deepEqual(kept.added, ['https://a.example']);
  assert.deepEqual(kept.directoriesAdded, []);
  assert.equal(kept.current, 'https://b.example');
  assert.equal(kept.config.boards['https://b.example']?.token, 'mine');
});

test('the store picks the next revision in one statement, prunes to ten, and reports a stale save as the current revision', async () => {
  const fresh = pool({ 'returning revision': [{ revision: 1, created_at: '2026-09-13T02:00:00.000Z' }] });
  const store = settingsStore(fresh);
  const snapshot = { version: 1, host: 'laptop', app: 'agenticjobs', files: { 'boards.json': { content: '{"current":null,"boards":{},"directories":[]}' } } };
  const put = await handlePut(store, 'user-1', { snapshot, ifRevision: null });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body['revision'], 1);
  const insert = fresh.asked.find((a) => a.text.includes('insert into settings_snapshots'));
  assert.ok(insert);
  assert.match(insert!.text, /coalesce\(max\(revision\), 0\) \+ 1/);
  assert.match(insert!.text, /having \$7::int is null or coalesce\(max\(revision\), 0\) = \$7::int/);
  assert.equal(insert!.values[6], null);
  const prune = fresh.asked.find((a) => a.text.includes('delete from settings_snapshots'));
  assert.deepEqual(prune?.values, ['user-1', 1 - 10]);

  const empty = await handleGet(settingsStore(pool()), 'user-1', { emptyStatus: 200 });
  assert.equal(empty.status, 200);
  assert.equal(empty.body['empty'], true);

  const stale = settingsStore(
    pool({ 'order by revision desc limit 1': [{ revision: 2, digest: 'd2', host: 'desktop', version: 'agenticjobs', size: 10, body: { version: 1, files: {} }, created_at: '2026-09-13T02:00:00.000Z' }] }),
  );
  const refused = await handlePut(stale, 'user-1', { snapshot, ifRevision: 1 });
  assert.equal(refused.status, 409);
  assert.equal(refused.body['revision'], 2);
});
