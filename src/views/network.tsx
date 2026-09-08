/**
 * The directory: every instance that has announced itself, and one search
 * across all of them.
 */

import type { FC } from 'hono/jsx';
import type { InstanceListing } from '../schema/instance.ts';
import type { FederatedSearch } from '../directory/federate.ts';
import type { JobQuery } from '../schema/index.ts';
import { ago, formatSalary } from '../schema/text.ts';
import { AgentPolicyBadge, Alert, Badge, Card, Empty } from './layout.tsx';
import { Filters } from './jobs.tsx';

export const NetworkPage: FC<{
  instances: InstanceListing[];
  topics: { topic: string; instances: number }[];
  publicUrl: string;
  boardName: string;
}> = ({ instances, topics, publicUrl, boardName }) => {
  const online = instances.filter((instance) => instance.online).length;
  const openJobs = instances.reduce((sum, instance) => sum + instance.descriptor.jobs.open, 0);

  return (
    <div class="stack">
      <div>
        <h1>The network</h1>
        <p class="lede">
          {instances.length} {instances.length === 1 ? 'board' : 'boards'} listed here, {online}{' '}
          answering right now, {openJobs.toLocaleString('en-US')} open roles between them.
        </p>
      </div>

      <Card>
        <div class="card-header">
          <h2 class="card-title">Search all of them at once</h2>
          <p class="card-description">
            One question, asked of every listed board in parallel. Each result stays on the board
            that posted it - this directory holds no listings of its own.
          </p>
        </div>
        <form class="filters-inline" method="get" action="/network/search">
          <input class="input" type="search" name="q" placeholder="rust, staff, remote" aria-label="Search" />
          <button class="btn" type="submit">
            Search the network
          </button>
        </form>
      </Card>

      {topics.length > 0 && (
        <div class="row">
          {topics.map((topic) => (
            <a class="badge" href={`/network?topic=${encodeURIComponent(topic.topic)}`}>
              {topic.topic} <span class="muted">{topic.instances}</span>
            </a>
          ))}
        </div>
      )}

      {instances.length === 0 ? (
        <Empty>
          <p>No boards have announced themselves here yet.</p>
        </Empty>
      ) : (
        <ul class="job-list">
          {instances.map((instance) => (
            <li>
              <a class="card card-link" href={instance.url} rel="noopener">
                <div class="spread">
                  <h2 class="card-title">{instance.descriptor.name}</h2>
                  <Badge
                    variant={instance.online ? 'online' : 'offline'}
                    class="badge-dot"
                  >
                    {instance.online ? 'answering' : `quiet for ${ago(instance.updatedAt)}`}
                  </Badge>
                </div>
                {instance.descriptor.tagline !== '' && (
                  <p class="card-description">{instance.descriptor.tagline}</p>
                )}
                <div class="job-meta">
                  <Badge variant="primary">{instance.descriptor.jobs.open} open</Badge>
                  <span class="small muted mono">{instance.url.replace(/^https?:\/\//, '')}</span>
                  {instance.descriptor.topics.slice(0, 4).map((topic) => (
                    <Badge variant="outline">{topic}</Badge>
                  ))}
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}

      <Card>
        <div class="card-header">
          <h2 class="card-title">List your own board</h2>
          <p class="card-description">
            Run agenticjobs anywhere, point it here, and it appears in this list. You keep your own
            database, your own domain and your own rules.
          </p>
        </div>
        <pre class="code-block">
          {`DIRECTORY_URL=${publicUrl}\nANNOUNCE=true`}
        </pre>
        <p class="small muted">
          Your instance sends one field - its own URL. {boardName} then reads{' '}
          <code>/.well-known/agenticjobs</code> from it directly, so nothing about your board is
          taken on trust from the announcement.
        </p>
      </Card>
    </div>
  );
};

export const NetworkSearchPage: FC<{ result: FederatedSearch; query: JobQuery }> = ({
  result,
  query,
}) => {
  const failed = result.sources.filter((source) => !source.ok);
  return (
    <div class="grid-2">
      <div class="stack">
        <div>
          <h1>Across the network</h1>
          <p class="lede">
            {result.total.toLocaleString('en-US')} matching roles on{' '}
            {result.sources.filter((source) => source.ok).length} of {result.sources.length} boards.
          </p>
        </div>
        <Filters query={query} action="/network/search" />

        {failed.length > 0 && (
          <Alert variant="warning">
            {failed.length} {failed.length === 1 ? 'board' : 'boards'} did not answer, so their
            listings are missing from this page. They are named on the right.
          </Alert>
        )}

        {result.jobs.length === 0 ? (
          <Empty>Nothing matched on any listed board.</Empty>
        ) : (
          <ul class="job-list">
            {result.jobs.map((entry) => {
              const salary = formatSalary(entry.job.salary);
              return (
                <li>
                  <a class="card card-link job-card" href={entry.url} rel="noopener">
                    <div class="spread">
                      <h2 class="job-title">{entry.job.title}</h2>
                      {salary !== null && <span class="job-salary">{salary}</span>}
                    </div>
                    <div class="job-org">
                      {entry.job.org.name}
                      {entry.job.location !== null && ` - ${entry.job.location}`}
                    </div>
                    <div class="job-meta">
                      <Badge variant="primary">{entry.instanceName}</Badge>
                      <Badge variant="outline">{entry.job.workplace}</Badge>
                      <AgentPolicyBadge policy={entry.job.agentPolicy} />
                    </div>
                    <div class="small muted">{ago(entry.job.publishedAt)}</div>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <aside class="stack">
        <Card>
          <div class="card-header">
            <h2 class="card-title">Who answered</h2>
            <p class="card-description">
              A board that is slow or down is named rather than quietly dropped.
            </p>
          </div>
          <ul class="source-list">
            {result.sources.map((source) => (
              <li>
                <span>{source.name}</span>
                <span class={source.ok ? 'muted' : 'error-text'}>
                  {source.ok ? `${source.count} in ${source.ms}ms` : 'no answer'}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </aside>
    </div>
  );
};
