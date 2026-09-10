import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { importDocument } from '../dist/core/import.js';

test('a Word import keeps inline tabs and breaks in order, with or without text in the run', async () => {
  // The adjacent XML file is the readable word/document.xml from this DOCX.
  // Its first two paragraphs encode the same text using different run boundaries.
  const bytes = await readFile(new URL('./fixtures/docx-inline-controls.docx', import.meta.url));
  const result = await importDocument('resume.docx', bytes);

  assert.deepEqual(result, {
    markdown: [
      'Engine Company  2024–2026',
      'Staff Engineer',
      'Engine Company  2024–2026',
      'Staff Engineer',
      'Research',
      '    ',
      '',
      'Projects',
      '**Bold  Role',
      'Second line**',
      '*Italic',
      'line*',
      'Plain & escaped <text>',
    ].join('\n'),
    via: 'docx',
    warnings: [],
  });
});
