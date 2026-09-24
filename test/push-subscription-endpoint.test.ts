/**
 * A push endpoint is a URL the board POSTs to itself, so it gets the same
 * host rules as every other fetched URL: no loopback, no private ranges, no
 * reserved space — in any spelling. Without that check a subscription
 * pointing at 169.254.169.254 turns every notification into a request the
 * board's own client makes against its own network, with a signed VAPID
 * header attached.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { parseSubscription } from '../src/core/push.ts';

function keys(): { p256dh: string; auth: string } {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' }) as { x: string; y: string; d: string };
  const point = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
  return {
    p256dh: point.toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };
}

const REFUSED = [
  'https://127.0.0.1:8443/send/abc',
  'https://localhost/send/abc',
  'https://169.254.169.254/latest/meta-data',
  'https://10.0.0.5/send/abc',
  'https://192.168.1.1/send/abc',
  'https://172.16.0.1/send/abc',
  'https://[::1]/send/abc',
  'https://[fd00::1]/send/abc',
  'https://[::ffff:127.0.0.1]/send/abc',
  'https://[2002:7f00:1::]/send/abc',
  'https://[64:ff9b::a9fe:a9fe]/send/abc',
  'https://0.0.0.0/send/abc',
];

test('a push endpoint cannot be a private or reserved host', () => {
  for (const endpoint of REFUSED) {
    assert.equal(
      parseSubscription({ endpoint, keys: keys() }),
      null,
      `endpoint should be refused: ${endpoint}`,
    );
  }
});

test('a public push endpoint still subscribes, path intact', () => {
  const endpoint = 'https://fcm.googleapis.com/fcm/send/abc123';
  const parsed = parseSubscription({ endpoint, keys: keys() });
  assert.ok(parsed !== null);
  assert.equal(parsed.endpoint, endpoint);
});
