/**
 * One client over the REST API, shared by the CLI, the TUI, the desktop app
 * and the stdio MCP binary.
 *
 * There is deliberately no second HTTP layer anywhere in this repository. A
 * command that builds its own request is a command that gets its own bugs
 * around auth headers, error shapes and trailing slashes.
 */

import type { Job, JobPage, JobQuery, Organisation } from '../schema/index.ts';
import { queryToParams } from '../schema/query.ts';
import type { InstanceDescriptor, InstanceListing } from '../schema/instance.ts';
import { WELL_KNOWN_PATH } from '../schema/instance.ts';
import { normaliseServer } from './config.ts';

export class ApiError extends Error {
  // Written out rather than declared as constructor parameters: parameter
  // properties are erasable-syntax-only violations, and this repo enforces
  // that so the .ts half of it can still be run without a build.
  readonly status: number;
  readonly code: string;
  readonly fields: { field: string; message: string }[];

  constructor(
    message: string,
    status: number,
    code = 'error',
    fields: { field: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export interface ClientOptions {
  token?: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
}

export class BoardClient {
  readonly server: string;
  private token: string | null;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(server: string, options: ClientOptions = {}) {
    this.server = normaliseServer(server);
    this.token = options.token ?? null;
    this.doFetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.userAgent = options.userAgent ?? 'agenticjobs-client';
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  hasToken(): boolean {
    return this.token !== null && this.token !== '';
  }

  async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.doFetch(`${this.server}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'user-agent': this.userAgent,
          ...(this.token === null ? {} : { authorization: `Bearer ${this.token}` }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      const raw = await response.text();
      let parsed: unknown = null;
      try {
        parsed = raw === '' ? null : (JSON.parse(raw) as unknown);
      } catch {
        // A board that answers HTML where JSON was asked for is usually a
        // proxy or a login wall, and saying so beats "unexpected token <".
        if (!response.ok) {
          throw new ApiError(
            `${this.server} answered ${response.status} with something that is not JSON. Is that a board?`,
            response.status,
          );
        }
      }

      if (!response.ok) {
        const error = (parsed as { error?: { message?: string; code?: string; fields?: [] } })?.error;
        throw new ApiError(
          error?.message ?? `${this.server} answered ${response.status}.`,
          response.status,
          error?.code ?? 'error',
          error?.fields ?? [],
        );
      }
      return parsed as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ApiError(`${this.server} did not answer in time.`, 0, 'timeout');
      }
      throw new ApiError(
        `Could not reach ${this.server}: ${error instanceof Error ? error.message : String(error)}`,
        0,
        'unreachable',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  // --- reads ------------------------------------------------------------

  async describe(): Promise<InstanceDescriptor> {
    return this.request<InstanceDescriptor>('GET', WELL_KNOWN_PATH);
  }

  async search(query: Partial<JobQuery>): Promise<JobPage<Job> & { query: JobQuery }> {
    const params = queryToParams({
      q: null,
      employmentType: null,
      workplace: null,
      seniority: null,
      agentPolicy: null,
      tags: [],
      salaryMin: null,
      org: null,
      sort: 'recent',
      limit: 25,
      offset: 0,
      ...query,
    });
    const search = params.toString();
    return this.request('GET', `/api/v1/jobs${search === '' ? '' : `?${search}`}`);
  }

  async job(slug: string): Promise<{ job: Job; html: string; jsonld: unknown }> {
    return this.request('GET', `/api/v1/jobs/${encodeURIComponent(slug)}`);
  }

  async applySchema(slug: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/api/v1/jobs/${encodeURIComponent(slug)}/apply-schema`);
  }

  async apply(slug: string, body: Record<string, unknown>): Promise<{ applicationId: string }> {
    return this.request('POST', `/api/v1/jobs/${encodeURIComponent(slug)}/apply`, body);
  }

  async employers(): Promise<{ items: Organisation[] }> {
    return this.request('GET', '/api/v1/orgs');
  }

  async me(): Promise<{
    user: { id: string; email: string; name: string | null; isAdmin: boolean };
    orgs: Organisation[];
    resumes: { slug: string; title: string; visibility: string; updatedAt: string }[];
  }> {
    return this.request('GET', '/api/v1/me');
  }

  async resumes(): Promise<{ items: { slug: string; title: string; markdown: string }[] }> {
    return this.request('GET', '/api/v1/resumes');
  }

  async saveResume(
    markdown: string,
    options: { slug?: string; title?: string } = {},
  ): Promise<unknown> {
    if (options.slug !== undefined) {
      return this.request('PATCH', `/api/v1/resumes/${encodeURIComponent(options.slug)}`, {
        markdown,
        ...(options.title === undefined ? {} : { title: options.title }),
      });
    }
    return this.request('POST', '/api/v1/resumes', {
      markdown,
      ...(options.title === undefined ? {} : { title: options.title }),
    });
  }

  async postJob(input: Record<string, unknown>): Promise<{ job: Job }> {
    return this.request('POST', '/api/v1/jobs', input);
  }

  /** Import a job from a URL, or refresh the listing already imported from it. */
  async importJob(input: {
    url: string;
    org?: string;
    slug?: string;
    agentPolicy?: string;
  }): Promise<{ job: Job; via: string; warnings: string[]; created: boolean }> {
    return this.request('POST', '/api/v1/jobs/import', input);
  }

  /** Change a listing's content. Only the fields sent are touched. */
  async editJob(slug: string, input: Record<string, unknown>): Promise<{ job: Job }> {
    return this.request('PATCH', `/api/v1/jobs/${encodeURIComponent(slug)}`, input);
  }

  async publishJob(slug: string): Promise<{ job: Job }> {
    return this.request('POST', `/api/v1/jobs/${encodeURIComponent(slug)}/publish`);
  }

  async applications(slug: string): Promise<{ items: unknown[] }> {
    return this.request('GET', `/api/v1/jobs/${encodeURIComponent(slug)}/applications`);
  }

  // --- federation -------------------------------------------------------

  async instances(): Promise<{ items: InstanceListing[] }> {
    return this.request('GET', '/api/v1/directory/instances');
  }

  async searchNetwork(query: Partial<JobQuery>): Promise<unknown> {
    const params = queryToParams({
      q: null,
      employmentType: null,
      workplace: null,
      seniority: null,
      agentPolicy: null,
      tags: [],
      salaryMin: null,
      org: null,
      sort: 'recent',
      limit: 25,
      offset: 0,
      ...query,
    });
    const search = params.toString();
    return this.request('GET', `/api/v1/directory/search${search === '' ? '' : `?${search}`}`);
  }

  // --- sign in ----------------------------------------------------------

  async startDeviceAuth(label: string): Promise<{
    deviceCode: string;
    userCode: string;
    verifyUrl: string;
    interval: number;
    expiresAt: number;
  }> {
    return this.request('POST', '/api/v1/auth/device', { label });
  }

  async pollDeviceAuth(
    deviceCode: string,
  ): Promise<{ status: 'pending' | 'approved' | 'expired'; token?: string }> {
    return this.request('POST', '/api/v1/auth/device/poll', { deviceCode });
  }
}
