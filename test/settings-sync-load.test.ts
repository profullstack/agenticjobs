import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const { loadConfig, saveConfig } = await import('../dist/client/config.js');
const { syncLoad } = await import('../dist/client/sync.js');

test('sync load persists metadata filled into an existing board', async (t) => {
  for (const field of ['email', 'name'] as const) {
    await t.test(field, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'agenticjobs-sync-load-'));
      const previous = process.env['AGENTICJOBS_CONFIG_DIR'];
      process.env['AGENTICJOBS_CONFIG_DIR'] = dir;
      try {
        const server = 'https://board.example';
        const local = {
          current: server,
          boards: { [server]: { server, token: 'local-test-token', ...(field === 'email' ? { name: 'Local board' } : { email: 'local@example.com' }) } },
          directories: ['https://directory.example'],
        };
        saveConfig(local);
        const remote = {
          current: server,
          boards: { [server]: { server, email: 'remote@example.com', name: 'Remote board' } },
          directories: local.directories,
        };
        const fetch: typeof globalThis.fetch = async () => Response.json({
          ok: true,
          revision: 1,
          snapshot: { version: 1, host: 'other-machine', app: 'agenticjobs', files: { 'boards.json': { content: JSON.stringify(remote) } } },
        });

        const planned = await syncLoad({ fetch, dryRun: true });
        assert.equal(planned.status, 'planned');
        assert.deepEqual(loadConfig(), local, 'dry run must not change the config');

        const result = await syncLoad({ fetch, force: true });
        assert.equal(result.status, 'loaded');
        assert.deepEqual(result.added, []);
        assert.deepEqual(result.directoriesAdded, []);
        assert.deepEqual(loadConfig(), {
          ...local,
          boards: { [server]: { ...local.boards[server], [field]: remote.boards[server][field] } },
        }, 'filled metadata must reach config.json without replacing local values or credentials');
      } finally {
        if (previous === undefined) delete process.env['AGENTICJOBS_CONFIG_DIR'];
        else process.env['AGENTICJOBS_CONFIG_DIR'] = previous;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
