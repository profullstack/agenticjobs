/**
 * The terminal.
 *
 * The whole board is here, both halves of it: a candidate searches, prepares
 * and releases applications; an employer posts, publishes and reads what came
 * in. One account does both, because the person running an agency and the
 * person looking for work are frequently the same person on a different
 * afternoon.
 *
 * Every command goes through BoardClient, so the terminal and the browser are
 * looking at the same board through the same API.
 */

import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { flagBool, flagList, flagNumber, flagString, parseArgs, type Args } from './args.ts';
import { bold, dim } from './format.ts';
import { installLine, update as runUpdate, uninstall as runUninstall, whereIsIt } from './manage.ts';
import {
  ApiError,
  BoardClient,
  configuredBoards,
  currentBoard,
  DEFAULT_SERVER,
  forgetBoard,
  loadConfig,
  login,
  LoginError,
  normaliseServer,
  rememberBoard,
  saveConfig,
  searchEverywhere,
} from '../client/index.ts';
import { VERSION } from '../config.ts';
import { ago, formatSalary } from '../schema/text.ts';
import type { Job, JobQuery } from '../schema/index.ts';

const USAGE = `agenticjobs ${VERSION} - an agent-friendly job board you can self-host

  Account
    signup [email]            create an account and sign this terminal in
    login [server]            sign in to a board (device flow)
    logout [server]           forget a board
    boards                    every board you are signed in to
    use <server>              make one of them the default
    whoami                    who you are on the current board

  Finding work
    search <words>            search the current board
      --all                     ...or every board you are signed in to
      --network                 ...or every board in the directory
      --remote --agents         filter: remote only, agents welcome
      --min <n> --limit <n> --tag <t>
    show <slug>               one listing
    schema <slug>             the application form, as data

  Applying
    apply <slug>              apply, or prepare an application
      --resume <file|slug>      Markdown resume, or one you have saved
      --draft                   hold it for you to read and release
      --answer name=value       repeatable, one per field
      --agent <name>            disclose which agent wrote it
    drafts                    applications prepared but not sent
    submit <id>               send one

  Resumes
    resume list
    resume show <slug>
    resume save <file> [--slug s] [--title t]
    resume import <file>      pdf, docx, txt or md, converted to Markdown

  Hiring
    post <file.md>            post a job; stays a draft until you publish
    publish <slug>            take a draft live
    close <slug>              close a listing
    applications <slug>       what came in

  Running one
    serve                     start the board
    migrate                   apply migrations and exit
    seed                      add example data (never on a board with jobs)
    announce                  tell a directory this board exists
    instances                 boards a directory knows about
    tui                       the full-screen client
    mcp                       stdio MCP server for the current board

  This install
    update                    update to the latest release
    uninstall [--yes]         remove it; your logins are kept
    where                     what was installed, and where

  --server <url>              act on a board other than the default
  --json                      machine-readable output, on every command
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  // Version is checked before the empty-command case, because `--version`
  // on its own leaves no positional and would otherwise print the usage.
  if (flagBool(args, 'version', 'v') || args.command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (args.command === '' || flagBool(args, 'help', 'h')) {
    process.stdout.write(USAGE);
    return 0;
  }

  try {
    return await run(args);
  } catch (error) {
    if (error instanceof ApiError || error instanceof LoginError) {
      process.stderr.write(`${error.message}\n`);
      if (error instanceof ApiError) {
        for (const problem of error.fields) {
          process.stderr.write(`  ${problem.field}: ${problem.message}\n`);
        }
      }
      return 1;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function run(args: Args): Promise<number> {
  switch (args.command) {
    // Running a board. Imported lazily so `agenticjobs search` on a laptop
    // needs neither a database nor the server half of the code.
    case 'serve': {
      const { startServer } = await import('../server/serve.ts');
      await startServer();
      return new Promise<number>(() => undefined);
    }
    case 'migrate': {
      const { closePool, getPool } = await import('../db/pool.ts');
      const { migrate } = await import('../db/migrate.ts');
      const { loadConfig: serverConfig } = await import('../config.ts');
      const result = await migrate(getPool(serverConfig().databaseUrl));
      process.stdout.write(
        result.applied.length === 0
          ? `Nothing to apply; ${result.alreadyApplied} already there.\n`
          : `Applied: ${result.applied.join(', ')}\n`,
      );
      await closePool();
      return 0;
    }
    case 'seed': {
      const { closePool, getPool } = await import('../db/pool.ts');
      const { seed } = await import('../db/seed.ts');
      const { loadConfig: serverConfig } = await import('../config.ts');
      const added = await seed(getPool(serverConfig().databaseUrl));
      process.stdout.write(
        added === 0
          ? 'This board already has jobs, so nothing was added.\n'
          : `Added ${added} example listings.\n`,
      );
      await closePool();
      return 0;
    }
    case 'tui': {
      const { startTui } = await import('../tui/index.ts');
      await startTui(clientFor(args));
      return 0;
    }
    case 'mcp': {
      const { startStdio } = await import('../mcp/stdio.ts');
      await startStdio(clientFor(args));
      return new Promise<number>(() => undefined);
    }

    case 'signup':
      return commandSignup(args);
    case 'login':
      return commandLogin(args);
    case 'update':
      return runUpdate();
    case 'uninstall':
      return runUninstall({ yes: flagBool(args, 'yes', 'y') });
    case 'where':
      return whereIsIt();
    case 'logout':
      return commandLogout(args);
    case 'boards':
      return commandBoards(args);
    case 'use':
      return commandUse(args);
    case 'whoami':
      return commandWhoami(args);

    case 'search':
      return commandSearch(args);
    case 'show':
      return commandShow(args);
    case 'schema':
      return commandSchema(args);

    case 'apply':
      return commandApply(args);
    case 'drafts':
      return commandDrafts(args);
    case 'submit':
      return commandSubmit(args);

    case 'resume':
      return commandResume(args);

    case 'post':
      return commandPost(args);
    case 'publish':
    case 'close':
      return commandPublish(args);
    case 'applications':
      return commandApplications(args);

    case 'announce':
      return commandAnnounce(args);
    case 'instances':
      return commandInstances(args);

    default:
      process.stderr.write(`No command called "${args.command}".\n\n${USAGE}`);
      return 1;
  }
}

// --- helpers --------------------------------------------------------------

function clientFor(args: Args): BoardClient {
  const explicit = flagString(args, 'server', 's');
  if (explicit !== undefined) {
    const server = normaliseServer(explicit);
    const known = loadConfig().boards[server];
    return new BoardClient(server, { token: known?.token ?? null, userAgent: userAgent() });
  }
  const board = currentBoard();
  if (board === null) {
    throw new Error(
      `No board configured yet. Run:\n\n  agenticjobs login ${DEFAULT_SERVER}\n\nor pass --server <url>.`,
    );
  }
  return new BoardClient(board.server, { token: board.token, userAgent: userAgent() });
}

function userAgent(): string {
  return `agenticjobs-cli/${VERSION}`;
}

function out(args: Args, human: string, machine: unknown): number {
  if (flagBool(args, 'json')) {
    process.stdout.write(`${JSON.stringify(machine, null, 2)}\n`);
  } else {
    process.stdout.write(human.endsWith('\n') ? human : `${human}\n`);
  }
  return 0;
}

function queryFrom(args: Args): Partial<JobQuery> {
  const query: Partial<JobQuery> = {};
  const words = args.positional.join(' ').trim();
  if (words !== '') query.q = words;
  if (flagBool(args, 'remote')) query.workplace = 'remote';
  if (flagBool(args, 'agents')) query.agentPolicy = 'welcome';

  const workplace = flagString(args, 'workplace');
  if (workplace === 'remote' || workplace === 'hybrid' || workplace === 'onsite') {
    query.workplace = workplace;
  }
  const policy = flagString(args, 'agent-policy');
  if (policy === 'welcome' || policy === 'disclose' || policy === 'human-only') {
    query.agentPolicy = policy;
  }
  const tags = flagList(args, 'tag');
  if (tags.length > 0) {
    query.tags = tags.flatMap((tag) => tag.split(',')).map((tag) => tag.trim());
  }
  const min = flagNumber(args, 'min', 'salary-min');
  if (min !== undefined) query.salaryMin = min;
  const limit = flagNumber(args, 'limit', 'n');
  if (limit !== undefined) query.limit = limit;
  return query;
}

function jobLine(job: Job, where?: string): string {
  const salary = formatSalary(job.salary);
  const bits = [job.workplace, job.seniority, job.location, salary, `agents: ${job.agentPolicy}`]
    .filter((bit): bit is string => typeof bit === 'string' && bit !== '');
  return [
    `${job.title}  ${dim(`- ${job.org.name}`)}`,
    `  ${dim(bits.join(' | '))}`,
    `  ${dim(`${job.slug}  ${ago(job.publishedAt)}${where === undefined ? '' : `  ${where}`}`)}`,
  ].join('\n');
}

// --- boards ---------------------------------------------------------------

/**
 * Sign up from a terminal.
 *
 * A terminal cannot follow a magic link and a brand new account has no browser
 * session to approve a device code with, so signing up used to mean two
 * commands and a detour through the website. This does it in one: it opens a
 * device grant, then asks for a magic link that lands on /device with the code
 * already filled in. One click in the mail creates the account, signs the
 * browser in and puts the person on the approval page.
 */
async function commandSignup(args: Args): Promise<number> {
  const target = flagString(args, 'server', 's') ?? DEFAULT_SERVER;
  const server = normaliseServer(target);
  const client = new BoardClient(server, { userAgent: userAgent() });

  let name = server;
  try {
    const descriptor = await client.describe();
    name = descriptor.name;
    process.stdout.write(`${bold(descriptor.name)} - ${descriptor.tagline}\n\n`);
  } catch {
    process.stderr.write(`${server} did not answer as an agenticjobs board.\n`);
    return 1;
  }

  let email = args.positional[0] ?? flagString(args, 'email');
  if (email === undefined) {
    if (!process.stdin.isTTY) {
      process.stderr.write('Which email? agenticjobs signup you@example.com\n');
      return 1;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      email = (await rl.question('Email: ')).trim();
    } finally {
      rl.close();
    }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email ?? '')) {
    process.stderr.write('That does not look like an email address.\n');
    return 1;
  }

  const grant = await client.startDeviceAuth(
    `${process.env['USER'] ?? 'terminal'}@${process.env['HOSTNAME'] ?? 'machine'}`,
  );

  // The link lands on the approval page with the code already in the box, so
  // there is nothing to copy between two windows.
  const sent = await client.request<{ delivered: boolean }>('POST', '/api/v1/auth/magic-link', {
    email,
    redirect: `/device?code=${encodeURIComponent(grant.userCode)}`,
  });

  if (sent.delivered) {
    process.stdout.write(`A sign-in link is on its way to ${bold(email as string)}.\n`);
  } else {
    // The board could not send it - either it is configured to send nothing,
    // or its provider refused. Either way the link went to that board's log,
    // and saying so beats waiting for an email that is never going to arrive.
    process.stdout.write(
      `${server} could not send the email, so the link went to its server log instead.\n`,
    );
  }
  process.stdout.write(
    `Open it, and approve this terminal. Your code is ${bold(grant.userCode)}.\n\nWaiting...\n`,
  );

  const token = await login(client, {
    label: `${process.env['USER'] ?? 'terminal'}@${process.env['HOSTNAME'] ?? 'machine'}`,
    // The grant is already open, so the prompt has nothing left to say.
    onPrompt: () => undefined,
    existing: grant,
  });

  let signedInAs: string | null = null;
  try {
    signedInAs = (await client.me()).user.email;
  } catch {
    // A token that polls but cannot read /me is odd, not fatal.
  }
  rememberBoard({ server, token, email: signedInAs ?? (email as string), name });
  process.stdout.write(`\nSigned in to ${name} as ${signedInAs ?? email}.\n`);
  return 0;
}

async function commandLogin(args: Args): Promise<number> {
  const target = args.positional[0] ?? flagString(args, 'server') ?? DEFAULT_SERVER;
  const server = normaliseServer(target);
  const client = new BoardClient(server, { userAgent: userAgent() });

  // Confirms it is a board before asking anyone to type a code into a browser.
  let name = server;
  try {
    const descriptor = await client.describe();
    name = descriptor.name;
    process.stdout.write(`${bold(descriptor.name)} - ${descriptor.tagline}\n`);
  } catch {
    process.stdout.write(`${server} did not serve an instance descriptor. Trying anyway.\n`);
  }

  const token = await login(client, {
    label: `${process.env['USER'] ?? 'terminal'}@${process.env['HOSTNAME'] ?? 'machine'}`,
    onPrompt: (grant) => {
      process.stdout.write(
        `\nOpen ${bold(grant.verifyUrl)} and enter this code:\n\n    ${bold(grant.userCode)}\n\nWaiting...\n`,
      );
    },
  });

  let email: string | null = null;
  try {
    email = (await client.me()).user.email;
  } catch {
    // A token good enough for the poll but not for /me is odd, not fatal.
  }
  rememberBoard({ server, token, email, name });
  process.stdout.write(`\nSigned in to ${name}${email === null ? '' : ` as ${email}`}.\n`);
  return 0;
}

function commandLogout(args: Args): number {
  const target = args.positional[0] ?? currentBoard()?.server;
  if (target === undefined) {
    process.stderr.write('No board to forget.\n');
    return 1;
  }
  const removed = forgetBoard(target);
  process.stdout.write(
    removed ? `Forgot ${normaliseServer(target)}.\n` : `Not signed in to ${target}.\n`,
  );
  return removed ? 0 : 1;
}

function commandBoards(args: Args): number {
  const config = loadConfig();
  const boards = Object.values(config.boards);
  if (boards.length === 0) {
    return out(args, `No boards yet. Try:\n\n  agenticjobs login ${DEFAULT_SERVER}`, { boards: [] });
  }
  const lines = boards.map((board) => {
    const marker = board.server === config.current ? '*' : ' ';
    const who = board.email === null || board.email === undefined ? '' : dim(`  ${board.email}`);
    return `${marker} ${board.name ?? board.server}\n  ${dim(board.server)}${who}`;
  });
  return out(args, lines.join('\n'), { current: config.current, boards });
}

function commandUse(args: Args): number {
  const target = args.positional[0];
  if (target === undefined) {
    process.stderr.write('Which board? agenticjobs use <url>\n');
    return 1;
  }
  const config = loadConfig();
  const server = normaliseServer(target);
  if (config.boards[server] === undefined) {
    process.stderr.write(`Not signed in to ${server}. Run: agenticjobs login ${server}\n`);
    return 1;
  }
  config.current = server;
  saveConfig(config);
  process.stdout.write(`Now using ${server}.\n`);
  return 0;
}

async function commandWhoami(args: Args): Promise<number> {
  const client = clientFor(args);
  const me = await client.me();
  const lines = [
    `${me.user.email} on ${client.server}`,
    me.orgs.length === 0
      ? dim('  no employers - you cannot post yet')
      : `  employers: ${me.orgs.map((org) => org.slug).join(', ')}`,
    me.resumes.length === 0
      ? dim('  no resumes')
      : `  resumes:   ${me.resumes.map((resume) => resume.slug).join(', ')}`,
  ];
  return out(args, lines.join('\n'), me);
}

// --- finding work ---------------------------------------------------------

async function commandSearch(args: Args): Promise<number> {
  const query = queryFrom(args);

  if (flagBool(args, 'all')) {
    const boards = configuredBoards();
    if (boards.length === 0) {
      process.stderr.write('No boards configured. Run: agenticjobs login <url>\n');
      return 1;
    }
    const result = await searchEverywhere(boards, query);
    const failed = result.sources.filter((source) => !source.ok);
    const body = result.jobs.map((hit) => jobLine(hit.job, hit.boardName)).join('\n\n');
    const note =
      failed.length === 0
        ? ''
        : `\n\n${dim(`${failed.length} board(s) did not answer: ${failed.map((source) => `${source.name} (${source.error ?? 'no reason given'})`).join(', ')}`)}`;
    return out(
      args,
      `${result.jobs.length} of ${result.total} across ${result.sources.length} boards\n\n${body}${note}`,
      result,
    );
  }

  if (flagBool(args, 'network')) {
    const result = (await clientFor(args).searchNetwork(query)) as {
      jobs: { job: Job; instanceName: string; url: string }[];
      sources: { name: string; ok: boolean }[];
    };
    const body = result.jobs.map((hit) => jobLine(hit.job, hit.instanceName)).join('\n\n');
    return out(args, body === '' ? 'Nothing matched on any listed board.' : body, result);
  }

  const client = clientFor(args);
  const page = await client.search(query);
  if (page.items.length === 0) {
    return out(
      args,
      `Nothing on ${client.server} matches that.\n${dim('This board only holds listings posted to it, so that means nobody posted one - not that a crawler missed it.')}`,
      page,
    );
  }
  const body = page.items.map((job) => jobLine(job)).join('\n\n');
  return out(args, `${page.total} match, showing ${page.items.length}\n\n${body}`, page);
}

async function commandShow(args: Args): Promise<number> {
  const slug = args.positional[0];
  if (slug === undefined) {
    process.stderr.write('Which job? agenticjobs show <slug>\n');
    return 1;
  }
  const found = await clientFor(args).job(slug);
  const job = found.job;
  const how = `agenticjobs apply ${job.slug}`;
  const lines = [
    bold(job.title),
    `${job.org.name}${job.location === null ? '' : ` - ${job.location}`}`,
    dim(
      [job.workplace, job.employmentType, job.seniority, formatSalary(job.salary), `agents: ${job.agentPolicy}`]
        .filter((bit) => typeof bit === 'string' && bit !== '')
        .join(' | '),
    ),
    '',
    job.description,
    '',
    dim(`Apply: ${how}`),
  ];
  return out(args, lines.join('\n'), found);
}

async function commandSchema(args: Args): Promise<number> {
  const slug = args.positional[0];
  if (slug === undefined) {
    process.stderr.write('Which job? agenticjobs schema <slug>\n');
    return 1;
  }
  process.stdout.write(`${JSON.stringify(await clientFor(args).applySchema(slug), null, 2)}\n`);
  return 0;
}

// --- applying -------------------------------------------------------------

async function commandApply(args: Args): Promise<number> {
  const slug = args.positional[0];
  if (slug === undefined) {
    process.stderr.write('Which job? agenticjobs apply <slug>\n');
    return 1;
  }
  const client = clientFor(args);

  const body: Record<string, unknown> = {};
  for (const pair of flagList(args, 'answer', 'a')) {
    const equals = pair.indexOf('=');
    if (equals < 0) {
      process.stderr.write(`--answer wants name=value, got "${pair}".\n`);
      return 1;
    }
    body[pair.slice(0, equals)] = pair.slice(equals + 1);
  }

  const resume = flagString(args, 'resume', 'r');
  if (resume !== undefined) {
    // A path if it reads as one, otherwise the slug of a saved resume. Decided
    // by trying to read it rather than by guessing from the shape of the name.
    try {
      body['resume'] = await readFile(resume, 'utf8');
    } catch {
      body['resumeSlug'] = resume;
    }
  }

  const agentName = flagString(args, 'agent');
  if (agentName !== undefined) {
    body['agent'] = { name: agentName, supervised: !flagBool(args, 'unsupervised') };
  }

  const draft = flagBool(args, 'draft');
  if (draft) body['submit'] = false;

  const response = (await client.apply(slug, body)) as { applicationId: string };

  if (draft) {
    return out(
      args,
      [
        'Prepared, not sent. Nobody at the employer can see it yet.',
        '',
        '  read it:  agenticjobs drafts',
        `  send it:  agenticjobs submit ${response.applicationId}`,
      ].join('\n'),
      response,
    );
  }
  return out(args, `Sent to ${slug}.`, response);
}

async function commandDrafts(args: Args): Promise<number> {
  const result = await clientFor(args).request<{
    items: { id: string; jobTitle: string; createdAt: string }[];
  }>('GET', '/api/v1/applications/drafts');

  if (result.items.length === 0) return out(args, 'No applications waiting for you.', result);

  const lines = result.items.map((draft) =>
    [
      bold(draft.jobTitle),
      `  ${dim(`prepared ${ago(draft.createdAt)}`)}`,
      `  ${dim(`send: agenticjobs submit ${draft.id}`)}`,
    ].join('\n'),
  );
  return out(
    args,
    `${result.items.length} waiting for you to read and send\n\n${lines.join('\n\n')}`,
    result,
  );
}

async function commandSubmit(args: Args): Promise<number> {
  const id = args.positional[0];
  if (id === undefined) {
    process.stderr.write('Which one? agenticjobs submit <id>\n');
    return 1;
  }
  await clientFor(args).request('POST', `/api/v1/applications/${encodeURIComponent(id)}/submit`);
  return out(args, 'Sent.', { ok: true });
}

// --- resumes --------------------------------------------------------------

async function commandResume(args: Args): Promise<number> {
  const action = args.positional[0] ?? 'list';
  const client = clientFor(args);

  if (action === 'list') {
    const result = await client.resumes();
    if (result.items.length === 0) return out(args, 'No resumes yet.', result);
    return out(
      args,
      result.items.map((resume) => `${resume.slug}  ${dim(resume.title)}`).join('\n'),
      result,
    );
  }

  if (action === 'show') {
    const slug = args.positional[1];
    if (slug === undefined) {
      process.stderr.write('Which one? agenticjobs resume show <slug>\n');
      return 1;
    }
    const result = await client.request<{ resume: { markdown: string } }>(
      'GET',
      `/api/v1/resumes/${encodeURIComponent(slug)}`,
    );
    process.stdout.write(`${result.resume.markdown}\n`);
    return 0;
  }

  if (action === 'save') {
    const path = args.positional[1];
    if (path === undefined) {
      process.stderr.write('Which file? agenticjobs resume save <file.md>\n');
      return 1;
    }
    const slug = flagString(args, 'slug');
    const title = flagString(args, 'title');
    const saved = await client.saveResume(await readFile(path, 'utf8'), {
      ...(slug === undefined ? {} : { slug }),
      ...(title === undefined ? {} : { title }),
    });
    return out(args, 'Saved.', saved);
  }

  if (action === 'import') {
    const path = args.positional[1];
    if (path === undefined) {
      process.stderr.write('Which file? agenticjobs resume import <file>\n');
      return 1;
    }
    const { importDocument } = await import('../core/import.ts');
    const imported = await importDocument(path, await readFile(path));
    const title = flagString(args, 'title');
    // Converted on this machine, so the original file never leaves it.
    const saved = await client.saveResume(imported.markdown, {
      ...(title === undefined ? {} : { title }),
    });
    for (const warning of imported.warnings) process.stderr.write(`note: ${warning}\n`);
    return out(args, `Converted from ${imported.via} and saved.`, saved);
  }

  process.stderr.write(`No resume command called "${action}".\n`);
  return 1;
}

// --- hiring ---------------------------------------------------------------

async function commandPost(args: Args): Promise<number> {
  const client = clientFor(args);
  const path = args.positional[0];

  let input: Record<string, unknown> = {};
  if (path !== undefined) {
    const { parseJobDocument } = await import('./jobfile.ts');
    input = parseJobDocument(await readFile(path, 'utf8'));
  }

  for (const key of [
    'org',
    'title',
    'employmentType',
    'workplace',
    'seniority',
    'location',
    'salaryMin',
    'salaryMax',
    'salaryCurrency',
    'salaryPeriod',
    'tags',
    'stack',
    'agentPolicy',
  ]) {
    const value = flagString(args, key);
    if (value !== undefined) input[key] = value;
  }

  if (input['org'] === undefined) {
    process.stderr.write('Which employer? Pass --org <slug>, or put "org:" in the front matter.\n');
    return 1;
  }
  if (flagBool(args, 'publish')) input['publish'] = true;

  const created = await client.postJob(input);
  const live = created.job.status === 'published';
  return out(
    args,
    `Created ${live ? 'and published' : 'as a draft'}: ${created.job.slug}\n${live ? '' : dim(`  publish it: agenticjobs publish ${created.job.slug}`)}`,
    created,
  );
}

async function commandPublish(args: Args): Promise<number> {
  const slug = args.positional[0];
  if (slug === undefined) {
    process.stderr.write(`Which job? agenticjobs ${args.command} <slug>\n`);
    return 1;
  }
  const action = args.command === 'close' ? 'close' : 'publish';
  const result = await clientFor(args).request<{ job: Job }>(
    'POST',
    `/api/v1/jobs/${encodeURIComponent(slug)}/${action}`,
  );
  return out(args, `${slug} is now ${result.job.status}.`, result);
}

async function commandApplications(args: Args): Promise<number> {
  const slug = args.positional[0];
  if (slug === undefined) {
    process.stderr.write('Which job? agenticjobs applications <slug>\n');
    return 1;
  }
  const result = await clientFor(args).request<{
    items: {
      id: string;
      answers: Record<string, string>;
      agent: { name: string; supervised: boolean } | null;
      status: string;
      createdAt: string;
    }[];
  }>('GET', `/api/v1/jobs/${encodeURIComponent(slug)}/applications`);

  if (result.items.length === 0) return out(args, 'Nobody yet.', result);

  const lines = result.items.map((application) => {
    const disclosure =
      application.agent === null
        ? ''
        : dim(
            `  agent: ${application.agent.name}${application.agent.supervised ? ' (supervised)' : ''}`,
          );
    const cover = application.answers['cover'];
    return [
      `${bold(application.answers['name'] ?? 'Someone')}  ${dim(application.answers['email'] ?? '')}`,
      `  ${dim(`${application.status} - ${ago(application.createdAt)}`)}`,
      disclosure,
      cover === undefined ? '' : `  ${cover.slice(0, 300)}`,
    ]
      .filter((line) => line !== '')
      .join('\n');
  });
  return out(args, `${result.items.length} applications\n\n${lines.join('\n\n')}`, result);
}

// --- federation -----------------------------------------------------------

async function commandAnnounce(args: Args): Promise<number> {
  const { announceOnce } = await import('../directory/announce.ts');
  const { loadConfig: serverConfig, sameOrigin } = await import('../config.ts');
  const config = serverConfig();
  const directory = flagString(args, 'directory') ?? config.directoryUrl;
  const self = flagString(args, 'url') ?? config.publicUrl;
  if (directory === null || directory === undefined) {
    process.stderr.write('No directory. Pass --directory <url> or set DIRECTORY_URL.\n');
    return 1;
  }
  if (sameOrigin(directory, self)) {
    // A board in its own listing is noise at best, so this refuses rather
    // than doing it. The flagship is both a board and the directory, which
    // makes this an easy command to run by accident.
    process.stderr.write(`${directory} is this board. A board is not listed in its own directory.\n`);
    return 1;
  }
  await announceOnce(directory, self);
  process.stdout.write(`Announced ${self} to ${directory}.\n`);
  return 0;
}

async function commandInstances(args: Args): Promise<number> {
  const result = await clientFor(args).instances();
  if (result.items.length === 0) return out(args, 'That directory lists no boards.', result);
  const lines = result.items.map((instance) =>
    [
      `${instance.online ? '*' : ' '} ${bold(instance.descriptor.name)}`,
      `  ${dim(instance.url)}`,
      `  ${dim(`${instance.descriptor.jobs.open} open - ${instance.descriptor.topics.join(', ')}`)}`,
    ].join('\n'),
  );
  return out(args, lines.join('\n\n'), result);
}

const code = await main();
if (code !== 0) process.exitCode = code;
