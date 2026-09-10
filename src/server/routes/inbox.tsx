/**
 * The inbox pages.
 *
 * Every form here works without JavaScript, like the rest of the site, and
 * every page needs a signed-in person: there is nothing public in an inbox.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  counterpartyFrom,
  getThread,
  listThreads,
  markRead,
  notifyParticipants,
  sendMessage,
  startThread,
  type Party,
} from '../../core/inbox.ts';
import {
  cancelInvoice,
  getInvoice,
  listInvoicesIn,
  requestPayment,
  sendInvoice,
  syncInvoice,
} from '../../core/invoices.ts';
import { getAccount } from '../../core/coinpay.ts';
import { getJobBySlug } from '../../core/jobs.ts';
import { getOrgBySlug, listOrgsForUser } from '../../core/orgs.ts';
import { getPublicResume } from '../../core/resumes.ts';
import { toCandidateSummary } from '../../core/candidates.ts';
import { Layout } from '../../views/layout.tsx';
import { InboxPage, NewThreadPage, ThreadPage } from '../../views/inbox.tsx';
import { formOf, requireViewer, shell } from './pages.tsx';
import type { AppEnv } from '../deps.ts';

type Ctx = Context<AppEnv>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function inboxRoutes(): Hono<AppEnv> {
  const inbox = new Hono<AppEnv>();

  inbox.get('/inbox', async (c) => {
    const { pool } = c.get('deps');
    const viewer = requireViewer(c);
    if (viewer instanceof Response) return viewer;
    const threads = await listThreads(pool, viewer.id);
    return c.html(
      <Layout {...shell(c)} title="Inbox" noindex>
        <InboxPage threads={threads} />
      </Layout>,
    );
  });

  /**
   * Who the compose page is to, from its query or its form.
   *
   * Resolved to a page the person can see, so the heading can name them, and
   * so "message" on a private resume is a 404 rather than a way to reach
   * somebody who did not publish.
   */
  async function resolveTarget(
    c: Ctx,
    input: Record<string, string>,
  ): Promise<{ to: Party; target: { candidate?: string; employer?: string } } | null> {
    const { pool } = c.get('deps');
    const candidate = (input['candidate'] ?? '').trim();
    const employer = (input['employer'] ?? '').trim();
    if (candidate !== '') {
      const resume = await getPublicResume(pool, candidate);
      if (resume === null) return null;
      const summary = toCandidateSummary(resume);
      return {
        to: { kind: 'candidate', name: summary.name, slug: candidate },
        target: { candidate },
      };
    }
    if (employer !== '') {
      const org = await getOrgBySlug(pool, employer);
      if (org === null) return null;
      return { to: { kind: 'employer', name: org.name, slug: org.slug }, target: { employer } };
    }
    return null;
  }

  const composePage = async (
    c: Ctx,
    input: Record<string, string>,
    status: 200 | 400 = 200,
    error?: string,
  ): Promise<Response> => {
    const { pool } = c.get('deps');
    const viewer = requireViewer(c);
    if (viewer instanceof Response) return viewer;
    const resolved = await resolveTarget(c, input);
    if (resolved === null) return c.notFound();
    const jobSlug = (input['job'] ?? '').trim();
    const job = jobSlug === '' ? null : await getJobBySlug(pool, jobSlug);
    const asOrgs = await listOrgsForUser(pool, viewer.id);
    return c.html(
      <Layout {...shell(c)} title={`Message ${resolved.to.name}`} noindex>
        <NewThreadPage
          to={resolved.to}
          job={job === null ? null : { slug: job.slug, title: job.title }}
          asOrgs={asOrgs}
          values={input}
          target={resolved.target}
          {...(error === undefined ? {} : { error })}
        />
      </Layout>,
      status,
    );
  };

  inbox.get('/inbox/new', (c) => {
    const params = new URL(c.req.url).searchParams;
    return composePage(c, Object.fromEntries(params.entries()));
  });

  inbox.post('/inbox/new', async (c) => {
    const { pool, config, mailer } = c.get('deps');
    const viewer = requireViewer(c);
    if (viewer instanceof Response) return viewer;
    const form = await formOf(c);

    const to = await counterpartyFrom(pool, {
      candidate: form['candidate'] ?? null,
      employer: form['employer'] ?? null,
    });
    if (to === null) return c.notFound();

    const jobSlug = (form['job'] ?? '').trim();
    const job = jobSlug === '' ? null : await getJobBySlug(pool, jobSlug);
    const asSlug = (form['as'] ?? '').trim();
    const asOrg = asSlug === '' ? null : await getOrgBySlug(pool, asSlug);
    if (asSlug !== '' && asOrg === null) return composePage(c, form, 400, 'No such employer.');

    const started = await startThread(pool, viewer.id, to, {
      subject: form['subject'],
      body: form['body'],
      jobId: job?.id ?? null,
      as: asOrg?.id ?? null,
    });
    if (typeof started === 'string') return composePage(c, form, 400, started);

    await notifyParticipants(pool, {
      mailer,
      boardName: config.boardName,
      publicUrl: config.publicUrl,
      threadId: started.threadId,
      senderId: viewer.id,
      kind: 'text',
    });
    return c.redirect(`/inbox/${started.threadId}`, 303);
  });

  const threadPage = async (
    c: Ctx,
    threadId: string,
    status: 200 | 400 = 200,
    error?: string,
    values?: Record<string, string>,
  ): Promise<Response> => {
    const { pool, coinpay } = c.get('deps');
    const viewer = requireViewer(c);
    if (viewer instanceof Response) return viewer;
    if (!UUID.test(threadId)) return c.notFound();

    const thread = await getThread(pool, threadId, viewer.id);
    if (thread === null) return c.notFound();

    // Ask CoinPay about every open quote before rendering, so a payer who paid
    // and came back sees "paid" rather than a stale button.
    const invoices = await Promise.all(
      (await listInvoicesIn(pool, coinpay, threadId)).map((invoice) =>
        syncInvoice(pool, coinpay, invoice),
      ),
    );
    const account = coinpay === null ? null : await getAccount(pool, viewer.id);
    if (status === 200) await markRead(pool, threadId, viewer.id);

    return c.html(
      <Layout {...shell(c)} title={thread.subject} noindex>
        <ThreadPage
          thread={thread}
          invoices={invoices}
          viewerId={viewer.id}
          billing={{ enabled: coinpay !== null, account }}
          {...(error === undefined ? {} : { error })}
          {...(values === undefined ? {} : { values })}
        />
      </Layout>,
      status,
    );
  };

  inbox.get('/inbox/:id', (c) => threadPage(c, c.req.param('id')));

  inbox.post('/inbox/:id', async (c) => {
    const { pool, config, mailer } = c.get('deps');
    const viewer = requireViewer(c);
    if (viewer instanceof Response) return viewer;
    const threadId = c.req.param('id');
    if (!UUID.test(threadId)) return c.notFound();
    const form = await formOf(c);
    const sent = await sendMessage(pool, threadId, viewer.id, form['body']);
    if (typeof sent === 'string') return threadPage(c, threadId, 400, sent, form);
    await notifyParticipants(pool, {
      mailer,
      boardName: config.boardName,
      publicUrl: config.publicUrl,
      threadId,
      senderId: viewer.id,
      kind: 'text',
    });
    return c.redirect(`/inbox/${threadId}#${sent.id}`, 303);
  });

  inbox.post('/inbox/:id/invoices', async (c) => {
    const { pool, config, mailer, coinpay } = c.get('deps');
    const viewer = requireViewer(c);
    if (viewer instanceof Response) return viewer;
    const threadId = c.req.param('id');
    if (!UUID.test(threadId)) return c.notFound();
    const form = await formOf(c);
    const invoice = await sendInvoice(pool, coinpay, {
      threadId,
      payeeId: viewer.id,
      amount: form['amount'],
      currency: form['currency'],
      description: form['description'],
    });
    if (typeof invoice === 'string') return threadPage(c, threadId, 400, invoice, form);
    await notifyParticipants(pool, {
      mailer,
      boardName: config.boardName,
      publicUrl: config.publicUrl,
      threadId,
      senderId: viewer.id,
      kind: 'invoice',
    });
    return c.redirect(`/inbox/${threadId}`, 303);
  });

  /** Off to CoinPay with a live quote. */
  inbox.post('/inbox/:id/invoices/:invoiceId/pay', async (c) => {
    const { pool, config, coinpay } = c.get('deps');
    const viewer = requireViewer(c);
    if (viewer instanceof Response) return viewer;
    const threadId = c.req.param('id');
    const invoiceId = c.req.param('invoiceId');
    if (!UUID.test(threadId) || !UUID.test(invoiceId)) return c.notFound();
    const result = await requestPayment(pool, coinpay, {
      invoiceId,
      payerId: viewer.id,
      publicUrl: config.publicUrl,
    });
    if (typeof result === 'string') return threadPage(c, threadId, 400, result);
    if (result.status === 'paid' || result.payment === null) {
      return c.redirect(`/inbox/${threadId}`, 303);
    }
    return c.redirect(result.payment.url, 303);
  });

  inbox.post('/inbox/:id/invoices/:invoiceId/cancel', async (c) => {
    const { pool, coinpay } = c.get('deps');
    const viewer = requireViewer(c);
    if (viewer instanceof Response) return viewer;
    const threadId = c.req.param('id');
    const invoiceId = c.req.param('invoiceId');
    if (!UUID.test(threadId) || !UUID.test(invoiceId)) return c.notFound();
    const invoice = await getInvoice(pool, coinpay, invoiceId, viewer.id);
    if (invoice === null || invoice.threadId !== threadId) return c.notFound();
    const cancelled = await cancelInvoice(pool, invoiceId, viewer.id);
    if (!cancelled) {
      return threadPage(
        c,
        threadId,
        400,
        'Only the sender can cancel an invoice, and only while it is unpaid.',
      );
    }
    return c.redirect(`/inbox/${threadId}`, 303);
  });

  return inbox;
}
