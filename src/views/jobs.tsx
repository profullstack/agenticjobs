/**
 * The job list, one job, and the application form.
 */

import type { FC } from 'hono/jsx';
import type { Job, JobPage, JobQuery, Organisation } from '../schema/index.ts';
import { ago, formatSalary } from '../schema/text.ts';
import { EMPTY_QUERY, queryToParams } from '../schema/query.ts';
import { EMPLOYMENT_TYPES, SENIORITIES, WORKPLACES, AGENT_POLICIES } from '../schema/job.ts';
import { AgentPolicyBadge, Alert, Badge, Card, Empty, Field, Prose } from './layout.tsx';
import { AuthorSocial, type SocialProps } from './updates.tsx';

/** Where a job tag points. Tags accumulate, so they narrow the search. */
export function jobTagHref(tags: string[]): string {
  return tags.length === 0 ? '/' : `/?tags=${encodeURIComponent(tags.join(','))}`;
}

/**
 * Where a facet badge points.
 *
 * `remote` and `contract` are not tags, they are the workplace and employment
 * type, and each already has its own filter. Linking them as `tags=remote`
 * would search the tag list for a word that is not in it and return nothing,
 * so they link to the filter that actually holds them.
 *
 * Built from the current query rather than from scratch, so clicking one from
 * a filtered page narrows further instead of throwing the rest away. Paging
 * resets, because page 3 of the old search is not page 3 of the new one.
 */
export function facetHref(query: JobQuery | undefined, patch: Partial<JobQuery>): string {
  const params = queryToParams({ ...(query ?? EMPTY_QUERY), ...patch, offset: 0 });
  const search = params.toString();
  return search === '' ? '/' : `/?${search}`;
}

/**
 * A job, as a row.
 *
 * The whole card used to be one anchor. That is why its tags were plain text:
 * an anchor cannot contain another anchor, so a tag inside it could never be a
 * link. The title carries the link now and the card is an ordinary element, so
 * every tag on it goes somewhere, and a screen reader is offered one link per
 * destination instead of one enormous link with the destinations buried in it.
 */
