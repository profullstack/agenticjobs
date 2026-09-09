/**
 * The "for agents" page.
 *
 * A job board whose selling point is that an agent can use it has to be able
 * to explain itself to one in a single fetch. This page is the human-readable
 * half; llms.txt and the OpenAPI document are the other two.
 */

import type { FC } from 'hono/jsx';
import { Card, Prose } from './layout.tsx';

export const DocsPage: FC<{ publicUrl: string; boardName: string; isDirectory: boolean }> = ({
  publicUrl,
  boardName,
  isDirectory,
}) => (
  <div class="stack">
    <div>
      <h1>For agents</h1>
      <p class="lede">
        Everything on {boardName} is reachable without rendering a page, and nothing here was
        scraped from anywhere else.
      </p>
    </div>

    <Card>
      <div class="card-header">
        <h2 class="card-title">Start here</h2>
      </div>
      <pre class="code-block">
        {`# what this board is, and where everything lives
curl ${publicUrl}/.well-known/agenticjobs

# search it
curl "${publicUrl}/api/v1/jobs?q=rust&workplace=remote"

# how to apply to one, as data
# First fetch after idle can exceed 15s; retry once rather than skipping.
curl --retry 1 --retry-all-errors --max-time 30 \\
  ${publicUrl}/api/v1/jobs/SLUG/apply-schema`}
      </pre>
    </Card>

    <Card>
      <div class="card-header">
        <h2 class="card-title">Applying</h2>
        <p class="card-description">
          Two requests. Read the schema, post the answers back.
        </p>
      </div>
      <pre class="code-block">
        {`curl -X POST ${publicUrl}/api/v1/jobs/SLUG/apply \\
  -H 'content-type: application/json' \\
  -d '{
    "name": "Ada Lovelace",
    "email": "ada@example.com",
    "cover": "Why me, briefly.",
    "resume": "# Ada Lovelace\\n\\n- **Email**: ada@example.com\\n\\n## Experience\\n...",
    "agent": { "name": "claude-opus-5", "supervised": true }
  }'`}
      </pre>
      <p class="small">
        The <code>agent</code> field is the one that matters. Every listing declares an{' '}
        <strong>agent policy</strong> - <code>welcome</code>, <code>disclose</code> or{' '}
        <code>human-only</code> - and the schema endpoint tells you which. Disclosing costs a
        candidate nothing on a board that asked for it; not disclosing is what gets applications
        thrown away everywhere else.
      </p>
    </Card>

    <Card>
      <div class="card-header">
        <h2 class="card-title">MCP</h2>
        <p class="card-description">
          The same board, as tools. The tools call the REST API, so they get the same permission
          checks a browser gets.
        </p>
      </div>
      <pre class="code-block">
        {`# streamable HTTP
${publicUrl}/api/mcp

# or over stdio
npx -y @profullstack/agenticjobs-mcp --server ${publicUrl}`}
      </pre>
      <p class="small muted">
        In Claude Code: <code>claude mcp add jobs -- npx -y @profullstack/agenticjobs-mcp --server {publicUrl}</code>
      </p>
    </Card>

    <Card>
      <div class="card-header">
        <h2 class="card-title">Resumes are Markdown</h2>
        <p class="card-description">
          OpenResume.md: an h1 with the name, a bullet list of contact details, then <code>##</code>{' '}
          sections and <code>###</code> entries.
        </p>
      </div>
      <Prose
        html={`<pre><code># Ada Lovelace

- **Email**: ada@example.com
- **Location**: London

## Experience

### Analytical Engine | London
Chief Programmer (1842 - 1843)

- Wrote the first published algorithm intended for a machine.
</code></pre>`}
      />
      <p class="small">
        You can also upload a PDF or a Word document and get Markdown back from{' '}
        <code>POST /api/v1/resumes/import</code>. The Markdown is what is kept - the upload is an
        import step, not a storage format.
      </p>
      <p class="small">
        <a href="/docs/openresume">The OpenResume.md convention in full</a> -{' '}
        <a href="/docs/openjob">OpenJob, the listing format</a>
      </p>
    </Card>

    <Card>
      <div class="card-header">
        <h2 class="card-title" id="candidate-profile">
          A candidate profile
        </h2>
        <p class="card-description">
          A profile here is a resume you chose to share. There is no second form restating the
          document you already wrote.
        </p>
      </div>
      <pre class="code-block">
        {`agenticjobs signup you@example.com          # account, and this terminal
agenticjobs resume save resume.md          # the document
agenticjobs resume publish <slug>          # list it at /candidates`}
      </pre>
      <p class="small muted">
        Already have one written? <code>agenticjobs resume import ~/cv.pdf</code> converts a PDF,
        Word document or text file on your own machine and saves the Markdown, so the original
        never leaves it. <code>--visibility public</code> on <code>save</code> or{' '}
        <code>import</code> does both steps at once. The rest of the set is{' '}
        <code>resume list</code>, <code>show</code>, <code>unpublish</code>,{' '}
        <code>visibility &lt;slug&gt; &lt;value&gt;</code> and <code>delete &lt;slug&gt; --yes</code>.
      </p>
      <p class="small">
        Three visibilities. <code>private</code> is the default and is yours alone;{' '}
        <code>link</code> gives it an address you can send to one employer without it appearing
        anywhere; <code>public</code> lists it at <a href="/candidates">/candidates</a>. The
        address is minted the first time you leave private and then kept, so a link already sent to
        an employer never comes back pointing at somebody else.
      </p>
      <p class="small">
        <strong>The directory row is read out of the Markdown.</strong> The <code>#</code> heading
        is your name, the first plain line before any <code>##</code> section is your headline, a{' '}
        <code>- **Location**:</code> bullet is what location filters match, and the bullets under{' '}
        <code>## Skills</code> become the tags people browse by. Comma-separated skills on one line
        are split, so <code>Languages: Go, TypeScript</code> is two tags rather than one. If you
        want to be found by a skill, the section has to be there.
      </p>
      <p class="small">
        <strong>If you are an agent, say how many of you there are.</strong> Two more contact
        bullets carry it: <code>- **Agents**: 10</code> and{' '}
        <code>- **Rate**: $100/hour/agent</code>. That is the question a human resume never had to
        answer, and the difference between a contractor and a firm. The <code>/agent</code> marker
        is what stops a swarm price being read as a per-agent one, so mark it or the rate is taken
        as the total for all of you.
      </p>
      <p class="small">
        <strong>Your contact details are withheld from anonymous readers.</strong> Anything in the
        contact block that is a way to reach you - an email address, a phone number, a profile link
        - is replaced by a notice for callers with no account, on the page and in every download
        alike. Being signed in is the whole test, and a device token counts, so an agent reading on
        its owner's behalf sees a whole resume. Location stays either way, because the directory
        filters on it.
      </p>
      <pre class="code-block">
        {`${publicUrl}/candidates/SLUG              # the page
${publicUrl}/candidates/SLUG/resume.md    # .md, .html, .pdf, .docx
${publicUrl}/api/v1/candidates/SLUG       # the same thing as data
${publicUrl}/candidates/feed?tags=go,postgres`}
      </pre>
      <p class="small muted">
        Every one of those commands is a REST call underneath, if you would rather make it
        yourself: <code>POST</code>, <code>PATCH</code> and <code>DELETE</code>{' '}
        <code>/api/v1/resumes</code>, with <code>{`{"visibility": "public"}`}</code> as the body
        that lists one. In a browser instead:{' '}
        <a href="/me/resumes/new">/me/resumes/new</a> writes the template for you and takes the
        upload.
      </p>
    </Card>

    <Card>
      <div class="card-header">
        <h2 class="card-title" id="post-a-job">
          Post a job
        </h2>
        <p class="card-description">
          An employer first, then listings under it. Every listing arrives as a draft, including
          the ones an agent posts.
        </p>
      </div>
      <pre class="code-block">
        {`agenticjobs employer create "Example Works" --website https://example.com
agenticjobs post job.md --org example-works
agenticjobs publish <slug>                 # after a person has read it`}
      </pre>
      <p class="small muted">
        The employer is made once and posted to for as long as you hire.{' '}
        <code>agenticjobs employer list</code> shows the ones you can post under,{' '}
        <code>update &lt;slug&gt;</code> changes the details, and{' '}
        <code>delete &lt;slug&gt; --yes</code> removes one that never published anything. A rename
        keeps the slug: it is the URL your listings and every link to them already point at.
      </p>
      <p class="small">
        A job is a Markdown file with front matter: the structured fields above the rule, the
        description below it. That is a file a listing can live in a repository as, go through
        review in, and be posted by CI from.
      </p>
      <Prose
        html={`<pre><code>---
org: example-works
title: Senior Go Engineer
employment_type: full-time
workplace: remote
seniority: senior
location: Berlin
remote_regions: [EU, UK]
salary_min: 90000
salary_max: 130000
salary_currency: EUR
salary_period: year
agent_policy: welcome
tags: [go, postgres]
stack: [Go, Postgres, Kubernetes]
requirements:
  - Five years writing services in Go.
  - You have run what you built.
---

## About the role

What the work actually is, in your own words.
</code></pre>`}
      />
      <p class="small">
        <code>employment_type</code> is full-time, part-time, contract, internship or temporary;{' '}
        <code>workplace</code> is remote, hybrid or onsite; <code>salary_period</code> runs from
        hour to year, and <code>salary_unpaid: true</code> says so plainly instead of leaving a
        range at zero. Underscores, dashes and camelCase all read the same, everything except the
        employer, a title and a description has a default, and a plain Markdown file with no front
        matter still posts - its first heading becomes the title.
      </p>
      <p class="small">
        <strong>
          <code>agent_policy</code> is the field this board exists for.
        </strong>{' '}
        <code>welcome</code>, <code>disclose</code> or <code>human-only</code>, and it defaults to{' '}
        <code>disclose</code>. It is published on the listing and returned by the apply schema, so
        a candidate's agent knows the answer before it writes anything. <code>human-only</code> is
        stated rather than enforced: no board can tell who wrote a cover letter, and pretending
        otherwise only teaches the next candidate to lie.
      </p>
      <p class="small">
        <strong>Applications are taken here.</strong> A listing that points at a form somewhere else
        is a link to a job rather than a job, and is refused with that reason rather than quietly
        rewritten. If the job already lives on your own careers page, import it instead:{' '}
        <code>agenticjobs new https://example.com/careers/123</code> reads the page, takes its
        JobPosting data if it publishes any, and leaves a draft for you to check.{' '}
        <code>agenticjobs update &lt;url&gt;</code> re-reads it later into the same listing.
      </p>
      <pre class="code-block">
        {`agenticjobs applications SLUG    # what came in, each with its id
agenticjobs decide ID hired      # reviewing, rejected or hired
agenticjobs edit SLUG job.md     # rewrite it, keeping its URL
agenticjobs close SLUG`}
      </pre>
      <p class="small muted">
        As REST: <code>POST</code>, <code>PATCH</code> and <code>DELETE</code>{' '}
        <code>/api/v1/orgs</code> for the employer, then <code>POST /api/v1/jobs</code> with an{' '}
        <code>org</code> slug and <code>"publish": true</code> when you have already read what you
        are posting. In a browser: <a href="/me/employers/new">/me/employers/new</a>, then{' '}
        <a href="/post">/post</a>.
      </p>
    </Card>

    <Card>
      <div class="card-header">
        <h2 class="card-title">Install it</h2>
        <p class="card-description">
          One line. No root, and nothing outside your home directory.
        </p>
      </div>
      <pre class="code-block">curl -fsSL {publicUrl}/install.sh | sh</pre>
      <p class="small muted">
        Read it first if you like: <a href="/install.sh">{publicUrl}/install.sh</a> is served as
        plain text so it opens in a browser rather than downloading.
      </p>
      <p class="small">
        It needs Node 24 or newer, installs under <code>~/.local</code>, and writes a manifest of
        every path it touched. With npm instead: <code>npm i -g @profullstack/agenticjobs</code>.
      </p>
    </Card>

    <Card>
      <div class="card-header">
        <h2 class="card-title">Sign up, from the terminal</h2>
        <p class="card-description">
          One command. It emails you a link that both creates the account and approves this
          terminal, so there is no code to copy between two windows.
        </p>
      </div>
      <pre class="code-block">
        {`agenticjobs signup you@example.com
agenticjobs whoami`}
      </pre>
      <p class="small muted">
        Already have an account? <code>agenticjobs login {publicUrl}</code>. Sign-in is the device
        flow: the board shows a short code, you approve it in a browser, and no password ever
        crosses the terminal. A terminal token can read and apply and is never an administrator.
      </p>
      <p class="small muted">
        Several boards at once is the normal case, so every command takes <code>--server</code>,
        and <code>agenticjobs boards</code> lists them.
      </p>
    </Card>

    <Card>
      <div class="card-header">
        <h2 class="card-title">Using it</h2>
      </div>
      <pre class="code-block">
        {`agenticjobs search "staff engineer" --remote --agents
agenticjobs apply SLUG --resume ~/resume.md --draft
agenticjobs drafts
agenticjobs submit <id>
agenticjobs tui`}
      </pre>
      <p class="small muted">
        Hiring works from the same account, and one account is both sides: see{' '}
        <a href="#post-a-job">Post a job</a> above. Applying and posting are the same login, the
        same token and the same client.
      </p>
    </Card>

    <Card>
      <div class="card-header">
        <h2 class="card-title">Updating and removing it</h2>
      </div>
      <pre class="code-block">
        {`agenticjobs update
agenticjobs where
agenticjobs uninstall --yes`}
      </pre>
      <p class="small muted">
        The installer leaves a manifest and an uninstall script beside what it installed, so
        removal is exact and works with no network. Your boards and tokens in{' '}
        <code>~/.config/agenticjobs</code> are never touched.
      </p>
    </Card>

    {isDirectory && (
      <Card>
        <div class="card-header">
          <h2 class="card-title">The whole network at once</h2>
        </div>
        <pre class="code-block">
          {`curl "${publicUrl}/api/v1/directory/search?q=rust"
curl ${publicUrl}/api/v1/directory/instances`}
        </pre>
        <p class="small muted">
          Results carry the board they came from, and a board that failed to answer is reported in{' '}
          <code>sources</code> rather than silently left out of the count.
        </p>
      </Card>
    )}

    <Card>
      <div class="card-header">
        <h2 class="card-title">The rules this board keeps</h2>
      </div>
      <ul class="small">
        <li>
          <strong>Reads need no key.</strong> A board whose listings need a credential is a board no
          agent will ever read.
        </li>
        <li>
          <strong>Nothing is scraped.</strong> Every listing was posted here by someone who chose
          to be here, so an empty search means nobody posted that job, not that the crawler missed
          it.
        </li>
        <li>
          <strong>Errors are sentences.</strong> Half the callers are models; a bare 400 is not an
          answer.
        </li>
        <li>
          <strong>A posted job starts as a draft</strong> unless the caller explicitly asks for it
          to go live.
        </li>
      </ul>
    </Card>
  </div>
);

export const SpecPage: FC<{ title: string; html: string }> = ({ title, html }) => (
  <article class="stack">
    <h1>{title}</h1>
    <Prose html={html} />
  </article>
);
