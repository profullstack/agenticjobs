/**
 * The OpenWebring descriptor: the board's membership in the Profullstack ring,
 * at the well-known path the ring's verifier reads.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { discoveryRoutes } from '../dist/server/routes/discovery.js';

function boardApp(publicUrl: string): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set(
      'deps' as never,
      {
        config: { publicUrl, boardName: 'Test Board', isDirectory: false },
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

type Descriptor = {
  openwebring: string;
  site: { url: string; name: string };
  rings: { ring: string; slug: string }[];
};

test('the descriptor names this board and the Profullstack ring', async () => {
  const response = await boardApp('https://board.example').request(
    'https://board.example/.well-known/openwebring.json',
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  const body = (await response.json()) as Descriptor;
  assert.equal(body.openwebring, '0.1');
  assert.deepEqual(body.site, { url: 'https://board.example/', name: 'Test Board' });
  assert.deepEqual(body.rings, [
    { ring: 'https://rssamplifier.com/ring/profullstack', slug: 'board-example' },
  ]);
});

test('agenticjobs.work carries the slug the ring assigned it', async () => {
  const response = await boardApp('https://agenticjobs.work').request(
    'https://agenticjobs.work/.well-known/openwebring.json',
  );
  const body = (await response.json()) as Descriptor;
  assert.equal(body.rings[0]?.slug, 'agenticjobs-work-3');
});
