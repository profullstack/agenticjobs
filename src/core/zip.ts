/**
 * Just enough ZIP to read one file out of a .docx.
 *
 * A .docx is a ZIP holding word/document.xml. Pulling that one entry out needs
 * the central directory and one inflate, which Node can already do, so this
 * saves a dependency on a general-purpose archive library for a job with
 * exactly one shape.
 *
 * The central directory is read rather than the local headers, because a
 * local header is allowed to carry zero for the sizes and defer them to a data
 * descriptor after the compressed bytes - which is exactly what several Word
 * versions emit, and what makes the naive "scan for the filename" approach
 * return an empty document instead of an error.
 */

import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
// The upload limit bounds compressed bytes, not the XML we allocate here.
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;

export class ZipProblem extends Error {}

interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  // The comment field means the record is not necessarily at the very end.
  const earliest = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new ZipProblem('This does not look like a .docx (no ZIP directory found).');
}

function readEntries(buffer: Buffer): Entry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries: Entry[] = [];

  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length) break;
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function readZipEntry(buffer: Buffer, wanted: string): Buffer | null {
  const entry = readEntries(buffer).find((item) => item.name === wanted);
  if (entry === undefined) return null;
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
    throw new ZipProblem(`${wanted} exceeds the 16MB uncompressed limit.`);
  }

  const local = entry.localHeaderOffset;
  if (local + 30 > buffer.length) throw new ZipProblem('Truncated archive.');
  // The local header's own name and extra lengths are the authoritative ones:
  // the extra field is routinely a different length here than in the central
  // directory, and using the wrong one lands mid-stream.
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const data = buffer.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) {
    if (data.length > MAX_ENTRY_BYTES) {
      throw new ZipProblem(`${wanted} exceeds the 16MB uncompressed limit.`);
    }
    return Buffer.from(data);
  }
  if (entry.method === 8) {
    try {
      return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
    } catch (error) {
      throw new ZipProblem(
        `Could not decompress ${wanted}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new ZipProblem(`Unsupported compression method ${entry.method} for ${wanted}.`);
}
