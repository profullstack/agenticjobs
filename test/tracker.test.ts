import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { serve } from '@hono/node-server';
import { parseEvents, summarize } from '../dist/core/tracker.js';
import { moshcodeCosts, moshcodeWork } from '../dist/cli/tracker-import.js';
import { migrate } from '../dist/db/migrate.js';
import { createApp } from '../dist/server/app.js';
import { loadConfig } from '../dist/config.js';
import { ensureUser, createSession, SESSION_COOKIE } from '../dist/core/auth.js';
import { createResume } from '../dist/core/resumes.js';

const event = (id: string, kind: string, amount: number | null, extra = {}) => ({
  id,
  kind,
  amount,
  currency: 'USD',
  ...extra,
});
const fleet = { currency: 'USD', rate: 400, retainedTarget: 50, assumedDirectCost: 100 };

test('accounting distinguishes observations, estimates, missing coverage and potential value', () => {
  const events = parseEvents(
    [
      event('work', 'work', null, { seconds: 3600, agents: 2, billable: true }),
      event('cost1', 'cost', 100, { provenance: 'engine' }),
      event('cost2', 'cost', 20, { provenance: 'estimated' }),
      event('paid', 'receipt', 700),
      event('commission', 'commission', 10),
      event('fee', 'fee', 20),
      event('affiliate', 'affiliate', 50),
    ],
    'USD',
  );
  const s = summarize(fleet, events);
  assert.equal(s.billableAgentHours, 2);
  assert.equal(s.potentialBilledValue, 800);
  assert.equal(s.observedRevenue, 710);
  assert.equal(s.retainedProfit, 520);
  assert.equal(s.retainedPerAgentHour, 260);
  assert.equal(s.margin, 520 / 710);
  assert.equal(s.costEngine, 100);
  assert.equal(s.costEstimated, 20);
  assert.equal(s.profitIncludesEstimates, true);
  assert.equal(s.modeledHeadroomPerHour, 250);
  assert.equal(
    summarize(
      fleet,
      events.filter((e) => e.kind !== 'fee'),
    ).retainedProfit,
    null,
  );
  assert.equal(summarize(fleet, []).billableAgentHours, null);
  assert.equal(summarize(fleet, []).costEngine, null);
  assert.equal(
    summarize(fleet, [...events, { ...events[0]!, id: 'unknown-work', seconds: null }])
      .retainedPerAgentHour,
    null,
  );
  assert.equal(
    summarize(fleet, parseEvents([event('missing', 'cost', null)], 'USD')).categories.cost.complete,
    false,
  );
  assert.equal(
    summarize(fleet, [...events, { ...events[1]!, id: 'partial', partial: true }]).retainedProfit,
    null,
  );
});

test('parser rejects foreign currencies, nonfinite or negative money, extra metadata and duplicate IDs', () => {
  for (const amount of [-1, Infinity, NaN, '400'])
    assert.throws(() => parseEvents([event('a', 'cost', amount as number)], 'USD'));
  assert.throws(() => parseEvents([event('a', 'receipt', 1, { currency: 'EUR' })], 'USD'));
  assert.throws(() => parseEvents([event('a', 'cost', 1, { cwd: '/private/project' })], 'USD'));
  assert.throws(() => parseEvents([event('a', 'cost', 1), event('a', 'cost', 1)], 'USD'));
  assert.throws(() =>
    parseEvents([event('a', 'work', null, { seconds: 3600, agents: 1.5 })], 'USD'),
  );
  assert.throws(() => parseEvents([event('a', 'work', null, { seconds: 3600, agents: 0 })], 'USD'));
  assert.throws(() => parseEvents([event('a', 'receipt', 1, { at: 'not-a-date' })], 'USD'));
});

