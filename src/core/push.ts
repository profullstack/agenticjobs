/**
 * Browser push, from node:crypto and nothing else.
 *
 * Web Push is two RFCs: 8291 says how the message is encrypted to the
 * browser's key (ECDH on P-256, HKDF, AES-128-GCM, the `aes128gcm` content
 * encoding of RFC 8188), and 8292 says how the board proves it is the sender
 * (VAPID: an ES256 JWT over the push service's origin). Both fit in this file
 * and both are things Node's crypto module already does, so there is no
 * dependency to audit and no key file to manage: the VAPID pair is generated
 * once, on first use, and kept in the database beside everything else the
 * board owns.
 *
 * Push is best effort by construction. A subscription the push service says
 * is gone (404, 410) is deleted; any other failure is reported and dropped.
 */

import {
  createCipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';
import type pg from 'pg';
import { publishable } from '../schema/instance.ts';

export interface PushKeys {
  /** Uncompressed P-256 point, base64url: what the browser is handed. */
  publicKey: string;
  /** The private scalar, base64url. */
  privateKey: string;
}

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
}

export interface PushResult {
  endpoint: string;
  status: number | null;
  /** True when the push service accepted it. */
  sent: boolean;
  /** True when the subscription was deleted because the service said it is gone. */
  dropped: boolean;
}

const b64u = {
  encode: (bytes: Uint8Array | Buffer): string => Buffer.from(bytes).toString('base64url'),
  decode: (text: string): Buffer => Buffer.from(text, 'base64url'),
};

/** A fresh VAPID pair. */
export function generateKeys(): PushKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' }) as { x: string; y: string; d: string };
  void publicKey;
  return { publicKey: b64u.encode(pointOf(jwk.x, jwk.y)), privateKey: jwk.d };
}

function pointOf(x: string, y: string): Buffer {
  return Buffer.concat([Buffer.from([0x04]), b64u.decode(x), b64u.decode(y)]);
}

function coordinatesOf(point: Buffer): { x: string; y: string } {
  if (point.length !== 65 || point[0] !== 0x04)
    throw new Error('expected an uncompressed P-256 point');
  return { x: b64u.encode(point.subarray(1, 33)), y: b64u.encode(point.subarray(33, 65)) };
}

function privateKeyOf(keys: PushKeys): KeyObject {
  const { x, y } = coordinatesOf(b64u.decode(keys.publicKey));
  return createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x, y, d: keys.privateKey },
    format: 'jwk',
  });
}

function publicKeyOf(point: Buffer): KeyObject {
  const { x, y } = coordinatesOf(point);
  return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x, y }, format: 'jwk' });
}

/** The VAPID pair for this board, created on first use. */
export async function pushKeys(pool: pg.Pool): Promise<PushKeys> {
  const existing = await pool.query<{ public_key: string; private_key: string }>(
    `select public_key, private_key from push_keys where id`,
  );
  const row = existing.rows[0];
  if (row !== undefined) return { publicKey: row.public_key, privateKey: row.private_key };
  const fresh = generateKeys();
  // Two boots racing to create the pair keep whichever landed first.
  await pool.query(
    `insert into push_keys (id, public_key, private_key) values (true, $1, $2) on conflict (id) do nothing`,
    [fresh.publicKey, fresh.privateKey],
  );
  return pushKeys(pool);
}

