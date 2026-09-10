/**
 * Recommendations, in the parts that hold without a database: what a
 * paragraph from a stranger is allowed to become on a page, and what the
 * page says about it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RecommendationList,
  RecommendForm,
  RecommendationsSection,
} from '../dist/views/recommendations.js';

const render = (node: unknown): string => String(node);

const ITEM = {
  id: 'a1b2c3d4-0000-4000-8000-000000000000',
  body: 'Shipped the whole thing two weeks early.\nWrote the docs nobody asked for.',
  relationship: 'Hired her for a three-month contract',
  status: 'approved' as const,
  author: { kind: 'employer' as const, name: 'Acme', slug: 'acme' },
  subject: { kind: 'candidate' as const, name: 'Ada', slug: 'ada' },
  createdAt: new Date().toISOString(),
  decidedAt: new Date().toISOString(),
};

test('a recommendation renders as text, signed and linked, never as markup', () => {
  const html = render(
    RecommendationList({ items: [{ ...ITEM, body: 'Great <script>alert(1)</script>\nSecond' }], about: 'Ada' }),
  );
  assert.ok(!html.includes('<script>alert'), html);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Great[^]*\nSecond/, 'line breaks survive into the markup');
  assert.match(html, /href="\/employers\/acme"/, 'the author is linked to their page');
  assert.match(html, /Hired her for a three-month contract/);
  assert.match(html, /shown because Ada approved/);
});

test('an empty list renders nothing at all, so a page without any has no empty heading', () => {
  assert.equal(render(RecommendationList({ items: [], about: 'Ada' })), '');
});

test('the form knows whether the writer has a page to sign with', () => {
  const nobody = render(
    RecommendForm({ action: '/candidates/ada/recommend', asOptions: [], canWriteAsSelf: false, existing: null }),
  );
  assert.match(nobody, /Publish a resume/);
  assert.ok(!/<textarea/.test(nobody), 'no box to type into without a page');

  const employer = render(
    RecommendForm({
      action: '/candidates/ada/recommend',
      asOptions: [{ slug: 'acme', name: 'Acme' }],
      canWriteAsSelf: false,
      existing: null,
    }),
  );
  assert.match(employer, /<option value="acme"/);
  assert.ok(!/>\s*Yourself\s*</.test(employer), 'no "yourself" without a published resume');
  assert.match(employer, /name="body"/);

  const rewrite = render(
    RecommendForm({ action: '/candidates/ada/recommend', asOptions: [], canWriteAsSelf: true, existing: ITEM }),
  );
  assert.match(rewrite, /Rewrite your recommendation/);
  assert.match(rewrite, /Shipped the whole thing/, 'the earlier words are in the box');
});

test('the /me section puts the decision buttons on what is waiting', () => {
  const pending = { ...ITEM, id: 'b1b2c3d4-0000-4000-8000-000000000000', status: 'pending' as const, decidedAt: null };
  const html = render(RecommendationsSection({ received: [pending, ITEM], given: [] }));
  assert.match(html, /1 waiting for you/);
  assert.match(html, new RegExp(`/me/recommendations/${pending.id}/approve`));
  assert.match(html, new RegExp(`/me/recommendations/${pending.id}/reject`));
  // An approved one can be taken down, and is not offered "approve" again.
  assert.match(html, new RegExp(`/me/recommendations/${ITEM.id}/reject`));
  assert.ok(!html.includes(`/me/recommendations/${ITEM.id}/approve`));
  assert.match(html, /Take it down/);
  // No list item nested in a list item.
  assert.ok(!/<li[^>]*>\s*<li/.test(html), html);

  const empty = render(RecommendationsSection({ received: [], given: [] }));
  assert.match(empty, /None yet/);
});