export const JobCard: FC<{
  job: Job;
  origin?: string;
  instanceName?: string;
  /** Tags already being filtered on, so clicking another adds to them. */
  tags?: string[];
  /** The search this card is part of, so a facet narrows it. */
  query?: JobQuery;
}> = ({ job, origin, instanceName, tags = [], query }) => {
  const salary = formatSalary(job.salary);
  const href = origin === undefined ? `/jobs/${job.slug}` : `${origin}/jobs/${job.slug}`;
  // Tags and stack are one row of badges to a reader, so they are deduplicated
  // together rather than shown twice when a listing puts a word in both.
  const seen = new Set<string>();
  const badges = [...job.tags, ...job.stack].filter((item) => {
    const key = item.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const add = (tag: string): string[] =>
    tags.some((item) => item.toLowerCase() === tag.toLowerCase()) ? tags : [...tags, tag];

  return (
    <li>
      <div class="card job-card">
        <div class="spread">
          <h2 class="job-title">
            <a href={href}>{job.title}</a>
          </h2>
          {salary !== null && <span class="job-salary">{salary}</span>}
        </div>
        <div class="job-org">
          {job.org.name}
          {job.location !== null && ` - ${job.location}`}
        </div>
        <div class="job-meta">
          {origin === undefined ? (
            <>
              <a class="badge badge-outline" href={facetHref(query, { workplace: job.workplace })}>
                {job.workplace}
              </a>
              <a
                class="badge badge-outline"
                href={facetHref(query, { employmentType: job.employmentType })}
              >
                {job.employmentType}
              </a>
              {job.seniority !== null && (
                <a
                  class="badge badge-outline"
                  href={facetHref(query, { seniority: job.seniority })}
                >
                  {job.seniority}
                </a>
              )}
              <a class="badge-plain" href={facetHref(query, { agentPolicy: job.agentPolicy })}>
                <AgentPolicyBadge policy={job.agentPolicy} />
              </a>
            </>
          ) : (
            <>
              <Badge variant="outline">{job.workplace}</Badge>
              <Badge variant="outline">{job.employmentType}</Badge>
              {job.seniority !== null && <Badge variant="outline">{job.seniority}</Badge>}
              <AgentPolicyBadge policy={job.agentPolicy} />
            </>
          )}
          {origin === undefined
            ? badges.slice(0, 6).map((item) => (
                <a class="badge" href={jobTagHref(add(item))}>
                  {item}
                </a>
              ))
            : // A job on another board is not filterable from here, so its
              // tags stay plain rather than linking to a search of ours that
              // would return nothing.
              badges.slice(0, 6).map((item) => <Badge>{item}</Badge>)}
        </div>
        <div class="small muted">
          {ago(job.publishedAt)}
          {instanceName !== undefined && ` - on ${instanceName}`}
        </div>
      </div>
    </li>
  );
};

export const Filters: FC<{ query: JobQuery; action?: string }> = ({ query, action = '/' }) => (
  <form class="filters" method="get" action={action}>
    {/*
      * A GET form submits its own fields and nothing else, so anything set by
      * a link rather than a control is dropped the moment somebody searches.
      * Tags are set by clicking a badge, which meant searching from a tagged
      * page silently threw the tag away. These carry them through.
      */}
    {query.tags.length > 0 && <input type="hidden" name="tags" value={query.tags.join(',')} />}
    {query.salaryMin !== null && (
      <input type="hidden" name="salaryMin" value={String(query.salaryMin)} />
    )}
    {query.org !== null && <input type="hidden" name="org" value={query.org} />}
    <div class="filters-inline">
      <Field label="Search" name="q">
        <input
          class="input"
          type="search"
          id="q"
          name="q"
          value={query.q ?? ''}
          placeholder="title, stack, anything"
        />
      </Field>
      <button class="btn" type="submit">
        Search
      </button>
    </div>
    <div class="row">
      <Select name="workplace" label="Anywhere" value={query.workplace} options={WORKPLACES} />
      <Select
        name="employmentType"
        label="Any type"
        value={query.employmentType}
        options={EMPLOYMENT_TYPES}
      />
      <Select name="seniority" label="Any level" value={query.seniority} options={SENIORITIES} />
      <Select
        name="agentPolicy"
        label="Any agent policy"
        value={query.agentPolicy}
        options={AGENT_POLICIES}
      />
      <Select name="sort" label="Newest" value={query.sort === 'recent' ? null : query.sort} options={['relevant', 'salary'] as const} />
      <button class="btn btn-secondary btn-sm" type="submit">
        Apply filters
      </button>
    </div>
  </form>
);

const Select: FC<{
  name: string;
  label: string;
  value: string | null;
  options: readonly string[];
}> = ({ name, label, value, options }) => (
  <select class="select" name={name} aria-label={label} style="width:auto;min-width:9rem">
    <option value="">{label}</option>
    {options.map((option) => (
      <option value={option} selected={value === option}>
        {option}
      </option>
    ))}
  </select>
);

export const Pagination: FC<{ page: JobPage<unknown>; query: JobQuery; base?: string }> = ({
  page,
  query,
  base = '/',
}) => {
  const previous = Math.max(0, query.offset - query.limit);
  const next = query.offset + query.limit;
  if (page.total <= query.limit) return null;
  const link = (offset: number): string => {
    const params = queryToParams({ ...query, offset });
    const search = params.toString();
    return search === '' ? base : `${base}?${search}`;
  };
  return (
    <nav class="pagination" aria-label="Pages">
      {query.offset > 0 && (
        <a class="btn btn-secondary btn-sm" href={link(previous)}>
          Previous
        </a>
      )}
      <span class="small muted" style="align-self:center">
        {query.offset + 1}-{Math.min(page.total, next)} of {page.total}
      </span>
      {next < page.total && (
        <a class="btn btn-secondary btn-sm" href={link(next)}>
          Next
        </a>
      )}
    </nav>
  );
};

export const InstallStrip: FC<{ publicUrl: string }> = ({ publicUrl }) => (
  <div class="install-strip">
    <div>
      <strong>Use it from a terminal.</strong>{' '}
      <span class="muted small">Search, apply and post without opening a page.</span>
    </div>
    <pre class="code-block install-line">curl -fsSL {publicUrl}/install.sh | sh</pre>
    <p class="small muted install-note">
      No root, nothing outside your home directory. Then{' '}
      <code>agenticjobs signup</code>. Updating is <code>agenticjobs update</code> and removing
      is <code>agenticjobs uninstall</code>. <a href="/docs">What it installs</a>.
    </p>
  </div>
);

export const JobList: FC<{
  page: JobPage<Job>;
  query: JobQuery;
  boardName: string;
  tagline: string;
  publicUrl: string;
}> = ({ page, query, boardName, tagline, publicUrl }) => (
  <div class="stack">
    <div>
      <h1>{boardName}</h1>
      <p class="lede">{tagline}</p>
    </div>
    <Filters query={query} />
    {query.tags.length > 0 && (
      <p class="row" style="align-items:center;flex-wrap:wrap;gap:.5rem">
        <span class="small muted">Tagged:</span>
        {query.tags.map((tag) => (
          <a
            class="badge"
            title={`Remove ${tag}`}
            href={jobTagHref(query.tags.filter((other) => other !== tag))}
          >
            {tag} x
          </a>
        ))}
        <a class="small" href="/">
          Clear
        </a>
        <a class="small" href={`/feed?tags=${encodeURIComponent(query.tags.join(','))}`}>
          Subscribe
        </a>
      </p>
    )}
    <InstallStrip publicUrl={publicUrl} />
    {page.items.length === 0 ? (
      <Empty>
        <p>Nothing matches that yet.</p>
        <p class="small">
          This board only shows jobs posted to it, so an empty result means nobody has posted one
          like that - not that the search failed.
        </p>
      </Empty>
    ) : (
      <ul class="job-list">
        {page.items.map((job) => (
          <JobCard job={job} tags={query.tags} query={query} />
        ))}
      </ul>
    )}
    <Pagination page={page} query={query} />
    <p class="small muted">
      This search is a feed: <a href="/feed">/feed</a>, and <code>/feed?tags=react,go</code> for
      any set of tags. People are at <a href="/candidates">/candidates</a>, with{' '}
      <a href="/candidates/feed">/candidates/feed</a>. What everyone is up to between
      listings is at <a href="/updates">/updates</a>.
    </p>
  </div>
);

export const JobDetail: FC<{
  job: Job;
  html: string;
  publicUrl: string;
  applied?: boolean;
  problems?: { field: string; message: string }[];
  values?: Record<string, string>;
  signedIn: boolean;
  resumes?: { slug: string; title: string }[];
}> = ({ job, html, publicUrl, applied, problems, values, signedIn, resumes }) => {
  const salary = formatSalary(job.salary);
  return (
    <div class="grid-2">
      <article class="stack">
        <div>
          <h1>{job.title}</h1>
          <p class="lede">
            <a href={`/employers/${job.org.slug}`}>{job.org.name}</a>
            {job.location !== null && ` - ${job.location}`}
          </p>
        </div>
        <div class="job-meta">
          <a class="badge badge-outline" href={facetHref(undefined, { workplace: job.workplace })}>
            {job.workplace}
          </a>
          <a
            class="badge badge-outline"
            href={facetHref(undefined, { employmentType: job.employmentType })}
          >
            {job.employmentType}
          </a>
          {job.seniority !== null && (
            <a class="badge badge-outline" href={facetHref(undefined, { seniority: job.seniority })}>
              {job.seniority}
            </a>
          )}
          <a class="badge-plain" href={facetHref(undefined, { agentPolicy: job.agentPolicy })}>
            <AgentPolicyBadge policy={job.agentPolicy} />
          </a>
          {salary !== null && <Badge variant="primary">{salary}</Badge>}
        </div>
        <Prose html={html} />
        {job.requirements.length > 0 && (
          <section>
            <h2>What they are asking for</h2>
            <ul>
              {job.requirements.map((item) => (
                <li>{item}</li>
              ))}
            </ul>
          </section>
        )}
        {job.responsibilities.length > 0 && (
          <section>
            <h2>What you would do</h2>
            <ul>
              {job.responsibilities.map((item) => (
                <li>{item}</li>
              ))}
            </ul>
          </section>
        )}
        {(job.stack.length > 0 || job.tags.length > 0) && (
          <section>
            <h2>Stack and tags</h2>
            <p class="small muted">Each one finds the other jobs asking for it.</p>
            <div class="row" style="flex-wrap:wrap;gap:.35rem">
              {[...job.stack, ...job.tags]
                .filter((item, index, all) => all.findIndex((other) => other.toLowerCase() === item.toLowerCase()) === index)
                .map((item) => (
                  <a class="badge" href={jobTagHref([item])}>
                    {item}
                  </a>
                ))}
            </div>
          </section>
        )}
        <div id="apply">
          <h2>Apply</h2>
          {applied === true ? (
            <Alert variant="success">
              <strong>Sent.</strong> {job.org.name} has your application.
            </Alert>
          ) : (
            <ApplyForm
              job={job}
              problems={problems ?? []}
              values={values ?? {}}
              signedIn={signedIn}
              resumes={resumes ?? []}
            />
          )}
        </div>
      </article>

      <aside class="stack">
        <Card>
          <div class="card-header">
            <h2 class="card-title">For agents</h2>
            <p class="card-description">
              This job is machine readable. No scraping, no rendering.
            </p>
          </div>
          <p class="small muted">The form above, as data:</p>
          <pre class="code-block">
            GET {publicUrl}/api/v1/jobs/{job.slug}/apply-schema
          </pre>
          <p class="small muted">Or over MCP, with the board connected:</p>
          <pre class="code-block">apply_to_job(slug: "{job.slug}")</pre>
          <p class="small muted">
            Policy on this listing: <strong>{job.agentPolicy}</strong>.
          </p>
        </Card>
        <Card>
          <div class="card-header">
            <h2 class="card-title">{job.org.name}</h2>
          </div>
          {job.org.description !== null && <p class="small">{job.org.description}</p>}
          {job.org.website !== null && (
            <p class="small">
              <a href={job.org.website} rel="nofollow noopener">
                {job.org.website.replace(/^https?:\/\//, '')}
              </a>
            </p>
          )}
          <p class="small muted">Posted {ago(job.publishedAt)}</p>
        </Card>
      </aside>
    </div>
  );
};

const ApplyForm: FC<{
  job: Job;
  problems: { field: string; message: string }[];
  values: Record<string, string>;
  signedIn: boolean;
  resumes: { slug: string; title: string }[];
}> = ({ job, problems, values, signedIn, resumes }) => {
  const errorFor = (name: string): string | undefined =>
    problems.find((problem) => problem.field === name)?.message;

  return (
    <form class="stack" method="post" action={`/jobs/${job.slug}/apply`} novalidate>
      {problems.length > 0 && (
        <Alert variant="error">
          {problems.length === 1 ? 'One answer needs fixing.' : `${problems.length} answers need fixing.`}
        </Alert>
      )}
      {job.apply.schema.fields.map((field) => (
        <Field
          label={field.label}
          name={field.name}
          hint={field.help}
          error={errorFor(field.name)}
        >
          {field.type === 'textarea' ? (
            <textarea
              class="textarea"
              id={field.name}
              name={field.name}
              required={field.required}
              maxlength={field.maxLength}
            >
              {values[field.name] ?? ''}
            </textarea>
          ) : field.type === 'select' ? (
            <select class="select" id={field.name} name={field.name} required={field.required}>
              <option value="">Choose one</option>
              {(field.options ?? []).map((option) => (
                <option value={option} selected={values[field.name] === option}>
                  {option}
                </option>
              ))}
            </select>
          ) : (
            <input
              class="input"
              type={field.type === 'file' ? 'text' : field.type}
              id={field.name}
              name={field.name}
              value={values[field.name] ?? ''}
              required={field.required}
              maxlength={field.maxLength}
            />
          )}
        </Field>
      ))}

      <Field
        label="Resume"
        name="resume"
        hint="Markdown, in the OpenResume.md convention. Paste it, or pick one you have saved."
        error={errorFor('resume')}
      >
        {signedIn && resumes.length > 0 && (
          <select class="select" name="resumeSlug" style="margin-bottom:.5rem">
            <option value="">Paste one below instead</option>
            {resumes.map((resume) => (
              <option value={resume.slug}>{resume.title}</option>
            ))}
          </select>
        )}
        <textarea class="textarea code" id="resume" name="resume" placeholder="# Your Name">
          {values['resume'] ?? ''}
        </textarea>
      </Field>

      {job.agentPolicy !== 'human-only' && (
        <fieldset>
          <legend>Did an agent write this?</legend>
          <p class="hint" style="margin-top:0">
            {job.agentPolicy === 'disclose'
              ? 'This employer asks you to say so. Saying so is not held against you; not saying so is.'
              : 'This employer is fine either way. Answer if you like.'}
          </p>
          <Field label="Which agent" name="agent.name">
            <input
              class="input"
              type="text"
              id="agent.name"
              name="agent.name"
              value={values['agent.name'] ?? ''}
              placeholder="e.g. claude-opus-5 via agenticjobs-mcp"
            />
          </Field>
          <label class="row small" style="margin-top:.5rem">
            <input type="checkbox" name="agent.supervised" value="true" />
            A person read it before it was sent
          </label>
        </fieldset>
      )}

      <button class="btn btn-block" type="submit">
        Send application
      </button>
    </form>
  );
};

export const EmployerList: FC<{ orgs: Organisation[] }> = ({ orgs }) => (
  <div class="stack">
    <h1>Employers</h1>
    <p class="lede">Everyone with an open listing on this board.</p>
    {orgs.length === 0 ? (
      <Empty>No employers with open listings yet.</Empty>
    ) : (
      <ul class="job-list">
        {orgs.map((org) => (
          <li>
            <a class="card card-link" href={`/employers/${org.slug}`}>
              <h2 class="card-title">{org.name}</h2>
              {org.description !== null && <p class="card-description">{org.description}</p>}
            </a>
          </li>
        ))}
      </ul>
    )}
  </div>
);

export const EmployerDetail: FC<{
  org: Organisation;
  page: JobPage<Job>;
  query: JobQuery;
  /** Follow, updates and the composer. Absent on a board with none of it. */
  social?: SocialProps;
}> = ({ org, page, query, social }) => (
  <div class="stack">
    <div>
      <h1>{org.name}</h1>
      {org.website !== null && (
        <p class="lede">
          <a href={org.website} rel="nofollow noopener">
            {org.website.replace(/^https?:\/\//, '')}
          </a>
        </p>
      )}
    </div>
    {org.description !== null && <p>{org.description}</p>}
    {social !== undefined && <AuthorSocial {...social} />}
    <h2>
      {page.total} open {page.total === 1 ? 'role' : 'roles'}
    </h2>
    {page.items.length === 0 ? (
      <Empty>Nothing open right now.</Empty>
    ) : (
      <ul class="job-list">
        {page.items.map((job) => (
          <JobCard job={job} />
        ))}
      </ul>
    )}
    <Pagination page={page} query={query} base={`/employers/${org.slug}`} />
  </div>
);
