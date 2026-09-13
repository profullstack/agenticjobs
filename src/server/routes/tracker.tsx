import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '../deps.ts';
import {
  deleteSource,
  findFleet,
  fleetReport,
  importEvents,
  leaderboard,
  ownedFleets,
  ownerFleet,
  saveFleet,
  TrackerProblem,
} from '../../core/tracker.ts';
import { listResumes } from '../../core/resumes.ts';
import { Layout } from '../../views/layout.tsx';
import { Leaderboard, TrackerPage } from '../../views/tracker.tsx';
import { formOf, requireViewer, shell } from './pages.tsx';
import { readFile } from 'node:fs/promises';
import { renderMarkdown } from '../../markup/markdown.ts';
import { raw } from 'hono/html';

type Ctx = Context<AppEnv>;
const safe =
  (fn: (c: Ctx) => Promise<Response>) =>
  async (c: Ctx): Promise<Response> => {
    try {
      return await fn(c);
    } catch (error) {
      if (!(error instanceof TrackerProblem)) throw error;
      if (c.req.path.startsWith('/api/'))
        return c.json({ error: { code: 'tracker_error', message: error.message } }, error.status);
      return c.html(
        <Layout {...shell(c)} title="Fleet tracker" noindex>
          <h1>Could not save fleet</h1>
          <p role="alert">{error.message}</p>
          <a href="/tracker">Back to your tracker</a>
        </Layout>,
        error.status,
      );
    }
  };
const user = (c: Ctx) => {
  const viewer = c.get('viewer');
  if (!viewer)
    return c.json(
      { error: { code: 'unauthorized', message: 'Sign in to manage your fleet.' } },
      401,
    );
  return viewer;
};
function mutation(c: Ctx) {
  const origin = c.req.header('origin');
  const bearer = /^Bearer /i.test(c.req.header('authorization') ?? '');
  if ((origin && origin !== new URL(c.get('deps').config.publicUrl).origin) || (!bearer && !origin))
    throw new TrackerProblem('Submit this change from the board or an authenticated CLI.', 403);
}
async function json(c: Ctx): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new TrackerProblem('Expected valid JSON.');
  }
}

