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
        const client = new BoardClient(board.server, {
          token: board.token,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        });
        const page = await client.search(query);
        for (const job of page.items) {
          jobs.push({
            job,
            server: board.server,
            boardName: source.name,
            url: `${board.server}/jobs/${job.slug}`,
          });
        }
        source.count = page.items.length;
        source.total = page.total;
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
  jobs.sort((a, b) => published(b.job) - published(a.job));

  return {
    jobs,
    sources,
    total: sources.reduce((sum, source) => sum + (source.ok ? source.total : 0), 0),
  };
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
