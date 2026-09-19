import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importDocument } from '../dist/core/import.js';

const plain = 'Renée 李华\r\n\r\nEXPERIENCE\r\n\r\nBuilt ocean models 🌊.';
const markdown = '# Renée 李华\n\n## Experience\n\n- **Ocean models** 🌊';

const encodings = [
  ['UTF-16 LE', (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])],
  ['UTF-16 BE', (text: string) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()])],
] as const;

for (const [name, encode] of encodings) {
  test(`${name} plain-text resumes preserve names, sections and non-BMP text`, async () => {
    assert.deepEqual(await importDocument('resume.txt', encode(plain)), {
      markdown: '# Renée 李华\n\n## Experience\n\nBuilt ocean models 🌊.',
      via: 'text',
      warnings: [],
    });
  });

  test(`${name} Markdown resumes retain their original Markdown structure`, async () => {
    assert.deepEqual(await importDocument('resume.md', encode(markdown)), {
      markdown,
      via: 'markdown',
      warnings: [],
    });
  });

  test(`${name} BOM identifies an extensionless text resume`, async () => {
    const result = await importDocument('resume', encode(plain));
    assert.equal(result.via, 'text');
    assert.equal(result.markdown, '# Renée 李华\n\n## Experience\n\nBuilt ocean models 🌊.');
  });
}

test('UTF-8 imports remain unchanged with and without a BOM', async () => {
  for (const prefix of ['', '\ufeff']) {
    const result = await importDocument('resume.md', Buffer.from(prefix + markdown, 'utf8'));
    assert.equal(result.markdown, markdown);
    assert.equal(result.via, 'markdown');
  }
});
