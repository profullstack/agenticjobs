/**
 * The heartbeat, from the instance's side.
 *
 * An instance sends one field — its own URL — and the directory goes and reads
 * the rest for itself. That asymmetry is the whole design: there is nothing in
 * an announcement worth forging, so there is nothing to authenticate.
 *
 * Announcing is opt-in. An instance with ANNOUNCE unset never contacts
 * anything, which is the correct default for a company running this for its
 * own openings.
 */

import { HEARTBEAT_MS } from '../schema/instance.ts';
import { fetchJson, FetchProblem } from './fetch.ts';

export interface Announcer {
  stop: () => void;
  /** Exposed so the CLI can announce once and exit. */
  beat: () => Promise<boolean>;
}

export interface AnnounceOptions {
  directoryUrl: string;
  publicUrl: string;
  intervalMs?: number;
  log?: (message: string) => void;
}

export async function announceOnce(directoryUrl: string, publicUrl: string): Promise<void> {
  await fetchJson(`${directoryUrl.replace(/\/+$/, '')}/api/v1/directory/announce`, {
    method: 'POST',
    body: { url: publicUrl },
    maxBytes: 64 * 1024,
  });
}

/**
 * Announce now, then keep announcing.
 *
 * Failures are logged once and retried on the next beat rather than escalated:
 * a directory being down is not a reason for a job board to stop serving jobs,
 * and the only consequence is that the instance drops off a list until it
 * comes back.
 */
export function startAnnouncing(options: AnnounceOptions): Announcer {
  const interval = options.intervalMs ?? HEARTBEAT_MS;
  const log = options.log ?? ((message: string) => console.log(message));
  let lastError: string | null = null;

  const beat = async (): Promise<boolean> => {
    try {
      await announceOnce(options.directoryUrl, options.publicUrl);
      if (lastError !== null) {
        log(`directory: ${options.directoryUrl} is answering again`);
        lastError = null;
      }
      return true;
    } catch (error) {
      const message = error instanceof FetchProblem ? error.message : String(error);
      // Only the first occurrence of a given failure is logged. A directory
      // that is down for a day would otherwise write 144 identical lines.
      if (message !== lastError) {
        log(`directory: could not announce to ${options.directoryUrl}: ${message}`);
        lastError = message;
      }
      return false;
    }
  };

  void beat();
  const timer = setInterval(() => void beat(), interval);
  // Announcing must never be the reason a process stays alive.
  timer.unref?.();

  return { stop: () => clearInterval(timer), beat };
}
