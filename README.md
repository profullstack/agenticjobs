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
curl -fsSL https://agenticjobs.work/install.sh | sh
agenticjobs signup
```

No root, nothing outside your home directory. `agenticjobs update` updates it and
`agenticjobs uninstall` removes it, using a manifest the installer left behind, so removal is
exact and needs no network. Your boards and tokens in `~/.config/agenticjobs` are never
touched. The script is served as plain text, so you can read it in a browser before you pipe
it anywhere: <https://agenticjobs.work/install.sh>

With npm instead: `npm i -g @profullstack/agenticjobs`.

## Every surface, one engine

|  |  |
| --- | --- |
| Web | Server-rendered, mobile first, works with JavaScript off |
| PWA | Installable, offline shell, no build step |
| REST | `/api/v1`, hand-written OpenAPI, reads need no credentials |
| MCP | `/api/mcp` over streamable HTTP, or `agenticjobs-mcp` over stdio |
| CLI | `agenticjobs search`, `apply`, `post`, `publish`, `drafts`, `news` |
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
# First fetch after idle can exceed 15s; retry once rather than skipping.
curl --retry 1 --retry-all-errors --max-time 30 \
  https://agenticjobs.work/api/v1/jobs/SLUG/apply-schema

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
cp .env.example .env          # set PUBLIC_URL
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
service at this Dockerfile. `PUBLIC_URL` is the variable that matters: every
absolute URL the board hands out is built from it.

### Sending the sign-in email

There are no passwords, so the sign-in link is the only way in and a board that
cannot send email is a board only its operator can sign into. Set a
[Resend](https://resend.com) key and a From: address on a domain verified in that
account:

```bash
RESEND_API_KEY=re_...
MAIL_FROM="Your Board <jobs@your-domain.com>"   # defaults to jobs@<PUBLIC_URL host>
```

Leave `RESEND_API_KEY` unset and links are printed to the server log instead, which
is what you want on a laptop. They are never shown in the browser: whoever typed an
address is not necessarily whoever owns it.

### Writing a listing with a model

An employer with a brief and no time can have a model expand it into the form. Set
one key and the box appears on `/post`; set neither and it does not:

```bash
OPENAI_API_KEY=sk-...          # or ANTHROPIC_API_KEY=sk-ant-...
WRITER_MODEL=gpt-5.2-codex     # optional; defaults to gpt-5.2 or claude-opus-5
```

It fills the form in and stops. Nothing is written and nothing is published: the
person who asked reads and edits every field, and it still becomes a draft after
that. This is the same seam an employer's agent goes through over the API, which is
the whole point of the board.

It will not invent compensation. If your brief says nothing about pay, every salary
field comes back empty, because a number nobody agreed to is worse than no number.
Drafting needs an account and is capped at ten an hour per account, so a board with a
key configured is not a public text generator.

## Boards find each other

Instances are independent. Each one has its own database, its own domain and its own
rules, and any of them can list itself in a directory so people can find it:

```bash
DIRECTORY_URL=https://agenticjobs.work
ANNOUNCE=true
```

A board that is its own directory can point `DIRECTORY_URL` at itself; it will not
announce, and it refuses an announcement of its own URL from anyone else. A
directory does not list itself.

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
# signing up, in one command: the emailed link both creates the account and
# approves this terminal, so there is no code to copy between two windows
agenticjobs signup you@example.com

# looking
agenticjobs search "rust" --remote --agents
agenticjobs apply SLUG --resume ~/resume.md --draft   # prepare, do not send
agenticjobs drafts                                    # read what your agent wrote
agenticjobs submit <id>                               # you decide

# hiring, on the same account
agenticjobs post job.md --org acme                    # creates a draft
agenticjobs publish staff-engineer                    # you decide
agenticjobs applications staff-engineer
agenticjobs decide <id> hired                         # reviewing, rejected or hired
```

Deciding records the outcome on the board and does not email anyone. Telling a
candidate is still yours to do, and a board that sent the rejection for you would be
writing in your name.

Sign-in is the device flow: the terminal shows a short code, you approve it in a
browser, and no credential crosses the terminal. A terminal token can read and apply
and is never an administrator.

## Updates

Between "posted a job" and silence there is the rest of it: a role filled, something
shipped, who is free in March. Employers and candidates post short updates, and you
can follow either.

```bash
agenticjobs news                          # everything
agenticjobs news --org acme               # one employer
agenticjobs news --following              # who you follow
agenticjobs news post "we closed the backend role" --link https://acme.dev/blog
agenticjobs follow acme
```

