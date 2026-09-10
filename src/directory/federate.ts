/**
 * Searching more than one instance at once.
 *
 * This is what the directory is for. A candidate should be able to ask one
 * question and have it answered by every board that opted in, without any of
 * those boards having to share a database, and without a slow or hostile one
 * being able to hold up the answer.
 *
 * The rules that make that true:
 *
 *  - every instance is queried in parallel, with its own timeout;
 *  - one instance failing removes that instance from the results and nothing
 *    else, and the failure is reported rather than swallowed, so a client can
 *    say "11 of 12 boards answered" instead of quietly showing less;
 *  - results carry the instance they came from, because a job on someone
 *    else's board is applied for on someone else's board.
 */

import type { Job, JobQuery } from '../schema/index.ts';
import { queryToParams } from '../schema/query.ts';
import { annualisedTopSalary } from '../schema/salary.ts';
import type { InstanceDescriptor } from '../schema/instance.ts';
import { fetchJson, FetchProblem } from './fetch.ts';

export interface FederatedJob {
  job: Job;
  /** Origin of the instance that served it. */
  instance: string;
  instanceName: string;
  /** Where a human or an agent goes to apply. Always on the origin board. */
  url: string;
}

export interface FederatedSearch {
  jobs: FederatedJob[];
  /** One entry per instance queried, in the order they were asked. */
  sources: SourceResult[];
  /** Sum of `total` across the instances that answered. */
  total: number;
}

export interface SourceResult {
  instance: string;
  name: string;
  ok: boolean;
  count: number;
  total: number;
  ms: number;
  error: string | null;
}

export interface FederateOptions {
  timeoutMs?: number;
  concurrency?: number;
  /** Cap per instance, so one busy board cannot crowd out eleven others. */
  perInstance?: number;
  signal?: AbortSignal;
}

interface Target {
  url: string;
  name: string;
  search: string;
}

export function targetsFromDescriptors(descriptors: InstanceDescriptor[]): Target[] {
  return descriptors.map((descriptor) => ({
    url: descriptor.url,
    name: descriptor.name,
    search: descriptor.endpoints.search,
  }));
}

export function targetsFromUrls(urls: string[]): Target[] {
  return urls.map((url) => {
    const origin = url.replace(/\/+$/, '');
    return { url: origin, name: hostOf(origin), search: `${origin}/api/v1/jobs` };
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export async function federatedSearch(
  targets: Target[],
  query: JobQuery,
  options: FederateOptions = {},
): Promise<FederatedSearch> {
  const perInstance = Math.min(100, Math.max(1, options.perInstance ?? query.limit));
  const concurrency = Math.min(24, Math.max(1, options.concurrency ?? 8));

  const params = queryToParams({ ...query, limit: perInstance, offset: 0 });
  const sources: SourceResult[] = targets.map((target) => ({
    instance: target.url,
    name: target.name,
    ok: false,
    count: 0,
    total: 0,
    ms: 0,
    error: null,
  }));
  const collected: FederatedJob[] = [];

  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const target = targets[index];
      const source = sources[index];
      if (target === undefined || source === undefined) return;

      const started = Date.now();
      try {
        const payload = await fetchJson(`${target.search}?${params.toString()}`, {
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        const page = payload as { items?: unknown; total?: unknown };
        const items = Array.isArray(page.items) ? page.items : [];
        for (const item of items.slice(0, perInstance)) {
          const job = item as Job;
          // A malformed row from one instance drops that row, not the answer.
          if (typeof job?.slug !== 'string' || typeof job?.title !== 'string') continue;
          collected.push({
            job,
            instance: target.url,
            instanceName: target.name,
            url: `${target.url}/jobs/${job.slug}`,
          });
          source.count += 1;
        }
        source.total = Number(page.total) || source.count;
        source.ok = true;
      } catch (error) {
        source.error = error instanceof FetchProblem ? error.message : String(error);
      } finally {
        source.ms = Date.now() - started;
      }
    }
  });

  await Promise.all(workers);

  sortMerged(collected, query);

  return {
    jobs: collected.slice(query.offset, query.offset + query.limit),
    sources,
    total: sources.reduce((sum, source) => sum + (source.ok ? source.total : 0), 0),
  };
}

/**
 * Merge-sort the combined set.
 *
 * Each instance already sorted its own page, but "recent" across twelve boards
 * is not any one board's order, so it has to be redone here. Relevance cannot
 * be: the rank came from each instance's own corpus statistics and the numbers
 * are not comparable between them, so a relevance search falls back to recency
 * once merged rather than pretending otherwise.
 */
function sortMerged(jobs: FederatedJob[], query: JobQuery): void {
  if (query.sort === 'salary') {
    jobs.sort((a, b) => annualisedTopSalary(b.job.salary) - annualisedTopSalary(a.job.salary));
    return;
  }
  jobs.sort((a, b) => published(b.job) - published(a.job));
}

function published(job: Job): number {
  return Date.parse(job.publishedAt ?? job.createdAt) || 0;
}
