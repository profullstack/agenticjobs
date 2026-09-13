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
import { settingsRoutes } from './routes/settings.ts';
import { pageRoutes } from './routes/pages.tsx';
import { inboxRoutes } from './routes/inbox.tsx';
import { discoveryRoutes } from './routes/discovery.ts';
import { mcpRoutes } from './routes/mcp.ts';
import { passkeyRoutes } from './routes/passkey.ts';
import { apiCors, securityHeaders, withViewer } from './middleware.ts';
import { Layout } from '../views/layout.tsx';
import { createMailer } from '../core/mail.ts';
import type { Mailer } from '../core/mail.ts';
import { createCoinPay, type CoinPayClient } from '../core/coinpay.ts';
import type { AppEnv, Deps } from './deps.ts';

/**
 * The mailer and the CoinPay client are built once, here, and injectable so a
 * test can watch what would have been sent without a provider or a network.
 */
export function createApp(
  pool: pg.Pool,
  config: Config,
  mailer: Mailer | null = createMailer(config),
  coinpay: CoinPayClient | null = config.coinpay === null ? null : createCoinPay(config.coinpay),
): Hono<AppEnv> {
  const deps: Deps = { pool, config, mailer, coinpay };
  const app = new Hono<AppEnv>();

  app.use('*', withViewer(deps));
  // A payer is sent from a form on this board to CoinPay's hosted pay page,
  // and the policy has to say so or the browser stops the redirect.
  app.use(
    '*',
    securityHeaders({ formActions: config.coinpay === null ? [] : [config.coinpay.url] }),
  );
  app.use('/api/*', apiCors());

  // Settings sync (@profullstack/synconfig): the boards a member uses, on
  // every machine. Mounted before the API router, whose catch-all answers
  // 404 for any /api/v1 path it does not know, this one included.
  app.route('/api/v1/settings', settingsRoutes());
  app.route('/api/v1', apiRoutes());
  // The MCP tools call this same app, so the getter is resolved lazily: the
  // app does not exist yet at the point the routes are mounted on it.
  app.route(
    '/api/mcp',
    mcpRoutes(() => app),
  );
  app.route('/auth/passkey', passkeyRoutes());
  app.route('/', discoveryRoutes());
  app.route('/', inboxRoutes());
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
