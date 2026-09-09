/**
 * Installing, updating and removing the CLI itself.
 *
 * These live on the command rather than in a second script, because a person
 * who installed with one line should not have to go and find a different URL
 * to get rid of it. The installer writes a manifest listing every path it
 * created and an uninstall.sh beside it; `uninstall` runs that script, so
 * removal is exact and needs no network.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { bold, dim } from './format.ts';

const run = promisify(execFile);

export interface Manifest {
  package: string;
  version: string;
  installer: string;
  installedAt: string;
  prefix: string;
  paths: string[];
}

/**
 * Where the installer put things.
 *
 * AGENTICJOBS_HOME is set by the shim it writes, so a normal invocation knows
 * without searching. The fallback covers someone who installed with npm
 * directly and still expects `update` to do something sensible.
 */
export function installDir(): string {
  return process.env['AGENTICJOBS_HOME'] ?? join(homedir(), '.local', 'share', 'agenticjobs');
}

export async function readManifest(): Promise<Manifest | null> {
  try {
    return JSON.parse(await readFile(join(installDir(), 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    return null;
  }
}

/** The line a person can paste, used in more than one message. */
export function installLine(site = 'https://agenticjobs.work'): string {
  return `curl -fsSL ${site}/install.sh | sh`;
}

export async function update(): Promise<number> {
  const manifest = await readManifest();

  if (manifest === null) {
    // Not installed by the installer. Saying which of the two situations this
    // is beats running an npm command against a tree we do not own.
    process.stderr.write(
      [
        'This copy was not put here by the installer, so there is nothing for it to update.',
        '',
        `  installed with npm:  npm install -g @profullstack/agenticjobs@latest`,
        `  otherwise:           ${installLine()}`,
        '',
      ].join('\n'),
    );
    return 1;
  }

  process.stdout.write(`Updating ${manifest.package} (${manifest.version} installed)...\n`);

  // Re-running the installer rather than `npm update` on purpose: the
  // installer is the thing that knows about shims, the manifest and the
  // uninstall script, and it rewrites all three.
  try {
    const { stdout, stderr } = await run(
      'sh',
      ['-c', `curl -fsSL ${manifest.installer} | sh`],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    process.stdout.write(stdout);
    if (stderr.trim() !== '') process.stderr.write(stderr);
    return 0;
  } catch (error) {
    process.stderr.write(
      `The update failed: ${error instanceof Error ? error.message : String(error)}\n\nRun it by hand:\n  ${installLine()}\n`,
    );
    return 1;
  }
}

export async function uninstall(options: { yes: boolean }): Promise<number> {
  const manifest = await readManifest();

  if (manifest === null) {
    process.stderr.write(
      [
        'This copy was not put here by the installer, so there is no manifest saying what to remove.',
        '',
        '  installed with npm:  npm uninstall -g @profullstack/agenticjobs',
        '',
      ].join('\n'),
    );
    return 1;
  }

  if (!options.yes) {
    process.stdout.write(
      [
        `${bold('This will remove agenticjobs ' + manifest.version)}:`,
        '',
        ...manifest.paths.map((path) => `  ${path}`),
        '',
        dim('Your boards and tokens in ~/.config/agenticjobs are NOT touched.'),
        '',
        'Run it for real with:  agenticjobs uninstall --yes',
        '',
      ].join('\n'),
    );
    return 0;
  }

  const script = join(installDir(), 'uninstall.sh');
  try {
    const { stdout } = await run('sh', [script], { maxBuffer: 4 * 1024 * 1024 });
    process.stdout.write(stdout);
    return 0;
  } catch (error) {
    process.stderr.write(
      `Could not run ${script}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

export async function whereIsIt(): Promise<number> {
  const manifest = await readManifest();
  if (manifest === null) {
    process.stdout.write(`Not installed by the installer.\n  ${installLine()}\n`);
    return 0;
  }
  process.stdout.write(
    [
      `${manifest.package} ${manifest.version}`,
      `  installed  ${manifest.installedAt}`,
      `  prefix     ${manifest.prefix}`,
      ...manifest.paths.map((path) => `  path       ${path}`),
      '',
    ].join('\n'),
  );
  return 0;
}
