import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { flagBool, flagString, type Args } from './args.ts';
import type { BoardClient } from '../client/client.ts';
import { moshcodeCosts, moshcodeWork } from './tracker-import.ts';
import { parseEvents, record } from '../core/tracker.ts';

export async function runTracker(args: Args, client: BoardClient): Promise<number> {
  const verb = args.positional[0] ?? 'list';
  const fleet = flagString(args, 'fleet') ?? args.positional[1];
  const emit = (value: unknown, human: string) => {
    process.stdout.write(
      flagBool(args, 'json') ? `${JSON.stringify(value, null, 2)}\n` : `${human}\n`,
    );
    return 0;
  };
  if (verb === 'list') {
    const body = await client.trackerFleets();
    return emit(
      body,
      body.fleets
        .map((f) => `${f.slug}: ${f.agents} agents · ${f.currency} ${f.rate}/agent-hour`)
        .join('\n') ||
        'No fleets yet. Use agenticjobs tracker register NAME --operator PROFILE --count N.',
    );
  }
  if (verb === 'leaderboard') {
    const body = await client.trackerLeaderboard();
    return emit(
      body,
      body.fleets.map((f, i) => `${i + 1}. ${f.slug}: ${f.agents} declared agents`).join('\n') ||
        'No fleets have opted in.',
    );
  }
  if (!fleet) throw new Error('Specify --fleet NAME.');
  if (verb === 'register') {
    const operatorSlug = flagString(args, 'operator');
    if (!operatorSlug)
      throw new Error('Specify --operator PUBLIC-CANDIDATE-SLUG owned by this account.');
    const body = await client.trackerSave({
      slug: fleet,
      operatorSlug,
      agents: Number(flagString(args, 'count') ?? flagString(args, 'agents') ?? '1'),
      currency: flagString(args, 'currency') ?? 'USD',
      rate: Number(flagString(args, 'rate') ?? '400'),
      retainedTarget: Number(flagString(args, 'target') ?? '50'),
      assumedDirectCost: Number(flagString(args, 'assumed-cost') ?? '100'),
      publicListing: flagBool(args, 'public'),
    });
    return emit(
      body,
      `Registered ${fleet}. ${body.fleet.publicListing ? 'Public identity opted in.' : 'Private by default.'} ${client.server}/tracker?fleet=${fleet}`,
    );
  }
  if (verb === 'show') {
    const body = await client.trackerReport(fleet);
    return emit(
      body,
      `${fleet}: ${body.eventCount} imported events\n${client.server}/tracker?fleet=${fleet}\n${JSON.stringify(body.summary, null, 2)}`,
    );
  }
  const source =
    flagString(args, 'source') ??
    `moshcode-${createHash('sha256').update(hostname()).digest('hex').slice(0, 16)}`;
  if (verb === 'forget') {
    if (!flagString(args, 'source') || !flagBool(args, 'yes'))
      throw new Error('Deleting imports requires --source SOURCE --yes.');
    const body = await client.trackerForget(fleet, source);
    return emit(body, `Removed ${body.deleted} events from ${source}.`);
  }
  if (!['sync', 'import'].includes(verb))
    throw new Error('Tracker commands: register, list, show, sync, import, forget, leaderboard.');
  const { fleet: registered } = await client.trackerReport(fleet);
  let input: unknown;
  let format = flagString(args, 'format') ?? 'cost';
  if (verb === 'sync') {
    format = 'cost';
    const report = spawnSync(
      'moshcode',
      ['cost', '--all', '--json', '--since', flagString(args, 'since') ?? '30d'],
      { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 },
    );
    if (report.error || report.status !== 0)
      throw new Error(
        'Could not read Moshcode costs. Run moshcode cost --all --json locally, then retry or import its export.',
      );
    try {
      input = JSON.parse(report.stdout);
    } catch {
      throw new Error('Moshcode did not produce valid JSON.');
    }
  } else {
    const file = flagString(args, 'file');
    if (!file) throw new Error('Specify --file PATH, or --file - for stdin.');
    let text = '';
    if (file === '-') {
      for await (const chunk of process.stdin) {
        text += String(chunk);
        if (text.length > 32 * 1024 * 1024) throw new Error('Report exceeds 32 MB.');
      }
    } else text = await readFile(file, 'utf8');
    if (text.length > 32 * 1024 * 1024) throw new Error('Report exceeds 32 MB.');
    try {
      input = JSON.parse(text);
    } catch {
      throw new Error('Import file must contain JSON.');
    }
  }
  const events =
    format === 'cost'
      ? moshcodeCosts(input)
      : format === 'timers' || format === 'billing'
        ? moshcodeWork(input, registered.currency)
        : format === 'ledger'
          ? parseEvents(Array.isArray(input) ? input : record(input)['events'], registered.currency)
          : null;
  if (!events) throw new Error('Supported formats: cost, timers, billing, ledger.');
  if (events.some((e) => e.currency !== registered.currency))
    throw new Error(
      'This report uses a different currency from the fleet; no currency conversion is performed.',
    );
  const payload = { source, events };
  if (flagBool(args, 'dry-run')) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  const body = await client.trackerImport(fleet, payload);
  return emit(
    body,
    `Imported ${body.imported} sanitized events into ${fleet}. Repeating this import updates the same events.\n${client.server}/tracker?fleet=${fleet}`,
  );
}
