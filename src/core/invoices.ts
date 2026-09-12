/**
 * Invoices: a message with money attached.
 *
 * The payee writes one in a conversation they are in. The other side sees it
 * there, presses Pay, and is sent to CoinPay to settle it in the coin the
 * payee chose, straight to the payee's wallet. The board mints the payment
 * under its own business key and names the payee's address as the payout, so
 * at no point does money sit anywhere the board controls.
 *
 * A CoinPay payment is a quote that expires. The invoice does not: when a
 * quote lapses unpaid, Pay mints a fresh one under the same invoice, and
 * `status` only ever moves sent -> paid or sent -> cancelled. Payment is
 * confirmed by webhook, and by asking CoinPay when the page is opened, so a
 * lost webhook delays the answer rather than losing it.
 */

import type pg from 'pg';
import { clean } from '../schema/text.ts';
import { CoinPayProblem, getAccount, type CoinPayClient } from './coinpay.ts';

export type InvoiceStatus = 'sent' | 'paid' | 'cancelled';

export interface Invoice {
  id: string;
  threadId: string;
  payee: { id: string; name: string };
  amountUsd: string;
  /** The chain, in CoinPay's spelling. */
  currency: string;
  walletAddress: string;
  description: string;
  status: InvoiceStatus;
  payment: {
    id: string;
    address: string | null;
    amountCrypto: string | null;
    expiresAt: string | null;
    /** Where to pay. */
    url: string;
  } | null;
  paidAt: string | null;
  paidBy: string | null;
  txHash: string | null;
  createdAt: string;
}

interface InvoiceRow {
  id: string;
  thread_id: string;
  payee_id: string;
  payee_name: string | null;
  payee_email: string;
  amount_usd: string;
  currency: string;
  wallet_address: string;
  description: string;
  status: InvoiceStatus;
  coinpay_payment_id: string | null;
  payment_address: string | null;
  amount_crypto: string | null;
  payment_expires_at: string | null;
  paid_at: string | null;
  paid_by: string | null;
  tx_hash: string | null;
  created_at: string;
}

const SELECT = `
  select i.*, u.name as payee_name, u.email as payee_email
    from invoices i join users u on u.id = i.payee_id`;

function toInvoice(row: InvoiceRow, coinpay: CoinPayClient | null): Invoice {
  const name = (row.payee_name ?? '').trim();
  return {
    id: row.id,
    threadId: row.thread_id,
    payee: { id: row.payee_id, name: name === '' ? row.payee_email : name },
    amountUsd: Number(row.amount_usd).toFixed(2),
    currency: row.currency,
    walletAddress: row.wallet_address,
    description: row.description,
    status: row.status,
    payment:
      row.coinpay_payment_id === null || coinpay === null
        ? null
        : {
            id: row.coinpay_payment_id,
            address: row.payment_address,
            amountCrypto: row.amount_crypto,
            expiresAt: row.payment_expires_at,
            url: coinpay.payUrl(row.coinpay_payment_id),
          },
    paidAt: row.paid_at,
    paidBy: row.paid_by,
    txHash: row.tx_hash,
    createdAt: row.created_at,
  };
}

/** A dollar amount as typed: "120", "120.50", "$1,200". Null when it is not one. */
export function parseAmount(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value).trim();
  if (!/^\$?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(raw)) return null;
  const amount = Number(raw.replace(/[$,]/g, ''));
  if (!(amount > 0) || amount > 1_000_000) return null;
  return amount.toFixed(2);
}

/**
 * Send one. Returns the invoice, or a sentence saying why not.
 *
 * The payee has to be in the conversation and has to have connected a CoinPay
 * account with a wallet on the chain they chose; the address is copied onto
 * the invoice at this moment and never read again, so what the payer pays to
 * is what the payee had connected when they asked.
 */
