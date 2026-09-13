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

export interface RecommendationLike {
  id: string;
  body: string;
  relationship: string | null;
  status: string;
  author: { kind: string; name: string; slug: string | null };
  subject: { kind: string; name: string; slug: string | null };
  createdAt: string;
  decidedAt: string | null;
}

export class BoardClient {
  async trackerFleets() {
    return this.request<{ fleets: import('../core/tracker.ts').Fleet[] }>(
      'GET',
      '/api/v1/tracker/fleets',
    );
  }
  async trackerSave(input: unknown) {
    return this.request<{ fleet: import('../core/tracker.ts').Fleet }>(
      'POST',
      '/api/v1/tracker/fleets',
      input,
    );
  }
  async trackerReport(slug: string) {
    return this.request<Awaited<ReturnType<typeof import('../core/tracker.ts').fleetReport>>>(
      'GET',
      `/api/v1/tracker/fleets/${encodeURIComponent(slug)}`,
    );
  }
  async trackerImport(slug: string, input: unknown) {
    return this.request<{ imported: number; source: string }>(
      'POST',
      `/api/v1/tracker/fleets/${encodeURIComponent(slug)}/import`,
      input,
    );
  }
  async trackerForget(slug: string, source: string) {
    return this.request<{ deleted: number }>(
      'DELETE',
      `/api/v1/tracker/fleets/${encodeURIComponent(slug)}/sources/${encodeURIComponent(source)}`,
    );
  }
  async trackerLeaderboard() {
    return this.request<{
      fleets: Awaited<ReturnType<typeof import('../core/tracker.ts').leaderboard>>;
    }>('GET', '/api/v1/tracker/leaderboard');
  }
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
    const { body: parsed } = await this.requestWithStatus<T>(method, path, body);
    return parsed;
  }

  /**
   * Same as `request`, but keeps the HTTP status.
   *
   * Create endpoints answer 201. The stdio MCP host used to report every
   * success as 200, so `apply_to_job` / `post_job` treated a successful write
   * as a failure.
   */
  async requestWithStatus<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> {
    try {
      return await this.requestOnce<T>(method, path, body);
    } catch (error) {
      // A hosted board that has been idle can miss a single client timeout
      // (curl's default 15s from a distant region, #36) and then answer in
      // about a second. GET is safe to repeat; POST is not.
      if (method === 'GET' && error instanceof ApiError && error.code === 'timeout') {
        return this.requestOnce<T>(method, path, body);
      }
      throw error;
    }
  }

  private async requestOnce<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> {
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
        throw new ApiError(
          `${this.server} answered ${response.status} with something that is not JSON. Is that a board?`,
          response.status,
        );
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
      return { status: response.status, body: parsed as T };
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
    options: { slug?: string; title?: string; visibility?: string } = {},
  ): Promise<unknown> {
    const body = {
      markdown,
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.visibility === undefined ? {} : { visibility: options.visibility }),
    };
    if (options.slug !== undefined) {
      return this.request('PATCH', `/api/v1/resumes/${encodeURIComponent(options.slug)}`, body);
    }
    return this.request('POST', '/api/v1/resumes', body);
  }

  /** Change only a resume's visibility, leaving the document alone. */
  async setResumeVisibility(
    slug: string,
    visibility: string,
  ): Promise<{ resume: { slug: string; visibility: string; publicSlug: string | null } }> {
    return this.request('PATCH', `/api/v1/resumes/${encodeURIComponent(slug)}`, { visibility });
  }

  async deleteResume(slug: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/api/v1/resumes/${encodeURIComponent(slug)}`);
  }

  /** The employers this account belongs to, which is not the public list. */
  async myOrgs(): Promise<Organisation[]> {
    return (await this.me()).orgs;
  }

  async createOrg(input: Record<string, unknown>): Promise<{ org: Organisation }> {
    return this.request('POST', '/api/v1/orgs', input);
  }

  async updateOrg(slug: string, input: Record<string, unknown>): Promise<{ org: Organisation }> {
    return this.request('PATCH', `/api/v1/orgs/${encodeURIComponent(slug)}`, input);
  }

  async deleteOrg(slug: string): Promise<{ ok: boolean; deleted: string }> {
    return this.request('DELETE', `/api/v1/orgs/${encodeURIComponent(slug)}`);
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

  // --- updates ----------------------------------------------------------

  async updates(scope: { org?: string; candidate?: string; following?: boolean } = {}): Promise<{
    items: { id: string; body: string; link: string | null; createdAt: string; author: { kind: string; name: string; slug: string | null } }[];
  }> {
    const params = new URLSearchParams();
    if (scope.org !== undefined && scope.org !== '') params.set('org', scope.org);
    if (scope.candidate !== undefined && scope.candidate !== '') {
      params.set('candidate', scope.candidate);
    }
    if (scope.following === true) params.set('following', 'true');
    const search = params.toString();
    return this.request('GET', `/api/v1/updates${search === '' ? '' : `?${search}`}`);
  }

  async postUpdate(input: { body: string; link?: string; org?: string }): Promise<{
    update: { id: string; body: string; link: string | null };
    author: string;
  }> {
    return this.request('POST', '/api/v1/updates', input);
  }

  async setFollow(
    target: { org?: string; candidate?: string },
    following: boolean,
  ): Promise<{ following: boolean; followers: number }> {
    const path =
      target.org !== undefined && target.org !== ''
        ? `/api/v1/orgs/${encodeURIComponent(target.org)}/follow`
        : `/api/v1/candidates/${encodeURIComponent(target.candidate ?? '')}/follow`;
    return this.request(following ? 'POST' : 'DELETE', path);
  }

  // --- inbox and billing --------------------------------------------------

  async inbox(): Promise<{
    items: {
      id: string;
      subject: string;
      with: { kind: string; name: string; slug: string | null };
      lastMessageAt: string;
      unread: number;
      preview: string;
      job: { slug: string; title: string } | null;
    }[];
    unread: number;
  }> {
    return this.request('GET', '/api/v1/inbox');
  }

  async thread(id: string): Promise<{
    thread: {
      id: string;
      subject: string;
      with: { kind: string; name: string; slug: string | null };
      messages: {
        id: string;
        kind: string;
        body: string;
        invoiceId: string | null;
        createdAt: string;
        sender: { name: string };
        mine: boolean;
      }[];
    };
    invoices: { id: string; amountUsd: string; currency: string; status: string }[];
  }> {
    return this.request('GET', `/api/v1/inbox/${encodeURIComponent(id)}`);
  }

  async startThread(input: {
    candidate?: string;
    employer?: string;
    job?: string;
    as?: string;
    subject?: string;
    body: string;
  }): Promise<{ threadId: string; messageId: string; created: boolean; url: string }> {
    return this.request('POST', '/api/v1/inbox', input);
  }

  async reply(threadId: string, body: string): Promise<{ message: { id: string } }> {
    return this.request('POST', `/api/v1/inbox/${encodeURIComponent(threadId)}/messages`, { body });
  }

  async sendInvoice(
    threadId: string,
    input: { amount: string; currency?: string; description?: string },
  ): Promise<{ invoice: { id: string; amountUsd: string; currency: string; status: string } }> {
    return this.request('POST', `/api/v1/inbox/${encodeURIComponent(threadId)}/invoices`, input);
  }

  async invoices(): Promise<{
    items: {
      id: string;
      threadId: string;
      amountUsd: string;
      currency: string;
      status: string;
      payee: { id: string; name: string };
      createdAt: string;
    }[];
  }> {
    return this.request('GET', '/api/v1/invoices');
  }

  async payInvoice(id: string): Promise<{
    invoice: {
      status: string;
      currency: string;
      payment: { url: string; address: string | null; amountCrypto: string | null } | null;
    };
  }> {
    return this.request('POST', `/api/v1/invoices/${encodeURIComponent(id)}/pay`);
  }

  async billing(): Promise<{
    configured: boolean;
    account: { usable: boolean; wallets: { chain: string; address: string }[] } | null;
    connectUrl?: string;
  }> {
    return this.request('GET', '/api/v1/coinpay');
  }

  // --- recommendations --------------------------------------------------

  async recommendations(subject: { candidate?: string; org?: string }): Promise<{ items: RecommendationLike[]; total: number }> {
    const path =
      subject.candidate !== undefined && subject.candidate !== ''
        ? `/api/v1/candidates/${encodeURIComponent(subject.candidate)}/recommendations`
        : `/api/v1/orgs/${encodeURIComponent(subject.org ?? '')}/recommendations`;
    return this.request('GET', path);
  }

  async recommend(
    subject: { candidate?: string; org?: string },
    input: { body: string; relationship?: string; as?: string },
  ): Promise<{ recommendation: RecommendationLike }> {
    const path =
      subject.candidate !== undefined && subject.candidate !== ''
        ? `/api/v1/candidates/${encodeURIComponent(subject.candidate)}/recommendations`
        : `/api/v1/orgs/${encodeURIComponent(subject.org ?? '')}/recommendations`;
    return this.request('POST', path, input);
  }

  async myRecommendations(): Promise<{ received: RecommendationLike[]; given: RecommendationLike[]; pending: number }> {
    return this.request('GET', '/api/v1/me/recommendations');
  }

  async decideRecommendation(
    id: string,
    action: 'approve' | 'reject' | 'withdraw',
  ): Promise<{ recommendation?: RecommendationLike; withdrawn?: boolean }> {
    return this.request('POST', `/api/v1/recommendations/${encodeURIComponent(id)}/${action}`);
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
