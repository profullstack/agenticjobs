# agenticjobs

**A job board where the agent on each side has a person behind it.**

The next few years of hiring look like this: a candidate's agent finds the role and
drafts the application, an employer's agent writes the posting and reads what comes
back, and a person at each end decides what actually happens. Everything in this
repository is built around that sentence.

Which means two things most job boards get wrong:

**Nothing here is scraped.** Every listing was posted to this board by the employer.
An empty search means nobody posted that job, not that a crawler missed it. That is
the only way a search result is worth anything to an agent, which cannot tell a stale
aggregator entry from a real opening.

**Both ends have a human control point, and they are the same shape.** An employer's
agent writes a listing and it lands as a draft for a person to publish. A candidate's
agent writes an application and it lands as a draft for a person to send. Neither
side can be automated past its human, and neither side is asked to trust that the
other one was not.

Self-hosted, MIT, Postgres. One person, one account, both sides of the table.

```
npx @profullstack/agenticjobs --help
```

## Every surface, one engine

|  |  |
| --- | --- |
| Web | Server-rendered, mobile first, works with JavaScript off |
| PWA | Installable, offline shell, no build step |
| REST | `/api/v1`, hand-written OpenAPI, reads need no credentials |
| MCP | `/api/mcp` over streamable HTTP, or `agenticjobs-mcp` over stdio |
| CLI | `agenticjobs search`, `apply`, `post`, `publish`, `drafts` |
| TUI | `agenticjobs tui`, both sides in one window |
| Desktop | Electron, signed in to the same boards as your terminal |

The MCP tools call the REST API rather than the database, so a tool call takes the
same code path and the same permission checks a browser request does. There is
deliberately no second read path anywhere in this codebase.

## For agents

Two requests to apply. No page to render, no form to guess.

```bash
# what this board is, and where everything lives
curl https://agenticjobs.work/.well-known/agenticjobs

# search it
curl "https://agenticjobs.work/api/v1/jobs?q=rust&workplace=remote&agentPolicy=welcome"

# the application form, as data
curl https://agenticjobs.work/api/v1/jobs/SLUG/apply-schema

# send it
curl -X POST https://agenticjobs.work/api/v1/jobs/SLUG/apply \
  -H 'content-type: application/json' \
  -d '{"name":"Ada","email":"ada@example.com","cover":"...",
       "resume":"# Ada Lovelace\n\n- **Email**: ada@example.com\n",
       "agent":{"name":"claude-opus-5","supervised":true}}'
```

### The agent policy

Every listing declares one, and it is required:

| | |
| --- | --- |
| `welcome` | Agent-written applications are fine. Nothing is asked. |
| `disclose` | Fine, but say so. The application carries a structured disclosure. |
| `human-only` | The employer is asking for something a person wrote. |

`human-only` is a request, not a control. No board can tell who wrote a cover letter,
and one that claims it can is selling something. Saying it plainly is worth more than
pretending to enforce it.

And disclosure is not evidence against a candidate. A board that collects the
disclosure and then quietly filters those applications out has broken the field for
everyone, because the next candidate learns to lie.

## Resumes are Markdown

A file a person can read, diff, and keep. A file an agent can write without being
taught a schema first.

```markdown
# Ada Lovelace

- **Email**: ada@example.com
- **Location**: London

## Experience

### Analytical Engine | London
Chief Programmer (1842 - 1843)

- Wrote the first published algorithm intended for a machine.
```

Upload a PDF, a Word file, plain text or Markdown and it is converted; what you keep
and what employers read is the Markdown, and you edit it before it goes anywhere. A
conversion nobody checks is a conversion nobody should trust.

The convention is [OpenResume.md](docs/openresume.md). The listing format is
[OpenJob](docs/openjob.md). Both are conventions anyone can implement, and neither
requires this software.

## Run your own

```bash
git clone https://github.com/profullstack/agenticjobs
cd agenticjobs
cp .env.example .env          # set SECRET and PUBLIC_URL
docker compose up -d
```

That is a board on http://localhost:8787 with its own Postgres. Migrations run at
boot behind an advisory lock, so `--scale app=3` is safe.

Without Docker:

```bash
pnpm install && pnpm build
pnpm migrate && pnpm seed
pnpm start
```

Deploying to Railway: the repo has a `railway.json`, so add a Postgres and point a
service at this Dockerfile. `PUBLIC_URL` and `SECRET` are the two variables that
matter.

## Boards find each other

Instances are independent. Each one has its own database, its own domain and its own
rules, and any of them can list itself in a directory so people can find it:

```bash
DIRECTORY_URL=https://agenticjobs.work
ANNOUNCE=true
```

Your instance sends one field: its own URL. The directory then reads
`/.well-known/agenticjobs` from you directly, so nothing about your board is taken on
trust from the announcement. (A stream directory can trust an announcement that says
"I am playing something". A job board's announcement carries a company name and a job
count, and one that could claim someone else's would be a phishing tool on day one.)

A directory can then answer one question across every listed board at once. A board
that is slow or down is named in the results rather than silently dropped, so nobody
sees a shorter list with no explanation.

The same works from your terminal, for boards that are listed nowhere:

```bash
agenticjobs login https://agenticjobs.work
agenticjobs login https://jobs.your-company.internal
agenticjobs search "staff engineer" --all      # asks both, in parallel
```

## Both sides, from a terminal

```bash
# looking
agenticjobs search "rust" --remote --agents
agenticjobs apply SLUG --resume ~/resume.md --draft   # prepare, do not send
agenticjobs drafts                                    # read what your agent wrote
agenticjobs submit <id>                               # you decide

# hiring, on the same account
agenticjobs post job.md --org acme                    # creates a draft
agenticjobs publish staff-engineer                    # you decide
agenticjobs applications staff-engineer
```

Sign-in is the device flow: the terminal shows a short code, you approve it in a
browser, and no credential crosses the terminal. A terminal token can read and apply
and is never an administrator.

## Posting from myna

A job opening goes out with the rest of a launch:

```bash
myna login jobs
myna jobs post opening.md
myna jobs applicants staff-engineer
```

The board is an **explicit target**. It is never part of `myna post --to all`, because
a status update fanning out into a job opening at your company is not something you
can delete your way out of.

## Development

```bash
pnpm install
docker compose up -d db
pnpm build && pnpm migrate && pnpm seed
pnpm dev
pnpm test          # 61 tests; the API suite needs the database above
pnpm typecheck
```

The repository is one package with a build step. The build exists because Node cannot
strip types from `.tsx` at all, and the pages are Hono JSX. Everything else follows
the house pattern: pnpm, Node 24, raw SQL forward-only migrations, no ORM.

shadcn's token vocabulary and component anatomy are ported by hand into plain CSS
(`web/public/tokens.css`, `app.css`). There is no Tailwind and no React here, so the
components could not be used directly; what is ported is their structure, and a theme
from the shadcn theme editor pastes straight in.

## Licence

MIT. See [LICENSE](LICENSE).
