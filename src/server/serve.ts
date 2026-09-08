/**
 * Bringing the board up.
 *
 * Migrate, listen, and - only if asked - start announcing to a directory.
 */

import { serve } from '@hono/node-server';
import { loadConfig, type Config } from '../config.ts';
import { getPool } from '../db/pool.ts';
import { migrate } from '../db/migrate.ts';
import { startAnnouncing, type Announcer } from '../directory/announce.ts';
import { sweep } from '../directory/registry.ts';
import { createApp } from './app.tsx';

export interface Running {
  config: Config;
  stop: () => Promise<void>;
}

export async function startServer(overrides: Partial<Config> = {}): Promise<Running> {
  const config = { ...loadConfig(), ...overrides };
  const pool = getPool(config.databaseUrl);

  const migrated = await migrate(pool);
  if (migrated.applied.length > 0) {
    console.log(`migrated: ${migrated.applied.join(', ')}`);
  }

  const app = createApp(pool, config);
  const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' });

  console.log(`${config.boardName} on http://localhost:${config.port}`);
  console.log(`  public url  ${config.publicUrl}`);
  if (config.ephemeralSecret) {
    // Not a warning about style: every session and device code minted before a
    // restart stops verifying, which looks like random sign-outs in production.
    console.warn('  SECRET is unset, so one was generated. Sessions will not survive a restart.');
  }

  let announcer: Announcer | null = null;
  if (config.announce && config.directoryUrl !== null) {
    announcer = startAnnouncing({
      directoryUrl: config.directoryUrl,
      publicUrl: config.publicUrl,
    });
    console.log(`  announcing  ${config.directoryUrl}`);
  }

  let sweeper: NodeJS.Timeout | null = null;
  if (config.isDirectory) {
    console.log('  directory   on');
    const run = (): void => {
      void sweep(pool)
        .then((result) => {
          if (result.failed > 0 || result.dropped > 0) {
            console.log(
              `directory sweep: ${result.ok} ok, ${result.failed} failed, ${result.dropped} dropped`,
            );
          }
        })
        .catch((error: unknown) => console.error('directory sweep failed', error));
    };
    // The first sweep waits a minute so a cold start serves requests before it
    // spends its connections re-reading forty other boards.
    sweeper = setInterval(run, 10 * 60 * 1000);
    sweeper.unref?.();
    setTimeout(run, 60_000).unref?.();
  }

  return {
    config,
    stop: async () => {
      announcer?.stop();
      if (sweeper !== null) clearInterval(sweeper);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
