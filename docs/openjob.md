# OpenJob

A job posting that an agent can read, and that says out loud whether an agent may
answer it.

Job postings already have a machine-readable format: schema.org `JobPosting`, which
search engines index and which most boards emit. OpenJob does not replace it. It
extends it with the three things `JobPosting` has no vocabulary for, and which the
next few years of hiring depend on:

1. **whether the employer accepts applications written with an agent**, stated
   rather than discovered by silent rejection;
2. **the application form, as data**, so applying does not require rendering a page;
3. **a description in Markdown**, so the same text is legible to a person, a model
   and a terminal without a HTML-to-text round trip.

## The document

A listing is a JSON object. Every field below is what the reference implementation
serves at `GET /api/v1/jobs/{slug}`.

```json
{
  "id": "b7c3...",
  "slug": "staff-engineer-agent-platform",
  "title": "Staff Engineer, Agent Platform",
  "description": "We are building the plumbing...",
  "org": {
    "slug": "example-works",
    "name": "Example Works",
    "website": "https://example.com"
  },
  "employmentType": "full-time",
  "workplace": "remote",
  "seniority": "staff",
  "location": "European timezones",
  "remoteRegions": ["DE", "NL", "PT"],
  "pay": {
    "lines": [
      { "type": "yearly", "min": 180000, "max": 230000, "currency": "USD", "unit": null }
    ],
    "method": "payroll",
    "equity": "0.1% - 0.4%",
    "unpaid": false
  },
  "salary": {
    "min": 180000,
    "max": 230000,
    "currency": "USD",
    "period": "year",
    "equity": "0.1% - 0.4%",
    "unpaid": false
  },
  "tags": ["infrastructure", "agents"],
  "stack": ["typescript", "postgres", "rust"],
  "requirements": ["Has run something other people depended on."],
  "responsibilities": ["Own the execution layer."],
  "agentPolicy": "welcome",
  "apply": { "via": "board", "schema": { "fields": [] } },
  "status": "published",
  "publishedAt": "2026-09-08T10:00:00.000Z",
  "expiresAt": null
}
```

`description` is Markdown. Not HTML, and not plain text with the formatting removed.

## pay

What it pays, in full, and **required before a listing can be published**. A listing
that says nothing about pay gets fewer and worse applications, and an agent reading it
cannot tell whether to bother; on this board "not stated" is not a listing anybody can
act on. "Unpaid" counts, because it is an answer.

`pay.lines` is a list because one price is not enough for the work this board is for.
A listing that pays per task, per pull request and per social post has three lines,
and a reader deciding whether to apply needs all of them:

```json
"pay": {
  "lines": [
    { "type": "per_task", "min": 0.25, "max": 0.25, "currency": "USD", "unit": "task" },
    { "type": "per_unit", "min": 0.25, "max": 0.25, "currency": "USD", "unit": "PR that fixes a bug you find" },
    { "type": "per_unit", "min": 0.25, "max": 0.25, "currency": "USD", "unit": "social post linking to your page" }
  ],
  "method": "SOL",
  "equity": null,
  "unpaid": false
}
```

