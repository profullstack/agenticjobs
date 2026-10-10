import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toPlainText } from '../src/markup/markdown.ts';

test('plain summaries consume an entire balanced link destination', () => {
  assert.equal(
    toPlainText('Read [our documentation](https://example.com/Guide_(2026)).'),
    'Read our documentation.',
  );
});

test('nested destination parentheses do not leak into summary prose', () => {
  assert.equal(
    toPlainText('[See details](https://example.com/report(one(two))) and apply.'),
    'See details and apply.',
  );
});

test('escaped destination parentheses do not leave closing syntax behind', () => {
  assert.equal(
    toPlainText('[Documentation](https://example.com/Guide_\\(2026\\)) is available.'),
    'Documentation is available.',
  );
});

test('image destinations with parentheses are omitted completely', () => {
  assert.equal(
    toPlainText('Before ![release chart](https://example.com/Chart_(2026).png) after.'),
    'Before after.',
  );
});

test('a quoted title is consumed independently of parentheses in its text', () => {
  assert.equal(
    toPlainText('[Documentation](https://example.com/guide(one) "Guide )") is available.'),
    'Documentation is available.',
  );
});

test('surrounding prose punctuation remains outside links and images', () => {
  assert.equal(
    toPlainText('([Portfolio](https://example.com/Ada_(developer))), next.'),
    '(Portfolio), next.',
  );
  assert.equal(toPlainText('![Chart](https://example.com/Chart_(2026).png), next.'), ', next.');
});

test('an image inside a link remains omitted from a plain summary', () => {
  assert.equal(
    toPlainText('Before [![chart](chart.png)](https://example.com/chart) after.'),
    'Before after.',
  );
});

test('ordinary links, images and literal label text retain their existing summaries', () => {
  assert.equal(
    toPlainText('Some **bold** [A & B](https://example.com/?a=1&b=2), then ![chart](chart.png).'),
    'Some bold A & B, then .',
  );
  assert.equal(toPlainText('[First](one) and [Second](two).'), 'First and Second.');
  assert.equal(
    toPlainText('An unmatched [label](destination stays text.'),
    'An unmatched [label](destination stays text.',
  );
});