const costReport = {
  since: 1700000000000,
  sessions: [
    {
      name: 'PRIVATE_NAME',
      engine: 'codex',
      cwd: '/PRIVATE_PATH',
      unpriced: [],
      runs: [
        {
          id: 'engine-session',
          cost: 12.345678,
          costSource: 'rates',
          start: 1700000000000,
          end: 1700000300000,
          prompt: 'PRIVATE_PROMPT',
          usage: { input: 100 },
          pr: { url: 'https://PRIVATE_PR' },
        },
      ],
    },
  ],
  unattributed: [
    { id: 'unpriced', engine: 'claude', cost: null, costSource: null, cwd: '/PRIVATE_PATH' },
  ],
};
test('repeated engine snapshots count once and conflicting amounts remain unknown', () => {
  const original = costReport.sessions[0]!.runs[0]!;
  const later = { ...original, end: original.end + 1000 };
  const report = (runs: unknown[]) => ({
    sessions: [{ engine: 'codex', runs }],
    unattributed: [],
  });
  const clean = moshcodeCosts(report([original, later, original]));
  assert.equal(clean.length, 1);
  assert.equal(clean[0]?.amount, original.cost);
  assert.equal(clean[0]?.at, new Date(later.end).toISOString());
  assert.deepEqual(moshcodeCosts(report([later, original])), clean);
  assert.equal(summarize(fleet, clean).categories.cost.amount, original.cost);
  const conflicting = { ...later, cost: 22 };
  const uncertain = moshcodeCosts(report([original, conflicting, later]));
  assert.equal(uncertain[0]?.amount, null);
  assert.equal(uncertain[0]?.partial, true);
  assert.deepEqual(moshcodeCosts(report([later, conflicting, original])), uncertain);
  const unpriced = { ...original, cost: null, costSource: null };
  assert.equal(moshcodeCosts(report([unpriced, { ...unpriced, end: later.end }])).length, 1);
  assert.throws(() => moshcodeCosts(report([{ ...original, cost: -1 }, later])));
});
test('Moshcode sanitizer preserves cost provenance and stable identity without sensitive metadata or invented hours', () => {
  const clean = moshcodeCosts(costReport);
  assert.equal(clean[0]?.amount, 12.345678);
  assert.equal(clean[0]?.provenance, 'estimated');
  assert.equal(clean[1]?.amount, null);
  assert.equal(clean[1]?.partial, true);
  assert.equal(clean[0]?.seconds, null);
  assert.equal(clean[0]?.agents, null);
  assert.doesNotMatch(JSON.stringify(clean), /PRIVATE_|engine-session|usage|prompt|cwd/);
  assert.deepEqual(moshcodeCosts({ ...costReport, since: 1800000000000 }), clean);
  const work = {
    id: 'timer-1',
    client: 'PRIVATE_CLIENT',
    task: 'PRIVATE_TASK',
    seconds: 1800,
    agents: 2,
    startedAt: '2026-09-13T10:00:00Z',
    endedAt: '2026-09-13T10:30:00Z',
  };
  const timers = moshcodeWork([work]);
  assert.equal(timers[0]?.billable, true);
  assert.equal(summarize(fleet, timers).billableAgentHours, 1);
  assert.deepEqual(
    moshcodeWork({ entries: [work], total: 9999, client: { email: 'PRIVATE_EMAIL' } }),
    timers,
  );
  assert.doesNotMatch(JSON.stringify(timers), /PRIVATE_|timer-1/);
  assert.equal(
    summarize(fleet, moshcodeWork([{ ...work, agents: undefined }])).billableAgentHours,
    null,
  );
  assert.equal(moshcodeWork([{ ...work, client: null }])[0]?.billable, false);
  assert.throws(() => moshcodeWork([{ ...work, endedAt: null }]));
});

