/**
 * What a job is, on this board and on every other one.
 *
 * These shapes are the contract between the seven front doors — pages, REST,
 * MCP, CLI, TUI, desktop and the directory — so a field that is not here is a
 * field one surface has and the others do not. They are also the federation
 * contract: an instance reading another instance's listings parses exactly
 * this, which is why the enumerations are string unions with runtime guards
 * rather than TypeScript enums nobody else can see.
 */

export const EMPLOYMENT_TYPES = [
  'full-time',
  'part-time',
  'contract',
  'internship',
  'temporary',
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const WORKPLACES = ['remote', 'hybrid', 'onsite'] as const;
export type Workplace = (typeof WORKPLACES)[number];

export const SENIORITIES = ['intern', 'junior', 'mid', 'senior', 'staff', 'principal', 'lead'] as const;
export type Seniority = (typeof SENIORITIES)[number];

export const SALARY_PERIODS = ['hour', 'day', 'week', 'month', 'year'] as const;
export type SalaryPeriod = (typeof SALARY_PERIODS)[number];

export const JOB_STATUSES = ['draft', 'published', 'closed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * Where an employer stands on candidates who let an agent do the work.
 *
 * This board exists because that question currently gets answered by silent
 * rejection. Making it a required field means a listing has to say, and an
 * agent reading the listing can decide whether to bother.
 *
 * - `welcome`     agent-written applications are fine, no disclosure asked.
 * - `disclose`    fine, but say so; the application carries an `agent` block.
 * - `human-only`  the employer wants a person to have written it.
 */
export const AGENT_POLICIES = ['welcome', 'disclose', 'human-only'] as const;
export type AgentPolicy = (typeof AGENT_POLICIES)[number];

export interface Salary {
  min: number | null;
  max: number | null;
  currency: string;
  period: SalaryPeriod;
  equity: string | null;
}

export interface Organisation {
  id: string;
  slug: string;
  name: string;
  website: string | null;
  logoUrl: string | null;
  description: string | null;
  createdAt: string;
}

export interface Job {
  id: string;
  slug: string;
  org: Organisation;
  title: string;
  /** Markdown. Rendered on pages, handed over raw everywhere else. */
  description: string;
  employmentType: EmploymentType;
  workplace: Workplace;
  seniority: Seniority | null;
  /** Free text ("Berlin", "US timezones"). `null` when workplace is remote and unrestricted. */
  location: string | null;
  /** ISO 3166-1 alpha-2 codes a remote hire may sit in. Empty means anywhere. */
  remoteRegions: string[];
  salary: Salary;
  tags: string[];
  stack: string[];
  requirements: string[];
  responsibilities: string[];
  agentPolicy: AgentPolicy;
  apply: ApplyMethod;
  status: JobStatus;
  publishedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * How to apply.
 *
 * `board` is the one that matters: it means the application is a POST to this
 * instance against a published schema, which is the only variant an agent can
 * complete without a browser. The other two exist because employers ask for
 * them, and a listing that lies about having them is worse than one that says
 * so plainly.
 */
export type ApplyMethod =
  | { via: 'board'; schema: ApplySchema }
  | { via: 'url'; url: string }
  | { via: 'email'; email: string };

/**
 * The shape of an application, published with the job.
 *
 * A subset of JSON Schema on purpose. It is small enough to render as an HTML
 * form and small enough for a model to fill in without a validator, and both
 * of those matter more here than expressiveness.
 */
export interface ApplySchema {
  fields: ApplyField[];
}

export interface ApplyField {
  name: string;
  label: string;
  type: 'text' | 'textarea' | 'email' | 'url' | 'select' | 'file';
  required: boolean;
  /** Only for `select`. */
  options?: string[];
  /** Shown under the input, and included in the machine-readable schema. */
  help?: string;
  maxLength?: number;
}

/** Every job gets these unless the employer replaces them. */
export const DEFAULT_APPLY_SCHEMA: ApplySchema = {
  fields: [
    { name: 'name', label: 'Your name', type: 'text', required: true, maxLength: 120 },
    { name: 'email', label: 'Email', type: 'email', required: true, maxLength: 200 },
    { name: 'url', label: 'Portfolio, GitHub or LinkedIn', type: 'url', required: false, maxLength: 500 },
    {
      name: 'cover',
      label: 'Why you',
      type: 'textarea',
      required: true,
      maxLength: 5000,
      help: 'Plain text. Short is fine.',
    },
  ],
};

/**
 * `draft` is the candidate-side control point: an agent prepared it and the
 * person has not released it yet. An employer never sees a draft.
 */
export const APPLICATION_STATUSES = ['draft', 'new', 'reviewing', 'rejected', 'hired'] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export interface Application {
  id: string;
  jobId: string;
  /** Answers keyed by `ApplyField.name`. */
  answers: Record<string, string>;
  /**
   * Present when the applicant declared an agent wrote it. Never inferred:
   * guessing would make the disclosure worthless in both directions.
   */
  agent: AgentDisclosure | null;
  status: ApplicationStatus;
  /** Null while it is still a draft nobody has sent. */
  submittedAt: string | null;
  createdAt: string;
}

export interface AgentDisclosure {
  /** Free text, e.g. "claude-opus-5 via agenticjobs-mcp". */
  name: string;
  /** Whether a human read it before it was sent. */
  supervised: boolean;
}

export function isEmploymentType(value: unknown): value is EmploymentType {
  return typeof value === 'string' && (EMPLOYMENT_TYPES as readonly string[]).includes(value);
}
export function isWorkplace(value: unknown): value is Workplace {
  return typeof value === 'string' && (WORKPLACES as readonly string[]).includes(value);
}
export function isSeniority(value: unknown): value is Seniority {
  return typeof value === 'string' && (SENIORITIES as readonly string[]).includes(value);
}
export function isSalaryPeriod(value: unknown): value is SalaryPeriod {
  return typeof value === 'string' && (SALARY_PERIODS as readonly string[]).includes(value);
}
export function isAgentPolicy(value: unknown): value is AgentPolicy {
  return typeof value === 'string' && (AGENT_POLICIES as readonly string[]).includes(value);
}
export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && (JOB_STATUSES as readonly string[]).includes(value);
}
