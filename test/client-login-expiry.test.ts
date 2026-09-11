import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BoardClient } from '../dist/client/client.js';
import { login, LoginError } from '../dist/client/login.js';

for (const expiresAt of [1000, 1500, 3500]) {
  test(`device polling stops at local grant expiry ${expiresAt}`, async (t) => {
    let now = 1000;
    let polls = 0;
    const sleeps: number[] = [];
    t.mock.method(Date, 'now', () => now);
    const client = new BoardClient('https://board.test', {
      fetch: async () => {
        polls += 1;
        // Bound the old behavior too, so a regression never hangs the suite.
        return Response.json({ status: polls > 2 ? 'expired' : 'pending' });
      },
    });
    await assert.rejects(() => login(client, {
      label: 'test', onPrompt: () => {},
      existing: { deviceCode: 'fixture', userCode: 'TEST', verifyUrl: 'https://board.test/device', interval: 2, expiresAt },
      sleep: async (ms) => { sleeps.push(ms); now += ms; },
    }), LoginError);
    assert.equal(polls, expiresAt === 3500 ? 1 : 0);
    assert.equal(now, expiresAt);
    assert.deepEqual(sleeps, expiresAt === 1000 ? [] : expiresAt === 1500 ? [500] : [2000, 500]);
  });
}

test('an approval before the deadline installs the token', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const client = new BoardClient('https://board.test', {
    fetch: async () => Response.json({ status: 'approved', token: 'synthetic-token' }),
  });
  assert.equal(await login(client, {
    label: 'test', onPrompt: () => {},
    existing: { deviceCode: 'fixture', userCode: 'TEST', verifyUrl: 'https://board.test/device', interval: 2, expiresAt: 5000 },
    sleep: async (ms) => { now += ms; },
  }), 'synthetic-token');
  assert.equal(client.hasToken(), true);
});
