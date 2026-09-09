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
        Hiring works from the same account: <code>agenticjobs post job.md --org acme</code>, then{' '}
        <code>agenticjobs publish</code> when you have read it.
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
