/**
 * The device flow, without a UI.
 *
 * Anything that can block - the CLI, a script, an MCP server being set up -
 * uses this rather than writing the polling loop again. The TUI drives the
 * same two client calls itself, interleaved with its own event loop.
 */

import { ApiError, type BoardClient } from './client.ts';

export interface LoginOptions {
  /** What the token is called in the member's session list. */
  label: string;
  /** Called once, with the code and the page a human has to open. */
  onPrompt: (grant: { userCode: string; verifyUrl: string; expiresAt: number }) => void;
  /** Overridable so tests do not wait in real time. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * A grant this caller already opened.
   *
   * Signing up needs the user code *before* the link is sent, because the link
   * carries it. Without this, signup would open one grant to build the link and
   * this function would immediately open a second, so the code in the mail
   * would approve a terminal that is no longer listening.
   */
  existing?: {
    deviceCode: string;
    userCode: string;
    verifyUrl: string;
    interval: number;
    expiresAt: number;
  };
}

export class LoginError extends Error {}

export async function login(client: BoardClient, options: LoginOptions): Promise<string> {
  let grant: Awaited<ReturnType<BoardClient['startDeviceAuth']>>;
  if (options.existing !== undefined) {
    grant = options.existing;
    options.onPrompt({
      userCode: grant.userCode,
      verifyUrl: grant.verifyUrl,
      expiresAt: grant.expiresAt,
    });
    return await poll(client, grant, options);
  }
  try {
    grant = await client.startDeviceAuth(options.label);
  } catch (error) {
    // A server that does not answer the device endpoint is either not a board
    // or is too old for one, and "404" alone does not say which.
    if (error instanceof ApiError && error.status === 404) {
      throw new LoginError(
        `${client.server} has no device sign-in endpoint. Is it an agenticjobs board, and recent enough?`,
      );
    }
    throw error;
  }

  options.onPrompt({
    userCode: grant.userCode,
    verifyUrl: grant.verifyUrl,
    expiresAt: grant.expiresAt,
  });

  return poll(client, grant, options);
}

async function poll(
  client: BoardClient,
  grant: { deviceCode: string; interval: number; expiresAt: number },
  options: LoginOptions,
): Promise<string> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  // The board says how often it wants to be asked. Ignoring that interval is
  // how a client gets itself rate-limited on the one request it cannot skip.
  const interval = Math.max(1, grant.interval || 2) * 1000;

  for (;;) {
    const remaining = grant.expiresAt - Date.now();
    if (remaining <= 0) {
      throw new LoginError('That code expired before it was approved. Run the command again.');
    }
    // A pending response must not keep a terminal polling beyond the deadline.
    await sleep(Math.min(interval, remaining));
    if (Date.now() >= grant.expiresAt) {
      throw new LoginError('That code expired before it was approved. Run the command again.');
    }
    const answer = await client.pollDeviceAuth(grant.deviceCode);
    if (answer.status === 'approved' && typeof answer.token === 'string') {
      client.setToken(answer.token);
      return answer.token;
    }
    if (answer.status === 'expired') {
      throw new LoginError('That code expired before it was approved. Run the command again.');
    }
  }
}
