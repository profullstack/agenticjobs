import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractJob } from '../dist/core/import-job.js';

function importLocation(address: unknown): string | undefined {
  const posting = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: 'Research engineer',
    description: 'Build and maintain scientific data tools.',
    jobLocation: { '@type': 'Place', address },
  };
  const html = `<script type="application/ld+json">${JSON.stringify(posting)}</script>`;
  return extractJob(html, 'https://example.com/jobs/research').location;
}

test('retains a Country object alongside a textual locality', () => {
  assert.equal(
    importLocation({ addressLocality: 'Paris', addressCountry: { '@type': 'Country', name: 'France' } }),
    'Paris, France',
  );
});

test('retains a country-only location encoded as a Country object', () => {
  assert.equal(importLocation({ addressCountry: { '@type': 'Country', name: '日本' } }), '日本');
});

test('retains both AdministrativeArea and Country names', () => {
  assert.equal(importLocation({
    addressLocality: 'Montréal',
    addressRegion: { '@type': 'AdministrativeArea', name: 'Québec' },
    addressCountry: { '@type': 'Country', name: 'Canada' },
  }), 'Montréal, Québec, Canada');
});

test('keeps existing string addresses and textual address components', () => {
  assert.equal(importLocation('Berlin, Germany'), 'Berlin, Germany');
  assert.equal(importLocation({
    addressLocality: 'Seattle', addressRegion: 'WA', addressCountry: 'US',
  }), 'Seattle, WA, US');
});

test('does not invent names for unnamed, malformed, or array-valued places', () => {
  for (const country of [null, {}, { '@type': 'Country' }, { name: '' }, { name: 12 }, ['CA']]) {
    assert.equal(importLocation({ addressLocality: 'Toronto', addressCountry: country }), 'Toronto');
  }
  assert.equal(importLocation({ addressCountry: { '@type': 'Country' } }), undefined);
});
