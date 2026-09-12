import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normaliseServer } from '../dist/client/config.js';
import { BoardClient } from '../dist/client/client.js';

test('HTTP schemes are case insensitive without changing the path case', () => {
  assert.equal(normaliseServer(' HTTPS://example.test/Board/ '), 'https://example.test/Board');
  assert.equal(normaliseServer('HtTp://localhost:8787/'), 'http://localhost:8787');
});

test('bare loopback hosts are case insensitive', () => {
  assert.equal(normaliseServer('LOCALHOST:8787'), 'http://LOCALHOST:8787');
  assert.equal(normaliseServer('[::1]:8787/'), 'http://[::1]:8787');
  assert.equal(normaliseServer('example.test'), 'https://example.test');
});

test('a client with an uppercase scheme requests the supplied board', async () => {
  let requested = '';
  const client = new BoardClient('HTTPS://example.test/', {
    fetch: async (input) => {
      requested = String(input);
      return Response.json({ items: [] });
    },
  });
  await client.employers();
  assert.equal(requested, 'https://example.test/api/v1/orgs');
});
