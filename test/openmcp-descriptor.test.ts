/**
 * The board as an OpenMCP relay.
 *
 * What has to hold: the descriptor points at this board's own MCP endpoint,
 * names every tool the MCP server has, and says which of them answer with no
 * token, so a catalog that fetched it from our origin lists the board as
 * verified and a caller knows what needs signing in.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { discoveryRoutes } from '../dist/server/routes/discovery.js';
import { OPEN_TOOLS, TOOLS } from '../dist/mcp/tools.js';

function boardApp(): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set(
      'deps' as never,
      {
        config: { publicUrl: 'https://board.example', boardName: 'Test Board', isDirectory: false },
        pool: null,
        mailer: null,
        coinpay: null,
      } as never,
    );
    c.set('viewer' as never, null as never);
    await next();
  });
  app.route('/', discoveryRoutes() as unknown as Hono);
  return app;
}

test('the descriptor is served at the well-known path and points at this board', async () => {
  const response = await boardApp().request('https://board.example/.well-known/openmcp.json');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  const descriptor = (await response.json()) as Record<string, unknown>;
  assert.equal(descriptor.openmcp, '0.1');
  assert.equal(descriptor.mcp, 'https://board.example/api/mcp');
  assert.equal(descriptor.name, 'Test Board');
  assert.equal(descriptor.url, 'https://board.example');
  assert.deepEqual((descriptor.auth as { kind: string }).kind, 'bearer');
  assert.deepEqual((descriptor.auth as { open: string[] }).open, [...OPEN_TOOLS]);
  assert.deepEqual(
    descriptor.tools,
    TOOLS.map((tool) => tool.name),
  );
  assert.ok((descriptor.tags as string[]).includes('jobs'));
});

test('every open tool is a real tool, and the tools that need a token are not called open', () => {
  const names = new Set(TOOLS.map((tool) => tool.name));
  for (const open of OPEN_TOOLS)
    assert.ok(names.has(open), `${open} is listed open but is not a tool`);
  for (const needsToken of ['post_update', 'save_resume', 'send_message', 'pay_invoice']) {
    assert.ok(
      !(OPEN_TOOLS as readonly string[]).includes(needsToken),
      `${needsToken} needs a token`,
    );
  }
});
