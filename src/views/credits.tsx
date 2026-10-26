/**
 * Credit and invites: the "Have a code?" card on /me, the /invites page and
 * the /i/<code> landing page.
 */

import type { FC } from 'hono/jsx';
import type { CreditSummary, InviteSummary } from '../core/credits.ts';
import { formatCents } from '../core/credits.ts';
import { ago } from '../schema/text.ts';
import { Alert, Badge, Card, Field } from './layout.tsx';

export const CreditsCard: FC<{
  summary: CreditSummary;
  notice?: { variant: 'success' | 'error'; text: string };
}> = ({ summary, notice }) => (
  <section class="stack" id="credits">
    <div class="spread">
      <h2>Credit</h2>
      <a class="btn btn-secondary btn-sm" href="/invites">
        Invites
      </a>
    </div>
    {notice !== undefined && <Alert variant={notice.variant}>{notice.text}</Alert>}
    <Card>
      <div class="spread">
        <div>
          <h3 class="card-title">{summary.balance}</h3>
          <p class="small muted">
            Credit on your account. This board charges no listing fee and no commission, so nothing
            draws on it yet; it is held for the first thing the board sells.
          </p>
        </div>
      </div>
      <form class="stack" method="post" action="/me/redeem" style="margin-top:.75rem">
        <Field label="Have a code?" name="code" hint="Codes look like AJ-XXXX-XXXX-XXXX-XXXX.">
          <input
            class="input code"
            type="text"
            id="code"
            name="code"
            autocomplete="off"
            spellcheck={false}
            maxlength={48}
            required
          />
        </Field>
        <button class="btn btn-sm" type="submit">
          Redeem
        </button>
      </form>
      {summary.history.length > 0 && (
        <ul class="stack-sm small" style="list-style:none;margin:.75rem 0 0;padding:0">
          {summary.history.map((entry) => (
            <li>
              {entry.kind === 'spend' ? '-' : '+'}
              {formatCents(entry.cents)} <span class="muted">{entry.source}</span>{' '}
              <span class="muted">{ago(entry.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  </section>
);

export const InvitesPage: FC<{
  summary: InviteSummary;
  created?: { code: string; url: string };
  error?: string;
  bonus: string | null;
}> = ({ summary, created, error, bonus }) => (
  <div class="stack">
    <div>
      <h1>Invites</h1>
      <p class="lede">
        You have {summary.quota.left} of {summary.quota.total} invites left. Each one works once,
        for one new account, for 30 days.
        {bonus !== null &&
          ` When someone joins with yours and confirms their address, you both get ${bonus} in credit.`}
      </p>
    </div>
    {error !== undefined && <Alert variant="error">{error}</Alert>}
    {created !== undefined && (
      <Alert variant="success">
        Invite made. Send this link; it is shown once:{' '}
        <code class="code" style="user-select:all">
          {created.url}
        </code>
      </Alert>
    )}
    <Card>
      <form class="stack" method="post" action="/invites">
        <Field label="Who is it for?" name="note" hint="Only you see this.">
          <input class="input" type="text" id="note" name="note" maxlength={120} />
        </Field>
        <button class="btn" type="submit" disabled={summary.quota.left <= 0}>
          {summary.quota.left <= 0 ? 'No invites left' : 'Make an invite'}
        </button>
      </form>
    </Card>
    {summary.invites.length > 0 && (
      <section class="stack">
        <h2>Your invites</h2>
        <ul class="stack-sm" style="list-style:none;margin:0;padding:0">
          {summary.invites.map((invite) => (
            <li class="small">
              {invite.used ? (
                <Badge variant="welcome">Accepted</Badge>
              ) : invite.revoked ? (
                <Badge variant="outline">Withdrawn</Badge>
              ) : invite.expiresAt !== null && Date.parse(invite.expiresAt) < Date.now() ? (
                <Badge variant="outline">Expired</Badge>
              ) : (
                <Badge variant="outline">Open</Badge>
              )}{' '}
              {invite.note || <span class="muted">No note</span>}{' '}
              <span class="muted">made {ago(invite.createdAt)}</span>
            </li>
          ))}
        </ul>
      </section>
    )}
    <section class="stack">
      <h2>Your link</h2>
      <p class="small muted">
        Open to anyone and never used up. Accounts made after following it are credited to you.
        {summary.invitedCount > 0 && ` ${summary.invitedCount} joined with your invites so far.`}
      </p>
      <Card>
        <code class="code" style="user-select:all">
          {summary.affiliateUrl}
        </code>
      </Card>
    </section>
  </div>
);

export const InviteLandingPage: FC<{
  boardName: string;
  code: string | null;
  signedIn: boolean;
}> = ({ boardName, code, signedIn }) => (
  <div style="max-width:30rem;margin:0 auto">
    <div class="stack">
      <h1>{code === null ? 'That invite link is broken' : `You are invited to ${boardName}`}</h1>
      {code === null ? (
        <p class="lede">
          The code in the link is not one this board makes. Ask whoever sent it for a new one.
        </p>
      ) : signedIn ? (
        <p class="lede">
          You already have an account, so this invite is for someone new. Pass it on, or make your
          own at <a href="/invites">/invites</a>.
        </p>
      ) : (
        <>
          <p class="lede">
            Someone on {boardName} wanted you here. Invites are scarce: each account gets three.
            Create your account with the same email you will read the link in, and the invite is
            applied when you confirm it.
          </p>
          <p class="row">
            <a class="btn" href={`/signup?invite=${encodeURIComponent(code)}`}>
              Create your account
            </a>
          </p>
          <p class="small muted">
            Invite code <code class="code">{code}</code>
          </p>
        </>
      )}
    </div>
  </div>
);
