import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { importDocument } from '../dist/core/import.js';

async function importedDocument() {
  // The adjacent XML is the readable word/document.xml from this DOCX.
  const bytes = await readFile(new URL('./fixtures/docx-tag-whitespace.docx', import.meta.url));
  return importDocument('resume.docx', bytes);
}

test('DOCX paragraphs accept a newline between the tag name and attributes', async () => {
  const result = await importedDocument();
  assert.ok(result.markdown.split('\n').includes('Paragraph with a newline before attributes'));
});

test('DOCX runs accept a tab between the tag name and attributes', async () => {
  const result = await importedDocument();
  assert.ok(result.markdown.split('\n').includes('Run with a tab before attributes'));
});

test('DOCX list properties accept a newline before the closing angle bracket', async () => {
  const result = await importedDocument();
  assert.ok(result.markdown.split('\n').includes('- List item'));
});

test('DOCX tables with multiline opening tags still report flattened layout', async () => {
  const result = await importedDocument();
  assert.ok(result.markdown.split('\n').includes('Table cell'));
  assert.deepEqual(result.warnings, [
    '1 table in the document were flattened to plain lines. Check the layout.',
  ]);
});

test('DOCX ordinary tag spacing and bold runs retain their existing meaning', async () => {
  const result = await importedDocument();
  assert.equal(result.via, 'docx');
  assert.equal(result.markdown.split('\n').at(-1), '**Ordinary paragraph**');
});
