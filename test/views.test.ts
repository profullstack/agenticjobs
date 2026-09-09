/**
 * Layout facts that are invisible to every other kind of test.
 *
 * A component in the wrong column still typechecks, still renders, and still
 * passes an API test. The only thing that catches it is asserting where the
 * markup puts it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResumeEditor } from '../dist/views/me.js';

const resume = {
  id: 'r',
  userId: 'u',
  slug: 'agentic-web-architect',
  title: 'Agentic Web Architect',
  markdown: '# A Person\n\n## Skills\n\n- Go\n',
  parsed: null,
  visibility: 'public' as const,
  publicSlug: 'a-person',
  sourceName: null,
  createdAt: '',
  updatedAt: '',
};

test('the resume preview is below the editor, not squeezed into the sidebar', () => {
  // The sidebar is 20rem. A resume rendered into 20rem is a column of two-word
  // lines, which is what it was, and is unreadable. A document needs the width
  // of the page; the short things belong beside the form.
  const html = String(
    ResumeEditor({ resume, html: '<h1>A Person</h1>', warnings: ['check this'] }),
  );

  const aside = /<aside[\s\S]*?<\/aside>/.exec(html)?.[0];
  assert.ok(aside, 'expected a sidebar');
  assert.ok(!aside.includes('Preview'), 'the preview must not be in the sidebar');

  // What genuinely is short stays there.
  assert.ok(aside.includes('check this'), 'warnings belong in the sidebar');
  assert.ok(aside.includes('/candidates/a-person'), 'the share link belongs in the sidebar');

  // And the preview follows the whole two-column block rather than sitting in it.
  assert.ok(
    html.indexOf('Preview') > html.indexOf('</aside>'),
    'the preview must come after the sidebar closes',
  );
});
