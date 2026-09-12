/**
 * Where the terminal keeps which boards it talks to, and the token for each.
 *
 * Several boards at once is the normal case, not a power feature: the whole
 * point of the network is that a candidate watches a general board, two
 * niche ones and their employer's own, and asks all of them one question.
 * So the config is a map keyed by server URL with one marked current, and
 * every command takes `--server` to address a different one.
 *
 * Tokens are credentials, so the file is 0600 and the directory 0700.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface BoardConfig {
  server: string;
  token: string | null;
  email?: string | null;
  /** The board's own name, cached so `boards` can list without a round trip. */
  name?: string | null;
}

export interface Config {
  current: string | null;
  boards: Record<string, BoardConfig>;
  /** Directories to discover other boards through. */
  directories: string[];
}

const EMPTY: Config = { current: null, boards: {}, directories: [] };

export function configPath(): string {
  const base =
    process.env['AGENTICJOBS_CONFIG_DIR'] ??
    process.env['XDG_CONFIG_HOME'] ??
    join(homedir(), '.config');
  return join(base, 'agenticjobs', 'config.json');
}

export function loadConfig(): Config {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<Config>;
    return {
      current: parsed.current ?? null,
      boards: parsed.boards ?? {},
      directories: parsed.directories ?? [],
    };
  } catch {
    // A missing or unreadable config is the first run, not an error.
    return { ...EMPTY, boards: {}, directories: [] };
  }
}

export function saveConfig(config: Config): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    // writeFileSync only applies its mode when it creates the file, so a
    // config written before this rule existed would keep its old permissions.
    chmodSync(path, 0o600);
  } catch {
    // A filesystem that refuses chmod is not a reason to fail.
  }
}

export function normaliseServer(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/^https?:/i, (scheme) => scheme.toLowerCase());
  }
  // A bare hostname is almost always meant as https; localhost almost never is.
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(trimmed);
  return `${local ? 'http' : 'https'}://${trimmed}`;
}

export function currentBoard(config: Config = loadConfig()): BoardConfig | null {
  if (config.current === null) return null;
  return config.boards[config.current] ?? null;
}

export function rememberBoard(board: BoardConfig): Config {
  const config = loadConfig();
  const server = normaliseServer(board.server);
  config.boards[server] = { ...board, server };
  config.current = server;
  saveConfig(config);
  return config;
}

export function forgetBoard(server: string): boolean {
  const config = loadConfig();
  const key = normaliseServer(server);
  if (config.boards[key] === undefined) return false;
  delete config.boards[key];
  if (config.current === key) {
    // Falling back to any remaining board beats leaving `current` pointing at
    // something that no longer exists, which every later command would trip on.
    config.current = Object.keys(config.boards)[0] ?? null;
  }
  saveConfig(config);
  return true;
}

export function rememberDirectory(url: string): void {
  const config = loadConfig();
  const key = normaliseServer(url);
  if (!config.directories.includes(key)) config.directories.push(key);
  saveConfig(config);
}

export const DEFAULT_SERVER = 'https://agenticjobs.work';
