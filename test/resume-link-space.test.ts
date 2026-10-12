import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMarkdownLink, parseResume } from '../src/markup/resume.ts';

for (const destination of ['https://github.com/example ', 'https://github.com/example\t', '<https://github.com/example> ']) {
  test(`contact links retain destinations with closing whitespace: ${JSON.stringify(destination)}`, () => {
    const link = `[GitHub](${destination})`;
    assert.deepEqual(parseMarkdownLink(link), { label: 'GitHub', href: 'https://github.com/example', end: link.length - 1 });
    assert.deepEqual(parseResume(`# Example\n- ${link}`).contact, [{ key: 'GitHub', value: 'GitHub', href: 'https://github.com/example' }]);
  });
}
test('does not accept unquoted text after a destination', () => {
  assert.equal(parseMarkdownLink('[GitHub](https://github.com/example extra)'), null);
});
test('existing titled links remain supported', () => {
  const link = '[GitHub](https://github.com/example "Profile")';
  assert.equal(parseMarkdownLink(link)?.href, 'https://github.com/example');
});
