/**
 * The inbox: private conversations, and the invoices that travel in them.
 *
 * Plain on purpose, like updates. No read receipts, no typing indicator, no
 * reactions: the thing this has to be is the place an invoice goes instead of
 * a public comment box, and everything else is a place for noise to grow.
 */

import type { FC } from 'hono/jsx';
import type { Organisation } from '../schema/index.ts';
import type { Message, Party, Thread, ThreadSummary } from '../core/inbox.ts';
import type { Invoice } from '../core/invoices.ts';
import type { Account, Wallet } from '../core/coinpay.ts';
import { ago } from '../schema/text.ts';
import { Alert, Badge, Card, Empty, Field } from './layout.tsx';

function partyHref(party: Party): string | null {
  if (party.slug === null) return null;
  return party.kind === 'employer' ? `/employers/${party.slug}` : `/candidates/${party.slug}`;
}

const PartyName: FC<{ party: Party }> = ({ party }) => {
  const href = partyHref(party);
  return href === null ? (
    <strong>{party.name}</strong>
  ) : (
    <a href={href}>
      <strong>{party.name}</strong>
    </a>
  );
};

/**
 * The button on a candidate's or an employer's page.
 *
 * It goes to a compose page rather than opening a box inline, because the
 * compose page is where "as which employer" and "about which job" are asked,
 * and because a stranger's page should not carry a form that posts to you.
 */
export const MessageButton: FC<{
  to: { candidate: string } | { employer: string };
  job?: string;
  signedIn: boolean;
  next: string;
}> = ({ to, job, signedIn, next }) => {
  const params = new URLSearchParams();
  if ('candidate' in to) params.set('candidate', to.candidate);
  else params.set('employer', to.employer);
  if (job !== undefined) params.set('job', job);
  const href = `/inbox/new?${params.toString()}`;
  return (
    <a
      class="btn btn-secondary btn-sm"
      href={signedIn ? href : `/login?next=${encodeURIComponent(next)}`}
    >
      Message
    </a>
  );
};

export const InboxPage: FC<{ threads: ThreadSummary[] }> = ({ threads }) => (
  <div class="stack">
    <div>
      <h1>Inbox</h1>
      <p class="lede">
        Conversations with the people on this board. Private to the people in them, and the place an
        invoice goes.
      </p>
    </div>
    {threads.length === 0 ? (
      <Empty>
        <p>Nothing yet.</p>
        <p class="small muted">
          Write to a candidate from their page, or to an employer from theirs. Every conversation
          started with you lands here.
        </p>
      </Empty>
    ) : (
      <ul class="thread-list">
        {threads.map((thread) => (
          <li>
            <a class="card card-link thread" href={`/inbox/${thread.id}`}>
              <div class="spread">
                <span class="thread-with">
                  <strong>{thread.with.name}</strong>
                  {thread.with.kind === 'employer' && <span class="small muted"> employer</span>}
                </span>
                <span class="small muted">{ago(thread.lastMessageAt)}</span>
              </div>
              <p class="thread-subject">
                {thread.subject}
                {thread.unread > 0 && (
                  <>
                    {' '}
                    <Badge variant="primary">{thread.unread} new</Badge>
                  </>
                )}
              </p>
              <p class="small muted thread-preview">{thread.preview}</p>
              {thread.job !== null && <p class="small muted">About: {thread.job.title}</p>}
            </a>
          </li>
        ))}
      </ul>
    )}
  </div>
);

