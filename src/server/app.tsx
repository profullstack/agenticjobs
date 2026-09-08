/**
 * The application, assembled.
 *
 * One Hono app carries every surface a browser or a machine can reach. The MCP
 * endpoint dispatches through this app's own fetch rather than reaching into
 * the database, so a tool call takes the same code path and the same
 * permission checks a browser request does.
 */

import { Hono } from 'hono';
import type pg from 'pg';
import type { Config } from '../config.ts';
import { apiRoutes } from './routes/api.ts';
import { pageRoutes } from './routes/pages.tsx';
import { discoveryRoutes } from './routes/discovery.ts';
import { mcpRoutes } from './routes/mcp.ts';
import { apiCors, securityHeaders, withViewer } from './middleware.ts';
import { Layout } from '../views/layout.tsx';
import type { AppEnv, Deps } from './deps.ts';

export function createApp(pool: pg.Pool, config: Config): Hono<AppEnv> {
  const deps: Deps = { pool, config };
  const app = new Hono<AppEnv>();

  app.use('*', withViewer(deps));
  app.use('*', securityHeaders());
  app.use('/api/*', apiCors());

  app.route('/api/v1', apiRoutes());
  // The MCP tools call this same app, so the getter is resolved lazily: the
  // app does not exist yet at the point the routes are mounted on it.
  app.route('/api/mcp', mcpRoutes(() => app));
  app.route('/', discoveryRoutes());
  app.route('/', pageRoutes());

  app.notFound((c) => {
    // A machine asking for JSON gets JSON. Handing an HTML 404 to a client
    // that asked for JSON is how a parse error ends up masking a typo in a URL.
    if (wantsJson(c.req.header('accept'), c.req.path)) {
      return c.json({ error: { message: `Nothing at ${c.req.path}.`, code: 'not_found' } }, 404);
    }
    return c.html(
      <Layout
        viewer={c.get('viewer')}
        boardName={config.boardName}
        publicUrl={config.publicUrl}
        path={c.req.path}
        isDirectory={config.isDirectory}
        title="Not found"
        noindex
      >
        <div class="empty">
          <h1>Not found</h1>
          <p>
            Nothing lives at <code>{c.req.path}</code>.
          </p>
          <p>
            <a class="btn" href="/">
              Back to the jobs
            </a>
          </p>
        </div>
      </Layout>,
      404,
    );
  });

  app.onError((error, c) => {
    // The message is logged, never returned: it can carry a query, a column
    // name or a connection string.
    console.error(`error on ${c.req.method} ${c.req.path}:`, error);
    if (wantsJson(c.req.header('accept'), c.req.path)) {
      return c.json(
        { error: { message: 'Something went wrong on this board.', code: 'internal' } },
        500,
      );
    }
    return c.html(
      <Layout
        viewer={null}
        boardName={config.boardName}
        publicUrl={config.publicUrl}
        path={c.req.path}
        title="Something went wrong"
        noindex
      >
        <div class="empty">
          <h1>Something went wrong</h1>
          <p>That is this board's fault, not yours. It has been logged.</p>
        </div>
      </Layout>,
      500,
    );
  });

  return app;
}

function wantsJson(accept: string | undefined, path: string): boolean {
  if (path.startsWith('/api/')) return true;
  if (accept === undefined) return false;
  return accept.includes('application/json') && !accept.includes('text/html');
}
