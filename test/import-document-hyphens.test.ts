import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { importDocument } from '../dist/core/import.js';

async function importedLines(): Promise<string[]> {
  // The adjacent XML file is the readable word/document.xml from this DOCX.
  const bytes = await readFile(new URL('./fixtures/docx-nonbreaking-hyphens.docx', import.meta.url));
  const result = await importDocument('resume.docx', bytes);
  assert.equal(result.via, 'docx');
  assert.deepEqual(result.warnings, []);
  return result.markdown.split('\n');
}

test('a Word non-breaking hyphen separates words within one run', async () => {
  assert.equal((await importedLines())[0], 'customer\u2011facing');
});

test('Word non-breaking hyphens survive separate run boundaries', async () => {
  assert.equal((await importedLines())[1], 'end\u2011to\u2011end');
});

test('a Word run containing only a non-breaking hyphen retains its emphasis', async () => {
  assert.equal((await importedLines())[2], '**\u2011**');
});

test('Word literal hyphens, tabs and line breaks retain their existing meaning', async () => {
  const lines = await importedLines();
  assert.ok(lines.includes('plain-hyphen  then'));
  assert.equal(lines.at(-1), 'next line');
});
