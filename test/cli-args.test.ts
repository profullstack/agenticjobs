import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flagBool, flagList, flagString, parseArgs } from '../dist/cli/args.js';

test('boolean search flags preserve the following search words', () => {
  const args = parseArgs(['search', '--remote', 'rust', '--agents', 'developer']);
  assert.equal(args.command, 'search');
  assert.deepEqual(args.positional, ['rust', 'developer']);
  assert.equal(flagBool(args, 'remote'), true);
  assert.equal(flagBool(args, 'agents'), true);
});

test('global boolean flags preserve the command', () => {
  for (const flag of ['--json', '--help', '-h', '--version', '-v', '--yes', '-y']) {
    const args = parseArgs([flag, 'search', 'rust']);
    assert.equal(args.command, 'search', flag);
    assert.deepEqual(args.positional, ['rust'], flag);
  }
});

test('explicit boolean values remain supported', () => {
  for (const value of ['false', '0', 'no', 'FALSE']) {
    for (const flag of [['--remote', value], [`--remote=${value}`]]) {
      const args = parseArgs(['search', ...flag, 'rust']);
      assert.equal(flagBool(args, 'remote'), false);
      assert.deepEqual(args.positional, ['rust']);
    }
  }
});

test('value options, repeated fields, and the option terminator retain their meaning', () => {
  const args = parseArgs([
    'apply',
    '-s',
    'https://example.com',
    '--answer',
    'a=1',
    '--answer',
    'b=2',
    '--',
    '--remote',
    'job-slug',
  ]);
  assert.equal(flagString(args, 's'), 'https://example.com');
  assert.deepEqual(flagList(args, 'answer'), ['a=1', 'b=2']);
  assert.deepEqual(args.positional, ['--remote', 'job-slug']);
});
