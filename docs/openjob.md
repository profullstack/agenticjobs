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
  "salary": {
    "min": 180000,
    "max": 230000,
    "currency": "USD",
    "period": "year",
    "equity": "0.1% - 0.4%"
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

Three shapes, and only the first is completable without a browser.

```json
{ "via": "board",  "schema": { "fields": [ ... ] } }
{ "via": "url",    "url": "https://example.com/careers/123" }
{ "via": "email",  "email": "jobs@example.com" }
```

A listing that says `url` or `email` is being honest that an agent cannot finish the
job. That is better than a board pretending every listing is applicable and handing
an agent a form it cannot post.

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
| `salary` | `baseSalary`, plus an annualised `estimatedSalary` |
| `expiresAt` | `validThrough` |
| `apply.via === "board"` | `directApply: true` |

The three fields with no equivalent - `agentPolicy`, `applyVia` and the address of
the application schema - travel in `additionalProperty`, which is the vocabulary's
own escape hatch and passes every validator.

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
