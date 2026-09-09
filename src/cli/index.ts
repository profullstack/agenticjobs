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
import { APPLICATION_DECISIONS, isApplicationDecision } from '../schema/job.ts';
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

  Updates
    news                      the updates on this board
      --org <slug>              ...from one employer
      --candidate <slug>        ...from one candidate
      --following               ...from everyone you follow
    news post <text>          post one; --link <url>, --org <slug> to post as an employer
    follow <slug>             follow an employer; --candidate for a person
    unfollow <slug>           stop

  Hiring
    post <file.md>            post a job; stays a draft until you publish
    new <url>                 import a job from a URL, as a draft
    update <url>              re-read that URL into the listing it created
      --slug <slug>             ...adopting a listing that was written by hand
                              (with no URL, updates this install instead)
    edit <slug> <file.md>     rewrite a listing, keeping its URL
    publish <slug>            take a draft live
    close <slug>              close a listing
    applications <slug>       what came in
    decide <id> <status>      reviewing, rejected or hired

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
    // `update` means two things, told apart by whether it was given a URL.
    // `agenticjobs update` updates this install, which it did long before
    // there was an importer and which people have in their fingers;
    // `agenticjobs update <url>` re-reads that URL into the listing it made.
    // A separate verb was the alternative, but "update the job at this URL" is
    // what the command is for and is what it should be called.
    case 'update':
      return looksLikeUrl(args.positional[0]) ? commandImport(args) : runUpdate();
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
    case 'new':
      return commandImport(args);
    case 'edit':
      return commandEdit(args);
    case 'publish':
    case 'close':
      return commandPublish(args);
    case 'applications':
      return commandApplications(args);
    case 'decide':
      return commandDecide(args);

    case 'news':
      return commandNews(args);
    case 'follow':
    case 'unfollow':
      return commandFollow(args);

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
        // The URL already carries the code, so the usual path is one click.
        // The code is printed too, for a browser on another machine.
        `\nOpen ${bold(grant.verifyUrl)} to approve this terminal.\n\nYour code is ${bold(grant.userCode)}, if you need to type it.\n\nWaiting...\n`,
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

/**
 * `new <url>` and `update <url>` are the same call.
 *
 * The board keys an import on the URL it came from, so re-importing refreshes
 * that listing instead of making a second copy of one job. Two verbs because
 * two intentions, one endpoint because there is only one sane behaviour.
 */
/** A positional that is an http(s) URL, which is how `update` tells its two jobs apart. */
export function looksLikeUrl(value: string | undefined): boolean {
  if (value === undefined) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

async function commandImport(args: Args): Promise<number> {
  const url = args.positional[0];
  if (url === undefined) {
    process.stderr.write(`Which URL? agenticjobs ${args.command} https://example.com/jobs/123\n`);
    return 1;
  }

  const org = flagString(args, 'org');
  // --slug adopts a listing that was written by hand, so it can be refreshed
  // from its page from now on instead of duplicated by it.
  const slug = flagString(args, 'slug');
  const result = await clientFor(args).importJob({
    url,
    ...(org === undefined ? {} : { org }),
    ...(slug === undefined ? {} : { slug }),
    ...(flagString(args, 'agentPolicy') === undefined
      ? {}
      : { agentPolicy: flagString(args, 'agentPolicy') as string }),
  });

  const lines = [
    result.created
      ? `Imported as a draft: ${result.job.slug}`
      : `Refreshed: ${result.job.slug}`,
    result.via === 'jsonld'
      ? dim('  read from the JobPosting data the page publishes')
      : dim('  that page publishes no JobPosting data, so this was read off the page'),
    ...result.warnings.map((warning) => dim(`  ${warning}`)),
    result.job.status === 'published'
      ? ''
      : dim(`  publish it: agenticjobs publish ${result.job.slug}`),
  ].filter((line) => line !== '');

  return out(args, lines.join('\n'), result);
}

/**
 * Rewrite a listing from a file, keeping its slug.
 *
 * The board could publish and close a listing and not change a word of it, so
 * a typo could only be fixed by closing it and posting again under a new URL.
 * This is also how an import off a page with no JobPosting data gets tidied.
 */
async function commandEdit(args: Args): Promise<number> {
  const slug = args.positional[0];
  const path = args.positional[1];
  if (slug === undefined || path === undefined) {
    process.stderr.write('Which listing, and from what? agenticjobs edit <slug> <file.md>\n');
    return 1;
  }
  const { parseJobDocument } = await import('./jobfile.ts');
  const input = parseJobDocument(await readFile(path, 'utf8'));
  const result = await clientFor(args).editJob(slug, input);
  return out(args, `Updated ${result.job.slug}.`, result);
}

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

  // A flag rather than a value, because "unpaid" is a fact about the role and
  // not a number. `salary_unpaid: true` in front matter already arrives on its
  // own, camel-cased with every other key.
  if (flagBool(args, 'salary-unpaid')) input['salaryUnpaid'] = true;

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
      // The id is here so `decide` has something to take. Reading applications
      // and acting on them is one sitting, and sending someone to the API to
      // find the id of the row they are looking at is not a workflow.
      `  ${dim(application.id)}`,
      `  ${dim(`${application.status} - ${ago(application.createdAt)}`)}`,
      disclosure,
      cover === undefined ? '' : `  ${cover.slice(0, 300)}`,
    ]
      .filter((line) => line !== '')
      .join('\n');
  });
  return out(args, `${result.items.length} applications\n\n${lines.join('\n\n')}`, result);
}

