/**
 * Cross-cutting request handling: who is asking, and what the browser is
 * allowed to do with the answer.
 */

import { getCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono';
import { SESSION_COOKIE, viewerFromToken } from '../core/auth.ts';
import type { AppEnv, Deps } from './deps.ts';

/**
 * Resolve the caller.
 *
 * Two sources, and the order matters. A bearer token wins over a cookie so
 * that a person signed in to the board in one tab can still drive the API as
 * a different identity from a script in another.
 *
 * A bad token is not an error here: it is simply nobody. Handlers that need
 * an identity say so themselves, and the ones that do not - the job list, a
 * job page - must keep working for a stranger with a stale token in their
 * config file.
 */
export function withViewer(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set('deps', deps);
    c.set('viewer', null);

    const header = c.req.header('authorization') ?? '';
    const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
    if (bearer !== undefined && bearer !== '') {
      c.set('viewer', await viewerFromToken(deps.pool, bearer));
      await next();
      return;
    }

    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie !== undefined && cookie !== '') {
      c.set('viewer', await viewerFromToken(deps.pool, cookie));
    }
    await next();
  };
}

/**
 * Security headers.
 *
 * The board ships no inline script, so script-src needs no 'unsafe-inline'.
 * It does ship exactly one third-party script - the CrawlProof stats tag in
 * the layout - and that host has to be named here or the browser drops it with
 * nothing to show for it but a console line nobody is looking at. A tracker
 * that silently never runs is worse than no tracker: the numbers look like an
 * audience rather than like a bug.
 *
 * Styles need 'unsafe-inline' only because a few components carry an inline
 * `style` attribute for a computed width - note that in CSP a style ATTRIBUTE
 * is covered by style-src, not by style-src-attr alone, which is a distinction
 * that has cost time before.
 */
export function securityHeaders(): MiddlewareHandler<AppEnv> {
  const policy = [
    `default-src 'self'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `object-src 'none'`,
    `script-src 'self' https://crawlproof.com`,
    `style-src 'self' 'unsafe-inline'`,
    // Employer logos and avatars come from wherever the employer hosts them.
    // 'self' has to be listed explicitly: omitting it works in production and
    // breaks every local asset, which is a fun afternoon.
    `img-src 'self' https: data:`,
    `font-src 'self'`,
    // The board itself is same-origin, but a federated search in the browser
    // talks to other instances over https.
    `connect-src 'self' https:`,
  ].join('; ');

  return async (c, next) => {
    await next();
    const headers = c.res.headers;
    if (!headers.has('content-security-policy')) {
      headers.set('content-security-policy', policy);
    }
    headers.set('x-content-type-options', 'nosniff');
    headers.set('referrer-policy', 'strict-origin-when-cross-origin');
    headers.set('x-frame-options', 'DENY');
    headers.set('permissions-policy', 'geolocation=(), microphone=(), camera=()');
  };
}

/**
 * CORS for the API only.
 *
 * Wide open for reads, because a federated search from another instance's
 * browser is the point. Credentials are never reflected: a cross-origin caller
 * authenticates with a bearer token it holds deliberately, never with a cookie
 * the browser attached on its behalf.
 */
export function apiCors(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') {
      return c.body(null, 204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-max-age': '86400',
      });
    }
    await next();
    c.res.headers.set('access-control-allow-origin', '*');
    c.res.headers.set('vary', 'origin');
  };
}