export async function sendInvoice(
  pool: pg.Pool,
  coinpay: CoinPayClient | null,
  input: {
    threadId: string;
    payeeId: string;
    amount: unknown;
    currency: unknown;
    description: unknown;
  },
): Promise<Invoice | string> {
  if (coinpay === null) return 'This board has no payment rail configured.';
  const amount = parseAmount(input.amount);
  if (amount === null) return 'The amount has to be a number of dollars, like 1200 or 1200.50.';
  const description = clean(input.description, 1000, { multiline: true });

  const account = await getAccount(pool, input.payeeId);
  if (account === null)
    return 'Connect a CoinPay account first, so there is a wallet to be paid to.';
  if (!account.usable)
    return 'Your CoinPay connection has lapsed. Reconnect it, then send the invoice.';
  if (account.wallets.length === 0) {
    return 'Your CoinPay account has no wallet yet. Add one on CoinPay, refresh the connection here, then send the invoice.';
  }

  const wanted = clean(input.currency, 20).toUpperCase();
  const wallet =
    wanted === ''
      ? account.wallets.length === 1
        ? account.wallets[0]
        : undefined
      : account.wallets.find((w) => w.chain === wanted);
  if (wallet === undefined) {
    return wanted === ''
      ? `Say which coin to be paid in: ${account.wallets.map((w) => w.chain).join(', ')}.`
      : `You have no ${wanted} wallet connected. You can be paid in: ${account.wallets.map((w) => w.chain).join(', ')}.`;
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const member = await client.query(
      `select 1 from thread_participants where thread_id = $1 and user_id = $2`,
      [input.threadId, input.payeeId],
    );
    if (member.rows.length === 0) {
      await client.query('rollback');
      return 'You are not in that conversation.';
    }
    const inserted = await client.query<{ id: string }>(
      `insert into invoices (thread_id, payee_id, amount_usd, currency, wallet_address, description)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [input.threadId, input.payeeId, amount, wallet.chain, wallet.address, description],
    );
    const invoiceId = inserted.rows[0]!.id;
    const body = description === '' ? `Invoice for $${amount}` : description;
    const message = await client.query<{ created_at: string }>(
      `insert into messages (thread_id, sender_id, kind, body, invoice_id)
       values ($1, $2, 'invoice', $3, $4) returning created_at`,
      [input.threadId, input.payeeId, body, invoiceId],
    );
    await client.query(`update threads set last_message_at = $2 where id = $1`, [
      input.threadId,
      message.rows[0]!.created_at,
    ]);
    await client.query(
      `update thread_participants set last_read_at = $3 where thread_id = $1 and user_id = $2`,
      [input.threadId, input.payeeId, message.rows[0]!.created_at],
    );
    await client.query('commit');
    const row = await pool.query<InvoiceRow>(`${SELECT} where i.id = $1`, [invoiceId]);
    return toInvoice(row.rows[0]!, coinpay);
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/** The invoices in a conversation, oldest first, for rendering beside messages. */
export async function listInvoicesIn(
  pool: pg.Pool,
  coinpay: CoinPayClient | null,
  threadId: string,
): Promise<Invoice[]> {
  const result = await pool.query<InvoiceRow>(
    `${SELECT} where i.thread_id = $1 order by i.created_at asc`,
    [threadId],
  );
  return result.rows.map((row) => toInvoice(row, coinpay));
}

/**
 * Everything the viewer sent or can pay: their invoices, and the invoices in
 * conversations they are in. Newest first.
 */
export async function listInvoicesFor(
  pool: pg.Pool,
  coinpay: CoinPayClient | null,
  viewerId: string,
): Promise<Invoice[]> {
  const result = await pool.query<InvoiceRow>(
    `${SELECT}
      where exists (select 1 from thread_participants tp
                     where tp.thread_id = i.thread_id and tp.user_id = $1)
      order by i.created_at desc limit 200`,
    [viewerId],
  );
  return result.rows.map((row) => toInvoice(row, coinpay));
}

/** One invoice, for a participant of its conversation. Null for anybody else. */
export async function getInvoice(
  pool: pg.Pool,
  coinpay: CoinPayClient | null,
  invoiceId: string,
  viewerId: string,
): Promise<Invoice | null> {
  const result = await pool.query<InvoiceRow>(
    `${SELECT}
      where i.id = $1
        and exists (select 1 from thread_participants tp
                     where tp.thread_id = i.thread_id and tp.user_id = $2)`,
    [invoiceId, viewerId],
  );
  const row = result.rows[0];
  return row === undefined ? null : toInvoice(row, coinpay);
}

/** The payee takes it back. Only while unpaid. */
export async function cancelInvoice(
  pool: pg.Pool,
  invoiceId: string,
  payeeId: string,
): Promise<boolean> {
  const result = await pool.query(
    `update invoices set status = 'cancelled', updated_at = now()
      where id = $1 and payee_id = $2 and status = 'sent'`,
    [invoiceId, payeeId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Get somewhere to pay. Returns the invoice with a live payment on it, or a
 * sentence.
 *
 * Anyone in the conversation but the payee may pay. A payment still inside its
 * quote window is reused; otherwise a new one is minted for the same invoice,
 * and the id is remembered so the webhook can find its way back.
 */
export async function requestPayment(
  pool: pg.Pool,
  coinpay: CoinPayClient | null,
  input: { invoiceId: string; payerId: string; publicUrl: string },
): Promise<Invoice | string> {
  if (coinpay === null) return 'This board has no payment rail configured.';
  const current = await getInvoice(pool, coinpay, input.invoiceId, input.payerId);
  if (current === null) return 'No such invoice.';
  if (current.payee.id === input.payerId) return 'You cannot pay your own invoice.';
  if (current.status === 'paid') return 'That invoice is already paid.';
  if (current.status === 'cancelled') return 'That invoice was cancelled.';

  // Ask CoinPay about the payment we have before minting another: a payer who
  // paid and came back should see "paid", not a second quote.
  const synced = await syncInvoice(pool, coinpay, current);
  if (synced.status === 'paid') return synced;
  if (
    synced.payment !== null &&
    synced.payment.expiresAt !== null &&
    new Date(synced.payment.expiresAt).getTime() > Date.now() + 60_000
  ) {
    return synced;
  }

  let minted;
  try {
    minted = await coinpay.createPayment({
      amountUsd: current.amountUsd,
      chain: current.currency,
      payeeAddress: current.walletAddress,
      description:
        current.description === '' ? `Invoice ${current.id.slice(0, 8)}` : current.description,
      redirectUrl: `${input.publicUrl}/inbox/${current.threadId}`,
      // One quote per invoice per minute: a double click is one payment.
      idempotencyKey: `${current.id}:${Math.floor(Date.now() / 60_000)}`,
      metadata: {
        source: 'agenticjobs',
        invoice_id: current.id,
        thread_id: current.threadId,
        payer_id: input.payerId,
      },
    });
  } catch (error) {
    if (error instanceof CoinPayProblem) return error.message;
    throw error;
  }

  // Two statements, not one with a CTE: a data-modifying CTE is not visible to
  // the SELECT beside it, which would read the row from before the update and
  // hand back an invoice with no payment on it.
  const updated = await pool.query(
    `update invoices set coinpay_payment_id = $2, payment_address = $3, amount_crypto = $4,
            payment_expires_at = $5, updated_at = now()
      where id = $1 and status = 'sent'`,
    [
      current.id,
      minted.id,
      minted.address,
      minted.amountCrypto,
      minted.expiresAt ?? new Date(Date.now() + 15 * 60_000).toISOString(),
    ],
  );
  if ((updated.rowCount ?? 0) === 0)
    return 'That invoice changed while the payment was being created.';
  const saved = await pool.query<InvoiceRow>(`${SELECT} where i.id = $1`, [current.id]);
  const row = saved.rows[0];
  return row === undefined ? 'No such invoice.' : toInvoice(row, coinpay);
}

const PAID = new Set(['confirmed', 'forwarded', 'completed', 'paid']);
const DEAD = new Set(['expired', 'failed', 'cancelled']);

/**
 * Ask CoinPay how the current payment is doing and record the answer.
 *
 * Paid is paid, whichever way the news arrives. A dead quote is cleared so the
 * next Pay mints a fresh one. Anything in between, or CoinPay not answering,
 * leaves the invoice as it was: this is a read that happens on page load, and
 * a provider hiccup must not turn into a changed status.
 */
export async function syncInvoice(
  pool: pg.Pool,
  coinpay: CoinPayClient | null,
  invoice: Invoice,
): Promise<Invoice> {
  if (coinpay === null || invoice.status !== 'sent' || invoice.payment === null) return invoice;
  let payment;
  try {
    payment = await coinpay.getPayment(invoice.payment.id);
  } catch {
    return invoice;
  }
  if (payment === null) return invoice;

  if (PAID.has(payment.status)) {
    await markPaid(pool, { paymentId: payment.id, txHash: payment.txHash });
  } else if (DEAD.has(payment.status)) {
    await pool.query(
      `update invoices set coinpay_payment_id = null, payment_address = null, amount_crypto = null,
              payment_expires_at = null, updated_at = now()
        where id = $1 and coinpay_payment_id = $2 and status = 'sent'`,
      [invoice.id, payment.id],
    );
  } else {
    return invoice;
  }
  const fresh = await pool.query<InvoiceRow>(`${SELECT} where i.id = $1`, [invoice.id]);
  const row = fresh.rows[0];
  return row === undefined ? invoice : toInvoice(row, coinpay);
}

/**
 * Record a payment as settled. Idempotent: the webhook fires for `confirmed`
 * and again for `forwarded`, and a poll may land between them.
 */
export async function markPaid(
  pool: pg.Pool,
  input: { paymentId: string; txHash: string | null; paidBy?: string | null },
): Promise<boolean> {
  const result = await pool.query(
    `update invoices
        set status = 'paid', paid_at = coalesce(paid_at, now()),
            tx_hash = coalesce($2, tx_hash), paid_by = coalesce(paid_by, $3), updated_at = now()
      where coinpay_payment_id = $1 and status in ('sent', 'paid')`,
    [input.paymentId, input.txHash, input.paidBy ?? null],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * A webhook from CoinPay, already verified by the caller.
 *
 * Only the two settlement events change anything. An expired quote is left
 * to the next page load, which clears it the same way and does not depend on
 * a delivery that may never come.
 */
export async function applyWebhook(
  pool: pg.Pool,
  payload: Record<string, unknown>,
): Promise<'paid' | 'ignored' | 'unknown'> {
  const event = typeof payload['event'] === 'string' ? payload['event'] : '';
  const paymentId = typeof payload['payment_id'] === 'string' ? payload['payment_id'] : '';
  if (paymentId === '') return 'ignored';
  if (event !== 'payment.confirmed' && event !== 'payment.forwarded') return 'ignored';
  const txHash = typeof payload['tx_hash'] === 'string' ? payload['tx_hash'] : null;
  const paid = await markPaid(pool, { paymentId, txHash });
  return paid ? 'paid' : 'unknown';
}
