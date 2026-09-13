import type pg from 'pg';

export const EVENT_KINDS = ['cost', 'work', 'receipt', 'commission', 'fee', 'affiliate'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export interface TrackerEvent {
  id: string;
  kind: EventKind;
  at: string | null;
  amount: number | null;
  currency: string;
  seconds: number | null;
  agents: number | null;
  billable: boolean;
  provenance: 'engine' | 'estimated' | 'reported';
  partial: boolean;
}
export interface Fleet {
  id: string;
  slug: string;
  ownerId: string;
  operatorSlug: string;
  agents: number;
  currency: string;
  rate: number;
  retainedTarget: number;
  assumedDirectCost: number;
  publicListing: boolean;
  updatedAt: string;
}
export class TrackerProblem extends Error {
  status: 400 | 403 | 404 | 409;
  constructor(message: string, status: 400 | 403 | 404 | 409 = 400) {
    super(message);
    this.status = status;
  }
}
export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TrackerProblem('Expected an object.');
  return value as Record<string, unknown>;
}
export function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value))
    throw new TrackerProblem(`${label} must be a short identifier, without paths or spaces.`);
  return value;
}
export function numeric(value: unknown, label: string, nullable = false, max = 1e9): number | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max)
    throw new TrackerProblem(
      `${label} must be a finite nonnegative number${nullable ? ' or null' : ''}.`,
    );
  return Math.round(value * 1e6) / 1e6;
}
function count(
  value: unknown,
  label: string,
  nullable = false,
  min = 0,
  max = 2147483647,
): number | null {
  const n = numeric(value, label, nullable, max);
  if (n !== null && (!Number.isInteger(n) || n < min))
    throw new TrackerProblem(`${label} must be an integer between ${min} and ${max}.`);
  return n;
}
export function currencyOf(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value))
    throw new TrackerProblem(
      'Use an uppercase three-letter currency code. No currency conversion is performed.',
    );
  return value;
}
export function parseEvents(value: unknown, currency: string): TrackerEvent[] {
  if (!Array.isArray(value) || value.length > 10000)
    throw new TrackerProblem('Supply an events array with at most 10,000 entries.');
  const seen = new Set<string>();
  return value.map((raw) => {
    const e = record(raw);
    const allowed = new Set([
      'id',
      'kind',
      'at',
      'amount',
      'currency',
      'seconds',
      'agents',
      'billable',
      'provenance',
      'partial',
    ]);
    if (Object.keys(e).some((key) => !allowed.has(key)))
      throw new TrackerProblem(
        'Events may contain only tracker fields; remove prompts, paths and other metadata.',
      );
    const id = identifier(e['id'], 'Event ID');
    if (seen.has(id)) throw new TrackerProblem('Duplicate event IDs in one import.');
    seen.add(id);
    const kind = e['kind'] as EventKind;
    if (!EVENT_KINDS.includes(kind)) throw new TrackerProblem('Unknown event kind.');
    if (currencyOf(e['currency']) !== currency)
      throw new TrackerProblem(
        'Event currency differs from the fleet. Import into a fleet with the matching currency.',
      );
    const at = e['at'] ?? null;
    if (
      at !== null &&
      (typeof at !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T/.test(at) ||
        !Number.isFinite(Date.parse(at)))
    )
      throw new TrackerProblem('Event time must be an ISO timestamp or null.');
    const provenance = e['provenance'] ?? 'reported';
    if (!['engine', 'estimated', 'reported'].includes(String(provenance)))
      throw new TrackerProblem('Unknown cost provenance.');
    if (e['partial'] !== undefined && typeof e['partial'] !== 'boolean')
      throw new TrackerProblem('partial must be boolean.');
    if (e['billable'] !== undefined && typeof e['billable'] !== 'boolean')
      throw new TrackerProblem('billable must be boolean.');
    if (kind === 'work' && e['amount'] != null)
      throw new TrackerProblem('Work time is not a receipt.');
    if (kind !== 'work' && (e['seconds'] != null || e['agents'] != null || e['billable'] === true))
      throw new TrackerProblem('Only work events may contain time or agent counts.');
    return {
      id,
      kind,
      at: at === null ? null : new Date(at as string).toISOString(),
      amount: kind === 'work' ? null : numeric(e['amount'] ?? null, 'Amount', true),
      currency,
      seconds: kind === 'work' ? count(e['seconds'] ?? null, 'Seconds', true) : null,
      agents: kind === 'work' ? count(e['agents'] ?? null, 'Agents', true, 1, 1000) : null,
      billable: e['billable'] === true,
      provenance: provenance as TrackerEvent['provenance'],
      partial: e['partial'] === true,
    };
  });
}

