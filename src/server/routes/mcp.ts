/**
 * MCP over streamable HTTP.
 *
 * The tools dispatch back through this same app rather than reaching into the
 * database, so an assistant gets the same code and the same permission checks
 * a browser does. The app has to dispatch into itself, which is a cycle the
 * module graph cannot express - so createApp passes a getter that is filled in
 * once the app exists.
 *
 * Bearer tokens are honoured and cookies are deliberately ignored. Browsers
 * attach cookies to cross-origin POSTs, so honouring one would turn this
 * endpoint into a write primitive for any page on the web.
 */

import { Hono } from 'hono';
import { SOFTWARE_NAME } from '../../config.ts';
import { handleMessage } from '../../mcp/server.ts';
import type { Caller } from '../../mcp/tools.ts';
import type { AppEnv } from '../deps.ts';

export interface Dispatcher {
  fetch(request: Request): Response | Promise<Response>;
}

export function mcpRoutes(getApp: () => Dispatcher): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.post('/', async (c) => {
    const { config } = c.get('deps');

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json(
        { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } },
        400,
      );
    }

    const authorization = c.req.header('authorization');
    // Built from the request's own origin rather than PUBLIC_URL, so loopback
    // works behind a proxy, on a laptop and in tests, where the configured
    // public URL is not necessarily the one answering.
    const origin = new URL(c.req.url).origin;

    const caller: Caller = {
      server: config.publicUrl,
      authenticated: authorization !== undefined,
      call: async (method, path, body) => {
        const headers: Record<string, string> = { accept: 'application/json' };
        if (authorization !== undefined) headers['authorization'] = authorization;
        if (body !== undefined) headers['content-type'] = 'application/json';

        const response = await getApp().fetch(
          new Request(new URL(path, origin), {
            method,
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
        const raw = await response.text();
        try {
          return { status: response.status, body: JSON.parse(raw) as unknown };
        } catch {
          // A non-JSON body from our own API means a route returned HTML,
          // which is worth surfacing verbatim rather than hiding.
          return { status: response.status, body: raw };
        }
      },
    };

    const info = { name: `${SOFTWARE_NAME}-mcp`, version: config.version };

    // A batch is an array. Notifications inside it produce no reply, and a
    // batch of nothing but notifications produces no body at all.
    if (Array.isArray(payload)) {
      const responses = [];
      for (const item of payload) {
        const answer = await handleMessage(item, caller, info);
        if (answer !== null) responses.push(answer);
      }
      return responses.length === 0 ? c.body(null, 202) : c.json(responses);
    }

    const answer = await handleMessage(payload, caller, info);
    return answer === null ? c.body(null, 202) : c.json(answer);
  });

  routes.get('/', (c) => {
    const { config } = c.get('deps');
    return c.json({
      name: `${SOFTWARE_NAME}-mcp`,
      version: config.version,
      transport: 'streamable-http',
      board: config.publicUrl,
      note: 'POST JSON-RPC 2.0 here. Send a bearer token to act as an account; cookies are ignored on purpose.',
    });
  });

  return routes;
}