`type` is one of `hourly`, `daily`, `weekly`, `monthly`, `yearly`, `fixed`, `per_task`,
`per_unit`, `revenue_share`, `bounty`: the same list [ugig.net](https://ugig.net) carries
as a gig's `budget_type`, in the same spelling, so a gig there and a job here describe
pay the same way. `currency` is what the figure is written in, an ISO code or a ticker
such as `SOL`; `%` for a revenue share. `method` is separate from the price on purpose:
"$100 an hour paid in USDC" is one rate with a settlement preference, not two rates,
and the number does not change because the rail did. It is a coin (`SOL`, `USDC`, `ETH`,
`USDT`, `POL`) or a rail (`bank transfer`, `PayPal`, `payroll`).

**Writing it.** Nobody has to build that JSON. Every writer on this board, the web form,
the API, the CLI, the job file and the MCP tool, takes each line as the sentence a person
would say, and the reference implementation parses it:

```
$120k - $150k a year          $100 an hour           $800 a day
$5000 fixed                   $250 bounty            10% revenue share
$0.25 per task                $0.25 per PR that fixes a bug you find
0.01 SOL per task             $0.25 per social post, settled in SOL
```

A rail on the end of a line ("settled in SOL", "via bank transfer") becomes `method`.
A line that says how much but not what for (`$60k`) is refused with the fix. In a job
file the lines are a `pay:` list in the front matter and `pay_method:` beside it; over
the API, `pay` is an array of those strings or of line objects.

`salary` is the first time-based line flattened to `min`, `max`, `currency`, `period`,
kept for readers written against earlier versions and for the salary filter and sort,
which compare on an annual basis. A listing that pays per task has a null range there,
and its pay in `pay`.

## agentPolicy

The field this format exists for. Required on every listing, with exactly three
values:

| Value | Means |
| --- | --- |
| `welcome` | Agent-written applications are fine. Nothing is asked. |
| `disclose` | Fine, but say so. The application carries a structured disclosure. |
| `human-only` | The employer is asking for something a person wrote. |

Three things about it are deliberate.

**It is required.** An optional field would be omitted by most posters, and "not
stated" is exactly the ambiguity candidates are navigating today by guessing.

**`human-only` is a request, not a control.** No board can tell who wrote a cover
letter, and one that claims it can is selling something. Stating it plainly is worth
more than pretending to enforce it: a candidate who reads `human-only` and writes it
themselves has been told what the employer wants, which is all anyone can offer.

**Disclosure is not evidence against the candidate.** A board that collects the
disclosure and then filters those applications out has broken the field for
everybody, because the next candidate learns to lie. `disclose` means the employer
wants to know, and wanting to know is the reason to answer honestly.

## apply

One shape. An application is a POST against a published schema, which is the only
kind an agent can complete without a browser.

```json
{ "via": "board",  "schema": { "fields": [ ... ] } }
```

Earlier drafts of this spec also allowed `{ "via": "url" }` and
`{ "via": "email" }`, on the reasoning that a listing saying so was at least being
honest that an agent could not finish the job. That was the wrong trade. A board
where some listings are applicable and some are links is one an agent has to filter,
and the listings it filters out are exactly the ones an employer cared enough to
cross-post. Offsite applications are gone.

A URL still has a use, but it points the other way: give the board a URL to a job
posting and it imports it, so the listing lives here and is applicable here. It is a
source, never a destination.

### The application schema

A deliberately small subset of JSON Schema: small enough to render as an HTML form,
small enough for a model to fill in without a validator.

```json
{
  "fields": [
    { "name": "name",  "label": "Your name", "type": "text",     "required": true,  "maxLength": 120 },
    { "name": "email", "label": "Email",     "type": "email",    "required": true,  "maxLength": 200 },
    { "name": "cover", "label": "Why you",   "type": "textarea", "required": true,  "maxLength": 5000,
      "help": "Plain text. Short is fine." }
  ]
}
```

`type` is one of `text`, `textarea`, `email`, `url`, `select` or `file`. A `select`
carries `options`.

An implementation publishes the schema at a stable address alongside the endpoint
that accepts it, so reading and answering are two requests and no guessing:

```
GET  /api/v1/jobs/{slug}/apply-schema
POST /api/v1/jobs/{slug}/apply
```

The schema GET is a read. An idle hosted instance can miss a 15 second client
timeout on the first attempt and then answer in about a second. Retry that
request once. Agents that treat a single timeout as a dead endpoint will skip
applying to a board that is up.

### The disclosure

Posted alongside the answers:

```json
{
  "agent": { "name": "claude-opus-5 via agenticjobs-mcp", "supervised": true }
}
```

`supervised` means a person read it before it was sent. It is never inferred - a
guessed disclosure is worthless in both directions.

### Resumes

A resume travels as Markdown, in the [OpenResume.md](./openresume.md) convention, in
a `resume` field. Not a file upload, not a URL to a PDF. An employer receives text
they can read and an agent receives text it can write.

## Mapping onto schema.org

An OpenJob listing maps cleanly onto `JobPosting`, and an implementation should emit
both - the JSON-LD for search engines, the OpenJob document for everything else.

| OpenJob | JobPosting |
| --- | --- |
| `title` | `title` |
| `description` | `description` |
| `org` | `hiringOrganization` |
| `employmentType` | `employmentType` (`FULL_TIME`, `PART_TIME`, `CONTRACTOR`, `INTERN`, `TEMPORARY`) |
| `workplace: "remote"` | `jobLocationType: "TELECOMMUTE"` |
| `remoteRegions` | `applicantLocationRequirements` |
| `location` | `jobLocation` |
| `pay` | nothing whole; the first time-based line travels as `salary`, below |
| `salary` | `baseSalary`, plus an annualised `estimatedSalary` |
| `salary.unpaid` | nothing; schema.org has no vocabulary for it, so `baseSalary` is simply absent |
| `expiresAt` | `validThrough` |
| `apply.via === "board"` | `directApply: true` |

`salary.unpaid` is the board's own field, and it exists because a null range and an
unpaid role are different facts. A listing that says nothing about pay was probably
written by somebody who could not be bothered; one that says `unpaid` is an internship
or a volunteer post being honest about itself. Reading the first as the second is how
an honest employer gets treated like a careless one. When it is set the range is null,
so an unpaid listing never matches a salary floor and never rises up a salary sort.

The two fields with no equivalent - `agentPolicy` and the address of the application
schema - travel in `additionalProperty`, which is the vocabulary's own escape hatch
and passes every validator. `directApply` is always `true`, because every listing is
applied to here.

One trap worth naming, because it catches almost everyone: a remote role needs
`jobLocationType: "TELECOMMUTE"` **and** a location the hire may sit in. A remote
posting with no `jobLocation` and no `applicantLocationRequirements` fails Google's
validation while looking entirely correct.

## Drafts

A listing has a `status`, and `draft` is the interesting one. A draft is not
published, not in the feed, not in the API's search results, and not visible to any
other instance.

This is the employer's human control point. An agent can write the listing; a person
publishes it. The reference implementation makes a job created over the API or by a
tool call a draft *unless the caller explicitly asks otherwise*, which is the correct
default the first time an agent posts a job its author has not read.

The candidate's side of that seam is an application that can be prepared and held
until a person sends it. Both ends of the transaction have one, or the design is
lopsided.

## Federation

An implementation that wants to be discoverable serves a descriptor at
`/.well-known/agenticjobs` naming its search endpoint, its OpenAPI document, its MCP
endpoint and its feed. A directory reads that descriptor from the instance itself
rather than trusting an announcement, and a client fans one query out across every
instance it knows.

Nothing about OpenJob requires federation, and nothing about it requires a directory.
A single self-hosted board that serves these documents is a complete implementation.

## Implementations

- `agenticjobs` - MIT, https://github.com/profullstack/agenticjobs
