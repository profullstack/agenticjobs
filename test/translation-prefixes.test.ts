/**
 * IPv6 translation prefixes carry an IPv4 the connect can still reach: the
 * NAT64 well-known prefix a translator or a DNS64 resolver actually dials
 * (64:ff9b::/96, v4 in the last 32 bits), 6to4 (2002::/16, the relay v4 in
 * the two hextets after the prefix) and the deprecated v4-compatible form
 * (::/96). The guard has to judge the address inside, not the wrapper.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertPublicUrl, isPrivateAddress } from '../dist/core/browse.js';
import { assertPublicTarget, fetchText, FetchProblem } from '../dist/directory/fetch.js';
import { publishable } from '../dist/schema/instance.js';

test('the NAT64 well-known prefix is judged by the v4 it translates', () => {
  // 64:ff9b::a9fe:a9fe is how a NAT64-only host — or a DNS64 answer — spells
  // 169.254.169.254, so the embedded address decides, not the spelling.
  assert.equal(isPrivateAddress('64:ff9b::7f00:1'), true);
  assert.equal(isPrivateAddress('64:ff9b::a9fe:a9fe'), true);
  assert.equal(isPrivateAddress('64:ff9b::a00:1'), true);
  assert.equal(isPrivateAddress('64:ff9b:0:0:0:0:7f00:1'), true);
  // A public v4 under the same prefix stays public.
  assert.equal(isPrivateAddress('64:ff9b::808:808'), false);
  // The rest of the translation space names no public host.
  assert.equal(isPrivateAddress('64:ff9b:1::808:808'), true);
});

test('a 6to4 prefix is judged by the relay v4 it carries', () => {
  assert.equal(isPrivateAddress('2002:7f00:1::'), true);
  assert.equal(isPrivateAddress('2002:a9fe:a9fe::'), true);
  assert.equal(isPrivateAddress('2002:808:808::'), false);
});

test('the deprecated compatible form is judged like the mapped one', () => {
  assert.equal(isPrivateAddress('::7f00:1'), true);
  assert.equal(isPrivateAddress('::a9fe:a9fe'), true);
  assert.equal(isPrivateAddress('::808:808'), false);
});

test('a DNS64 answer for a private v4 is refused', async () => {
  const resolve = async () => ['64:ff9b::a9fe:a9fe'];
  await assert.rejects(assertPublicTarget(new URL('http://example.com/'), resolve), FetchProblem);
});

test('translation literals are refused before any fetch', async () => {
  await assert.rejects(
    assertPublicUrl('http://[64:ff9b::a9fe:a9fe]/resume'),
    /not a public address/,
  );
  await assert.rejects(
    assertPublicUrl('http://[2002:a9fe:a9fe::]/resume'),
    /not a public address/,
  );
  await assert.rejects(fetchText('http://[64:ff9b::7f00:1]/x'), FetchProblem);
});

test('publishable refuses instances on a translated private v4', () => {
  assert.equal(publishable('http://[64:ff9b::a9fe:a9fe]/'), null);
  assert.equal(publishable('http://[2002:a9fe:a9fe::]/'), null);
  assert.equal(publishable('http://[::a9fe:a9fe]/'), null);
  assert.notEqual(publishable('http://[64:ff9b::808:808]/'), null);
});
