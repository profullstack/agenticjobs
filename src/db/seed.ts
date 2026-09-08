/**
 * Example data, so a fresh board is not an empty page.
 *
 * Refuses to run on a board that already has jobs. Seed data appearing on a
 * live board next to real listings would be worse than an empty one, and this
 * is a command people run twice by accident.
 */

import type pg from 'pg';
import { createJob, countJobs, normaliseInput, setStatus } from '../core/jobs.ts';
import { createOrg } from '../core/orgs.ts';
import { ensureUser } from '../core/auth.ts';

interface Example {
  title: string;
  description: string;
  workplace: string;
  seniority: string;
  location: string;
  salaryMin: number;
  salaryMax: number;
  stack: string;
  tags: string;
  agentPolicy: string;
}

const EXAMPLES: Example[] = [
  {
    title: 'Staff Engineer, Agent Platform',
    description: `We are building the plumbing that lets other people's agents do real work: sandboxes, tool registries, audit trails.

## What you would own

The execution layer. When someone's agent calls a tool, everything between the call and the result is yours: isolation, quotas, retries, and the record of what happened.

## What we are looking for

Someone who has run something in production that other people depended on, and who has opinions about failure modes that came from watching them happen.

You will be reviewing a lot of machine-written code. We would rather hire someone who is good at that than someone who is offended by it.`,
    workplace: 'remote',
    seniority: 'staff',
    location: 'European timezones',
    salaryMin: 180000,
    salaryMax: 230000,
    stack: 'typescript, postgres, kubernetes, rust',
    tags: 'infrastructure, agents, backend',
    agentPolicy: 'welcome',
  },
  {
    title: 'Founding Designer',
    description: `Three engineers and no designer, which is exactly as visible in the product as it sounds.

## The job

Own what it looks like and how it works, end to end. There is no design system yet; you would be making it, then living with it.

## Honestly

Early, uncertain, and the equity is a bet not a salary. Say no if that is not what you want right now.`,
    workplace: 'hybrid',
    seniority: 'senior',
    location: 'Berlin',
    salaryMin: 85000,
    salaryMax: 110000,
    stack: 'figma, css, typescript',
    tags: 'design, frontend',
    agentPolicy: 'human-only',
  },
  {
    title: 'Backend Engineer, Payments',
    description: `Money moving correctly, every time, with a paper trail.

## What you would do

- Ledger work: double-entry, reconciliation, the boring parts that must be right
- Integrations with banking partners whose APIs were designed in 2009
- On-call for a system where an outage is measured in money

## What we care about

Correctness over speed, and the judgment to know when that is the wrong trade.`,
    workplace: 'remote',
    seniority: 'mid',
    location: 'Anywhere',
    salaryMin: 120000,
    salaryMax: 160000,
    stack: 'go, postgres, kafka',
    tags: 'backend, fintech, payments',
    agentPolicy: 'disclose',
  },
  {
    title: 'Developer Advocate',
    description: `Write the documentation you wish you had found, then go and find out why people still could not use it.

## The work

Half writing, half talking to people who are stuck. Conference talks if you like them; nobody will make you.

## Not the work

This is not a marketing role with a technical coat of paint. You would be shipping code that goes in the docs.`,
    workplace: 'remote',
    seniority: 'mid',
    location: 'US timezones',
    salaryMin: 110000,
    salaryMax: 140000,
    stack: 'typescript, python, markdown',
    tags: 'devrel, docs',
    agentPolicy: 'welcome',
  },
];

export async function seed(pool: pg.Pool): Promise<number> {
  const counts = await countJobs(pool);
  if (counts.total > 0) return 0;

  const user = await ensureUser(pool, 'example@example.com', 'Example');
  const org = await createOrg(pool, user.id, {
    name: 'Example Works',
    website: 'https://example.com',
    description:
      'A placeholder employer, created by `agenticjobs seed`. Delete it before anyone real turns up.',
  });
  if (typeof org === 'string') throw new Error(org);

  let added = 0;
  for (const example of EXAMPLES) {
    const input = normaliseInput({ ...example }, org.id);
    if (typeof input === 'string') throw new Error(`seed rejected: ${input}`);
    const job = await createJob(pool, input);
    await setStatus(pool, job.id, 'published');
    added += 1;
  }
  return added;
}
