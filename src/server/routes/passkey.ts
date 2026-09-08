/**
 * Passkeys.
 *
 * The second half of the house auth rule (magic link and passkey, never a
 * password). A magic link is what gets you in the first time and what gets you
 * back on a machine you have never used; a passkey is what makes the second
 * visit instant.
 *
 * Registration and sign-in are both discoverable-credential flows, so the
 * sign-in path asks for no email at all: the authenticator already knows which
 * account it holds for this board, and asking a person to type an address
 * before touching their fingerprint reader defeats most of the point.
 *
 * The verification itself is @simplewebauthn/server's. Hand-rolling COSE key
 * parsing and signature verification is exactly the kind of thing that looks
 * finished and is subtly wrong.
 */

import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import {
  createSession,
  SESSION_COOKIE,
  storeChallenge,
  takeChallenge,
  type Viewer,
} from '../../core/auth.ts';
import { clean } from '../../schema/text.ts';
import type { AppEnv } from '../deps.ts';

interface PasskeyRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  counter: string | number;
  transports: string[];
}

export function passkeyRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /**
   * The relying party is the registrable domain, and the origin is the exact
   * URL. Getting these from PUBLIC_URL rather than from the request is
   * deliberate: a passkey registered against one hostname does not work on
   * another, so the value has to be the one the board tells everyone it is.
   */
  const identity = (publicUrl: string): { rpID: string; origin: string } => {
    const url = new URL(publicUrl);
    return { rpID: url.hostname, origin: url.origin };
  };

  // --- adding one to an existing account --------------------------------

  routes.post('/register/start', async (c) => {
    const { pool, config } = c.get('deps');
    const viewer: Viewer | null = c.get('viewer');
    if (viewer === null) return c.json({ error: { message: 'Sign in first.', code: 'unauthenticated' } }, 401);

    const { rpID } = identity(config.publicUrl);
    const existing = await pool.query<{ credential_id: string }>(
      `select credential_id from passkeys where user_id = $1`,
      [viewer.id],
    );

    const options = await generateRegistrationOptions({
      rpName: config.boardName,
      rpID,
      userName: viewer.email,
      userDisplayName: viewer.name ?? viewer.email,
      attestationType: 'none',
      // Without this the authenticator happily enrols a second credential for
      // an account that already has one, and the person ends up with a list of
      // identical-looking keys.
      excludeCredentials: existing.rows.map((row) => ({ id: row.credential_id })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });

    await storeChallenge(pool, options.challenge, 'register', { userId: viewer.id });
    return c.json(options);
  });

  routes.post('/register/verify', async (c) => {
    const { pool, config } = c.get('deps');
    const viewer: Viewer | null = c.get('viewer');
    if (viewer === null) return c.json({ error: { message: 'Sign in first.', code: 'unauthenticated' } }, 401);

    const body = (await c.req.json()) as Record<string, unknown>;
    const challenge = typeof body['challenge'] === 'string' ? body['challenge'] : '';
    const stored = await takeChallenge(pool, challenge);
    if (stored === null || stored.userId !== viewer.id) {
      return c.json({ error: { message: 'That challenge has expired. Try again.', code: 'expired' } }, 400);
    }

    const { rpID, origin } = identity(config.publicUrl);
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body as never,
        expectedChallenge: stored.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
      });
    } catch (error) {
      return c.json(
        {
          error: {
            message: error instanceof Error ? error.message : 'That passkey was not accepted.',
            code: 'rejected',
          },
        },
        400,
      );
    }

    if (!verification.verified || verification.registrationInfo === undefined) {
      return c.json({ error: { message: 'That passkey was not accepted.', code: 'rejected' } }, 400);
    }

    const credential = verification.registrationInfo.credential;
    await pool.query(
      `insert into passkeys (user_id, credential_id, public_key, counter, transports, label)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (credential_id) do nothing`,
      [
        viewer.id,
        credential.id,
        Buffer.from(credential.publicKey).toString('base64url'),
        credential.counter,
        credential.transports ?? [],
        clean(body['label'], 60) || 'passkey',
      ],
    );

    return c.json({ ok: true });
  });

  // --- signing in with one ----------------------------------------------

  routes.post('/challenge', async (c) => {
    const { pool, config } = c.get('deps');
    const { rpID } = identity(config.publicUrl);

    // No allowCredentials and no email: a discoverable credential means the
    // authenticator offers the accounts it holds for this board, so nobody has
    // to identify themselves before proving who they are.
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'preferred',
    });
    await storeChallenge(pool, options.challenge, 'login', {});
    return c.json(options);
  });

  routes.post('/verify', async (c) => {
    const { pool, config } = c.get('deps');
    const body = (await c.req.json()) as Record<string, unknown>;

    const response = body['response'] as Record<string, unknown> | undefined;
    const clientDataJSON = typeof response?.['clientDataJSON'] === 'string' ? response['clientDataJSON'] : '';
    // The challenge is read back out of the signed client data rather than
    // taken from a field the caller controls.
    let challenge = '';
    try {
      const clientData = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')) as {
        challenge?: string;
      };
      challenge = clientData.challenge ?? '';
    } catch {
      return c.json({ error: { message: 'That sign-in was malformed.', code: 'rejected' } }, 400);
    }

    const stored = await takeChallenge(pool, challenge);
    if (stored === null) {
      return c.json({ error: { message: 'That challenge has expired. Try again.', code: 'expired' } }, 400);
    }

    const credentialId = typeof body['id'] === 'string' ? body['id'] : '';
    const found = await pool.query<PasskeyRow>(
      `select id, user_id, credential_id, public_key, counter, transports
         from passkeys where credential_id = $1`,
      [credentialId],
    );
    const row = found.rows[0];
    if (row === undefined) {
      return c.json({ error: { message: 'This board does not know that passkey.', code: 'unknown' } }, 400);
    }

    const { rpID, origin } = identity(config.publicUrl);
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body as never,
        expectedChallenge: stored.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: row.credential_id,
          publicKey: new Uint8Array(Buffer.from(row.public_key, 'base64url')),
          counter: Number(row.counter),
          transports: row.transports as never,
        },
      });
    } catch (error) {
      return c.json(
        {
          error: {
            message: error instanceof Error ? error.message : 'That passkey was not accepted.',
            code: 'rejected',
          },
        },
        400,
      );
    }

    if (!verification.verified) {
      return c.json({ error: { message: 'That passkey was not accepted.', code: 'rejected' } }, 400);
    }

    // A counter that goes backwards means the credential has been cloned. Some
    // authenticators legitimately report 0 forever, so only a real decrease
    // from a non-zero value is treated as a problem.
    const newCounter = verification.authenticationInfo.newCounter;
    if (newCounter !== 0 && newCounter < Number(row.counter)) {
      return c.json(
        {
          error: {
            message: 'That passkey looks like it has been copied. It has been disabled.',
            code: 'cloned',
          },
        },
        400,
      );
    }

    await pool.query(`update passkeys set counter = $2, last_used_at = now() where id = $1`, [
      row.id,
      newCounter,
    ]);

    const token = await createSession(pool, row.user_id, { label: 'browser (passkey)' });
    setCookie(c, SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure: config.publicUrl.startsWith('https://'),
      maxAge: 30 * 24 * 60 * 60,
    });
    return c.json({ ok: true });
  });

  return routes;
}