const database = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
describe('tracker API and CLI against Postgres', { skip: !database }, () => {
  const pool = new pg.Pool({ connectionString: database });
  const suffix = randomUUID().slice(0, 8);
  const slug = `fleet-${suffix}`;
  const config = loadConfig({
    DATABASE_URL: database!,
    PUBLIC_URL: 'http://board.test',
    SECRET: 'tracker-test-secret',
  });
  const app = createApp(pool, config, null, null);
  let owner = '',
    other = '',
    ownerId = '',
    otherId = '',
    operatorSlug = '',
    otherSlug = '';
  let temp = '';
  const request = (
    path: string,
    token = owner,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.fetch(
      new Request(`http://board.test${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  before(async () => {
    await migrate(pool);
    const a = await ensureUser(pool, `tracker-owner-${suffix}@example.test`);
    const b = await ensureUser(pool, `tracker-other-${suffix}@example.test`);
    ownerId = a.id;
    otherId = b.id;
    owner = await createSession(pool, a.id, { label: 'tracker test' });
    other = await createSession(pool, b.id, { label: 'tracker test' });
    const profile = await createResume(pool, a.id, {
      markdown: `# Operator ${suffix}\n\n- **Kind**: person\n- **Fleet**: ${slug}`,
      visibility: 'public',
    });
    const foreign = await createResume(pool, b.id, {
      markdown: `# Other ${suffix}`,
      visibility: 'public',
    });
    operatorSlug = profile.publicSlug!;
    otherSlug = foreign.publicSlug!;
    temp = await mkdtemp(join(tmpdir(), 'agenticjobs-tracker-'));
  });
  after(async () => {
    await pool.query('delete from users where id=any($1::uuid[])', [
      [ownerId, otherId].filter(Boolean),
    ]);
    await pool.end();
    if (temp) await rm(temp, { recursive: true, force: true });
  });
  test('requires ownership, isolates private data, imports idempotently and exposes only opted-in identity', async () => {
    const input = { slug, operatorSlug, agents: 10, rate: 400 };
    assert.equal((await request('/api/v1/tracker/fleets', '', 'POST', input)).status, 401);
    assert.equal(
      (
        await request('/api/v1/tracker/fleets', owner, 'POST', {
          ...input,
          operatorSlug: otherSlug,
        })
      ).status,
      403,
    );
    assert.equal((await request('/api/v1/tracker/fleets', owner, 'POST', input)).status, 200);
    assert.equal(
      (
        await request('/api/v1/tracker/fleets', other, 'POST', {
          ...input,
          operatorSlug: otherSlug,
        })
      ).status,
      409,
    );
    assert.equal((await request(`/api/v1/tracker/fleets/${slug}`, other)).status, 404);
    assert.equal((await request(`/fleets/${slug}`, '')).status, 404);
    const payload = { source: 'private-source', events: moshcodeCosts(costReport) };
    for (let i = 0; i < 2; i++)
      assert.equal(
        (await request(`/api/v1/tracker/fleets/${slug}/import`, owner, 'POST', payload)).status,
        200,
      );
    let report = await (await request(`/api/v1/tracker/fleets/${slug}`)).json();
    assert.equal(report.eventCount, 2);
    assert.equal(report.summary.categories.cost.amount, 12.345678);
    assert.equal(report.summary.retainedProfit, null);
    payload.events[0]!.amount = 20;
    await request(`/api/v1/tracker/fleets/${slug}/import`, owner, 'POST', payload);
    report = await (await request(`/api/v1/tracker/fleets/${slug}`)).json();
    assert.equal(report.eventCount, 2);
    assert.equal(report.summary.categories.cost.amount, 20);
    assert.equal(
      (await request(`/api/v1/tracker/fleets/${slug}/import`, other, 'POST', payload)).status,
      404,
    );
    assert.equal(
      (
        await request(`/api/v1/tracker/fleets/${slug}/import`, owner, 'POST', {
          ...payload,
          events: [event('eur', 'cost', 1, { currency: 'EUR' })],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(`/api/v1/tracker/fleets/${slug}/import`, owner, 'POST', {
          ...payload,
          events: [...payload.events, event('bad', 'cost', 1, { transcript: 'PRIVATE' })],
        })
      ).status,
      400,
    );
    await request('/api/v1/tracker/fleets', owner, 'POST', { ...input, publicListing: true });
    const publicList = await (await request('/api/v1/tracker/leaderboard', '')).json();
    const publicFleet = publicList.fleets.find((f: { slug: string }) => f.slug === slug);
    assert.deepEqual(Object.keys(publicFleet).sort(), [
      'agents',
      'currency',
      'operatorSlug',
      'rate',
      'slug',
    ]);
    assert.doesNotMatch(
      JSON.stringify(publicList),
      /private-source|ownerId|costEngine|retainedProfit|billableAgentHours/,
    );
    assert.equal((await request(`/api/v1/tracker/fleets/${slug}`, '')).status, 401);
    const publicProfile = await (await request(`/fleets/${slug}/openprofile.md`, '')).text();
    assert.match(publicProfile, /Kind\*\*: fleet/);
    assert.doesNotMatch(publicProfile, /private-source|20\.00|retained/i);
    const page = await request(`/tracker?fleet=${slug}`);
    assert.match(page.headers.get('cache-control') ?? '', /no-store/);
    const html = await page.text();
    assert.match(html, /Tracked billable agent-hours/);
    assert.match(html, /Unknown/);
    assert.doesNotMatch(html, /crawlproof.com\/stats/);
    assert.equal((await request('/tracker', '')).status, 302);
    assert.equal((await request('/tracker/docs', '')).status, 200);
    assert.equal(
      (
        await request('/api/v1/tracker/fleets', owner, 'POST', input, {
          origin: 'https://evil.example',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request('/api/v1/tracker/fleets', '', 'POST', input, {
          cookie: `${SESSION_COOKIE}=${owner}`,
        })
      ).status,
      403,
    );
    await request('/api/v1/tracker/fleets', owner, 'POST', { ...input, publicListing: false });
    assert.equal((await request(`/fleets/${slug}/openprofile.md`, '')).status, 404);
    assert.equal(
      (await request(`/api/v1/tracker/fleets/${slug}/sources/private-source`, other, 'DELETE'))
        .status,
      404,
    );
    assert.equal(
      (
        await (
          await request(`/api/v1/tracker/fleets/${slug}/sources/private-source`, owner, 'DELETE')
        ).json()
      ).deleted,
      2,
    );
  });
  test('the built CLI imports sanitized data, replays safely and never records draft invoice revenue', async () => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((resolve) =>
      server.listening ? resolve() : server.once('listening', resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const configDir = join(temp, 'config');
    await mkdir(join(configDir, 'agenticjobs'), { recursive: true });
    await writeFile(
      join(configDir, 'agenticjobs', 'config.json'),
      JSON.stringify({
        current: base,
        boards: { [base]: { server: base, token: owner } },
        directories: [],
      }),
      { mode: 0o600 },
    );
    const file = join(temp, 'report.json');
    await writeFile(file, JSON.stringify(costReport));
    const run = (args: string[]) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
        const proc = spawn(process.execPath, ['bin/agenticjobs.mjs', 'tracker', ...args], {
          cwd: process.cwd(),
          env: { ...process.env, AGENTICJOBS_CONFIG_DIR: configDir },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '',
          stderr = '';
        proc.stdout.on('data', (c) => (stdout += String(c)));
        proc.stderr.on('data', (c) => (stderr += String(c)));
        proc.on('error', reject);
        proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
      });
    try {
      const dry = await run([
        'import',
        '--fleet',
        slug,
        '--file',
        file,
        '--format',
        'cost',
        '--dry-run',
      ]);
      assert.equal(dry.code, 0, dry.stderr);
      assert.doesNotMatch(dry.stdout, /PRIVATE_|engine-session/);
      for (let i = 0; i < 2; i++) {
        const actual = await run([
          'import',
          '--fleet',
          slug,
          '--file',
          file,
          '--format',
          'cost',
          '--json',
        ]);
        assert.equal(actual.code, 0, actual.stderr);
        assert.equal(JSON.parse(actual.stdout).imported, 2);
      }
      await writeFile(
        file,
        JSON.stringify({
          total: 9000,
          entries: [
            {
              id: 't1',
              client: 'secret',
              agents: 2,
              seconds: 1800,
              endedAt: '2026-09-13T10:30:00Z',
            },
          ],
        }),
      );
      const billing = await run(['import', '--fleet', slug, '--file', file, '--format', 'billing']);
      assert.equal(billing.code, 0, billing.stderr);
      const shown = await run(['show', '--fleet', slug, '--json']);
      assert.equal(shown.code, 0, shown.stderr);
      const report = JSON.parse(shown.stdout);
      assert.equal(report.eventCount, 3);
      assert.equal(report.summary.billableAgentHours, 1);
      assert.equal(report.summary.categories.receipt.amount, null);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
