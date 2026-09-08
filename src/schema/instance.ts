/**
 * The federation contract.
 *
 * Every instance serves a descriptor at `/.well-known/agenticjobs`, and that
 * one document is how a directory lists it, how a client decides it is talking
 * to a job board at all, and how one instance searches another. Adding a field
 * here is additive; a client must ignore what it does not recognise, because
 * instances upgrade on their owners' schedules and never together.
 */

import { clean } from './text.ts';

/** Bumped only for a change that would break an older reader. */
export const PROTOCOL_VERSION = 1;

export const WELL_KNOWN_PATH = '/.well-known/agenticjobs';

export interface InstanceDescriptor {
  protocol: number;
  /** The instance's own public origin. Everything else is relative to it. */
  url: string;
  name: string;
  tagline: string;
  /** Free-form, lowercase. How a directory groups instances. */
  topics: string[];
  software: { name: string; version: string };
  /** Published counts, so a client can rank instances before querying them. */
  jobs: { open: number; total: number };
  endpoints: {
    /** Where a JobQuery goes. */
    search: string;
    openapi: string;
    /** Streamable HTTP MCP. */
    mcp: string;
    feed: string;
  };
  /** Whether this instance also runs a directory others can announce to. */
  directory: boolean;
  /** Optional, for a human to write to. */
  contact: string | null;
}

/**
 * What the directory stores.
 *
 * `updatedAt` is set from the directory's own clock at the moment it last
 * successfully read the instance, never from anything the instance sent.
 */
export interface InstanceListing {
  id: string;
  url: string;
  descriptor: InstanceDescriptor;
  /** Last time the directory fetched the descriptor and it answered. */
  updatedAt: string;
  /** First time this URL was ever seen. Survives an instance going quiet. */
  firstSeenAt: string;
  /** Consecutive failed fetches. Reset to 0 by any success. */
  failures: number;
  online: boolean;
}

/** How long an instance stays `online` without a successful re-check. */
export const ONLINE_TTL_MS = 30 * 60 * 1000;
/** How often an instance re-announces itself. Comfortably inside the TTL. */
export const HEARTBEAT_MS = 10 * 60 * 1000;
/** Dropped from the directory after this many consecutive failures. */
export const MAX_FAILURES = 48;

export const DEFAULT_DIRECTORY = 'https://agenticjobs.work';

/**
 * A URL the directory is willing to list.
 *
 * It has to be somewhere another person's browser can actually go. A loopback
 * or link-local address is only reachable from the machine that published it,
 * so listing one produces an entry nobody but its owner can ever open — and,
 * because the directory fetches the URL itself, accepting one would also point
 * the directory's own HTTP client at its own network.
 */
export function publishable(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return null;
  if (host === '::1' || host === '0.0.0.0') return null;
  if (/^127\./.test(host)) return null;
  if (/^10\./.test(host)) return null;
  if (/^192\.168\./.test(host)) return null;
  if (/^169\.254\./.test(host)) return null;
  // 172.16.0.0/12 is the one private range that is easy to get wrong by eye.
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return null;
  // Unique local addresses, fc00::/7.
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return null;

  // Only the origin is ever kept. A path, a query or credentials in the URL
  // would all end up concatenated onto endpoint paths later.
  return new URL(url.origin);
}

const MAX_NAME = 80;
const MAX_TAGLINE = 200;

/**
 * Validate a descriptor fetched from an instance.
 *
 * Everything here arrived over the network from a stranger, so the URL is
 * taken from where we fetched it rather than from what the document claims,
 * and every string is flattened before it can reach a terminal or a page.
 */
export function parseDescriptor(input: unknown, fetchedFrom: string): InstanceDescriptor | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;

  const origin = publishable(fetchedFrom);
  if (origin === null) return null;

  const protocol = Number(record['protocol']);
  if (!Number.isFinite(protocol) || protocol < 1) return null;

  const software = record['software'];
  const softwareRecord =
    typeof software === 'object' && software !== null ? (software as Record<string, unknown>) : {};
  const jobs = record['jobs'];
  const jobsRecord =
    typeof jobs === 'object' && jobs !== null ? (jobs as Record<string, unknown>) : {};
  const endpoints = record['endpoints'];
  const endpointsRecord =
    typeof endpoints === 'object' && endpoints !== null
      ? (endpoints as Record<string, unknown>)
      : {};

  const base = origin.origin;
  const contact = clean(record['contact'], 200);

  return {
    protocol: Math.floor(protocol),
    url: base,
    name: clean(record['name'], MAX_NAME) || new URL(base).hostname,
    tagline: clean(record['tagline'], MAX_TAGLINE),
    topics: Array.isArray(record['topics'])
      ? record['topics']
          .map((topic) => clean(topic, 40).toLowerCase())
          .filter((topic) => topic !== '')
          .slice(0, 12)
      : [],
    software: {
      name: clean(softwareRecord['name'], 40) || 'unknown',
      version: clean(softwareRecord['version'], 20) || '0',
    },
    jobs: {
      open: count(jobsRecord['open']),
      total: count(jobsRecord['total']),
    },
    endpoints: {
      search: relative(endpointsRecord['search'], base, '/api/v1/jobs'),
      openapi: relative(endpointsRecord['openapi'], base, '/api/v1/openapi.json'),
      mcp: relative(endpointsRecord['mcp'], base, '/api/mcp'),
      feed: relative(endpointsRecord['feed'], base, '/jobs.json'),
    },
    directory: record['directory'] === true,
    contact: contact === '' ? null : contact,
  };
}

function count(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(10_000_000, Math.floor(parsed));
}

/**
 * Endpoints are pinned to the instance's own origin.
 *
 * An instance that advertises `https://example.com/api` for its search
 * endpoint would otherwise have every federated client in the network query
 * example.com on its behalf, with the directory's blessing.
 */
function relative(value: unknown, base: string, fallback: string): string {
  if (typeof value !== 'string' || value.trim() === '') return `${base}${fallback}`;
  try {
    const resolved = new URL(value, base);
    if (resolved.origin !== base) return `${base}${fallback}`;
    return resolved.toString();
  } catch {
    return `${base}${fallback}`;
  }
}
