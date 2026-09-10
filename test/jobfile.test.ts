import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseJobDocument } from '../dist/cli/jobfile.js';

const requirements = [
  'Design, build and run services',
  'Write clear, concise documentation',
];
const jobFile = `---
org: example-works
title: Engineer
requirements: ["${requirements[0]}", '${requirements[1]}']
---
Role details`;

test('quoted inline requirements retain commas, like equivalent block lists', () => {
  const block = jobFile.replace(
    `requirements: ["${requirements[0]}", '${requirements[1]}']`,
    `requirements:\n  - "${requirements[0]}"\n  - '${requirements[1]}'`,
  );
  assert.deepEqual(parseJobDocument(block).requirements, requirements);
  assert.deepEqual(parseJobDocument(jobFile), parseJobDocument(block));
});

test('embedded quotes do not turn quoted commas into list separators', () => {
  const entries = String.raw`"Use \"clear, concise\" wording", 'Read ''slowly, carefully'''`;
  const expected = [String.raw`Use \"clear, concise\" wording`, "Read ''slowly, carefully''"];
  const parsed = parseJobDocument(`---\nrequirements: [${entries}]\n---\nDetails`);
  // Quoting only groups entries: the existing scalar parser keeps escapes literal.
  assert.deepEqual(parsed.requirements, expected);
});

test('plain entries, apostrophes, empty entries and CRLF retain their meaning', () => {
  const parsed = parseJobDocument([
    '---',
    'remote_regions: [EU, UK]',
    `requirements: [Bachelor's degree, "Clear writing", '', , remote,]`,
    'tags: []',
    '---',
    'Details',
  ].join('\r\n'));
  assert.deepEqual(parsed, {
    remoteRegions: ['EU', 'UK'],
    requirements: ["Bachelor's degree", 'Clear writing', 'remote'],
    tags: [],
    description: 'Details',
  });
});

test('CLI post and edit send each quoted requirement as one entry', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agenticjobs-jobfile-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'job.md');
  await writeFile(path, jobFile);
  const requests: { method: string | undefined; url: string | undefined; body: unknown }[] = [];
  const result = { job: { slug: 'example', status: 'draft' } };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      method: request.method,
      url: request.url,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    });
    response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    response.end(JSON.stringify(result));
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

  for (const command of [['post', path], ['edit', 'example', path]]) {
    const { stdout } = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL('../dist/cli/index.js', import.meta.url)),
      ...command, '--server', `http://127.0.0.1:${address.port}`, '--json',
    ], {
      env: { ...process.env, AGENTICJOBS_CONFIG_DIR: directory },
      timeout: 10_000,
    });
    assert.deepEqual(JSON.parse(stdout), result);
  }
  const body = { org: 'example-works', title: 'Engineer', requirements, description: 'Role details' };
  assert.deepEqual(requests, [
    { method: 'POST', url: '/api/v1/jobs', body },
    { method: 'PATCH', url: '/api/v1/jobs/example', body },
  ]);
});
