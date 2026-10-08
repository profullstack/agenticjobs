import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { flagBool, flagString, parseArgs } from '../dist/cli/args.js';

test('value options accept a lone dash without leaving it positional', () => {
  for (const flags of [['--file', '-'], ['--file=-'], ['-f', '-']]) {
    const args = parseArgs(['tracker', 'import', 'example-fleet', ...flags]);
    assert.equal(flagString(args, 'file', 'f'), '-');
    assert.deepEqual(args.positional, ['import', 'example-fleet']);
  }
});

test('boolean options leave a lone dash positional', () => {
  const args = parseArgs(['search', '--remote', '-']);
  assert.equal(flagBool(args, 'remote'), true);
  assert.deepEqual(args.positional, ['-']);
});

test('a lone dash does not change option or terminator parsing', () => {
  const args = parseArgs(['tracker', 'import', '--file', '-', '--dry-run', '--', '--literal']);
  assert.equal(flagString(args, 'file'), '-');
  assert.equal(flagBool(args, 'dry-run'), true);
  assert.deepEqual(args.positional, ['import', '--literal']);
  const missing = parseArgs(['tracker', 'import', '--file', '--dry-run']);
  assert.equal(flagString(missing, 'file'), undefined);
  assert.equal(flagBool(missing, 'dry-run'), true);
});

test('tracker import reads piped JSON with the documented --file - syntax', () => {
  const argsUrl = new URL('../dist/cli/args.js', import.meta.url).href;
  const trackerUrl = new URL('../dist/cli/tracker.js', import.meta.url).href;
  const script = `
    import { parseArgs } from ${JSON.stringify(argsUrl)};
    import { runTracker } from ${JSON.stringify(trackerUrl)};
    const client = {
      trackerReport: async () => ({ fleet: { currency: 'USD' } }),
      trackerImport: async () => { throw new Error('dry-run must not submit'); },
    };
    await runTracker(parseArgs([
      'tracker', 'import', 'example-fleet', '--file', '-', '--format', 'ledger',
      '--source', 'test-fixture', '--dry-run',
    ]), client);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    input: JSON.stringify([{ id: 'sample-cost', kind: 'cost', amount: 1.25, currency: 'USD' }]),
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.source, 'test-fixture');
  assert.equal(payload.events.length, 1);
  assert.equal(payload.events[0].id, 'sample-cost');
  assert.equal(payload.events[0].amount, 1.25);
});
