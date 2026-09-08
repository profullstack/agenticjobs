/**
 * agenticjobs for myna.
 *
 * myna posts things. A job opening is a thing worth posting, and it goes out
 * in the same breath as the launch announcement, the blog post and the ads -
 * which is the whole reason to have it here rather than in a separate script.
 *
 * Two pieces:
 *
 *   a network   so `myna post --to jobs:acme` reaches a board
 *   a command   `myna jobs` for the parts that are not a post: listing what is
 *               open, publishing a draft, and reading who applied
 *
 * The network is an EXPLICIT TARGET. It is never part of `all`. A post that
 * fans out to every connected account and quietly creates a job opening at
 * your company is the single worst thing this plugin could do, so it cannot:
 * a board only ever receives a post that named it.
 */

import { BoardClient, login, normaliseServer } from '@profullstack/agenticjobs/client';

const NETWORK_ID = 'jobs';

/** Front matter for the structured fields, Markdown below for the body. */
function parsePosting(text, title, extra) {
  const fields = { ...extra };
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text.replace(/\r\n?/g, '\n'));
  let body = text;

  if (match) {
    body = text.slice(match[0].length);
    for (const line of match[1].split('\n')) {
      const pair = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.+)$/.exec(line);
      if (!pair) continue;
      const key = pair[1].replace(/[_-]([a-z])/g, (_, c) => c.toUpperCase());
      fields[key] = pair[2].trim().replace(/^["']|["']$/g, '');
    }
  }

  const heading = /^#\s+(.+)$/m.exec(body);
  fields.title = fields.title ?? title ?? heading?.[1]?.trim();
  // The h1 is dropped when it became the title, so the listing does not show
  // the same line twice.
  fields.description = heading && !title ? body.replace(/^#\s+.+\n?/m, '').trim() : body.trim();
  return fields;
}

function clientFor(account) {
  return new BoardClient(account.meta.server, {
    token: account.creds.token,
    userAgent: 'myna-plugin-agenticjobs/0.1.0',
  });
}

const network = {
  id: NETWORK_ID,
  name: 'Agentic Jobs',
  // No "jobs" category exists, and a job posting behaves like a blog post: it
  // is a publication with a title that lives at a URL, not a status update.
  category: 'blog',
  blurb: 'Post an opening to an agenticjobs board. Self-hosted, federated, MIT.',
  auth: {
    kind: 'device',
    fields: [
      {
        key: 'server',
        label: 'Board URL',
        placeholder: 'https://agenticjobs.work',
        help: 'The board to post to. Your own instance, or a public one.',
        default: 'https://agenticjobs.work',
      },
      {
        key: 'org',
        label: 'Employer slug',
        placeholder: 'acme',
        help: 'Which employer on that board you post under. `myna jobs employers` lists yours.',
        optional: true,
      },
    ],
    note: 'The board shows a short code; approve it in a browser. No password is typed here.',
    docsUrl: 'https://agenticjobs.work/docs',
  },
  caps: {
    charLimit: 0,
    mediaLimit: 0,
    threads: false,
    delete: false,
    timeline: false,
    notifications: false,
    stats: false,
    needsTitle: true,
    // The line that keeps a status update from becoming a job opening.
    explicitTarget: true,
  },

  async login(input, ctx) {
    const server = normaliseServer(input.server || 'https://agenticjobs.work');
    const client = new BoardClient(server, { userAgent: 'myna-plugin-agenticjobs/0.1.0' });

    let name = server;
    try {
      const descriptor = await client.describe();
      name = descriptor.name;
      ctx.report(`${descriptor.name}: ${descriptor.tagline}`);
    } catch {
      throw new Error(`${server} does not serve an agenticjobs descriptor. Is that a board?`);
    }

    const token = await login(client, {
      label: 'myna',
      onPrompt: (grant) => {
        ctx.report(`Open ${grant.verifyUrl} and enter: ${grant.userCode}`);
        void ctx.openUrl(`${grant.verifyUrl}?code=${encodeURIComponent(grant.userCode)}`);
      },
    });

    const me = await client.me();
    const org = input.org || me.orgs[0]?.slug;
    if (!org) {
      throw new Error(
        `${me.user.email} has no employer on ${name}, so there is nothing to post under. Add one on the board first.`,
      );
    }

    return {
      handle: `${org}@${new URL(server).hostname}`,
      displayName: `${org} on ${name}`,
      creds: { token },
      meta: { server, org, board: name },
    };
  },

  async post(account, input) {
    const client = clientFor(account);
    const fields = parsePosting(input.text, input.title, input.extra ?? {});

    if (!fields.title) {
      throw new Error('A job posting needs a title: pass --title, or start the text with "# Title".');
    }

    const created = await client.postJob({
      org: fields.org ?? account.meta.org,
      ...fields,
      // Published only when the post says so explicitly. myna fans out; a
      // listing going live because a scheduled post fired is not recoverable
      // in the way deleting a tweet is.
      publish: fields.publish === 'true' || fields.publish === true,
    });

    const url = `${account.meta.server}/jobs/${created.job.slug}`;
    if (created.job.status !== 'published') {
      // Reported through the URL rather than thrown: the post succeeded, and
      // the draft is exactly what was asked for.
      return { id: created.job.slug, url: `${account.meta.server}/me/jobs/${created.job.slug}` };
    }
    return { id: created.job.slug, url };
  },
};

const command = {
  name: 'jobs',
  summary: 'Post and manage openings on an agenticjobs board.',
  usage: [
    'myna jobs                       every opening on your connected boards',
    'myna jobs employers             which employers you can post under',
    'myna jobs post <file.md>        create a listing (a draft, unless --publish)',
    'myna jobs publish <slug>        take a draft live',
    'myna jobs close <slug>          close a listing',
    'myna jobs applicants <slug>     who applied, and whether an agent wrote it',
    '  --to jobs:<handle>            pick one board when several are connected',
  ],

  async run(args, ctx) {
    const accounts = ctx.accounts().filter((account) => account.network === NETWORK_ID);
    if (accounts.length === 0) {
      ctx.out('No board connected. Run: myna login jobs');
      return 1;
    }

    const wanted = typeof ctx.flags.to === 'string' ? ctx.flags.to : null;
    const chosen = wanted
      ? accounts.filter((account) => account.id === wanted || account.handle === wanted)
      : accounts;
    if (chosen.length === 0) {
      ctx.out(`No connected board matches "${wanted}".`);
      return 1;
    }

    const [action = 'list', ...rest] = args;

    if (action === 'list') {
      for (const account of chosen) {
        const client = clientFor(account);
        const page = await client.search({ org: account.meta.org, limit: 50 });
        ctx.out(`\n${account.meta.board} - ${account.meta.org} (${page.total})`);
        if (page.items.length === 0) ctx.out('  nothing open');
        for (const job of page.items) {
          ctx.out(`  ${job.slug}  ${job.title}  [agents: ${job.agentPolicy}]`);
        }
      }
      return 0;
    }

    if (action === 'employers') {
      for (const account of chosen) {
        const me = await clientFor(account).me();
        ctx.out(`\n${account.meta.board}: ${me.orgs.map((org) => org.slug).join(', ') || 'none'}`);
      }
      return 0;
    }

    if (action === 'post') {
      const path = rest[0];
      if (!path) {
        ctx.out('Which file? myna jobs post <file.md>');
        return 1;
      }
      const { readFile } = await import('node:fs/promises');
      const text = await readFile(path, 'utf8');
      for (const account of chosen) {
        const result = await network.post(account, {
          text,
          extra: ctx.flags.publish ? { publish: 'true' } : {},
        });
        ctx.out(`${account.meta.board}: ${result.url}`);
      }
      return 0;
    }

    if (action === 'publish' || action === 'close') {
      const slug = rest[0];
      if (!slug) {
        ctx.out(`Which job? myna jobs ${action} <slug>`);
        return 1;
      }
      for (const account of chosen) {
        const client = clientFor(account);
        const result = await client.request('POST', `/api/v1/jobs/${encodeURIComponent(slug)}/${action}`);
        ctx.out(`${account.meta.board}: ${slug} is now ${result.job.status}`);
      }
      return 0;
    }

    if (action === 'applicants') {
      const slug = rest[0];
      if (!slug) {
        ctx.out('Which job? myna jobs applicants <slug>');
        return 1;
      }
      for (const account of chosen) {
        const result = await clientFor(account).applications(slug);
        ctx.out(`\n${account.meta.board}: ${result.items.length} applied`);
        for (const application of result.items) {
          const disclosed = application.agent
            ? `  [agent: ${application.agent.name}${application.agent.supervised ? ', supervised' : ''}]`
            : '';
          ctx.out(`  ${application.answers.name ?? 'someone'}  ${application.answers.email ?? ''}${disclosed}`);
        }
      }
      return 0;
    }

    ctx.out(`No such command: myna jobs ${action}`);
    return 1;
  },
};

export default {
  id: 'agenticjobs',
  name: 'Agentic Jobs',
  version: '0.1.0',
  description: 'Post openings to a self-hosted agenticjobs board, alongside the rest of a launch.',
  networks: [network],
  commands: [command],
};
