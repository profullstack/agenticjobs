/**
 * Fetching from another instance.
 *
 * Everything here talks to a URL a stranger supplied, so the rules are the
 * same in all three directions (a directory reading an instance, an instance
 * announcing to a directory, a client fanning a search out): a short timeout,
 * a size cap, no redirect to a different origin, and no trust in anything the
 * response says about where it came from.
 */

import { publishable, WELL_KNOWN_PATH, type InstanceDescriptor } from '../schema/instance.ts';
import { parseDescriptor } from '../schema/instance.ts';
import { SOFTWARE_NAME, VERSION } from '../config.ts';

export const USER_AGENT = `${SOFTWARE_NAME}/${VERSION} (+https://agenticjobs.work)`;

/** Big enough for a page of jobs, small enough that nobody can wedge a peer. */
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 8000;

export class FetchProblem extends Error {}

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  method?: 'GET' | 'POST';
  body?: unknown;
}

/**
 * A JSON GET with the safety rails on.
 *
 * Redirects are followed manually so that a redirect off the origin can be
 * refused: allowing one would let any listed instance point the directory's
 * HTTP client at an address the origin check already rejected.
 */
export async function fetchJson(url: string, options: FetchOptions = {}): Promise<unknown> {
  const text = await fetchRaw(url, 'application/json', options);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new FetchProblem(`${url} did not answer with JSON`);
  }
}

/**
 * The same guarded fetch, for a document rather than an API.
 *
 * Importing a job means fetching a URL a stranger chose, so every guard here
 * matters: `publishable` refuses localhost and the private ranges, redirects
 * may not leave the origin they started on, the body is measured as it
 * arrives, and there is a timeout. None of that is worth reimplementing next
 * to the copy that already had it.
 */
export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  return fetchRaw(url, 'text/html, application/xhtml+xml;q=0.9, */*;q=0.5', options);
}

async function fetchRaw(url: string, accept: string, options: FetchOptions): Promise<string> {
  const origin = publishable(url);
  if (origin === null) throw new FetchProblem(`${url} is not an address we will fetch`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
  const abort = (): void => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });

  try {
    let target = url;
    for (let hop = 0; hop < 3; hop += 1) {
      const response = await fetch(target, {
        method: options.method ?? 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept,
          'user-agent': USER_AGENT,
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location === null) throw new FetchProblem(`${target} redirected with no location`);
        const next = new URL(location, target);
        if (next.origin !== origin.origin) {
          throw new FetchProblem(`${target} redirected off its own origin, to ${next.origin}`);
        }
        target = next.toString();
        continue;
      }

      if (!response.ok) throw new FetchProblem(`${target} answered ${response.status}`);

      // Content-Length is a hint from the other end, so the body is measured
      // as it arrives rather than trusted up front.
      const declared = Number(response.headers.get('content-length') ?? '0');
      const cap = options.maxBytes ?? MAX_BYTES;
      if (Number.isFinite(declared) && declared > cap) {
        throw new FetchProblem(`${target} declared ${declared} bytes`);
      }
      return readCapped(response, cap);
    }
    throw new FetchProblem(`${url} redirected too many times`);
  } catch (error) {
    if (error instanceof FetchProblem) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new FetchProblem(`${url} timed out`);
    }
    throw new FetchProblem(`${url}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

async function readCapped(response: Response, cap: number): Promise<string> {
  const body = response.body;
  if (body === null) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new FetchProblem(`response exceeded ${cap} bytes`);
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/**
 * Read an instance's descriptor from the instance itself.
 *
 * The URL it is parsed against is where we fetched it, never what the document
 * claims, so an instance cannot announce itself as somebody else.
 */
export async function fetchDescriptor(
  origin: string,
  options: FetchOptions = {},
): Promise<InstanceDescriptor> {
  const base = publishable(origin);
  if (base === null) throw new FetchProblem(`${origin} is not an address we will list`);
  const payload = await fetchJson(`${base.origin}${WELL_KNOWN_PATH}`, {
    ...options,
    maxBytes: 64 * 1024,
  });
  const descriptor = parseDescriptor(payload, base.origin);
  if (descriptor === null) throw new FetchProblem(`${base.origin} did not serve a usable descriptor`);
  return descriptor;
}
