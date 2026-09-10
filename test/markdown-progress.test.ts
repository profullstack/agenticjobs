import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('unsupported fence info strings finish rendering instead of stalling the parser', () => {
  const cases = [
    '```js title="example.js"',
    '~~~{.typescript}',
    'Introduction\n```not a supported language\nMore text',
    '> ~~~words with spaces\n> More text',
    '- Example\n  ```js title="example.js"\n  More text',
  ];
  const renderer = new URL('../dist/markup/markdown.js', import.meta.url).href;
  // A synchronous loop blocks node:test's own timer. Keep the reproduction in
  // a child so a regression fails in a few seconds rather than hanging CI.
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { renderMarkdown } from ${JSON.stringify(renderer)};
       console.log(JSON.stringify(${JSON.stringify(cases)}.map(source => renderMarkdown(source))));`,
    ],
    { encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  const rendered = JSON.parse(child.stdout) as string[];
  assert.equal(rendered.length, cases.length);
  assert.ok(rendered[0]?.includes('title=&quot;example.js&quot;'), rendered[0]);
  assert.ok(rendered[1]?.includes('~~~{.typescript}'), rendered[1]);
  for (const html of rendered.slice(2)) assert.ok(html.includes('More text'), html);
});
