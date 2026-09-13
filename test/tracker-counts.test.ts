import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEvents, saveFleet, TrackerProblem } from '../dist/core/tracker.js';

const work = (seconds: number, agents: number) =>
  parseEvents([{ id: 'work', kind: 'work', currency: 'USD', seconds, agents }], 'USD')[0]!;

test('work counts preserve valid integer boundaries and unknown values', () => {
  for (const seconds of [0, 1, 2147483647]) {
    for (const agents of [1, 1000]) {
      const event = work(seconds, agents);
      assert.equal(event.seconds, seconds);
      assert.equal(event.agents, agents);
    }
  }
  const unknown = parseEvents([{ id: 'work', kind: 'work', currency: 'USD' }], 'USD')[0]!;
  assert.equal(unknown.seconds, null);
  assert.equal(unknown.agents, null);
});

test('work imports reject fractional seconds instead of rounding them to integers', () => {
  for (const seconds of [0.0000001, 0.9999999, 1.0000001, 3599.9999999]) {
    assert.throws(() => work(seconds, 1), TrackerProblem, `seconds=${seconds}`);
  }
});

test('work imports reject fractional agent counts on either side of an integer', () => {
  for (const agents of [0.9999999, 1.0000001, 999.9999999]) {
    assert.throws(() => work(3600, agents), TrackerProblem, `agents=${agents}`);
  }
});

test('fleet registration rejects fractional capacity before accessing the database', async () => {
  let connected = false;
  const pool = {
    async connect() {
      connected = true;
      throw new Error('Unexpected database access');
    },
  } as unknown as Parameters<typeof saveFleet>[0];
  for (const agents of [0.9999999, 1.0000001, 999.9999999]) {
    await assert.rejects(
      saveFleet(pool, 'owner', { slug: 'example', operatorSlug: 'operator', agents }),
      TrackerProblem,
    );
  }
  assert.equal(connected, false);
});
