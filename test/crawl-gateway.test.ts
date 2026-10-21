/**
 * The crawl door: training crawlers are sold a day pass before the board does
 * any work for them; people are not. No database and no network: the offer is
 * built locally and the 402 comes before the first query.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { createApp } = await import('../dist/server/app.js');
const { loadConfig } = await import('../dist/config.js');

let queries = 0;
const pool = {
  query: async () => {
    queries += 1;
    return { rows: [] };
  },
};
const config = loadConfig({
  PUBLIC_URL: 'https://agenticjobs.work',
  COINPAY_X402_KEY: 'cp_live_test_crawl_key',
  CRAWL_PAY_TO: '0xCC3b072391AE7A8d10cF00DdC5F61DB2cA5541E5',
});
const app = createApp(pool as never, config, null, null);

const GPTBOT =
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)';

test('crawl config is read from COINPAY_X402_KEY and CRAWL_PAY_TO, both or nothing', () => {
  assert.ok(config.crawl);
  assert.equal(loadConfig({ COINPAY_X402_KEY: 'cp_live_x' }).crawl, null);
});

test('GPTBot gets 402 with PAYMENT-REQUIRED, before any query', async () => {
  queries = 0;
  const res = await app.request('/', { headers: { 'user-agent': GPTBOT, accept: 'application/json' } });
  assert.equal(res.status, 402);
  assert.ok(res.headers.get('payment-required'));
  assert.equal(queries, 0);
});

test('/crawl sells the day pass', async () => {
  const res = await app.request('/crawl', { headers: { 'user-agent': 'curl/8', accept: 'application/json' } });
  assert.equal(res.status, 402);
  const body = (await res.json()) as { accepts: Array<{ amount: string }> };
  assert.equal(body.accepts[0]?.amount, '1000000');
});

test('a browser and the status check are not charged', async () => {
  const chrome = {
    'user-agent':
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-dest': 'document',
  };
  const health = await app.request('/api/health', { headers: chrome });
  assert.equal(health.status, 200);
  const monitor = await app.request('/api/health', { headers: { 'user-agent': 'GPTBot/1.2' } });
  assert.equal(monitor.status, 200);
});
