/**
 * Credit codes and invites: the API, the /invites page, the /me redeem form
 * and the /i/<code> landing page.
 *
 *   GET  /api/v1/credits                 balance and recent history
 *   POST /api/v1/credits/redeem {code}   redeem a credit code
 *   GET  /api/v1/invites                 quota, invites, affiliate link
 *   POST /api/v1/invites {note}          make an invite (the code is shown once)
 *   POST /api/v1/admin/credit-codes      mint a code (a browser-session admin only)
 */

import { Hono, type Context } from 'hono';
import type { AppEnv } from '../deps.ts';
import { requireAdmin } from '../../core/auth.ts';
import {
  canonicalInvite,
  cleanCode,
  createInvite,
  creditSummary,
  formatCents,
  inviteSummary,
  mintCreditCode,
  redeemCreditCode,
} from '../../core/credits.ts';
import { Layout } from '../../views/layout.tsx';
import { InviteLandingPage, InvitesPage } from '../../views/credits.tsx';
import { formOf, requireViewer, shell } from './pages.tsx';
import { rememberInvite } from '../signup-credits.ts';

type Ctx = Context<AppEnv>;

/**
 * The origin every link on these pages is built from. The configured public
 * URL, unless it was left at its localhost default, in which case the host the
 * request came in on: an invite link that says localhost is a dead link.
 */
export function originOf(c: Ctx): string {
  const configured = c.get('deps').config.publicUrl;
  if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(configured)) return configured;
  const url = new URL(c.req.url);
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? url.host;
  const proto =
    c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.replace(':', '');
  return `${proto}://${host}`;
}

function unauthenticated(c: Ctx): Response {
  return c.json({ error: { code: 'unauthenticated', message: 'Sign in first.' } }, 401);
}

async function body(c: Ctx): Promise<Record<string, unknown>> {
  const type = c.req.header('content-type') ?? '';
  try {
    if (type.includes('application/json')) {
      const parsed = (await c.req.json()) as unknown;
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    }
    return (await c.req.parseBody()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function bonusLabel(c: Ctx): string | null {
  const cents = c.get('deps').config.invites?.bonusCents ?? 100;
  return cents > 0 ? formatCents(cents) : null;
}

export function creditRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  // --- API ---------------------------------------------------------------

  routes.get('/api/v1/credits', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === null) return unauthenticated(c);
    return c.json(await creditSummary(c.get('deps').pool, viewer.id));
  });

  routes.post('/api/v1/credits/redeem', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === null) return unauthenticated(c);
    const code = cleanCode((await body(c))['code']);
    if (code === null) {
      return c.json(
        { error: { code: 'invalid', message: 'Send the code as {"code": "AJ-..."}.' } },
        400,
      );
    }
    const result = await redeemCreditCode(c.get('deps').pool, viewer.id, code);
    if (!result.ok) return c.json({ error: { code: result.reason, message: result.message } }, 400);
    return c.json({
      ok: true,
      addedCents: result.cents,
      balanceCents: result.balanceCents,
      balance: formatCents(result.balanceCents),
    });
  });

  routes.get('/api/v1/invites', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === null) return unauthenticated(c);
    return c.json({
      ...(await inviteSummary(c.get('deps').pool, viewer.id, originOf(c))),
      bonusCents: c.get('deps').config.invites?.bonusCents ?? 100,
    });
  });

  routes.post('/api/v1/invites', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === null) return unauthenticated(c);
    const note = (await body(c))['note'];
    const result = await createInvite(
      c.get('deps').pool,
      viewer.id,
      typeof note === 'string' ? note : '',
      originOf(c),
    );
    if (!result.ok) {
      return c.json(
        { error: { code: 'no_invites_left', message: 'Every invite on this account is used.' } },
        409,
      );
    }
    return c.json(result, 201);
  });

  routes.post('/api/v1/admin/credit-codes', async (c) => {
    const viewer = c.get('viewer');
    if (!requireAdmin(viewer)) {
      return c.json(
        { error: { code: 'forbidden', message: 'Administrators only, from a browser session.' } },
        403,
      );
    }
    const input = await body(c);
    const days = input['expiresInDays'];
    try {
      const minted = await mintCreditCode(c.get('deps').pool, {
        cents: Number(input['cents']),
        label: typeof input['label'] === 'string' ? input['label'] : '',
        maxRedemptions: input['maxRedemptions'] === undefined ? 1 : Number(input['maxRedemptions']),
        expiresInDays: days === undefined || days === null ? null : Number(days),
        createdBy: viewer.email,
      });
      return c.json(
        {
          code: minted.code,
          id: minted.id,
          label: minted.label,
          cents: minted.grant.amount,
          maxRedemptions: minted.maxRedemptions,
          expiresAt: minted.expiresAt === null ? null : new Date(minted.expiresAt).toISOString(),
        },
        201,
      );
    } catch (error) {
      return c.json(
        { error: { code: 'invalid', message: error instanceof Error ? error.message : 'invalid' } },
        400,
      );
    }
  });

  // --- pages -------------------------------------------------------------

  routes.post('/me/redeem', async (c) => {
    const viewer = requireViewer(c);
    if (viewer instanceof Response) return viewer;
    const code = cleanCode((await formOf(c))['code']);
    if (code === null) return c.redirect('/me?credit=invalid#credits', 303);
    const result = await redeemCreditCode(c.get('deps').pool, viewer.id, code);
    return c.redirect(
      result.ok
        ? `/me?credit=added&cents=${result.cents}#credits`
        : `/me?credit=${result.reason}#credits`,
      303,
    );
  });

  routes.get('/invites', async (c) => {
    const viewer = requireViewer(c);
    if (viewer instanceof Response) return viewer;
    const summary = await inviteSummary(c.get('deps').pool, viewer.id, originOf(c));
    return c.html(
      <Layout {...shell(c)} title="Invites" noindex>
        <InvitesPage summary={summary} bonus={bonusLabel(c)} />
      </Layout>,
    );
  });

  routes.post('/invites', async (c) => {
    const viewer = requireViewer(c);
    if (viewer instanceof Response) return viewer;
    const { pool } = c.get('deps');
    const form = await formOf(c);
    const result = await createInvite(pool, viewer.id, form['note'] ?? '', originOf(c));
    const summary = await inviteSummary(pool, viewer.id, originOf(c));
    return c.html(
      <Layout {...shell(c)} title="Invites" noindex>
        <InvitesPage
          summary={summary}
          bonus={bonusLabel(c)}
          {...(result.ok
            ? { created: { code: result.code, url: result.url } }
            : { error: 'Every invite on this account is used.' })}
        />
      </Layout>,
      result.ok ? 201 : 409,
    );
  });

  /**
   * An invite link. It only remembers the code: the invite is spent when the
   * new account's magic link is, so a link preview fetching this page costs
   * nobody anything. Open to crawlers (see the gateway's openPaths).
   */
  routes.get('/i/:code', (c) => {
    const code = canonicalInvite(c.req.param('code'));
    const signedIn = c.get('viewer') !== null;
    if (code !== null && !signedIn) rememberInvite(c, code);
    return c.html(
      <Layout {...shell(c)} title="You are invited" noindex>
        <InviteLandingPage
          boardName={c.get('deps').config.boardName}
          code={code}
          signedIn={signedIn}
        />
      </Layout>,
      code === null ? 404 : 200,
    );
  });

  return routes;
}
