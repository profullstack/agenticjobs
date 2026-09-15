import type { SyncOptions } from '../../dist/client/sync.js';

type Options = SyncOptions & { force?: boolean; dryRun?: boolean };
export const calls: { method: string; options: Options }[] = [];

export async function syncStatus(options: Options) {
  calls.push({ method: 'status', options });
  return { marker: null, drifted: [], behind: false };
}

export async function syncSave(options: Options) {
  calls.push({ method: 'save', options });
  return { status: 'saved', revision: 7 };
}

export async function syncLoad(options: Options) {
  calls.push({ method: 'load', options });
  return options.dryRun
    ? { status: 'planned', revision: 7, plan: [{ status: 'added', path: 'boards.json' }] }
    : { status: 'loaded', revision: 7, added: [], directoriesAdded: [] };
}

export function syncContext(options: Options) {
  return { client: { async revisions() {
    calls.push({ method: 'revisions', options });
    return [{ revision: 7, savedAt: '2026-09-15T00:00:00.000Z', host: 'fixture', size: 42 }];
  } } };
}
