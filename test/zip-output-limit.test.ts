import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { readZipEntry, ZipProblem } from '../dist/core/zip.js';

function archive(data: Buffer, method: number, declaredSize = data.length): Buffer {
  const name = Buffer.from('word/document.xml');
  const packed = method === 8 ? deflateRawSync(data) : data;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(declaredSize, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(declaredSize, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + packed.length, 16);
  return Buffer.concat([local, name, packed, central, name, end]);
}

test('DOCX entry expansion is bounded even when the declared size is false', () => {
  const oversized = Buffer.alloc(16 * 1024 * 1024 + 1, 65);
  const zipped = archive(oversized, 8, 1);
  assert.ok(zipped.length < 20_000, 'small upload can expand beyond the XML budget');
  assert.throws(() => readZipEntry(zipped, 'word/document.xml'), ZipProblem);
});

test('declared oversized entries are rejected and ordinary entries still read', () => {
  const xml = Buffer.from('<w:document/>');
  for (const method of [0, 8]) {
    assert.throws(() => readZipEntry(archive(xml, method, 16 * 1024 * 1024 + 1), 'word/document.xml'), ZipProblem);
    assert.deepEqual(readZipEntry(archive(xml, method), 'word/document.xml'), xml);
  }
});
