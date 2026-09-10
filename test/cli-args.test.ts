import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
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

test('repeated bare boolean flags remain enabled', () => {
  for (const name of ['draft', 'json', 'remote', 'publish', 'unsupervised', 'y']) {
    const flag = name === 'y' ? '-y' : `--${name}`;
    const args = parseArgs(['apply', 'example', flag, flag]);
    assert.equal(flagBool(args, name), true, flag);
  }
});

test('the last value of a repeated boolean flag wins', () => {
  for (const [flags, expected] of [
    [['--draft', '--draft=false'], false],
    [['--draft=false', '--draft'], true],
    [['--draft', 'no', '--draft', 'YES'], true],
    [['--draft', '1', '--draft', '0'], false],
  ] as const) {
    const args = parseArgs(['apply', 'example', ...flags]);
    assert.equal(flagBool(args, 'draft'), expected, flags.join(' '));
  }
});

test('repeating --draft and --json keeps the CLI request held and its output JSON', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agenticjobs-cli-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests: { method: string | undefined; url: string | undefined; body: unknown }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      method: request.method,
      url: request.url,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    });
    response.writeHead(201, { 'content-type': 'application/json', connection: 'close' });
    response.end(JSON.stringify({ applicationId: 'example-draft' }));
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');

  const { stdout } = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('../dist/cli/index.js', import.meta.url)),
    'apply', 'example', '--server', `http://127.0.0.1:${address.port}`,
    '--draft', '--draft', '--json', '--json',
  ], {
    env: { ...process.env, AGENTICJOBS_CONFIG_DIR: directory },
    timeout: 10_000,
  });
  assert.deepEqual(requests, [{
    method: 'POST', url: '/api/v1/jobs/example/apply', body: { submit: false },
  }]);
  assert.deepEqual(JSON.parse(stdout), { applicationId: 'example-draft' });
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
