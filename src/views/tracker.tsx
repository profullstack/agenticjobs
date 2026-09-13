import type { FC } from 'hono/jsx';
import type { Fleet, fleetReport, leaderboard } from '../core/tracker.ts';

type Report = Awaited<ReturnType<typeof fleetReport>>;
const money = (amount: number | null, currency: string): string =>
  amount === null
    ? 'Unknown'
    : `${currency} ${amount.toLocaleString('en-US', { maximumFractionDigits: 6 })}`;
const Metric: FC<{ label: string; value: string; note?: string }> = ({ label, value, note }) => (
  <div class="card">
    <div class="card-content">
      <p class="muted">{label}</p>
      <h2>{value}</h2>
      {note && <p class="muted">{note}</p>}
    </div>
  </div>
);

export const FleetForm: FC<{ fleet?: Fleet; profiles: { slug: string; title: string }[] }> = ({
  fleet,
  profiles,
}) => (
  <form method="post" action="/tracker/fleet" class="card stack">
    <h2>{fleet ? 'Fleet settings' : 'Register a fleet'}</h2>
    <label class="field">
      Fleet name
      <input
        class="input"
        name="slug"
        value={fleet?.slug ?? ''}
        placeholder="profullstack"
        required
        readonly={fleet !== undefined}
        pattern="[a-z0-9]+(-[a-z0-9]+)*"
        maxlength={64}
      />
    </label>
    <label class="field">
      Operator profile
      <select class="select" name="operatorSlug" required>
        {profiles.map((p) => (
          <option value={p.slug} selected={p.slug === fleet?.operatorSlug}>
            {p.title}
          </option>
        ))}
      </select>
    </label>
    <p class="muted">
      Only a public candidate profile owned by your account can operate this fleet.
    </p>
    <label class="field">
      Agents
      <input
        class="input"
        name="agents"
        type="number"
        min={1}
        max={1000}
        step={1}
        value={fleet?.agents ?? 1}
        required
      />
    </label>
    <label class="field">
      Currency
      <input
        class="input"
        name="currency"
        value={fleet?.currency ?? 'USD'}
        pattern="[A-Z]{3}"
        maxlength={3}
        readonly={fleet !== undefined}
        required
      />
    </label>
    <label class="field">
      Rate per agent-hour
      <input
        class="input"
        name="rate"
        type="number"
        min={0}
        step="0.000001"
        value={fleet?.rate ?? 400}
        required
      />
    </label>
    <label class="field">
      Retained profit target per agent-hour
      <input
        class="input"
        name="retainedTarget"
        type="number"
        min={0}
        step="0.000001"
        value={fleet?.retainedTarget ?? 50}
        required
      />
    </label>
    <label class="field">
      Assumed direct cost per agent-hour
      <input
        class="input"
        name="assumedDirectCost"
        type="number"
        min={0}
        step="0.000001"
        value={fleet?.assumedDirectCost ?? 100}
        required
      />
    </label>
    <p class="muted">
      The direct cost assumption is for modeling only. It never replaces imported costs.
    </p>
    <label class="field">
      <input
        name="publicListing"
        type="checkbox"
        value="true"
        checked={fleet?.publicListing ?? false}
      />{' '}
      List fleet identity, operator, agent count and advertised rate on the public capacity
      leaderboard
    </label>
    <p class="muted">Costs, receipts, hours, sources and profit always stay private.</p>
    <button class="btn" type="submit">
      {fleet ? 'Save fleet' : 'Register fleet'}
    </button>
  </form>
);

export const TrackerPage: FC<{
  fleets: Fleet[];
  report: Report | null;
  profiles: { slug: string; title: string }[];
  error?: string;
}> = ({ fleets, report, profiles, error }) => (
  <div class="stack">
    <div>
      <h1>Fleet tracker</h1>
      <p class="muted">Your fleet's reported work and financial health. Private to your account.</p>
      <a href="/tracker/leaderboard">Public capacity leaderboard</a>
    </div>
    {error && (
      <p role="alert" class="alert">
        {error}
      </p>
    )}
    <nav class="actions">
      {fleets.map((f) => (
        <a class="btn btn-secondary" href={`/tracker?fleet=${f.slug}`}>
          {f.slug}
        </a>
      ))}
      <a class="btn btn-secondary" href="/tracker?new=1">
        New fleet
      </a>
    </nav>
    {report && <FleetDashboard report={report} />}
    {profiles.length ? (
      <FleetForm {...(report ? { fleet: report.fleet } : {})} profiles={profiles} />
    ) : (
      <p>
        Publish your <a href="/me">candidate profile</a> before registering a fleet.
      </p>
    )}
  </div>
);

