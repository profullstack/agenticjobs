/**
 * The parts of billing that need no database: the CoinPay client's contract,
 * the config's all-or-none rule, and the two rules that bit ugig.net before
 * this board existed - a grant without wallet:read is not a connection, and a
 * webhook is only a webhook when the signature says so.
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { coinpayConfig } from '../dist/config.js';
import {
  createCoinPay,
  hasScope,
  normaliseWallets,
  pkcePair,
  SCOPES,
} from '../dist/core/coinpay.js';
import { parseAmount } from '../dist/core/invoices.js';
import { inboxMessage } from '../dist/core/mail.js';

const FULL = {
  COINPAY_CLIENT_ID: 'cp_client',
  COINPAY_CLIENT_SECRET: 'cps_secret',
  COINPAY_API_KEY: 'cp_live_key',
  COINPAY_BUSINESS_ID: 'biz',
  COINPAY_WEBHOOK_SECRET: 'whsec_test',
};

test('billing is all four credentials or none', () => {
  assert.equal(coinpayConfig({}), null);
  const logged: string[] = [];
  assert.equal(
    coinpayConfig({ COINPAY_CLIENT_ID: 'cp_x', COINPAY_CLIENT_SECRET: 'cps_y' }, (m) =>
      logged.push(m),
    ),
    null,
  );
  assert.equal(logged.length, 1, 'a partial set is said out loud');
  const config = coinpayConfig(FULL);
  assert.ok(config);
  assert.equal(config.url, 'https://coinpayportal.com');
  assert.equal(config.webhookSecret, 'whsec_test');
  assert.equal(
    coinpayConfig({ ...FULL, COINPAY_URL: 'https://pay.example/' })?.url,
    'https://pay.example',
  );
});

test('the authorize URL asks for wallet:read with PKCE, and nothing is trusted from the request', () => {
  const client = createCoinPay(coinpayConfig(FULL)!);
  const { challenge } = pkcePair();
  const url = new URL(
    client.authorizeUrl({
      state: 's',
      codeChallenge: challenge,
      redirectUri: 'https://b/api/v1/coinpay/callback',
    }),
  );
  assert.equal(url.origin + url.pathname, 'https://coinpayportal.com/api/oauth/authorize');
  assert.equal(url.searchParams.get('scope'), SCOPES.join(' '));
  assert.ok(SCOPES.includes('wallet:read'));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), challenge);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://b/api/v1/coinpay/callback');
});

test('a grant without wallet:read is not a usable connection', () => {
  // CoinPay narrows a grant to the client's registered scopes without an
  // error. ugig.net showed "Connected" for weeks beside tokens that could not
  // read a wallet. The check is on what came back, never on what was asked.
  assert.equal(hasScope('openid profile email'), false);
  assert.equal(hasScope('openid profile email wallet:read'), true);
  assert.equal(hasScope(['wallet:readwrite']), false, 'a whole token, not a prefix');
});

test('wallets are read from the userinfo claim and spelled the way CoinPay spells chains', () => {
  const wallets = normaliseWallets([
    { address: 'bc1qabc', chain: 'btc', label: 'Main' },
    { address: '0xdef', cryptocurrency: 'USDC_POL' },
    { address: '', chain: 'ETH' },
    'nonsense',
  ]);
  assert.deepEqual(wallets, [
    { address: 'bc1qabc', chain: 'BTC', label: 'Main' },
    { address: '0xdef', chain: 'USDC_POL', label: null },
  ]);
  assert.deepEqual(normaliseWallets(undefined), []);
});

test('a webhook is only a webhook when the signature says so', () => {
  const client = createCoinPay(coinpayConfig(FULL)!);
  const body = JSON.stringify({ event: 'payment.confirmed', payment_id: 'p1' });
  const now = 1_700_000_000_000;
  const t = Math.floor(now / 1000);
  const sign = (secret: string, ts = t) =>
    `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;

  assert.equal(client.verifyWebhook(body, sign('whsec_test'), now), true);
  assert.equal(client.verifyWebhook(body, sign('whsec_other'), now), false, 'wrong secret');
  assert.equal(client.verifyWebhook(body, undefined, now), false, 'no header');
  assert.equal(client.verifyWebhook(body, sign('whsec_test', t - 600), now), false, 'too old');
  assert.equal(client.verifyWebhook(`${body} `, sign('whsec_test'), now), false, 'body changed');

  const unsecured = createCoinPay(coinpayConfig({ ...FULL, COINPAY_WEBHOOK_SECRET: '' })!);
  assert.equal(
    unsecured.verifyWebhook(body, sign('whsec_test'), now),
    false,
    'no secret, no webhooks',
  );
});

test('the payment request names the payee wallet and the board business, with the business key', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(
      JSON.stringify({
        success: true,
        payment: {
          id: 'pay_1',
          payment_address: '0xpayto',
          amount_crypto: '1199.5',
          currency: 'usdc_pol',
          status: 'pending',
          expires_at: '2030-01-01T00:00:00.000Z',
        },
      }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    );
  };
  const client = createCoinPay(coinpayConfig(FULL)!, fetchImpl);
  const payment = await client.createPayment({
    amountUsd: '1200.00',
    chain: 'USDC_POL',
    payeeAddress: '0xpayee',
    description: 'Sprint 3',
    redirectUrl: 'https://b/inbox/t',
    idempotencyKey: 'k',
    metadata: { invoice_id: 'i' },
  });
  assert.equal(payment.id, 'pay_1');
  assert.equal(payment.currency, 'USDC_POL');
  assert.equal(payment.address, '0xpayto');
  assert.equal(client.payUrl('pay_1'), 'https://coinpayportal.com/pay/pay_1');

  const call = calls[0]!;
  assert.equal(call.url, 'https://coinpayportal.com/api/payments/create');
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers['authorization'], 'Bearer cp_live_key');
  const sent = JSON.parse(String(call.init.body)) as Record<string, unknown>;
  assert.equal(sent['business_id'], 'biz');
  assert.equal(sent['merchant_wallet_address'], '0xpayee');
  assert.equal(sent['blockchain'], 'USDC_POL');
  assert.equal(sent['amount_usd'], 1200);
  assert.equal((sent['metadata'] as Record<string, unknown>)['idempotency_key'], 'k');
});

test('an HTML answer from CoinPay is reported as such, not parsed', async () => {
  const client = createCoinPay(
    coinpayConfig(FULL)!,
    async () =>
      new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  );
  await assert.rejects(client.getPayment('x'), /not JSON/);
});

test('an amount is dollars and cents, however it was typed', () => {
  assert.equal(parseAmount('1200'), '1200.00');
  assert.equal(parseAmount('$1,200.50'), '1200.50');
  assert.equal(parseAmount(' $1,200.50 '), '1200.50');
  assert.equal(parseAmount(99.9), '99.90');
  assert.equal(parseAmount('1,2'), null);
  assert.equal(parseAmount('1,23'), null);
  assert.equal(parseAmount('12,34,567'), null);
  assert.equal(parseAmount('1$2'), null);
  assert.equal(parseAmount('1 2'), null);
  assert.equal(parseAmount('0'), null);
  assert.equal(parseAmount('-5'), null);
  assert.equal(parseAmount('12.345'), null);
  assert.equal(parseAmount('a lot'), null);
  assert.equal(parseAmount('1000001'), null);
});

test('the notification email carries no message body', () => {
  const mail = inboxMessage({
    to: 'p@example.com',
    boardName: 'Board',
    from: 'Acme',
    subject: 'Sprint 3',
    url: 'https://b/inbox/t',
    kind: 'invoice',
  });
  assert.match(mail.subject, /Acme sent you an invoice on Board/);
  assert.ok(mail.text.includes('https://b/inbox/t'));
  assert.ok(!mail.html.includes('1200'), 'nothing about the invoice but that there is one');
});
