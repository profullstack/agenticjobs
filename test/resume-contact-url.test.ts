import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseResume } from '../dist/markup/resume.js';
import { resumeHtml } from '../dist/core/markdown-media.js';
import { CandidateDetail } from '../dist/views/candidates.js';

const render = (href: string, surface: 'candidate' | 'download'): string => {
  const markdown = '# Ada\n\n## Skills\n\nTesting';
  const parsed = parseResume(markdown);
  // Stored parsed resumes must be checked at rendering time as well.
  parsed.contact = [{ key: 'Profile', value: 'Contact label', href }];
  if (surface === 'download') return resumeHtml({ markdown, parsed, title: 'Resume' });
  return String(
    CandidateDetail({
      candidate: {
        slug: 'ada',
        name: 'Ada',
        headline: null,
        location: null,
        skills: [],
        capacity: null,
        updatedAt: '',
      },
      parsed,
      html: '',
      markdownUrl: '/candidates/ada/resume.md',
      listed: true,
    }),
  );
};

for (const surface of ['candidate', 'download'] as const) {
  test(`${surface} renders disallowed contact URL schemes as plain text`, () => {
    for (const href of [
      'javascript:void(0)',
      'JaVaScRiPt:void(0)',
      'data:text/plain,example',
      'file:///example',
      'java\tscript:void(0)',
    ]) {
      const html = render(href, surface);
      assert.ok(html.includes('Contact label'), 'keep the written label');
      assert.doesNotMatch(html, /<a\b[^>]*>Contact label<\/a>/, href);
    }
  });

  test(`${surface} preserves supported web, email and telephone contact links`, () => {
    for (const href of [
      'https://example.com/ada',
      'http://example.com/ada',
      'mailto:ada@example.com',
      'tel:+14085550100',
      '/profiles/ada',
      '#contact',
    ]) {
      assert.ok(render(href, surface).includes(`href="${href}"`), href);
    }
  });
}

test('both explicit contact link syntaxes are safe in the download', () => {
  for (const bullet of [
    '- [Portfolio](javascript:void`0`)',
    '- Web: [Portfolio](data:text/plain,example)',
  ]) {
    const markdown = `# Ada\n\n${bullet}\n\n## Skills\n\nTesting`;
    const html = resumeHtml({ markdown, parsed: parseResume(markdown), title: 'Resume' });
    assert.ok(html.includes('Portfolio'));
    assert.doesNotMatch(html, /href="(?:javascript|data):/i);
  }
});