/** RFC 8292: `Authorization: vapid t=<jwt>, k=<public key>`. */
export function vapidHeader(
  keys: PushKeys,
  audience: string,
  subject: string,
  now = Date.now(),
): string {
  const header = b64u.encode(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u.encode(
    Buffer.from(
      JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }),
    ),
  );
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
    key: privateKeyOf(keys),
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${header}.${claims}.${b64u.encode(signature)}, k=${keys.publicKey}`;
}

/**
 * RFC 8291 + RFC 8188: the plaintext, encrypted to one subscription.
 *
 * `ephemeral` is injectable so a test can check the bytes against a
 * decryption done with the same primitives; a caller never passes it.
 */
export function encrypt(
  subscription: PushSubscription,
  plaintext: Buffer,
  ephemeral: { privateKey: KeyObject; publicKey: Buffer; salt: Buffer } = freshEphemeral(),
): Buffer {
  const uaPublic = b64u.decode(subscription.keys.p256dh);
  const authSecret = b64u.decode(subscription.keys.auth);
  if (authSecret.length !== 16) throw new Error('the auth secret must be 16 bytes');

  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: publicKeyOf(uaPublic),
  });
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, ephemeral.publicKey]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(
    hkdfSync('sha256', ikm, ephemeral.salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, ephemeral.salt, Buffer.from('Content-Encoding: nonce\0'), 12),
  );

  // One record: the plaintext, then the 0x02 delimiter that marks the last
  // record, then the GCM tag. rs is the record size, and a single record
  // needs it to be at least the record's length.
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.concat([
    ephemeral.salt,
    rs,
    Buffer.from([ephemeral.publicKey.length]),
    ephemeral.publicKey,
  ]);
  return Buffer.concat([header, body]);
}

export function freshEphemeral(): { privateKey: KeyObject; publicKey: Buffer; salt: Buffer } {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' }) as { x: string; y: string };
  return { privateKey, publicKey: pointOf(jwk.x, jwk.y), salt: randomBytes(16) };
}

/** The request for one subscription, ready to send. */
export function buildRequest(
  keys: PushKeys,
  subscription: PushSubscription,
  payload: PushPayload,
  subject: string,
  options: { ttl?: number } = {},
): { url: string; init: RequestInit } {
  const audience = new URL(subscription.endpoint).origin;
  const body = encrypt(subscription, Buffer.from(JSON.stringify(payload)));
  return {
    url: subscription.endpoint,
    init: {
      method: 'POST',
      headers: {
        authorization: vapidHeader(keys, audience, subject),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(options.ttl ?? 24 * 3600),
        urgency: 'normal',
      },
      body: new Uint8Array(body),
    },
  };
}

// --- subscriptions ----------------------------------------------------------

export function parseSubscription(input: unknown): PushSubscription | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;
  const endpoint = typeof record['endpoint'] === 'string' ? record['endpoint'].trim() : '';
  const keys =
    typeof record['keys'] === 'object' && record['keys'] !== null
      ? (record['keys'] as Record<string, unknown>)
      : {};
  const p256dh = typeof keys['p256dh'] === 'string' ? keys['p256dh'] : '';
  const auth = typeof keys['auth'] === 'string' ? keys['auth'] : '';
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 2000) return null;
  // The board POSTs to this endpoint itself, with a signed VAPID header, so
  // the host rules are the directory's: a loopback or private address would
  // point the board's own client at its own network on every notification.
  // `publishable` keeps only an origin, so it is used as the test and the
  // full URL is what is stored — a push endpoint is its path.
  if (publishable(endpoint) === null) return null;
  if (b64u.decode(p256dh).length !== 65 || b64u.decode(auth).length !== 16) return null;
  return { endpoint, keys: { p256dh, auth } };
}

export async function saveSubscription(
  pool: pg.Pool,
  userId: string,
  subscription: PushSubscription,
): Promise<void> {
  await pool.query(
    `insert into push_subscriptions (endpoint, user_id, p256dh, auth) values ($1, $2, $3, $4)
     on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
    [subscription.endpoint, userId, subscription.keys.p256dh, subscription.keys.auth],
  );
}

export async function deleteSubscription(
  pool: pg.Pool,
  userId: string,
  endpoint: string,
): Promise<boolean> {
  const result = await pool.query(
    `delete from push_subscriptions where endpoint = $1 and user_id = $2`,
    [endpoint, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function subscriptionsOf(pool: pg.Pool, userId: string): Promise<PushSubscription[]> {
  const rows = await pool.query<{ endpoint: string; p256dh: string; auth: string }>(
    `select endpoint, p256dh, auth from push_subscriptions where user_id = $1`,
    [userId],
  );
  return rows.rows.map((row) => ({
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth },
  }));
}

export async function subscriptionCount(pool: pg.Pool, userId: string): Promise<number> {
  const rows = await pool.query<{ n: number }>(
    `select count(*)::int as n from push_subscriptions where user_id = $1`,
    [userId],
  );
  return rows.rows[0]?.n ?? 0;
}

/**
 * Push one payload to every browser a person subscribed.
 *
 * `fetch` is injectable so a test can see the request without a push
 * service. `subject` is the board's contact per RFC 8292, a mailto: URL.
 */
export async function pushTo(
  pool: pg.Pool,
  userId: string,
  payload: PushPayload,
  options: { subject: string; fetch?: typeof fetch; keys?: PushKeys },
): Promise<PushResult[]> {
  const subscriptions = await subscriptionsOf(pool, userId);
  if (subscriptions.length === 0) return [];
  const keys = options.keys ?? (await pushKeys(pool));
  const doFetch = options.fetch ?? fetch;
  const results: PushResult[] = [];
  for (const subscription of subscriptions) {
    const result: PushResult = {
      endpoint: subscription.endpoint,
      status: null,
      sent: false,
      dropped: false,
    };
    try {
      const { url, init } = buildRequest(keys, subscription, payload, options.subject);
      const response = await doFetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
      result.status = response.status;
      result.sent = response.ok;
      if (response.status === 404 || response.status === 410) {
        await pool.query(`delete from push_subscriptions where endpoint = $1`, [
          subscription.endpoint,
        ]);
        result.dropped = true;
      }
    } catch {
      result.sent = false;
    }
    results.push(result);
  }
  return results;
}

/** The mailto: contact a push service may use to reach this board. */
export function pushSubject(mailFrom: string, publicUrl: string): string {
  const address = /<([^>]+)>/.exec(mailFrom)?.[1] ?? mailFrom;
  if (/^[^@\s]+@[^@\s]+$/.test(address)) return `mailto:${address}`;
  return publicUrl;
}
