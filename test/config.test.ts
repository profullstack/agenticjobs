/**
 * Config that says what it does.
 *
 * This repo has now shipped four settings wired to nothing: SMTP_URL (never
 * sent), applyVia: url (excluded the readers the board is for), resume
 * visibility "public" (listed nowhere) and SECRET (read by no code at all,
 * while the README called it one of the two variables that matter and the
 * boot log warned that sessions would not survive without it).
 *
 * Each one looked fine in review because the field existed. This asserts the
 * one that was hardest to see: that the board does not ask for a secret it
 * has no use for.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../dist/config.js';

test('the board asks for no secret, because it uses none', () => {
  // Sessions, magic links, device codes and webauthn challenges are all
  // 256-bit random values stored as a SHA-256 hash in Postgres. There is no
  // HMAC and nothing to key, so a SECRET would be a question with no answer.
  const config = loadConfig({
    DATABASE_URL: 'postgres://x@localhost:5432/x',
    PUBLIC_URL: 'https://board.test',
    SECRET: 'this should be ignored',
  });

  assert.ok(!('secret' in config), 'Config must not carry a secret it never reads');
  assert.ok(!('ephemeralSecret' in config), 'nor a flag about one');
});

test('config reports the public url every absolute link is built from', () => {
  const config = loadConfig({
    DATABASE_URL: 'postgres://x@localhost:5432/x',
    PUBLIC_URL: 'https://board.test/',
  });
  // Trailing slash is trimmed, or every built URL gets a double slash.
  assert.equal(config.publicUrl, 'https://board.test');
});
