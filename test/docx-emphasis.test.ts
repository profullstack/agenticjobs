import assert from 'node:assert/strict';
import { test } from 'node:test';
import { docxToMarkdown } from '../dist/core/import.js';

// Minimal stored ZIP with a central directory, sufficient for the DOCX reader.
function docx(xml: string): Buffer {
  const name = Buffer.from('word/document.xml');
  const data = Buffer.from(xml);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

test('Word emphasis accepts equivalent XML empty-element spellings', async () => {
  for (const [tag, expected] of [['b', '**Role**'], ['i', '*Role*']] as const) {
    for (const property of [`<w:${tag}/>`, `<w:${tag} />`, `<w:${tag}></w:${tag}>`, `<w:${tag} w:val="true"/>`]) {
      const result = await docxToMarkdown(docx(`<w:document><w:body><w:p><w:r><w:rPr>${property}</w:rPr><w:t>Role</w:t></w:r></w:p></w:body></w:document>`));
      assert.equal(result.markdown, expected, property);
    }
    for (const value of ['0', 'false', 'off']) {
      const result = await docxToMarkdown(docx(`<w:document><w:body><w:p><w:r><w:rPr><w:${tag} w:val="${value}"/></w:rPr><w:t>Role</w:t></w:r></w:p></w:body></w:document>`));
      assert.equal(result.markdown, 'Role');
    }
  }
});
