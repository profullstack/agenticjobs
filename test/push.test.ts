/**
 * Web Push from node:crypto: the encryption decrypts with the same
 * primitives, and the VAPID token verifies against the public key.
 *
 * RFC 8291 and RFC 8188 are checked here by doing the receiving side the way
 * a browser does, with the same HKDF labels and the same record layout. A
 * bug in either direction fails the round trip.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  verify,
} from 'node:crypto';
import {
  buildRequest,
  encrypt,
  generateKeys,
  parseSubscription,
  pushSubject,
  vapidHeader,
} from '../src/core/push.ts';

const b64u = (bytes: Buffer): string => bytes.toString('base64url');

/** A browser-side subscription: a P-256 pair and a 16 byte auth secret. */
function browserSubscription(): {
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  privateJwk: { x: string; y: string; d: string };
} {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' }) as { x: string; y: string; d: string };
  const point = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
  return {
    subscription: {
      endpoint: 'https://push.example.test/send/abc',
      keys: { p256dh: b64u(point), auth: b64u(randomBytes(16)) },
    },
    privateJwk: jwk,
  };
}

/** RFC 8291 decryption, written independently of the encryptor. */
function decrypt(
  body: Buffer,
  privateJwk: { x: string; y: string; d: string },
  authSecret: Buffer,
): Buffer {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20] ?? 0;
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  assert.ok(rs >= record.length, 'a single record fits in rs');

  const uaPrivate = createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', ...privateJwk },
    format: 'jwk',
  });
  const asKey = createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: b64u(asPublic.subarray(1, 33)),
      y: b64u(asPublic.subarray(33, 65)),
    },
    format: 'jwk',
  });
  const shared = diffieHellman({ privateKey: uaPrivate, publicKey: asKey });
  const uaPublic = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(privateJwk.x, 'base64url'),
    Buffer.from(privateJwk.y, 'base64url'),
  ]);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, info, 32));
  const cek = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12),
  );

  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([
    decipher.update(record.subarray(0, record.length - 16)),
    decipher.final(),
  ]);
  assert.equal(plain[plain.length - 1], 0x02, 'the last record ends with the 0x02 delimiter');
  return plain.subarray(0, plain.length - 1);
}

test('a payload encrypted to a subscription decrypts with its private key', () => {
  const { subscription, privateJwk } = browserSubscription();
  const payload = Buffer.from(
    JSON.stringify({ title: 'Rust engineer at Acme', body: 'New listing', url: '/jobs/x' }),
  );
  const body = encrypt(subscription, payload);
  assert.deepEqual(
    decrypt(body, privateJwk, Buffer.from(subscription.keys.auth, 'base64url')),
    payload,
  );
});

test('the same payload never encrypts to the same bytes twice', () => {
  const { subscription } = browserSubscription();
  const payload = Buffer.from('hello');
  assert.notDeepEqual(encrypt(subscription, payload), encrypt(subscription, payload));
});

test('the VAPID token is an ES256 JWT over the push origin, signed by the board key', () => {
  const keys = generateKeys();
  const header = vapidHeader(
    keys,
    'https://push.example.test',
    'mailto:jobs@example.test',
    Date.parse('2026-09-21T12:00:00Z'),
  );
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.ok(match);
  const [, token, k] = match as unknown as [string, string, string];
  assert.equal(k, keys.publicKey);

  const [h, c, s] = token.split('.') as [string, string, string];
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), {
    typ: 'JWT',
    alg: 'ES256',
  });
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString()) as {
    aud: string;
    exp: number;
    sub: string;
  };
  assert.equal(claims.aud, 'https://push.example.test');
  assert.equal(claims.sub, 'mailto:jobs@example.test');
  assert.equal(claims.exp, Math.floor(Date.parse('2026-09-21T12:00:00Z') / 1000) + 12 * 3600);

  const point = Buffer.from(keys.publicKey, 'base64url');
  const publicKey = createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: b64u(point.subarray(1, 33)),
      y: b64u(point.subarray(33, 65)),
    },
    format: 'jwk',
  });
  assert.ok(
    verify(
      'sha256',
      Buffer.from(`${h}.${c}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(s, 'base64url'),
    ),
    'signature verifies as raw r||s',
  );
});

test('the request carries the headers a push service requires', () => {
  const keys = generateKeys();
  const { subscription } = browserSubscription();
  const { url, init } = buildRequest(
    keys,
    subscription,
    { title: 't', body: 'b', url: '/x' },
    'mailto:jobs@example.test',
  );
  assert.equal(url, subscription.endpoint);
  const headers = init.headers as Record<string, string>;
  assert.equal(headers['content-encoding'], 'aes128gcm');
  assert.equal(headers['content-type'], 'application/octet-stream');
  assert.match(headers['authorization'] ?? '', /^vapid t=.+, k=.+$/);
  assert.equal(headers['ttl'], '86400');
  assert.ok((init.body as Uint8Array).length > 86, 'header plus at least one record');
});

test('a subscription is accepted only in the shape the browser hands over', () => {
  const { subscription } = browserSubscription();
  assert.deepEqual(parseSubscription(subscription), subscription);
  assert.equal(parseSubscription({ ...subscription, endpoint: 'http://insecure' }), null);
  assert.equal(
    parseSubscription({ ...subscription, keys: { ...subscription.keys, auth: 'short' } }),
    null,
  );
  assert.equal(parseSubscription('nope'), null);
});

test('the VAPID contact is the mail sender, or the site when there is no address', () => {
  assert.equal(
    pushSubject('"Agentic Jobs" <jobs@agenticjobs.work>', 'https://agenticjobs.pwa.pit.world'),
    'mailto:jobs@agenticjobs.work',
  );
  assert.equal(pushSubject('jobs@localhost', 'http://localhost:8787'), 'mailto:jobs@localhost');
  assert.equal(
    pushSubject('not an address', 'https://agenticjobs.pwa.pit.world'),
    'https://agenticjobs.pwa.pit.world',
  );
});

test('push requests keep the encrypted payload within the 4096-byte service limit', () => {
  const keys = generateKeys();
  const { subscription, privateJwk } = browserSubscription();
  const payload = {
    title: 'Rust engineer at Acme',
    body: '新职位 '.repeat(2_000),
    url: '/jobs/rust-engineer',
  };
  const { init } = buildRequest(keys, subscription, payload, 'mailto:jobs@example.test');
  const body = Buffer.from(init.body as Uint8Array);
  assert.ok(body.length <= 4096, `push body was ${body.length} bytes`);
  const plaintext = decrypt(body, privateJwk, Buffer.from(subscription.keys.auth, 'base64url'));
  const delivered = JSON.parse(plaintext.toString()) as typeof payload;
  assert.equal(delivered.title, payload.title);
  assert.equal(delivered.url, payload.url);
  assert.ok(
    delivered.body.length < payload.body.length,
    'oversized notification text is shortened',
  );
});
