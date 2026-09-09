/**
 * Routes, as the app actually mounts them.
 *
 * Every other test in this suite calls a handler or renders a component. That
 * is where the resume download bug hid: the route matched when it was asked of
 * its own router and stopped matching once `app.route('/', pages)` mounted it,
 * so the whole feature 404'd in production while the suite stayed green and
 * 0.6.0 shipped with its named feature dead.
 *
 * So these go through the mounted app and assert only one thing: that a URL
 * reaches a handler at all. What the handler then does is somebody else's test.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { pageRoutes } from '../dist/server/routes/pages.js';

/**
 * The app, mounted the way src/server/app.tsx mounts it, with a pool that
 * refuses to answer.
 *
 * A stub that returned no rows would make the handler answer 404, which is
 * exactly what an unmatched route answers, and the test could not tell the two
 * apart. Throwing means "the handler ran": anything that is not a 404 proves
 * the URL found its way to one.
 */
function mounted(): Hono {
  const app = new Hono();
  const pool = {
    query() {
      throw new Error('the handler ran');
    },
  };

  app.use('*', async (c, next) => {
    c.set('deps', {
      pool,
      config: { publicUrl: 'https://example.test', boardName: 'A board' },
    } as never);
    c.set('viewer', null);
    await next();
  });
  app.route('/', pageRoutes() as never);
  app.notFound((c) => c.text('no route', 404));
  app.onError((_error, c) => c.text('handler reached', 500));
  return app;
}

test('every resume download URL reaches a handler once mounted', async () => {
  const app = mounted();

  for (const format of ['md', 'html', 'pdf', 'docx']) {
    const path = `/candidates/anybody/resume.${format}`;
    const res = await app.request(`http://board.test${path}`);
    assert.notEqual(
      res.status,
      404,
      `${path} matched no route. A literal prefix and a regex-constrained ` +
        `param in one segment do not survive app.route(); use one route per ` +
        `extension.`,
    );
  }
});

test('the candidate page itself still routes, and an unknown URL still 404s', async () => {
  const app = mounted();

  // The guard against "fixed it by making everything match".
  const page = await app.request('http://board.test/candidates/anybody');
  assert.notEqual(page.status, 404, 'the candidate page must still route');

  const nowhere = await app.request('http://board.test/candidates/anybody/resume.exe');
  assert.equal(nowhere.status, 404, 'an extension the board does not serve must not route');

  const alsoNowhere = await app.request('http://board.test/candidates/anybody/nonsense');
  assert.equal(alsoNowhere.status, 404, 'and neither must an unrelated path');
});
