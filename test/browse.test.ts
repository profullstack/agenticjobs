/**
 * A page as a resume draft.
 *
 * What has to hold: with a browser service the page goes through its
 * navigate and markdown tools; without one it is fetched and reduced to
 * Markdown here with chrome stripped; a private or non-http address is
 * refused before anything is fetched; an empty page is a problem, not a
 * resume.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertPublicUrl,
  BrowseProblem,
  htmlToMarkdown,
  isPrivateAddress,
  pageToMarkdown,
} from '../dist/core/browse.js';

const PAGE = `<!doctype html><html><head><title>Ada Lovelace - Site</title><style>body{}</style></head>
<body><nav><a href="/">Home</a></nav><main>
<h1>Ada Lovelace</h1><p>Mathematician, <strong>analyst</strong>.</p>
<h2>Experience</h2><ul><li>Analytical Engine, <a href="https://example.com/engine">first program</a></li><li>Notes G</li></ul>
<script>alert(1)</script></main><footer>© 1843</footer></body></html>`;

test('html becomes Markdown with headings, lists and links, and without nav, footer or scripts', () => {
  const markdown = htmlToMarkdown(PAGE);
  assert.ok(markdown.startsWith('# Ada Lovelace'));
  assert.ok(markdown.includes('Mathematician, **analyst**.'));
  assert.ok(markdown.includes('## Experience'));
  assert.ok(markdown.includes('- Analytical Engine, [first program](https://example.com/engine)'));
  assert.ok(!markdown.includes('Home'));
  assert.ok(!markdown.includes('1843'));
  assert.ok(!markdown.includes('alert'));
});

test('private and non-http addresses are refused before any fetch', async () => {
  assert.equal(isPrivateAddress('10.1.2.3'), true);
  assert.equal(isPrivateAddress('192.168.0.9'), true);
  assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateAddress('fd00::1'), true);
  assert.equal(isPrivateAddress('93.184.216.34'), false);
  await assert.rejects(assertPublicUrl('ftp://example.com/x'), BrowseProblem);
  await assert.rejects(assertPublicUrl('http://127.0.0.1/resume'), /not a public address/);
  await assert.rejects(assertPublicUrl('not a url'), /not a URL/);
  let fetched = false;
  await assert.rejects(
    pageToMarkdown('http://localhost:9/x', {
      obscuraMcpUrl: null,
      fetch: (async () => {
        fetched = true;
        return new Response('x');
      }) as typeof fetch,
    }),
    BrowseProblem,
  );
  assert.equal(fetched, false);
});

test('without a browser service the page is fetched and reduced', async () => {
  const calls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
  const result = await pageToMarkdown('https://ada.example/resume', {
    obscuraMcpUrl: null,
    fetch: fetcher,
    allowPrivate: true,
  });
  assert.equal(result.via, 'fetch');
  assert.equal(result.title, 'Ada Lovelace - Site');
  assert.ok(result.markdown.startsWith('# Ada Lovelace'));
  assert.deepEqual(calls, ['https://ada.example/resume']);
});

test('with a browser service the page goes through navigate then markdown', async () => {
  const seen: Array<{ method: string; name?: string; args?: Record<string, unknown> }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), 'http://obscura.internal:3000/mcp');
    const body = JSON.parse(String(init?.body)) as {
      id?: number;
      method: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    seen.push({ method: body.method, name: body.params?.name, args: body.params?.arguments });
    if (body.id === undefined) return new Response(null, { status: 202 });
    const reply = (result: unknown): Response =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
        headers: { 'content-type': 'application/json' },
      });
    if (body.method === 'initialize')
      return reply({ protocolVersion: '2024-11-05', serverInfo: { name: 'obscura-mcp' } });
    if (body.params?.name === 'browser_navigate')
      return reply({
        content: [
          { type: 'text', text: 'Navigated to https://ada.example/resume — "Ada Lovelace"' },
        ],
      });
    return reply({
      content: [
        {
          type: 'text',
          text: '# Ada Lovelace\n\nRendered by a browser, long enough to count as a page.',
        },
      ],
    });
  }) as typeof fetch;
  const result = await pageToMarkdown('https://ada.example/resume', {
    obscuraMcpUrl: 'http://obscura.internal:3000/mcp',
    fetch: fetcher,
    allowPrivate: true,
    maxChars: 5000,
  });
  assert.equal(result.via, 'obscura');
  assert.equal(result.title, 'Ada Lovelace');
  assert.ok(result.markdown.startsWith('# Ada Lovelace'));
  assert.deepEqual(
    seen.map((call) => call.name ?? call.method),
    ['initialize', 'notifications/initialized', 'browser_navigate', 'browser_markdown'],
  );
  assert.deepEqual(seen[2]?.args, { url: 'https://ada.example/resume', waitUntil: 'load' });
  assert.deepEqual(seen[3]?.args, { max_chars: 5000 });
});

test('a page with almost no text is a problem, not a resume', async () => {
  const fetcher = (async () =>
    new Response('<html><body><main><p>hi</p></main></body></html>', {
      headers: { 'content-type': 'text/html' },
    })) as typeof fetch;
  await assert.rejects(
    pageToMarkdown('https://ada.example/', {
      obscuraMcpUrl: null,
      fetch: fetcher,
      allowPrivate: true,
    }),
    /almost no text/,
  );
});
