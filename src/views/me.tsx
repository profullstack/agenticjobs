/**
 * Your side of the board: employers you can post under, jobs you have posted,
 * applications you have sent, and your resumes.
 */

import type { FC } from 'hono/jsx';
import type { Job, Organisation } from '../schema/index.ts';
import type { Resume } from '../core/resumes.ts';
import type { Viewer } from '../core/auth.ts';
import { ago } from '../schema/text.ts';
import { Alert, Badge, Card, Empty, Field, Prose } from './layout.tsx';

export const MePage: FC<{
  viewer: Viewer;
  orgs: Organisation[];
  jobs: Job[];
  resumes: Resume[];
  applications: { jobTitle: string; jobSlug: string; status: string; createdAt: string }[];
}> = ({ viewer, orgs, jobs, resumes, applications }) => (
  <div class="stack">
    <div>
      <h1>You</h1>
      <p class="lede">{viewer.email}</p>
    </div>

    <section class="stack">
      <div class="spread">
        <h2>Resumes</h2>
        <a class="btn btn-sm" href="/me/resumes/new">
          New resume
        </a>
      </div>
      <p class="small muted">
        Markdown, in the OpenResume.md convention. Upload a PDF or a Word file and it is converted
        for you; what you keep is the Markdown.
      </p>
      {resumes.length === 0 ? (
        <Empty>No resumes yet.</Empty>
      ) : (
        <ul class="job-list">
          {resumes.map((resume) => (
            <li>
              <a class="card card-link" href={`/me/resumes/${resume.slug}`}>
                <div class="spread">
                  <h3 class="card-title">{resume.title}</h3>
                  <Badge variant={resume.visibility === 'private' ? 'outline' : 'primary'}>
                    {resume.visibility}
                  </Badge>
                </div>
                <p class="small muted">
                  Updated {ago(resume.updatedAt)}
                  {resume.sourceName !== null && ` - from ${resume.sourceName}`}
                </p>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>

    <section class="stack">
      <div class="spread">
        <h2>Employers</h2>
        <a class="btn btn-sm btn-secondary" href="/me/employers/new">
          Add an employer
        </a>
      </div>
      {orgs.length === 0 ? (
        <Empty>
          You cannot post a job until you add the employer it is for.
        </Empty>
      ) : (
        <div class="row">
          {orgs.map((org) => (
            <a class="badge badge-primary" href={`/employers/${org.slug}`}>
              {org.name}
            </a>
          ))}
        </div>
      )}
    </section>

    <section class="stack">
      <div class="spread">
        <h2>Your listings</h2>
        {orgs.length > 0 && (
          <a class="btn btn-sm" href="/post">
            Post a job
          </a>
        )}
      </div>
      {jobs.length === 0 ? (
        <Empty>Nothing posted yet.</Empty>
      ) : (
        <ul class="job-list">
          {jobs.map((job) => (
            <li>
              <a class="card card-link" href={`/me/jobs/${job.slug}`}>
                <div class="spread">
                  <h3 class="card-title">{job.title}</h3>
                  <Badge variant={job.status === 'published' ? 'primary' : 'outline'}>
                    {job.status}
                  </Badge>
                </div>
                <p class="small muted">
                  {job.org.name} - {job.status === 'published' ? ago(job.publishedAt) : 'not live'}
                </p>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>

    <section class="stack">
      <h2>Applications you have sent</h2>
      {applications.length === 0 ? (
        <Empty>None yet.</Empty>
      ) : (
        <ul class="job-list">
          {applications.map((application) => (
            <li>
              <a class="card card-link" href={`/jobs/${application.jobSlug}`}>
                <div class="spread">
                  <h3 class="card-title">{application.jobTitle}</h3>
                  <Badge variant="outline">{application.status}</Badge>
                </div>
                <p class="small muted">Sent {ago(application.createdAt)}</p>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>

    <Card>
      <div class="card-header">
        <h2 class="card-title">Terminals and agents</h2>
        <p class="card-description">
          <code>agenticjobs login</code> asks this board for a code; approve it at{' '}
          <a href="/device">/device</a>. A terminal token can read and apply, and is never an
          administrator.
        </p>
      </div>
      {/* Hidden until the script confirms the browser has WebAuthn, so nobody
          is offered a sign-in method that will throw the moment they click. */}
      <button class="btn btn-secondary btn-sm" type="button" id="passkey-add" hidden>
        Add a passkey to this account
      </button>
      <p class="small error-text" id="passkey-add-error" hidden></p>
      <form method="post" action="/logout" style="margin-top:.75rem">
        <button class="btn btn-ghost btn-sm" type="submit">
          Sign out of this browser
        </button>
      </form>
    </Card>
  </div>
);

export const ResumeEditor: FC<{
  resume: Resume | null;
  html: string;
  warnings: string[];
  error?: string;
  saved?: boolean;
}> = ({ resume, html, warnings, error, saved }) => (
  /*
   * The preview sits below the editor, not beside it.
   *
   * It was in the sidebar, which is 20rem wide, and a resume rendered into
   * 20rem is a column of two-word lines. A document needs the width of the
   * page to be read at all, and the things that genuinely are short, the
   * warnings and the share link, are what belong next to the form.
   */
  <div class="stack">
    <div class="grid-2">
      <div class="stack">
      <h1>{resume === null ? 'New resume' : resume.title}</h1>
      {error !== undefined && <Alert variant="error">{error}</Alert>}
      {saved === true && <Alert variant="success">Saved.</Alert>}

      {resume === null && (
        <Card>
          <div class="card-header">
            <h2 class="card-title">Start from a file</h2>
            <p class="card-description">
              PDF, Word, plain text or Markdown. It is converted to Markdown you can then edit - the
              Markdown is what gets kept and what employers read.
            </p>
          </div>
          <form method="post" action="/me/resumes/import" enctype="multipart/form-data" class="stack">
            <input
              class="input"
              type="file"
              name="file"
              accept=".md,.markdown,.txt,.pdf,.docx,.doc,.odt,.rtf"
              required
            />
            <button class="btn" type="submit">
              Convert to Markdown
            </button>
          </form>
        </Card>
      )}

      <form
        class="stack"
        method="post"
        action={resume === null ? '/me/resumes/new' : `/me/resumes/${resume.slug}`}
      >
        <Field label="Title" name="title" hint="Only you see this. Name it after the kind of role.">
          <input
            class="input"
            type="text"
            id="title"
            name="title"
            value={resume?.title ?? ''}
            placeholder="Backend, senior"
          />
        </Field>
        <Field
          label="Resume"
          name="markdown"
          hint="OpenResume.md: an h1 with your name, a bullet list of contact details, then ## sections."
        >
          <textarea class="textarea code" id="markdown" name="markdown" spellcheck={false}>
            {resume?.markdown ?? ''}
          </textarea>
        </Field>
        <Field
          label="Who can see it"
          name="visibility"
          hint="Sharing puts your resume, including the contact details in it, on a page anyone can open."
        >
          <select class="select" id="visibility" name="visibility">
            <option value="private" selected={resume?.visibility === 'private'}>
              Private - only you, and employers you apply to
            </option>
            <option value="link" selected={resume?.visibility === 'link'}>
              Anyone with the link - not listed anywhere
            </option>
            <option value="public" selected={resume?.visibility === 'public'}>
              Public - listed in Candidates
            </option>
          </select>
        </Field>
        <div class="row">
          <button class="btn" type="submit">
            Save
          </button>
          {resume !== null && (
            <a class="btn btn-secondary" href={`/api/v1/resumes/${resume.slug}`}>
              As JSON
            </a>
          )}
        </div>
      </form>

      {resume !== null && (
        <form method="post" action={`/me/resumes/${resume.slug}/delete`}>
          <button class="btn btn-destructive btn-sm" type="submit">
            Delete this resume
          </button>
        </form>
      )}
    </div>

      <aside class="stack">
        {resume !== null && resume.visibility !== 'private' && resume.publicSlug !== null && (
        <Card>
          <div class="card-header">
            <h2 class="card-title">
              {resume.visibility === 'public' ? 'Listed in Candidates' : 'Shared by link'}
            </h2>
            <p class="card-description">
              {resume.visibility === 'public'
                ? 'Anyone can find this from the candidate directory.'
                : 'Anyone with this address can read it. It is not listed.'}
            </p>
          </div>
          <p class="small">
            <a href={`/candidates/${resume.publicSlug}`}>/candidates/{resume.publicSlug}</a>
          </p>
        </Card>
      )}
        {warnings.length > 0 && (
          <Alert variant="warning">
            <strong>Worth a look:</strong>
            <ul style="margin:.5rem 0 0;padding-left:1.1rem">
              {warnings.map((warning) => (
                <li>{warning}</li>
              ))}
            </ul>
          </Alert>
        )}
      </aside>
    </div>

    <Card>
      <div class="card-header">
        <h2 class="card-title">Preview</h2>
        <p class="card-description">
          What an employer reads, and what {resume?.visibility === 'private' ? 'would be' : 'is'} on
          your candidate page.
        </p>
      </div>
      <Prose html={html} />
    </Card>
  </div>
);