const FleetDashboard: FC<{ report: Report }> = ({
  report: { fleet, summary: s, sources, eventCount },
}) => (
  <section class="stack">
    <h2>{fleet.slug}</h2>
    <p>
      <a href={`/candidates/${fleet.operatorSlug}`}>Operator profile</a> · {fleet.agents} declared
      agents · {money(fleet.rate, fleet.currency)}/agent-hour ·{' '}
      {fleet.publicListing ? 'Public identity listed' : 'Private identity'}
    </p>
    <p class="muted">
      All retained imports · {eventCount} events · updated {String(fleet.updatedAt)}. Source reports
      are self-reported and may cover different periods.
    </p>
    <div class="tracker-metrics">
      <Metric
        label="Tracked billable agent-hours"
        value={s.billableAgentHours === null ? 'Unknown' : s.billableAgentHours.toFixed(2)}
        note={`${s.missingWorkEntries} billable entries missing time or agent counts. Session age is never counted.`}
      />
      <Metric
        label="Potential billed value"
        value={money(s.potentialBilledValue, fleet.currency)}
        note="Tracked billable hours × current advertised rate. This is not invoiced or received revenue."
      />
      <Metric
        label="Engine-reported costs"
        value={s.categories.cost.known ? money(s.costEngine, fleet.currency) : 'Unknown'}
        note={`${money(s.costEstimated, fleet.currency)} estimated from rate cards. Engine costs are reported by the CLI, not verified payments.`}
      />
      <Metric
        label="Retained profit from reported events"
        value={money(s.retainedProfit, fleet.currency)}
        note={
          s.retainedProfit === null
            ? 'Needs complete cost, receipt, commission, fee and affiliate coverage.'
            : s.profitIncludesEstimates
              ? 'Includes estimated or self-reported costs.'
              : 'Receipts + commissions − costs − fees − affiliate payouts.'
        }
      />
      <Metric
        label="Retained margin"
        value={s.margin === null ? 'Unknown' : `${(s.margin * 100).toFixed(1)}%`}
        note="Retained profit ÷ reported revenue."
      />
      <Metric
        label="Retained per billable agent-hour"
        value={money(s.retainedPerAgentHour, fleet.currency)}
        note={`Target: ${money(fleet.retainedTarget, fleet.currency)}/agent-hour.`}
      />
    </div>
    <h3>Coverage and reported amounts</h3>
    <p class="muted">
      Known amounts are subtotals of imported events, not proof of complete business accounting.
      Missing feeds stay unknown; import an explicit zero only when the source confirms zero.
    </p>
    <div class="table-wrap prose">
      <table>
        <thead>
          <tr>
            <th>Category</th>
            <th>Known subtotal</th>
            <th>Known / imported</th>
            <th>Partial entries</th>
          </tr>
        </thead>
        <tbody>
          {(['cost', 'receipt', 'commission', 'fee', 'affiliate'] as const).map((kind) => (
            <tr>
              <td>
                {
                  {
                    cost: 'Costs',
                    receipt: 'Receipts',
                    commission: 'Commissions received',
                    fee: 'Fees',
                    affiliate: 'Affiliate payouts',
                  }[kind]
                }
              </td>
              <td>{money(s.categories[kind].amount, fleet.currency)}</td>
              <td>
                {s.categories[kind].known} / {s.categories[kind].count}
              </td>
              <td>{s.categories[kind].partial}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    <div class="card">
      <h3>Planning assumptions</h3>
      <p>
        At {money(fleet.rate, fleet.currency)}/agent-hour, assuming{' '}
        {money(fleet.assumedDirectCost, fleet.currency)} direct cost and a{' '}
        {money(fleet.retainedTarget, fleet.currency)} retained target,{' '}
        {money(s.modeledHeadroomPerHour, fleet.currency)} remains per agent-hour for fees, discounts
        and affiliate payouts.
      </p>
      <p class="muted">
        This scenario is not observed profit and does not assume that every agent is working or
        billable.
      </p>
    </div>
    <h3>Import from your CLI</h3>
    <pre class="code-block">
      <code>{`agenticjobs tracker sync --fleet ${fleet.slug}\nagenticjobs tracker import --fleet ${fleet.slug} --format timers --file timer-log.json\nagenticjobs tracker import --fleet ${fleet.slug} --format ledger --source accounting --file ledger.json`}</code>
    </pre>
    <p>
      <a href="/tracker/docs">Import format, privacy and accounting guide</a>. Nothing uploads until
      you explicitly run a sync or import.
    </p>
    {sources.length > 0 && (
      <details>
        <summary>Imported sources ({sources.length})</summary>
        <ul>
          {sources.map((source) => (
            <li>
              <code>{source}</code>
            </li>
          ))}
        </ul>
        <p>To remove a source and its events:</p>
        <pre class="code-block">
          <code>{`agenticjobs tracker forget --fleet ${fleet.slug} --source SOURCE --yes`}</code>
        </pre>
      </details>
    )}
  </section>
);

export const Leaderboard: FC<{ fleets: Awaited<ReturnType<typeof leaderboard>> }> = ({
  fleets,
}) => (
  <section class="stack">
    <h1>Fleet capacity leaderboard</h1>
    <p>
      Opt-in fleet identities, ranked by declared agent capacity. Counts are operator-reported; this
      is not a ranking of earnings, efficiency or performance.
    </p>
    <a href="/tracker">Manage your private tracker</a>
    <div class="table-wrap prose">
      <table>
        <thead>
          <tr>
            <th>Rank</th>
            <th>Fleet</th>
            <th>Operator</th>
            <th>Agents</th>
            <th>Advertised rate / agent-hour</th>
          </tr>
        </thead>
        <tbody>
          {fleets.map((f, i) => (
            <tr>
              <td>{i + 1}</td>
              <td>
                <a href={`/fleets/${f.slug}`}>{f.slug}</a>
              </td>
              <td>
                <a href={`/candidates/${f.operatorSlug}`}>{f.operatorSlug}</a>
              </td>
              <td>{f.agents}</td>
              <td>{money(f.rate, f.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    {!fleets.length && (
      <p>
        No fleet has opted in yet. Financial details remain private even when a fleet is listed.
      </p>
    )}
  </section>
);