async function commandDecide(args: Args): Promise<number> {
  const [id, status] = args.positional;
  if (id === undefined || status === undefined) {
    process.stderr.write(
      `Which one, and what? agenticjobs decide <id> <${APPLICATION_DECISIONS.join('|')}>\n`,
    );
    return 1;
  }
  if (!isApplicationDecision(status)) {
    process.stderr.write(`Not a decision: ${status}. Use ${APPLICATION_DECISIONS.join(', ')}.\n`);
    return 1;
  }

  const result = await clientFor(args).request<{
    application: { answers: Record<string, string>; status: string };
  }>('POST', `/api/v1/applications/${encodeURIComponent(id)}/decision`, { status });

  const who = result.application.answers['name'] ?? 'That application';
  return out(
    args,
    `${who} is now ${result.application.status}. ${dim('The candidate was not emailed.')}`,
    result,
  );
}

// --- federation -----------------------------------------------------------

/**
 * Updates, read and written.
 *
 * `news post` rather than a second top-level verb, because "post" already
 * means a job here and a board where `post` sometimes means a job and
 * sometimes means a status line is a board where somebody eventually
 * publishes the wrong one.
 */
async function commandNews(args: Args): Promise<number> {
  const client = clientFor(args);

  if (args.positional[0] === 'post') {
    const body = args.positional.slice(1).join(' ').trim();
    if (body === '') {
      process.stderr.write('Say something: agenticjobs news post "we shipped it" --link https://...\n');
      return 1;
    }
    const link = flagString(args, 'link');
    const org = flagString(args, 'org');
    const posted = await client.postUpdate({
      body,
      ...(link === null || link === undefined ? {} : { link }),
      ...(org === null || org === undefined ? {} : { org }),
    });
    return out(args, `Posted. It is on ${posted.author}.`, posted);
  }

  const org = flagString(args, 'org');
  const candidate = flagString(args, 'candidate');
  const result = await client.updates({
    ...(org === null || org === undefined ? {} : { org }),
    ...(candidate === null || candidate === undefined ? {} : { candidate }),
    ...(flagBool(args, 'following') ? { following: true } : {}),
  });
  if (result.items.length === 0) return out(args, 'Nothing posted yet.', result);
  const lines = result.items.map((update) =>
    [
      `${bold(update.author.name)} ${dim(ago(update.createdAt))}`,
      `  ${update.body.replace(/\n/g, '\n  ')}`,
      ...(update.link === null ? [] : [`  ${dim(update.link)}`]),
    ].join('\n'),
  );
  return out(args, lines.join('\n\n'), result);
}

async function commandFollow(args: Args): Promise<number> {
  const following = args.command === 'follow';
  const candidate = flagBool(args, 'candidate');
  const slug = args.positional[0] ?? '';
  if (slug === '') {
    process.stderr.write('Which one? agenticjobs follow <employer-slug> [--candidate]\n');
    return 1;
  }
  const result = await clientFor(args).setFollow(
    candidate ? { candidate: slug } : { org: slug },
    following,
  );
  return out(
    args,
    `${following ? 'Following' : 'Not following'} ${slug}. ${result.followers} ${result.followers === 1 ? 'follower' : 'followers'}.`,
    result,
  );
}

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
