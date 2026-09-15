import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../dist/config.js';
import { calls } from './fixtures/cli-sync.ts';

const entry = new URL('../dist/cli/index.js', import.meta.url);
const fixture = new URL('./fixtures/cli-sync.ts', import.meta.url);
const statusOutput = 'here   never synced\nboard  nothing yet\n';
const savedOutput = 'Saved revision 7: the boards you use.\n';
const plannedOutput = 'added    boards.json\nWould take revision 7; nothing written.\n';
const cases = [
  { argv: ['sync'], method: 'status', options: {}, stdout: statusOutput },
  { argv: ['sync', 'status'], method: 'status', options: {}, stdout: statusOutput },
  { argv: ['sync', 'save'], method: 'save', options: { force: false }, stdout: savedOutput },
  { argv: ['sync', 'load'], method: 'load', options: { force: false, dryRun: false }, stdout: 'Loaded revision 7.\n' },
  { argv: ['sync', 'revisions'], method: 'revisions', options: {}, stdout: '   7  2026-09-15 00:00  fixture  42 bytes\n' },
  { argv: ['sync', 'unknown-action'], method: null, options: {}, stdout: '', exitCode: 1,
    stderr: 'Unknown: agenticjobs sync unknown-action. Try status, save, load or revisions.\n' },
  { argv: ['sync', 'save', '--force'], method: 'save', options: { force: true }, stdout: savedOutput },
  { argv: ['sync', 'load', '--dry-run'], method: 'load', options: { force: false, dryRun: true }, stdout: plannedOutput },
  { argv: ['sync', 'load', '--force', '--dry-run'], method: 'load', options: { force: true, dryRun: true }, stdout: plannedOutput },
];

test('compiled CLI dispatches settings sync subcommands and flags', async (t) => {
  // Redirect only this CLI import. The compiled entry point and parser run
  // unchanged; other tests can still import the real sync module.
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '../client/sync.js' && context.parentURL?.startsWith(`${entry.href}?`)) {
        return { url: fixture.href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected network request in sync dispatch test');
  });

  // Sequential subtests restore process state before reporting their results.
  for (const [index, example] of cases.entries()) {
    await t.test(example.argv.join(' '), async (t) => {
      const argv = process.argv;
      const exitCode = process.exitCode;
      t.after(() => {
        process.argv = argv;
        process.exitCode = exitCode;
        calls.length = 0;
      });
      calls.length = 0;
      process.argv = [process.execPath, fileURLToPath(entry), ...example.argv];
      process.exitCode = 0;
      let stdout = '';
      let stderr = '';
      t.mock.method(process.stdout, 'write', (chunk) => { stdout += String(chunk); return true; });
      t.mock.method(process.stderr, 'write', (chunk) => { stderr += String(chunk); return true; });

      // A fresh URL reruns the actual top-level CLI for each invocation.
      await import(`${entry.href}?sync-dispatch=${index}`);

      assert.equal(process.exitCode, example.exitCode ?? 0, 'exit code');
      assert.deepEqual([...calls], example.method === null ? [] : [{
        method: example.method,
        options: { userAgent: `agenticjobs-cli/${VERSION}`, ...example.options },
      }], 'selected sync operation and options');
      assert.equal(stdout, example.stdout, 'stdout');
      assert.equal(stderr, example.stderr ?? '', 'stderr');
      assert.equal(fetch.mock.callCount(), 0, 'no network requests');
    });
  }
});
