/**
 * Settings sync: the boards you use, on every machine, through the board.
 *
 * ~/.config/agenticjobs/config.json holds two kinds of thing: which boards
 * you belong to, which is current and which directories you discover through
 * (settings), and a token for each board (a credential). A credential never
 * leaves the machine it was issued to, so what syncs is a projection,
 * boards.json, written beside the config from everything but the tokens.
 * Loading it on another machine adds the boards it did not know, without
 * tokens, and `agenticjobs login` fills those in.
 *
 * The mechanism is @profullstack/synconfig: one snapshot under a revision,
 * a conflict rather than a merge when two machines both saved, and a marker
 * so a load never overwrites an unsynced local edit. The current board's
 * API is the cloud.
 */
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  createClient,
  load,
  save,
  status,
  type LoadResult,
  type SaveResult,
  type StatusResult,
  type SyncContext,
  type SyncPolicy,
} from '@profullstack/synconfig';
import { configPath, currentBoard, loadConfig, normaliseServer, saveConfig, type Config } from './config.ts';

export const SETTINGS_FILE = 'boards.json';

export interface BoardSettings {
  current: string | null;
  boards: Record<string, { server: string; email?: string | null; name?: string | null }>;
  directories: string[];
}

export const SYNC_POLICY: SyncPolicy = {
  files: [{ path: SETTINGS_FILE, json: true, label: 'boards' }],
  never: ['config.json', 'sync.json'],
  neverSuffixes: ['.tmp', '.log'],
};

/** config.json minus every token. Pure. */
export function settingsFrom(config: Config): BoardSettings {
  const boards: BoardSettings['boards'] = {};
  for (const [key, board] of Object.entries(config.boards)) {
    boards[key] = {
      server: board.server,
      ...(board.email ? { email: board.email } : {}),
      ...(board.name ? { name: board.name } : {}),
    };
  }
  return { current: config.current, boards, directories: [...config.directories] };
}

/**
 * Fold synced settings into the local config: boards this machine has not
 * seen are added without a token, a name or email is filled in where the
 * local one is empty, directories are unioned, and the current board is
 * taken when none is set here. Tokens are never touched. Pure.
 */
export function applySettings(
  settings: BoardSettings,
  config: Config,
): { config: Config; added: string[]; directoriesAdded: string[]; current: string | null } {
  const next: Config = { current: config.current, boards: { ...config.boards }, directories: [...config.directories] };
  const added: string[] = [];
  for (const [key, board] of Object.entries(settings.boards ?? {})) {
    if (typeof board?.server !== 'string' || !board.server) continue;
    const server = normaliseServer(board.server);
    const existing = next.boards[key] ?? next.boards[server];
    if (existing) {
      next.boards[key in next.boards ? key : server] = {
        ...existing,
        ...(!existing.email && board.email ? { email: board.email } : {}),
        ...(!existing.name && board.name ? { name: board.name } : {}),
      };
      continue;
    }
    next.boards[server] = {
      server,
      token: null,
      ...(board.email ? { email: board.email } : {}),
      ...(board.name ? { name: board.name } : {}),
    };
    added.push(server);
  }
  const directoriesAdded: string[] = [];
  for (const directory of settings.directories ?? []) {
    if (typeof directory !== 'string' || !directory || next.directories.includes(directory)) continue;
    next.directories.push(directory);
    directoriesAdded.push(directory);
  }
  if (!next.current && settings.current && next.boards[settings.current]) next.current = settings.current;
  return { config: next, added, directoriesAdded, current: next.current };
}

export const settingsPath = (): string => `${dirname(configPath())}/${SETTINGS_FILE}`;

export function writeSettingsFile(config: Config = loadConfig()): string {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(settingsFrom(config), null, 2)}\n`, { mode: 0o600 });
  return path;
}

export function readSettingsFile(): BoardSettings | null {
  const path = settingsPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as BoardSettings;
  } catch {
    return null;
  }
}

export interface SyncOptions {
  server?: string;
  fetch?: typeof fetch;
  userAgent?: string;
}

export function syncContext(options: SyncOptions = {}): SyncContext {
  const config = loadConfig();
  const board = options.server ? config.boards[normaliseServer(options.server)] : currentBoard(config);
  if (!board?.token) {
    throw new Error('Settings sync uses a board you are signed in to. Run `agenticjobs login <server>` first.');
  }
  return {
    rootDir: dirname(configPath()),
    policy: SYNC_POLICY,
    client: createClient({
      baseUrl: board.server,
      path: '/api/v1/settings',
      token: board.token,
      ...(options.fetch ? { fetchImpl: options.fetch } : {}),
      ...(options.userAgent ? { headers: { 'user-agent': options.userAgent } } : {}),
    }),
    api: board.server,
    host: hostname(),
    app: 'agenticjobs',
  };
}

export async function syncSave(options: SyncOptions & { force?: boolean } = {}): Promise<SaveResult> {
  const ctx = syncContext(options);
  writeSettingsFile();
  return save(ctx, { force: options.force });
}

export async function syncLoad(
  options: SyncOptions & { force?: boolean; dryRun?: boolean } = {},
): Promise<LoadResult & { added: string[]; directoriesAdded: string[] }> {
  const ctx = syncContext(options);
  writeSettingsFile();
  const result = await load(ctx, { force: options.force, dryRun: options.dryRun });
  let added: string[] = [];
  let directoriesAdded: string[] = [];
  if (result.status === 'loaded' || result.status === 'same') {
    const synced = readSettingsFile();
    if (synced) {
      const before = loadConfig();
      const applied = applySettings(synced, before);
      if (applied.added.length || applied.directoriesAdded.length || applied.current !== before.current) saveConfig(applied.config);
      added = applied.added;
      directoriesAdded = applied.directoriesAdded;
    }
  }
  return { ...result, added, directoriesAdded };
}

export async function syncStatus(options: SyncOptions = {}): Promise<StatusResult> {
  const ctx = syncContext(options);
  writeSettingsFile();
  return status(ctx);
}