export function summarize(
  fleet: Pick<Fleet, 'currency' | 'rate' | 'retainedTarget' | 'assumedDirectCost'>,
  events: TrackerEvent[],
) {
  const grouped = Object.fromEntries(
    EVENT_KINDS.map((kind) => {
      const rows = events.filter((e) => e.kind === kind);
      const known = rows.filter((e) => e.amount !== null);
      return [
        kind,
        {
          count: rows.length,
          known: known.length,
          partial: rows.filter((e) => e.partial).length,
          amount: known.length ? known.reduce((sum, e) => sum + (e.amount ?? 0), 0) : null,
          complete:
            rows.length > 0 && known.length === rows.length && rows.every((e) => !e.partial),
        },
      ];
    }),
  ) as Record<
    EventKind,
    { count: number; known: number; partial: number; amount: number | null; complete: boolean }
  >;
  const work = events.filter((e) => e.kind === 'work' && e.billable);
  const knownWork = work.filter((e) => e.seconds !== null && e.agents !== null && !e.partial);
  const hours = knownWork.length
    ? knownWork.reduce((sum, e) => sum + (e.seconds! * e.agents!) / 3600, 0)
    : null;
  const measuredRows = events.filter(
    (e) => e.kind === 'cost' && e.provenance === 'engine' && e.amount !== null,
  );
  const estimatedRows = events.filter(
    (e) => e.kind === 'cost' && e.provenance === 'estimated' && e.amount !== null,
  );
  const measured = measuredRows.length ? measuredRows.reduce((sum, e) => sum + e.amount!, 0) : null;
  const estimated = estimatedRows.length
    ? estimatedRows.reduce((sum, e) => sum + e.amount!, 0)
    : null;
  // Zero must be explicitly reported. An absent receipt, fee or affiliate feed
  // is missing coverage, not a statement that no money moved.
  const complete = ['cost', 'receipt', 'commission', 'fee', 'affiliate'].every(
    (kind) => grouped[kind as EventKind].complete,
  );
  const revenue =
    grouped.receipt.complete && grouped.commission.complete
      ? grouped.receipt.amount! + grouped.commission.amount!
      : null;
  const profit = complete
    ? revenue! - grouped.cost.amount! - grouped.fee.amount! - grouped.affiliate.amount!
    : null;
  return {
    currency: fleet.currency,
    categories: grouped,
    costEngine: measured,
    costEstimated: estimated,
    billableAgentHours: hours,
    missingWorkEntries: work.length - knownWork.length,
    potentialBilledValue: hours === null ? null : hours * fleet.rate,
    observedRevenue: revenue,
    retainedProfit: profit,
    margin: profit !== null && revenue! > 0 ? profit / revenue! : null,
    profitIncludesEstimates: events.some((e) => e.kind === 'cost' && e.provenance !== 'engine'),
    retainedPerAgentHour:
      profit !== null && hours !== null && hours > 0 && knownWork.length === work.length
        ? profit / hours
        : null,
    assumedDirectCost: fleet.assumedDirectCost,
    retainedTarget: fleet.retainedTarget,
    modeledHeadroomPerHour: fleet.rate - fleet.assumedDirectCost - fleet.retainedTarget,
  };
}

const SELECT = `select f.id, f.slug, f.owner_id as "ownerId", r.public_slug as "operatorSlug", f.agents, f.currency,
 f.rate::float8, f.retained_target::float8 as "retainedTarget", f.assumed_direct_cost::float8 as "assumedDirectCost",
 f.public_listing as "publicListing", f.updated_at as "updatedAt" from fleets f join resumes r on r.id=f.operator_resume_id`;
