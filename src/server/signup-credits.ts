/**
 * What a sign-up carries besides the address: an invite from /i/<code> and an
 * affiliate code from ?ref=. Both are read from the form or the cookie when the
 * link is asked for, saved on the magic link, and applied when it is spent, so
 * a link opened in a different browser (a phone's mail app) still counts.
 */

import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from './deps.ts';
import type { ConsumedLink } from '../core/auth.ts';
import {
  acceptInvite,
  attributeRef,
  canonicalInvite,
  cleanRef,
  INVITE_COOKIE,
  REF_COOKIE,
} from '../core/credits.ts';

type Ctx = Context<AppEnv>;

const THIRTY_DAYS = 30 * 24 * 60 * 60;

function secure(c: Ctx): boolean {
  return c.get('deps').config.publicUrl.startsWith('https://');
}

export function rememberInvite(c: Ctx, code: string): void {
  setCookie(c, INVITE_COOKIE, code, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: secure(c),
    maxAge: THIRTY_DAYS,
  });
}

/** The invite and ref a sign-up form should carry on its link. */
export function carried(
  c: Ctx,
  form: Record<string, string> = {},
): { invite: string | null; ref: string | null } {
  return {
    invite: canonicalInvite(form['invite'] ?? getCookie(c, INVITE_COOKIE)),
    ref: cleanRef(form['ref'] ?? getCookie(c, REF_COOKIE)),
  };
}

/** The invite to show on /signup, from ?invite= or the cookie. */
export function pendingInvite(c: Ctx): string | null {
  return canonicalInvite(
    new URL(c.req.url).searchParams.get('invite') ?? getCookie(c, INVITE_COOKIE),
  );
}

/**
 * First touch on ?ref=: the first affiliate code a browser arrives with is
 * kept for 30 days and never overwritten. The cookie is @profullstack/
 * referrals' `referral_code`, so a site that adds that package later does not
 * count one sign-up twice.
 */
export function trackRef(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.method === 'GET') {
      const ref = cleanRef(new URL(c.req.url).searchParams.get('ref'));
      if (ref !== null && getCookie(c, REF_COOKIE) === undefined) {
        setCookie(c, REF_COOKIE, ref, {
          path: '/',
          httpOnly: true,
          sameSite: 'Lax',
          secure: secure(c),
          maxAge: THIRTY_DAYS,
        });
      }
    }
    await next();
  };
}

/**
 * Apply an invite and a ref to an account the magic link just created. Only
 * a new account: an existing member following an invite link spends nothing
 * and earns nothing. Failures are logged and never stop the sign-in.
 */
export async function applySignupCredits(c: Ctx, consumed: ConsumedLink): Promise<void> {
  const { pool, config } = c.get('deps');
  const invite = consumed.invite ?? canonicalInvite(getCookie(c, INVITE_COOKIE));
  const ref = consumed.ref ?? cleanRef(getCookie(c, REF_COOKIE));
  if (invite !== null) deleteCookie(c, INVITE_COOKIE, { path: '/' });
  if (consumed.user.created !== true) return;
  if (invite !== null) {
    try {
      await acceptInvite(pool, config, invite, consumed.user);
    } catch (error) {
      console.error('invite accept failed', error instanceof Error ? error.message : error);
    }
  }
  if (ref !== null) {
    try {
      await attributeRef(pool, ref, consumed.user.id);
    } catch (error) {
      console.error('ref attribution failed', error instanceof Error ? error.message : error);
    }
  }
}
