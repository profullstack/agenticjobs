/**
 * The resolved-address half of the fetch guard.
 *
 * publishable() judges the spelling; these cover what the name answers with.
 * A resolver is injected so no test here needs a network, and the literal
 * forms are run through fetchText with fetch stubbed to prove the gate sits
 * in front of the request, not beside it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertPublicTarget, fetchText, FetchProblem } from '../src/directory/fetch.ts';

test('a name that resolves to a private address is refused', async () => {
  // localtest.me and its cousins answer 127.0.0.1 while spelling nothing.
  const resolve = async () => ['::1', '127.0.0.1'];
  await assert.rejects(
    assertPublicTarget(new URL('http://localtest.me/'), resolve),
    (error: unknown) => error instanceof FetchProblem && /not a public address/.test(error.message),
  );
});

test('one private answer is enough, even beside a public one', async () => {
  // The connect picks one address; a round-robin that includes a private
  // answer is not a public target.
  const resolve = async () => ['93.184.216.34', '169.254.169.254'];
  await assert.rejects(assertPublicTarget(new URL('http://example.com/'), resolve), FetchProblem);
});

test('a name that resolves nowhere is refused rather than fetched', async () => {
  const resolve = async () => [] as string[];
  await assert.rejects(
    assertPublicTarget(new URL('http://gone.example/'), resolve),
    (error: unknown) => error instanceof FetchProblem && /does not resolve/.test(error.message),
  );
});

test('a name that resolves only to public addresses is allowed', async () => {
  const resolve = async () => ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'];
  await assert.doesNotReject(assertPublicTarget(new URL('http://example.com/'), resolve));
});

test('literal spellings publishable() does not list are still checked', async () => {
  // 0.x and carrier-grade NAT never appear in the spelling checks, but the
  // connect would go there all the same.
  await assert.rejects(assertPublicTarget(new URL('http://0.1.2.3/')), FetchProblem);
  await assert.rejects(assertPublicTarget(new URL('http://100.64.1.1/')), FetchProblem);
  await assert.rejects(assertPublicTarget(new URL('http://[::1]/')), FetchProblem);
});

test('fetchText refuses the target before any request is made', async (t) => {
  let called = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    called += 1;
    return new Response('should never happen');
  });
  await assert.rejects(fetchText('http://0.1.2.3/internal'), FetchProblem);
  await assert.rejects(fetchText('http://100.64.1.1/'), FetchProblem);
  assert.equal(called, 0);
});

test('a public literal still fetches', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('document'));
  assert.equal(await fetchText('http://93.184.216.34/'), 'document');
});
