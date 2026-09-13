import { createHash } from 'node:crypto';
import { record, parseEvents, TrackerProblem, type TrackerEvent } from '../core/tracker.ts';

const key = (kind: string, ...parts: string[]) =>
  `${kind}:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
const stamp = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const time = typeof value === 'number' || typeof value === 'string' ? new Date(value) : null;
  if (!time || !Number.isFinite(time.getTime()))
    throw new TrackerProblem('Invalid report timestamp.');
  return time.toISOString();
};
const empty = (id: string, kind: TrackerEvent['kind'], currency: string): TrackerEvent => ({
  id,
  kind,
  currency,
  at: null,
  amount: null,
  seconds: null,
  agents: null,
  billable: false,
  provenance: 'reported',
  partial: false,
});

/** Whitelist only accounting fields. Raw engine reports can contain paths and PRs. */
export function moshcodeCosts(raw: unknown): TrackerEvent[] {
  const report = record(raw);
  if (!Array.isArray(report['sessions']) || !Array.isArray(report['unattributed']))
    throw new TrackerProblem('Expected moshcode cost --all --json output.');
  const events = new Map<string, TrackerEvent>();
  const add = (rawRun: unknown, engine: unknown, partial = false) => {
    const run = record(rawRun);
    if (
      typeof engine !== 'string' ||
      engine.length > 80 ||
      typeof run['id'] !== 'string' ||
      !run['id']
    )
      throw new TrackerProblem('Each engine run needs an engine and stable ID.');
    const id = key('cost', engine, run['id']);
    const source = run['costSource'];
    if (source != null && !['engine', 'rates', 'mixed'].includes(String(source)))
      throw new TrackerProblem('Unknown Moshcode cost provenance.');
    const amount = run['cost'] ?? null;
    const event = {
      ...empty(id, 'cost', 'USD'),
      amount: amount as number | null,
      at: stamp(run['end'] ?? run['start']),
      provenance: (source === 'engine'
        ? 'engine'
        : source === 'rates' || source === 'mixed'
          ? 'estimated'
          : 'reported') as TrackerEvent['provenance'],
      partial: partial || amount === null || source == null,
    };
    const prior = events.get(id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(event))
      throw new TrackerProblem('Conflicting copies of one engine run.');
    events.set(id, event);
  };
  for (const rawSession of report['sessions']) {
    const session = record(rawSession);
    if (!Array.isArray(session['runs']))
      throw new TrackerProblem('Each Moshcode session must include its runs.');
    for (const run of session['runs'])
      add(
        run,
        session['engine'],
        Array.isArray(session['unpriced']) && session['unpriced'].length > 0,
      );
  }
  for (const run of report['unattributed']) add(run, record(run)['engine']);
  return parseEvents([...events.values()], 'USD');
}

/** Completed timer records only. Invoice drafts supply time, never receipts. */
export function moshcodeWork(raw: unknown, currency = 'USD'): TrackerEvent[] {
  const rows = Array.isArray(raw) ? raw : record(raw)['entries'];
  if (!Array.isArray(rows))
    throw new TrackerProblem('Expected timer log JSON or a billing export with entries.');
  const events = rows.map((rawEntry) => {
    const e = record(rawEntry);
    if (typeof e['id'] !== 'string' || !e['id'])
      throw new TrackerProblem('Timer entries need stable IDs.');
    if (e['endedAt'] == null)
      throw new TrackerProblem(
        'Stop a running timer before importing it. Session age is not billable time.',
      );
    return {
      ...empty(key('work', e['id']), 'work', currency),
      at: stamp(e['endedAt']),
      seconds: (e['seconds'] ?? null) as number | null,
      agents: (e['agents'] ?? null) as number | null,
      billable:
        typeof e['billable'] === 'boolean'
          ? e['billable']
          : typeof e['client'] === 'string' && e['client'].trim() !== '',
      partial: e['seconds'] == null || e['agents'] == null,
    };
  });
  return parseEvents(events, currency);
}