export const NewThreadPage: FC<{
  to: Party;
  job: { slug: string; title: string } | null;
  /** Employers the writer belongs to, offered as "write as". */
  asOrgs: Organisation[];
  values?: Record<string, string>;
  error?: string;
  /** The hidden fields that say who this is to. */
  target: { candidate?: string; employer?: string };
}> = ({ to, job, asOrgs, values = {}, error, target }) => (
  <div class="stack" style="max-width:44rem">
    <div>
      <h1>
        Message <PartyName party={to} />
      </h1>
      {job !== null && (
        <p class="lede">
          About <a href={`/jobs/${job.slug}`}>{job.title}</a>.
        </p>
      )}
    </div>
    {error !== undefined && <Alert variant="error">{error}</Alert>}
    <Card>
      <form method="post" action="/inbox/new" class="stack-sm">
        {target.candidate !== undefined && (
          <input type="hidden" name="candidate" value={target.candidate} />
        )}
        {target.employer !== undefined && (
          <input type="hidden" name="employer" value={target.employer} />
        )}
        {job !== null && <input type="hidden" name="job" value={job.slug} />}
        {asOrgs.length > 0 && to.kind === 'candidate' && (
          <Field
            label="Write as"
            name="as"
            hint="As yourself, or as an employer you belong to. Their other members see the conversation too."
          >
            <select id="as" name="as" class="select">
              <option value="">Yourself</option>
              {asOrgs.map((org) => (
                <option value={org.slug} selected={values['as'] === org.slug}>
                  {org.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field
          label="Subject"
          name="subject"
          hint="One line. Optional; the first words of the message stand in."
        >
          <input
            id="subject"
            name="subject"
            class="input"
            maxlength={140}
            value={values['subject'] ?? ''}
          />
        </Field>
        <Field label="Message" name="body">
          <textarea id="body" name="body" class="textarea" rows={8} maxlength={4000} required>
            {values['body'] ?? ''}
          </textarea>
        </Field>
        <div class="row">
          <button class="btn" type="submit">
            Send
          </button>
          <span class="small muted">
            They are emailed that there is a message, not the message.
          </span>
        </div>
      </form>
    </Card>
  </div>
);

const StatusBadge: FC<{ status: Invoice['status'] }> = ({ status }) => {
  if (status === 'paid') return <Badge variant="welcome">Paid</Badge>;
  if (status === 'cancelled') return <Badge variant="outline">Cancelled</Badge>;
  return <Badge variant="primary">Awaiting payment</Badge>;
};

/**
 * An invoice, inside the conversation it belongs to.
 *
 * The payee sees what they asked for and a way to take it back. Everybody else
 * sees Pay. Paid is paid for both, with the transaction hash, which is the
 * receipt.
 */
export const InvoiceCard: FC<{ invoice: Invoice; threadId: string; viewerId: string }> = ({
  invoice,
  threadId,
  viewerId,
}) => {
  const payee = invoice.payee.id === viewerId;
  const base = `/inbox/${threadId}/invoices/${invoice.id}`;
  return (
    <div class="invoice">
      <div class="spread">
        <span class="invoice-amount">
          ${invoice.amountUsd} <span class="small muted">in {invoice.currency}</span>
        </span>
        <StatusBadge status={invoice.status} />
      </div>
      {invoice.description !== '' && <p class="invoice-description">{invoice.description}</p>}
      <p class="small muted">
        From {invoice.payee.name}, {ago(invoice.createdAt)}. Settles to{' '}
        <code class="mono">{invoice.walletAddress}</code>.
      </p>
      {invoice.status === 'paid' && (
        <p class="small">
          Paid {invoice.paidAt === null ? '' : ago(invoice.paidAt)}
          {invoice.txHash !== null && (
            <>
              {' '}
              &middot; tx <code class="mono">{invoice.txHash}</code>
            </>
          )}
        </p>
      )}
      {invoice.status === 'sent' && !payee && (
        <form method="post" action={`${base}/pay`} class="row">
          <button class="btn btn-sm" type="submit">
            Pay on CoinPay
          </button>
          <span class="small muted">
            {invoice.payment !== null && invoice.payment.amountCrypto !== null
              ? `Quoted ${invoice.payment.amountCrypto} ${invoice.currency}. A quote lasts a few minutes; a fresh one is made if it lapsed.`
              : 'You get a quote in the coin the payee asked for and pay it from any wallet.'}
          </span>
        </form>
      )}
      {invoice.status === 'sent' && payee && (
        <form method="post" action={`${base}/cancel`} class="row">
          <button class="btn btn-secondary btn-sm" type="submit">
            Cancel invoice
          </button>
          <span class="small muted">Nothing has been paid. A changed invoice is a new one.</span>
        </form>
      )}
    </div>
  );
};

const MessageItem: FC<{
  message: Message;
  invoice: Invoice | undefined;
  threadId: string;
  viewerId: string;
}> = ({ message, invoice, threadId, viewerId }) => (
  <li class={message.mine ? 'message mine' : 'message'} id={message.id}>
    <p class="message-meta small muted">
      <strong>{message.mine ? 'You' : message.sender.name}</strong>
      {!message.mine && message.sender.party?.kind === 'employer' && (
        <> at {message.sender.party.name}</>
      )}{' '}
      &middot; {ago(message.createdAt)}
    </p>
    {message.kind === 'invoice' && invoice !== undefined ? (
      <InvoiceCard invoice={invoice} threadId={threadId} viewerId={viewerId} />
    ) : (
      // Text, rendered as text. Nothing anybody typed becomes markup.
      <p class="message-body">{message.body}</p>
    )}
  </li>
);

export interface BillingState {
  /** False when the board has no CoinPay configured: no invoice form at all. */
  enabled: boolean;
  /** The viewer's connection, if any. */
  account: Account | null;
}

export const ThreadPage: FC<{
  thread: Thread;
  invoices: Invoice[];
  viewerId: string;
  billing: BillingState;
  error?: string;
  values?: Record<string, string>;
}> = ({ thread, invoices, viewerId, billing, error, values = {} }) => {
  const byId = new Map(invoices.map((invoice) => [invoice.id, invoice]));
  const wallets: Wallet[] = billing.account?.usable === true ? billing.account.wallets : [];
  return (
    <div class="stack" style="max-width:48rem">
      <div class="stack-sm">
        <p class="small">
          <a href="/inbox">&larr; Inbox</a>
        </p>
        <h1 style="margin-bottom:0">{thread.subject}</h1>
        <p class="lede">
          With <PartyName party={thread.with} />
          {thread.job !== null && (
            <>
              , about <a href={`/jobs/${thread.job.slug}`}>{thread.job.title}</a>
            </>
          )}
          .
        </p>
      </div>

      <ul class="message-list">
        {thread.messages.map((message) => (
          <MessageItem
            message={message}
            invoice={message.invoiceId === null ? undefined : byId.get(message.invoiceId)}
            threadId={thread.id}
            viewerId={viewerId}
          />
        ))}
      </ul>

      {error !== undefined && <Alert variant="error">{error}</Alert>}

      <Card>
        <form method="post" action={`/inbox/${thread.id}`} class="stack-sm">
          <Field label="Reply" name="body">
            <textarea id="body" name="body" class="textarea" rows={4} maxlength={4000} required>
              {values['body'] ?? ''}
            </textarea>
          </Field>
          <div class="row">
            <button class="btn" type="submit">
              Send
            </button>
          </div>
        </form>
      </Card>

      {billing.enabled && (
        <details class="card invoice-form">
          <summary class="card-title">Send an invoice</summary>
          {billing.account === null ? (
            <p class="small muted" style="margin-top:.6rem">
              <a href={`/me/coinpay/connect?next=${encodeURIComponent(`/inbox/${thread.id}`)}`}>
                Connect your CoinPay account
              </a>{' '}
              first, so there is a wallet for the payment to settle to. It is paid to you directly;
              this board never holds it.
            </p>
          ) : !billing.account.usable ? (
            <p class="small muted" style="margin-top:.6rem">
              Your CoinPay connection has lapsed.{' '}
              <a href={`/me/coinpay/connect?next=${encodeURIComponent(`/inbox/${thread.id}`)}`}>
                Reconnect it
              </a>{' '}
              to send an invoice.
            </p>
          ) : wallets.length === 0 ? (
            <p class="small muted" style="margin-top:.6rem">
              Your CoinPay account has no wallet yet. Add one on CoinPay, then{' '}
              <a href="/me#billing">refresh the connection</a>.
            </p>
          ) : (
            <form
              method="post"
              action={`/inbox/${thread.id}/invoices`}
              class="stack-sm"
              style="margin-top:.6rem"
            >
              <div class="grid-2 reverse" style="gap:.75rem">
                <Field label="Amount, USD" name="amount">
                  <input
                    id="amount"
                    name="amount"
                    class="input"
                    inputmode="decimal"
                    placeholder="1200.00"
                    required
                    value={values['amount'] ?? ''}
                  />
                </Field>
                <Field
                  label="Paid in"
                  name="currency"
                  hint="One of the wallets on your CoinPay account."
                >
                  <select id="currency" name="currency" class="select">
                    {wallets.map((wallet) => (
                      <option value={wallet.chain} selected={values['currency'] === wallet.chain}>
                        {wallet.chain}
                        {wallet.label === null ? '' : ` - ${wallet.label}`}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field
                label="For"
                name="description"
                hint="What this is for. It is the message the other side reads."
              >
                <textarea
                  id="description"
                  name="description"
                  class="textarea"
                  rows={3}
                  maxlength={1000}
                >
                  {values['description'] ?? ''}
                </textarea>
              </Field>
              <div class="row">
                <button class="btn" type="submit">
                  Send invoice
                </button>
                <span class="small muted">
                  They pay on CoinPay, to your wallet, in the coin you chose.
                </span>
              </div>
            </form>
          )}
        </details>
      )}
    </div>
  );
};

/**
 * Billing, on the You page.
 *
 * Connection state and wallets, and every invoice the person sent or can pay.
 * The state is computed from the token's scope, not from the row existing: a
 * connection that cannot read a wallet says so here rather than showing a
 * green badge beside an invoice form that fails.
 */
export const BillingCard: FC<{
  enabled: boolean;
  account: Account | null;
  invoices: Invoice[];
  viewerId: string;
  coinpayUrl: string | null;
  notice?: string;
}> = ({ enabled, account, invoices, viewerId, coinpayUrl, notice }) => (
  <section class="stack" id="billing">
    <div class="spread">
      <h2>Billing</h2>
      {enabled && account === null && (
        <a class="btn btn-sm" href="/me/coinpay/connect">
          Connect CoinPay
        </a>
      )}
    </div>
    {notice !== undefined && <Alert variant="info">{notice}</Alert>}
    {!enabled ? (
      <p class="small muted">
        This board has no payment rail configured, so invoices are off. An operator turns them on
        with a CoinPay business and OAuth client; see the README.
      </p>
    ) : account === null ? (
      <p class="small muted">
        Connect a CoinPay account to send invoices from the inbox. Payments settle to your own
        wallet; this board never holds them.
      </p>
    ) : (
      <Card>
        <div class="spread">
          <div>
            <h3 class="card-title">
              CoinPay{' '}
              {account.usable ? (
                <Badge variant="welcome">Connected</Badge>
              ) : (
                <Badge variant="human">Reconnect required</Badge>
              )}
            </h3>
            <p class="small muted">
              {account.email ?? account.name ?? account.sub}, since {ago(account.connectedAt)}.
              {!account.usable && ' The connection cannot read your wallets any more.'}
            </p>
          </div>
          <div class="row" style="gap:.4rem;flex-wrap:wrap">
            {account.usable ? (
              <form method="post" action="/me/coinpay/refresh">
                <button class="btn btn-secondary btn-sm" type="submit">
                  Refresh wallets
                </button>
              </form>
            ) : (
              <a class="btn btn-sm" href="/me/coinpay/connect">
                Reconnect
              </a>
            )}
            <form method="post" action="/me/coinpay/disconnect">
              <button class="btn btn-secondary btn-sm" type="submit">
                Disconnect
              </button>
            </form>
          </div>
        </div>
        {account.usable && (
          <div style="margin-top:.75rem">
            {account.wallets.length === 0 ? (
              <p class="small muted">
                No wallets on the account yet.{' '}
                {coinpayUrl !== null && (
                  <a href={`${coinpayUrl}/dashboard`} rel="noopener">
                    Add one on CoinPay
                  </a>
                )}
                , then refresh.
              </p>
            ) : (
              <ul class="stack-sm wallet-list" style="list-style:none;margin:0;padding:0">
                {account.wallets.map((wallet) => (
                  <li class="small">
                    <Badge variant="outline">{wallet.chain}</Badge>{' '}
                    <code class="mono">{wallet.address}</code>
                    {wallet.label !== null && <span class="muted"> {wallet.label}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>
    )}

    {invoices.length > 0 && (
      <div class="stack-sm">
        <h3 class="card-title">Invoices</h3>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Amount</th>
                <th>Between</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => (
                <tr>
                  <td class="small muted">{ago(invoice.createdAt)}</td>
                  <td>
                    ${invoice.amountUsd} <span class="small muted">{invoice.currency}</span>
                  </td>
                  <td class="small">
                    {invoice.payee.id === viewerId
                      ? 'You invoiced'
                      : `${invoice.payee.name} invoiced you`}
                  </td>
                  <td>
                    <StatusBadge status={invoice.status} />
                  </td>
                  <td>
                    <a class="small" href={`/inbox/${invoice.threadId}`}>
                      Open
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )}
  </section>
);