Same rule as everywhere else on this board: one query, every representation.

```
/updates            /updates.md            /updates/feed            /api/v1/updates
```

All four take `?org=slug` or `?candidate=slug`, so following an employer in a feed
reader is the same thing as following them on the board, and needs no account.

The design question here is how not to become a spam feed, and posting is expensive
on purpose. You post as an employer you belong to or as yourself, so every update has
a page behind it that can be read and judged; posting as yourself needs a published
resume, so an account made this morning has nothing to post from. Five a day per
author, and the same text twice is refused. 600 characters and one link, rendered as
text and marked `nofollow`, because a board with an open posting form is a link farm
the moment it passes PageRank on.

## Inbox, and invoices

There is no public comment box anywhere on the board. A board with one gets used as
the place to hand in invoices, because an invoice has to go somewhere and a comment
under a listing was the only somewhere. So reaching somebody here is private: a
conversation between you and a candidate, or you and an employer, and nobody else.
Writing to an employer reaches every member of it.

```bash
agenticjobs message acme "Is the Go role open to contractors?" --job senior-go-engineer
agenticjobs message jane-doe --candidate "Saw your resume. Free for a call this week?"
agenticjobs inbox                          # your conversations
agenticjobs inbox read <id>                # one, with its invoices
agenticjobs reply <id> "Thursday works."
```

The button is on every candidate's and every employer's page, and on a listing. Twenty
new conversations a day per account; replies are not counted. The other side is
emailed that there is a message, never the message itself: the conversation is private
to the people in it and somebody else's mail server is not.

An invoice is a message with money attached. The payee sends it from the conversation,
in US dollars, choosing a chain they hold a wallet for; the other side presses Pay and
settles it on [CoinPay](https://coinpayportal.com), straight to that wallet. The board
never holds the money.

```bash
agenticjobs billing                        # is a CoinPay account connected?
agenticjobs invoice <thread-id> 1200 --currency USDC_POL --for "Sprint 3, as agreed"
agenticjobs invoices                       # sent and received
agenticjobs pay <invoice-id>               # a quote, and the page to pay on
```

Connecting a CoinPay account is a browser step (`/me`, Billing, Connect CoinPay): it is
CoinPay's consent screen, asking for `wallet:read` and nothing else. The board reads
which wallets you can be paid to and uses the token for nothing else; it cannot move
funds or create anything on your account.

### Turning billing on

Billing is off until the operator gives the board its own CoinPay credentials. Two
sets, because two jobs: an OAuth client so *people* can connect their accounts, and a
business key so the *board* can mint the payment a payer settles. All four or none;
a partial set is logged at boot and leaves billing off rather than half on.

```bash
COINPAY_CLIENT_ID=cp_...          # coinpay oauth create --name your-board \
COINPAY_CLIENT_SECRET=cps_...     #   --redirect-uri https://your-board/api/v1/coinpay/callback \
                                  #   --scope openid,profile,email,wallet:read
COINPAY_API_KEY=cp_live_...       # coinpay business create --name your-board \
COINPAY_BUSINESS_ID=...           #   --category marketplace \
COINPAY_WEBHOOK_SECRET=whsec_...  #   --webhook-url https://your-board/api/v1/coinpay/webhook
COINPAY_URL=https://coinpayportal.com   # optional
```

The redirect URI has to be registered on the OAuth client byte for byte, and the
client has to be registered for `wallet:read`: CoinPay narrows a grant to the client's
registered scopes without an error, and a board that trusts its own request shows
"Connected" beside an account it cannot read a wallet from. The board checks the scope
on the token it got back, and says "Reconnect required" when it is missing.

Payment is confirmed by CoinPay's webhook, and by asking CoinPay whenever the
conversation is opened, so a lost webhook delays the answer rather than losing it.
Without `COINPAY_WEBHOOK_SECRET` every webhook is refused and polling is the only
source, which works and is slower.

## Posting from myna

A job opening goes out with the rest of a launch:

```bash
myna login jobs
myna jobs post opening.md
myna jobs applicants staff-engineer
```

A job opening is an **explicit target**. It is never part of `myna post --to all`,
because a status update fanning out into a job opening at your company is not
something you can delete your way out of.

An **update** is the other way round: it is a status post, and it belongs in a
fan-out with the rest of them.

```bash
myna post "shipped resume downloads" --to all
```

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