export function trackerRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use(
    '/api/v1/tracker/*',
    bodyLimit({
      maxSize: 5 * 1024 * 1024,
      onError: (c) =>
        c.json(
          { error: { code: 'too_large', message: 'Tracker imports are limited to 5 MB.' } },
          413,
        ),
    }),
  );
  routes.use(
    '/tracker/*',
    bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.text('Fleet form is too large.', 413) }),
  );
  routes.get(
    '/api/v1/tracker/leaderboard',
    safe(async (c) => c.json({ fleets: await leaderboard(c.get('deps').pool) })),
  );
  routes.get(
    '/api/v1/tracker/fleets',
    safe(async (c) => {
      const viewer = user(c);
      if (viewer instanceof Response) return viewer;
      c.header('cache-control', 'private, no-store');
      return c.json({ fleets: await ownedFleets(c.get('deps').pool, viewer.id) });
    }),
  );
  routes.post(
    '/api/v1/tracker/fleets',
    safe(async (c) => {
      const viewer = user(c);
      if (viewer instanceof Response) return viewer;
      mutation(c);
      return c.json({ fleet: await saveFleet(c.get('deps').pool, viewer.id, await json(c)) });
    }),
  );
  routes.get(
    '/api/v1/tracker/fleets/:slug',
    safe(async (c) => {
      const viewer = user(c);
      if (viewer instanceof Response) return viewer;
      c.header('cache-control', 'private, no-store');
      const pool = c.get('deps').pool;
      return c.json(
        await fleetReport(pool, await ownerFleet(pool, c.req.param('slug') ?? '', viewer.id)),
      );
    }),
  );
  routes.post(
    '/api/v1/tracker/fleets/:slug/import',
    safe(async (c) => {
      const viewer = user(c);
      if (viewer instanceof Response) return viewer;
      mutation(c);
      const pool = c.get('deps').pool;
      const fleet = await ownerFleet(pool, c.req.param('slug') ?? '', viewer.id);
      return c.json(await importEvents(pool, fleet, await json(c)));
    }),
  );
  routes.delete(
    '/api/v1/tracker/fleets/:slug/sources/:source',
    safe(async (c) => {
      const viewer = user(c);
      if (viewer instanceof Response) return viewer;
      mutation(c);
      const pool = c.get('deps').pool;
      return c.json(
        await deleteSource(
          pool,
          await ownerFleet(pool, c.req.param('slug') ?? '', viewer.id),
          c.req.param('source') ?? '',
        ),
      );
    }),
  );
  routes.get(
    '/tracker',
    safe(async (c) => {
      const viewer = requireViewer(c);
      if (viewer instanceof Response) return viewer;
      c.header('cache-control', 'private, no-store');
      const pool = c.get('deps').pool;
      const fleets = await ownedFleets(pool, viewer.id);
      const selected =
        c.req.query('new') === '1'
          ? undefined
          : (fleets.find((f) => f.slug === c.req.query('fleet')) ?? fleets[0]);
      const report = selected ? await fleetReport(pool, selected) : null;
      const profiles = (await listResumes(pool, viewer.id))
        .filter((r) => r.visibility === 'public' && r.publicSlug)
        .map((r) => ({ slug: r.publicSlug!, title: r.title }));
      return c.html(
        <Layout {...shell(c)} title="Fleet tracker" noindex>
          <TrackerPage fleets={fleets} report={report} profiles={profiles} />
        </Layout>,
      );
    }),
  );
  routes.post(
    '/tracker/fleet',
    safe(async (c) => {
      const viewer = requireViewer(c);
      if (viewer instanceof Response) return viewer;
      mutation(c);
      const form = await formOf(c);
      const fleet = await saveFleet(c.get('deps').pool, viewer.id, {
        ...form,
        agents: Number(form['agents']),
        rate: Number(form['rate']),
        retainedTarget: Number(form['retainedTarget']),
        assumedDirectCost: Number(form['assumedDirectCost']),
        publicListing: form['publicListing'] === 'true',
      });
      return c.redirect(`/tracker?fleet=${fleet.slug}`, 303);
    }),
  );
  routes.get(
    '/tracker/leaderboard',
    safe(async (c) =>
      c.html(
        <Layout {...shell(c)} title="Fleet capacity leaderboard">
          <Leaderboard fleets={await leaderboard(c.get('deps').pool)} />
        </Layout>,
      ),
    ),
  );
  routes.get(
    '/tracker/docs',
    safe(async (c) => {
      const markdown = await readFile(new URL('../../../docs/tracker.md', import.meta.url), 'utf8');
      return c.html(
        <Layout {...shell(c)} title="Fleet tracker guide">
          <article class="prose">{raw(renderMarkdown(markdown))}</article>
        </Layout>,
      );
    }),
  );
  for (const representation of ['', '/openprofile.md'])
    routes.get(
      `/fleets/:slug${representation}`,
      safe(async (c) => {
        const { pool, config } = c.get('deps');
        const fleet = await findFleet(pool, c.req.param('slug') ?? '', c.get('viewer')?.id);
        if (!fleet) return c.notFound();
        c.header('cache-control', 'private, no-store');
        const profile = `${config.publicUrl}/candidates/${fleet.operatorSlug}/openprofile.md`;
        if (representation)
          return c.text(
            `# ${fleet.slug}\n\n- **Kind**: fleet\n- **Operator**: ${profile}\n- **Agents**: ${fleet.agents}\n- **Rate**: ${fleet.currency} ${fleet.rate}/hour/agent\n- **Tracker**: ${config.publicUrl}/tracker\n`,
          );
        return c.html(
          <Layout
            {...shell(c)}
            title={fleet.slug}
            noindex={!fleet.publicListing}
            openprofile={`${config.publicUrl}/fleets/${fleet.slug}/openprofile.md`}
          >
            <h1>{fleet.slug}</h1>
            <p>
              {fleet.agents} declared agents · {fleet.currency} {fleet.rate}/agent-hour
            </p>
            <p>
              Operated by <a href={`/candidates/${fleet.operatorSlug}`}>{fleet.operatorSlug}</a>.
            </p>
            <a href={`/fleets/${fleet.slug}/openprofile.md`}>OpenProfile.md</a>
            <p>Financial reports are private to the fleet operator.</p>
          </Layout>,
        );
      }),
    );
  return routes;
}
