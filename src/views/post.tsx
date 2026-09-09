/**
 * Posting a job, and managing one after it is posted.
 */

import type { FC } from 'hono/jsx';
import type { Application, Job, Organisation } from '../schema/index.ts';
import {
  AGENT_POLICIES,
  APPLICATION_DECISIONS,
  EMPLOYMENT_TYPES,
  SALARY_PERIODS,
  SENIORITIES,
  WORKPLACES,
  type ApplicationDecision,
} from '../schema/job.ts';
import { ago } from '../schema/text.ts';
import { Alert, Badge, Card, Empty, Field, Prose } from './layout.tsx';

export const PostJobPage: FC<{
  orgs: Organisation[];
  error?: string;
  values?: Record<string, string>;
  /** True when this board has a model key, so the brief box is worth showing. */
  canDraft?: boolean;
  /** What was typed into it, so a failed draft does not lose the brief. */
  brief?: string;
}> = ({ orgs, error, values = {}, canDraft = false, brief = '' }) => (
  <div class="grid-2">
    <div class="stack">
      <h1>Post a job</h1>
      <p class="lede">
        It stays a draft until you publish it, so nothing goes live by accident.
      </p>
      {error !== undefined && <Alert variant="error">{error}</Alert>}

      {orgs.length === 0 ? (
        <Alert variant="info">
          Add the employer first: <a href="/me/employers/new">add an employer</a>.
        </Alert>
      ) : (
        <>
        {canDraft && (
          <form class="stack-sm" method="post" action="/post/draft">
            <Field
              label="Write it with an agent"
              name="brief"
              hint="A sentence or two is enough. It fills the form in below and posts nothing: you read and edit every field, and it still stays a draft after that."
            >
              <textarea
                class="textarea"
                id="brief"
                name="brief"
                rows={3}
                placeholder="Senior Go engineer, remote in European timezones, to own our payments service."
              >
                {brief}
              </textarea>
            </Field>
            <div class="row">
              <button class="btn btn-secondary" type="submit">
                Draft it
              </button>
              <span class="small muted">
                It will not invent a salary. Pay comes from what you write here, or stays empty.
              </span>
            </div>
          </form>
        )}

        <form class="stack" method="post" action="/post">
          <Field label="Employer" name="org">
            <select class="select" id="org" name="org" required>
              {orgs.map((org) => (
                <option value={org.slug} selected={values['org'] === org.slug}>
                  {org.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Title" name="title">
            <input
              class="input"
              type="text"
              id="title"
              name="title"
              value={values['title'] ?? ''}
              required
              maxlength={140}
            />
          </Field>

          <Field
            label="Description"
            name="description"
            hint="Markdown. Headings, lists, links and tables all work."
          >
            <textarea class="textarea" id="description" name="description" required>
              {values['description'] ?? ''}
            </textarea>
          </Field>

          <div class="row">
            <Field label="Type" name="employmentType">
              <select class="select" id="employmentType" name="employmentType">
                {EMPLOYMENT_TYPES.map((type) => (
                  <option value={type} selected={values['employmentType'] === type}>
                    {type}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Where" name="workplace">
              <select class="select" id="workplace" name="workplace">
                {WORKPLACES.map((place) => (
                  <option value={place} selected={values['workplace'] === place}>
                    {place}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Level" name="seniority">
              <select class="select" id="seniority" name="seniority">
                <option value="">unspecified</option>
                {SENIORITIES.map((level) => (
                  <option value={level} selected={values['seniority'] === level}>
                    {level}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="Location" name="location" hint='Free text: "Berlin", "US timezones".'>
            <input class="input" type="text" id="location" name="location" value={values['location'] ?? ''} />
          </Field>

          <fieldset>
            <legend>Pay</legend>
            <p class="hint" style="margin-top:0">
              A listing without a number gets fewer and worse applications. Say the range.
            </p>
            <p class="hint" style="margin-top:0">
              <label>
                <input
                  type="checkbox"
                  name="salaryUnpaid"
                  value="on"
                  checked={values['salaryUnpaid'] === 'on'}
                />{' '}
                This role is unpaid
              </label>{' '}
              An unpaid internship or volunteer post says so here. It reads as Unpaid rather
              than as a listing whose author skipped the question, and any range below is
              ignored.
            </p>
            <div class="row">
              <input class="input" type="number" name="salaryMin" placeholder="from" style="width:8rem" value={values['salaryMin'] ?? ''} />
              <input class="input" type="number" name="salaryMax" placeholder="to" style="width:8rem" value={values['salaryMax'] ?? ''} />
              <input class="input" type="text" name="salaryCurrency" placeholder="USD" maxlength={3} style="width:6rem" value={values['salaryCurrency'] ?? 'USD'} />
              <select class="select" name="salaryPeriod" style="width:auto">
                {SALARY_PERIODS.map((period) => (
                  <option value={period} selected={(values['salaryPeriod'] ?? 'year') === period}>
                    per {period}
                  </option>
                ))}
              </select>
            </div>
          </fieldset>

          <Field label="Stack" name="stack" hint="Comma separated. Also what people search on.">
            <input class="input" type="text" id="stack" name="stack" value={values['stack'] ?? ''} placeholder="typescript, postgres, hono" />
          </Field>

          <Field label="Tags" name="tags" hint="Comma separated.">
            <input class="input" type="text" id="tags" name="tags" value={values['tags'] ?? ''} placeholder="backend, remote-first" />
          </Field>

          <fieldset>
            <legend>Agent policy</legend>
            <p class="hint" style="margin-top:0">
              Required. Candidates increasingly use an agent to write applications; this says where
              you stand, instead of them finding out by being rejected without a reason.
            </p>
            {AGENT_POLICIES.map((policy) => (
              <label class="row" style="align-items:flex-start;margin-top:.5rem">
                <input
                  type="radio"
                  name="agentPolicy"
                  value={policy}
                  checked={(values['agentPolicy'] ?? 'disclose') === policy}
                  style="margin-top:.35rem"
                />
                <span>
                  <strong>{POLICY_LABEL[policy]}</strong>
                  <br />
                  <span class="hint">{POLICY_HELP[policy]}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <fieldset>
            <legend>How to apply</legend>
            <p class="small muted">
              Applications are taken on this board, so an agent can complete one without a
              browser and you get every application in one place. There is no offsite link.
            </p>
          </fieldset>

          <button class="btn btn-block" type="submit">
            Create draft
          </button>
        </form>
        </>
      )}
    </div>

    <aside class="stack">
      <Card>
        <div class="card-header">
          <h2 class="card-title">Or post it from anywhere else</h2>
        </div>
        <pre class="code-block">agenticjobs post --org acme job.md</pre>
        <p class="small muted">Over MCP, with the board connected:</p>
        <pre class="code-block">post_job(org: "acme", ...)</pre>
        <p class="small muted">Through myna, alongside the rest of a launch:</p>
        <pre class="code-block">myna jobs post --to jobs:acme job.md</pre>
      </Card>
    </aside>
  </div>
);

const POLICY_LABEL: Record<string, string> = {
  welcome: 'Agents welcome',
  disclose: 'Agents, if disclosed',
  'human-only': 'Written by a person',
};

const POLICY_HELP: Record<string, string> = {
  welcome: 'You do not mind how the application was written. Nothing is asked.',
  disclose:
    'Fine by you, as long as it says so. The application carries a structured disclosure you can filter on.',
  'human-only':
    'You want a person to have written it. This is a request the board states plainly; it cannot verify it, and says so.',
};

/**
 * What the button says, as against what the column stores.
 *
 * The status is a state the application is in; the button is an act the
 * employer is about to perform, and labelling a button with the noun makes
 * the reader work out the verb. Nothing here notifies the candidate, so no
 * label may imply a message was sent.
 */
const DECISION_VERBS: Record<ApplicationDecision, string> = {
  reviewing: 'Reviewing',
  rejected: 'Reject',
  hired: 'Hire',
};

export const ManageJobPage: FC<{
  job: Job;
  html: string;
  applications: (Application & { resume: string | null; resumeTitle: string | null })[];
  publicUrl: string;
}> = ({ job, html, applications, publicUrl }) => (
  <div class="stack">
    <div class="spread">
      <div>
        <h1>{job.title}</h1>
        <p class="lede">
          {job.org.name} - <Badge variant={job.status === 'published' ? 'primary' : 'outline'}>{job.status}</Badge>
        </p>
      </div>
      <div class="row">
        {job.status !== 'published' ? (
          <form method="post" action={`/me/jobs/${job.slug}/publish`}>
            <button class="btn" type="submit">
              Publish
            </button>
          </form>
        ) : (
          <>
            <a class="btn btn-secondary" href={`/jobs/${job.slug}`}>
              View live
            </a>
            <form method="post" action={`/me/jobs/${job.slug}/close`}>
              <button class="btn btn-secondary" type="submit">
                Close
              </button>
            </form>
          </>
        )}
      </div>
    </div>

    {job.status === 'draft' && (
      <Alert variant="info">
        This is a draft. It is not in the list, not in the feed, not in the API and not visible to
        any other instance until you publish it.
      </Alert>
    )}

    <section class="stack">
      <h2>
        {applications.length} {applications.length === 1 ? 'application' : 'applications'}
      </h2>
      {applications.length === 0 ? (
        <Empty>Nobody yet.</Empty>
      ) : (
        applications.map((application) => (
          <Card>
            <div class="spread">
              <h3 class="card-title">
                {application.answers['name'] ?? 'Someone'}{' '}
                {application.answers['email'] !== undefined && (
                  <a class="small" href={`mailto:${application.answers['email']}`}>
                    {application.answers['email']}
                  </a>
                )}
              </h3>
              <span class="row">
                {application.agent !== null && (
                  <Badge variant="disclose">
                    agent: {application.agent.name}
                    {application.agent.supervised ? ', supervised' : ''}
                  </Badge>
                )}
                <Badge variant={application.status === 'hired' ? 'primary' : 'outline'}>
                  {application.status}
                </Badge>
                <Badge variant="outline">{ago(application.createdAt)}</Badge>
              </span>
            </div>
            {Object.entries(application.answers)
              .filter(([key]) => !['name', 'email'].includes(key))
              .map(([key, value]) => (
                <p class="small">
                  <strong>{key}:</strong> {value}
                </p>
              ))}
            {application.resume !== null && (
              <details>
                <summary class="small">Resume</summary>
                <Prose html={application.resume} />
              </details>
            )}
            <div class="row">
              {APPLICATION_DECISIONS.filter((decision) => decision !== application.status).map(
                (decision) => (
                  <form
                    method="post"
                    action={`/me/jobs/${job.slug}/applications/${application.id}/decision`}
                  >
                    <input type="hidden" name="status" value={decision} />
                    <button class="btn btn-secondary btn-sm" type="submit">
                      {DECISION_VERBS[decision]}
                    </button>
                  </form>
                ),
              )}
            </div>
          </Card>
        ))
      )}
    </section>

    <details>
      <summary>The listing as it stands</summary>
      <Prose html={html} />
      <p class="small muted">
        Machine readable at <code>{publicUrl}/api/v1/jobs/{job.slug}</code>
      </p>
    </details>
  </div>
);

export const NewEmployerPage: FC<{ error?: string }> = ({ error }) => (
  <div style="max-width:32rem;margin:0 auto">
    <div class="stack">
      <h1>Add an employer</h1>
      <p class="lede">You post jobs under an employer, not under your own name.</p>
      {error !== undefined && <Alert variant="error">{error}</Alert>}
      <Card>
        <form class="stack" method="post" action="/me/employers/new">
          <Field label="Name" name="name">
            <input class="input" type="text" id="name" name="name" required maxlength={120} />
          </Field>
          <Field label="Website" name="website">
            <input class="input" type="url" id="website" name="website" placeholder="https://" />
          </Field>
          <Field label="About" name="description" hint="Markdown.">
            <textarea class="textarea" id="description" name="description"></textarea>
          </Field>
          <button class="btn btn-block" type="submit">
            Add employer
          </button>
        </form>
      </Card>
    </div>
  </div>
);