export async function ownedFleets(pool: pg.Pool, owner: string): Promise<Fleet[]> {
  return (await pool.query<Fleet>(`${SELECT} where f.owner_id=$1 order by f.slug`, [owner])).rows;
}
export async function findFleet(
  pool: pg.Pool,
  slug: string,
  owner?: string,
): Promise<Fleet | null> {
  return (
    (
      await pool.query<Fleet>(
        `${SELECT} where f.slug=$1 and (f.owner_id=$2 or (f.public_listing and r.visibility='public'))`,
        [slug, owner ?? null],
      )
    ).rows[0] ?? null
  );
}
export async function ownerFleet(pool: pg.Pool, slug: string, owner: string): Promise<Fleet> {
  const fleet = (await ownedFleets(pool, owner)).find((f) => f.slug === slug);
  if (!fleet) throw new TrackerProblem('Fleet not found for this account.', 404);
  return fleet;
}
export async function saveFleet(pool: pg.Pool, owner: string, raw: unknown): Promise<Fleet> {
  const input = record(raw);
  const slug = identifier(input['slug'], 'Fleet name');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 64)
    throw new TrackerProblem('Fleet name must use lowercase letters, digits and hyphens.');
  const operator = identifier(input['operatorSlug'], 'Operator profile');
  const args = [
    slug,
    owner,
    operator,
    count(input['agents'], 'Agents', false, 1, 1000),
    currencyOf(input['currency'] ?? 'USD'),
    numeric(input['rate'] ?? 400, 'Rate'),
    numeric(input['retainedTarget'] ?? 50, 'Retained target'),
    numeric(input['assumedDirectCost'] ?? 100, 'Assumed direct cost'),
    input['publicListing'] === true,
  ];
  if (input['publicListing'] !== undefined && typeof input['publicListing'] !== 'boolean')
    throw new TrackerProblem('publicListing must be boolean.');
  const db = await pool.connect();
  try {
    await db.query('begin');
    const profile = await db.query(
      `select id from resumes where public_slug=$1 and user_id=$2 and visibility='public' for share`,
      [operator, owner],
    );
    if (!profile.rows.length)
      throw new TrackerProblem(
        'Choose a public candidate profile owned by your signed-in account.',
        403,
      );
    const existing = await db.query(
      `select owner_id,currency from fleets where slug=$1 for update`,
      [slug],
    );
    if (existing.rows[0] && existing.rows[0].owner_id !== owner)
      throw new TrackerProblem('That fleet name is already registered.', 409);
    if (existing.rows[0] && existing.rows[0].currency !== args[4])
      throw new TrackerProblem(
        'Fleet currency cannot change; create a separate fleet for another currency.',
      );
    await db.query(
      `insert into fleets (slug,owner_id,operator_resume_id,agents,currency,rate,retained_target,assumed_direct_cost,public_listing)
      values ($1,$2,(select id from resumes where public_slug=$3 and user_id=$2),$4,$5,$6,$7,$8,$9)
      on conflict(slug) do update set operator_resume_id=excluded.operator_resume_id,agents=excluded.agents,rate=excluded.rate,
      retained_target=excluded.retained_target,assumed_direct_cost=excluded.assumed_direct_cost,public_listing=excluded.public_listing,updated_at=now()
      where fleets.owner_id=excluded.owner_id returning id`,
      args,
    );
    await db.query('commit');
  } catch (error) {
    await db.query('rollback');
    if ((error as { code?: string }).code === '23505')
      throw new TrackerProblem('That fleet name is already registered.', 409);
    throw error;
  } finally {
    db.release();
  }
  return ownerFleet(pool, slug, owner);
}
export async function importEvents(pool: pg.Pool, fleet: Fleet, raw: unknown) {
  const input = record(raw);
  if (Object.keys(input).some((k) => !['source', 'events'].includes(k)))
    throw new TrackerProblem('Import only source and sanitized events.');
  const source = identifier(input['source'], 'Source');
  const events = parseEvents(input['events'], fleet.currency);
  const db = await pool.connect();
  try {
    await db.query('begin');
    for (const e of events)
      await db.query(
        `insert into fleet_events (fleet_id,source,event_id,kind,occurred_at,amount,currency,seconds,agents,billable,provenance,partial)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict(fleet_id,source,event_id) do update set
      kind=excluded.kind,occurred_at=excluded.occurred_at,amount=excluded.amount,currency=excluded.currency,seconds=excluded.seconds,
      agents=excluded.agents,billable=excluded.billable,provenance=excluded.provenance,partial=excluded.partial,updated_at=now()`,
        [
          fleet.id,
          source,
          e.id,
          e.kind,
          e.at,
          e.amount,
          e.currency,
          e.seconds,
          e.agents,
          e.billable,
          e.provenance,
          e.partial,
        ],
      );
    await db.query('update fleets set updated_at=now() where id=$1', [fleet.id]);
    await db.query('commit');
  } catch (error) {
    await db.query('rollback');
    throw error;
  } finally {
    db.release();
  }
  return { imported: events.length, source };
}
export async function fleetReport(pool: pg.Pool, fleet: Fleet) {
  const events = (
    await pool.query<TrackerEvent & { source: string }>(
      `select event_id as id, source,kind,occurred_at as at,amount::float8,currency,seconds,agents,billable,provenance,partial from fleet_events where fleet_id=$1 order by occurred_at nulls last,source,event_id`,
      [fleet.id],
    )
  ).rows;
  return {
    fleet,
    summary: summarize(fleet, events),
    sources: [...new Set(events.map((e) => e.source))],
    eventCount: events.length,
  };
}
export async function leaderboard(pool: pg.Pool) {
  const rows = (
    await pool.query<Fleet>(
      `${SELECT} where f.public_listing and r.visibility='public' order by f.agents desc,f.slug limit 100`,
    )
  ).rows;
  return rows.map(({ slug, operatorSlug, agents, currency, rate }) => ({
    slug,
    operatorSlug,
    agents,
    currency,
    rate,
  }));
}
export async function deleteSource(pool: pg.Pool, fleet: Fleet, source: string) {
  const result = await pool.query('delete from fleet_events where fleet_id=$1 and source=$2', [
    fleet.id,
    identifier(source, 'Source'),
  ]);
  return { deleted: result.rowCount ?? 0 };
}
