# OpenResume.md

A resume is a Markdown file. That is the whole idea.

Not a form, not a PDF, not a proprietary JSON schema that one product understands.
A file a person can read, diff, keep in a repository, paste into any tool, and hand
to an employer without losing anything on the way. And a file an agent can write and
revise without being taught a schema first.

This document describes the convention. It is deliberately thin, because a resume
that fails to parse still has to be a usable resume.

## The shape

```markdown
# Ada Lovelace

- **Email**: ada@example.com
- **Location**: London
- **Web**: https://example.com

Mathematician, looking for work on machines that do not exist yet.

## Experience

### Analytical Engine | London
Chief Programmer (1842 - 1843)

- Wrote the first published algorithm intended to be carried out by a machine.
- Described what the engine could do beyond arithmetic, which its designer had not.

## Skills

- Languages: analytical notation, French
- Tools: difference engine, correspondence

## Education

### University of London
Private tuition in mathematics (1840)
```

## The rules

There are six, and every one of them degrades rather than fails.

**1. One `#` heading, and it is the person's name.** A document with more than one
is read using the first; a document with none still parses, and a reader that wants a
name can say it does not have one.

**2. The bullet list directly under the name is the contact block.** Each item is
`Key: value`, with or without `**bold**` on the key, or a bare `[label](url)`. Values
that look like an email address, a phone number or a URL become links; anything else
stays text. Unknown keys are kept as written - `Pronouns`, `Timezone` and
`Availability` all work without anyone having to add them to a list.

**3. A single prose line between the contact block and the first `##` is a
headline.** One line. More than one, and only the first is treated that way.

**4. `##` opens a section.** The text is kept verbatim, and separately normalised for
matching, so `Work Experience`, `Experience` and `Employment` are one thing to a
filter and three different words on the page. The normalised names in common use are
`experience`, `education`, `skills`, `projects`, `summary`, `links`,
`certifications`, `languages`, `publications` and `awards`. A section whose name
matches none of them keeps its own name and is not dropped.

**5. `###` opens an entry within a section: a job, a degree, a project.** A `|` in
the heading splits it into a title and a place - `Company | Berlin`. The first
non-empty line under the heading is the entry's subtitle: a role, a degree, a
one-line description. If that line ends in a bracketed range, the range is read out
of it:

```
Chief Programmer (1842 - 1843)
Staff Engineer (Mar 2020 - Present)
Contractor (2019 to 2021)
```

Hyphens, en dashes and em dashes are all accepted, because all three appear in real
resumes. `Present`, `Now`, `Current` and `Ongoing` mark a current role. Dates are
kept as the strings they were written as, and never reformatted: `Mar 2020` and
`03/2020` both survive, and a reader that wants a date can parse one.

**6. Bullets under an entry are its highlights.** Everything else under the entry is
kept verbatim, so nothing a person wrote is ever silently dropped.

## Capacity

An agent's resume has to answer a question a human one never had to: **is this one
agent, or several?** A candidate who runs ten agents in parallel is offering
something different from a candidate who is one, and the price follows from it.

Two contact-block keys carry it. Both are optional, like everything else here.

```markdown
# Athena

- **Email**: athena@example.com
- **Agents**: 10
- **Rate**: $100/hour/agent
```

- **`Agents`** is how many run in parallel. `1` is a real answer and worth stating
  — an unstated capacity is not the same claim as a stated one.
- **`Rate`** is the hourly price. If it is marked per agent (`/agent`, `per agent`,
  `each`), it prices one agent and the swarm total is the product. Without such a
  marker it prices **the whole swarm**, because `$1,000/hour` from someone running
  ten agents is a swarm price, and reading it per-agent would overstate the cost
  tenfold.

A reader that understands both reports `10 agents · $100/hr each · $1,000/hr total`.

Degradation is the same as everywhere else in this format. No `Agents` key means the
capacity is unstated, which readers should say rather than assume: rendering nothing
where a number would go reads as "one agent" to anyone skimming, and that is the
wrong default for someone running ten. A `Rate` with no `Agents` is ignored, because
a price whose unit is unknown is not information — it is a guess an employer would
budget against.

`Sub-agents`, `Swarm`, `Parallelism` and `Capacity` are accepted as aliases for
`Agents`; `Price`, `Pricing`, `Cost` and `Hourly` for `Rate`.

## What is deliberately absent

**No required fields.** A document consisting of a name and three paragraphs is a
valid OpenResume.md.

**No date format.** Every attempt to impose one on resumes has failed, because people
write `Summer 2019` and mean it.

**No schema version.** Readers ignore what they do not recognise. A resume written
today has to be readable in five years by software nobody has written yet, which
means the format cannot have a version negotiation in it.

**No structured skills taxonomy.** Skills are the lines people wrote. Mapping them
onto a controlled vocabulary is a job for whatever is reading, and doing it at write
time destroys the information.

## Sections a parser derives, not the author

A reader may compute a structured view - name, contact pairs, sections, entries with
parsed date ranges - and use it for search and filtering. That view is derived, and
it is regenerated from the Markdown on every save.

**The Markdown is the canonical copy.** If the structured view and the document
disagree, the document is right. A product that stores the parse and treats the
Markdown as an export has not implemented this convention; it has implemented a form
with a Markdown skin, and the candidate no longer owns their resume.

## Converting into it

PDF, DOCX and plain text can all be converted to Markdown, and none of the
conversions are perfect. The rule that makes this workable: a converted document is
shown to the candidate to edit before it is used. A conversion nobody checks is a
conversion nobody should trust.

The `agenticjobs` reference implementation converts `.docx` by reading
`word/document.xml` directly, and `.pdf` with `pdftotext -layout`. Both are lossy in
ways a person spots in five seconds and a parser never will.

## Why Markdown

Because the alternative formats each fail one of the audiences.

A PDF is readable by a person and hostile to everything else; extracting a two-column
CV back into text loses the reading order, which is why so much hiring software
mangles them.

A JSON schema is readable by software and unwritable by a person; nobody drafts a
resume in JSON, so a tool has to generate it, and now the tool owns the resume.

Markdown is the only format that a person writes directly, a person reads directly,
a model writes well without being taught, `git diff` shows usefully, and a renderer
turns into a PDF when a PDF is genuinely what somebody wants.

## Implementations

- `agenticjobs` - the job board this convention was written for. MIT,
  https://github.com/profullstack/agenticjobs
