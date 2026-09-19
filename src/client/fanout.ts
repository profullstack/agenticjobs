/**
 * Asking every board you are signed in to, at once.
 *
 * The directory's federated search covers boards that opted into being listed.
 * This covers the other case, which is the one a person actually has: three
 * boards in their config, one of them private to their employer and listed
 * nowhere. Same guarantees - parallel, per-board timeout, a board that fails
 * is named rather than silently dropped.
 */

import type { Job, JobQuery } from '../schema/index.ts';
import { MAX_LIMIT } from '../schema/query.ts';
import { annualisedTopSalary } from '../schema/salary.ts';
import { BoardClient } from './client.ts';
import { loadConfig, type BoardConfig } from './config.ts';

export interface FanoutHit {
  job: Job;
  server: string;
  boardName: string;
  url: string;
}

export interface FanoutSource {
  server: string;
  name: string;
  ok: boolean;
  count: number;
  total: number;
  ms: number;
  error: string | null;
}

export interface FanoutResult {
  jobs: FanoutHit[];
  sources: FanoutSource[];
  total: number;
}

export function configuredBoards(): BoardConfig[] {
  const config = loadConfig();
  return Object.values(config.boards);
}

const UPSTREAM_PAGE_LIMIT = MAX_LIMIT;
const MAX_FANOUT_OFFSET = 100_000;
const DEFAULT_TIMEOUT_MS = 20_000;

export async function searchEverywhere(
  boards: BoardConfig[],
  query: Partial<JobQuery>,
  options: { timeoutMs?: number } = {},
): Promise<FanoutResult> {
  const sources: FanoutSource[] = boards.map((board) => ({
    server: board.server,
    name: board.name ?? hostOf(board.server),
    ok: false,
    count: 0,
    total: 0,
    ms: 0,
    error: null,
  }));
  const jobs: FanoutHit[] = [];

  await Promise.all(
    boards.map(async (board, index) => {
      const source = sources[index];
      if (source === undefined) return;
      const started = Date.now();
      try {
        const staged: FanoutHit[] = [];
        let sourceOffset = 0;
        let reportedTotal = 0;
        const offset = normaliseOffset(query.offset);
        const limit = normaliseLimit(query.limit);
        const window = offset + limit;
        const budgetMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

        // Fetch each board's prefix before applying the global offset. A board
        // page is capped at 100, so a large global page is advanced in bounded
        // requests rather than sent as one oversized upstream query.
        while (staged.length < window) {
          const remainingMs = budgetMs - (Date.now() - started);
          if (remainingMs <= 0) throw new Error(`${board.server} did not answer in time.`);
          const pageLimit = Math.min(UPSTREAM_PAGE_LIMIT, window - staged.length);
          const client = new BoardClient(board.server, {
            token: board.token,
            timeoutMs: remainingMs,
          });
          const page = await client.search({ ...query, limit: pageLimit, offset: sourceOffset });
          if (Date.now() - started >= budgetMs) {
            throw new Error(`${board.server} did not answer in time.`);
          }
          if (!Array.isArray(page?.items) || !Number.isSafeInteger(page.total) || page.total < 0) {
            throw new Error('The board returned an invalid search page.');
          }
          const hits = page.items.map((job) => {
            if (job === null || typeof job !== 'object' || typeof job.slug !== 'string') {
              throw new Error('The board returned an invalid search item.');
            }
            return {
              job,
              server: board.server,
              boardName: source.name,
              url: `${board.server}/jobs/${job.slug}`,
            };
          });
          staged.push(...hits);
          sourceOffset += page.items.length;
          reportedTotal = page.total;
          if (page.items.length === 0 || sourceOffset >= page.total) break;
        }

        // Prepare the whole prefix first: a failed board must not contribute
        // partial hits while being excluded from the successful source totals.
        jobs.push(...staged.slice(0, window));
        source.count = Math.min(staged.length, window);
        source.total = reportedTotal;
        source.ok = true;
      } catch (error) {
        source.error = error instanceof Error ? error.message : String(error);
      } finally {
        source.ms = Date.now() - started;
      }
    }),
  );

  // Each board sorted its own page; "newest" across three boards is none of
  // those orders, so it is redone here.
  if (query.sort === 'salary') {
    jobs.sort((a, b) => annualisedTopSalary(b.job.salary) - annualisedTopSalary(a.job.salary));
  } else {
    jobs.sort((a, b) => published(b.job) - published(a.job));
  }

  const limit = normaliseLimit(query.limit);
  const offset = normaliseOffset(query.offset);

  return {
    jobs: jobs.slice(offset, offset + limit),
    sources,
    total: sources.reduce((sum, source) => sum + (source.ok ? source.total : 0), 0),
  };
}

function normaliseLimit(limit: number | undefined): number {
  return Number.isSafeInteger(limit) ? Math.min(MAX_LIMIT, Math.max(1, limit as number)) : 25;
}

function normaliseOffset(offset: number | undefined): number {
  return Number.isSafeInteger(offset) ? Math.min(MAX_FANOUT_OFFSET, Math.max(0, offset as number)) : 0;
}

function published(job: Job): number {
  return Date.parse(job.publishedAt ?? job.createdAt) || 0;
}

function hostOf(server: string): string {
  try {
    return new URL(server).hostname;
  } catch {
    return server;
  }
}
