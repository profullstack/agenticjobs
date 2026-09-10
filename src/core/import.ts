/**
 * Turning whatever a candidate has into Markdown.
 *
 * The rule the rest of the board depends on: after this module runs there is
 * exactly one representation of a resume, and it is Markdown the candidate can
 * read and edit. An upload is an import step, not a storage format.
 *
 * Four inputs, in descending order of how well they survive the trip:
 *
 *   .md    used as-is; nothing is inferred and nothing is lost
 *   .txt   structure guessed from blank lines and capitalisation, then edited
 *   .docx  read directly here, because a .docx is a ZIP with one XML in it
 *   .pdf   handed to pdftotext, because laying text back out of a PDF is a
 *          genuinely hard problem and poppler has already solved it
 *
 * External tools are used when they are installed and their absence is
 * reported as a sentence a person can act on, never as a stack trace. The
 * container image installs both, so this only degrades on a bare laptop.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readZipEntry, ZipProblem } from './zip.ts';

const run = promisify(execFile);

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export interface ImportResult {
  markdown: string;
  /** How it got here, for the "converted from your PDF" line on the editor. */
  via: 'markdown' | 'text' | 'docx' | 'pdf' | 'pandoc';
  warnings: string[];
}

export class ImportProblem extends Error {}

export function extensionOf(filename: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(filename.trim());
  return (match?.[1] ?? '').toLowerCase();
}

export async function importDocument(
  filename: string,
  bytes: Buffer,
  mime = '',
): Promise<ImportResult> {
  if (bytes.length === 0) throw new ImportProblem('That file is empty.');
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new ImportProblem(
      `That file is ${Math.round(bytes.length / 1024 / 1024)}MB. The limit is ${MAX_UPLOAD_BYTES / 1024 / 1024}MB.`,
    );
  }

  const extension = extensionOf(filename);
  const kind = classify(extension, mime, bytes);

  switch (kind) {
    case 'markdown':
      return { markdown: decodeText(bytes).trim(), via: 'markdown', warnings: [] };
    case 'text':
      return { markdown: textToMarkdown(decodeText(bytes)), via: 'text', warnings: [] };
    case 'docx':
      return docxToMarkdown(bytes);
    case 'pdf':
      return pdfToMarkdown(bytes);
    default:
      return legacyToMarkdown(bytes, extension);
  }
}

type Kind = 'markdown' | 'text' | 'docx' | 'pdf' | 'legacy';

function classify(extension: string, mime: string, bytes: Buffer): Kind {
  // The magic bytes win over the extension. A resume renamed from .pdf to
  // .docx is a mistake someone makes once, and the file itself is not lying.
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (bytes.subarray(0, 2).toString('latin1') === 'PK' && (extension === 'docx' || mime.includes('wordprocessingml'))) {
    return 'docx';
  }
  if (['md', 'markdown', 'mdown', 'mkd'].includes(extension)) return 'markdown';
  if (extension === 'txt' || mime === 'text/plain') return 'text';
  if (extension === 'docx') return 'docx';
  if (extension === 'pdf') return 'pdf';
  if (['doc', 'odt', 'rtf', 'html', 'htm'].includes(extension)) return 'legacy';
  // Anything that decodes cleanly as UTF-8 is treated as text rather than
  // refused: a resume with no extension is still a resume.
  return looksTextual(bytes) ? 'text' : 'legacy';
}

function looksTextual(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, 4096);
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  }
  return control / Math.max(1, sample.length) < 0.02;
}

function decodeText(bytes: Buffer): string {
  // A BOM left in place shows up as a stray character in the first heading.
  const text = bytes.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Plain text to Markdown.
 *
 * Deliberately conservative. Only two things are inferred - a line that is
 * short, standalone and title-cased or upper-case becomes a heading, and a
 * line already starting with a bullet character becomes a list item - because
 * the candidate is about to see the result in an editor and a wrong guess
 * costs them more than a missing one.
 */
export function textToMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let first = true;

  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trimEnd();
    const trimmed = line.trim();

    if (trimmed === '') {
      out.push('');
      continue;
    }

    const bullet = /^[•·▪●*+-]\s+(.*)$/.exec(trimmed);
    if (bullet !== null) {
      out.push(`- ${bullet[1] ?? ''}`);
      continue;
    }

    if (first) {
      out.push(`# ${trimmed}`);
      first = false;
      continue;
    }

    const previousBlank = (lines[index - 1] ?? '').trim() === '';
    const nextBlank = (lines[index + 1] ?? '').trim() === '';
    const heading =
      previousBlank &&
      nextBlank &&
      trimmed.length <= 60 &&
      !trimmed.endsWith('.') &&
      (trimmed === trimmed.toUpperCase() || /^[A-Z][a-z]+(\s+[A-Za-z&/]+){0,4}$/.test(trimmed));

    out.push(heading ? `## ${titleCase(trimmed)}` : trimmed);
  }

  return collapseBlankRuns(out.join('\n')).trim();
}

function titleCase(value: string): string {
  if (value !== value.toUpperCase()) return value;
  return value
    .toLowerCase()
    .replace(/\b([a-z])/g, (character) => character.toUpperCase());
}

function collapseBlankRuns(value: string): string {
  return value.replace(/\n{3,}/g, '\n\n');
}

/**
 * .docx to Markdown, without a library.
 *
 * Word's XML is verbose but the parts that matter are few: a paragraph carries
 * a style name that says whether it is a heading or a list item, and its text
 * is the concatenation of the runs inside it. Bold and italic runs are mapped;
 * everything else - fonts, colours, tracked changes - is dropped on purpose,
 * because none of it survives into a Markdown resume anyway.
 */
export async function docxToMarkdown(bytes: Buffer): Promise<ImportResult> {
  const warnings: string[] = [];
  let xml: Buffer | null;
  try {
    xml = readZipEntry(bytes, 'word/document.xml');
  } catch (error) {
    if (error instanceof ZipProblem) throw new ImportProblem(error.message);
    throw error;
  }
  if (xml === null) {
    throw new ImportProblem('That .docx has no word/document.xml inside it.');
  }

  const document = xml.toString('utf8');
  const out: string[] = [];
  const paragraphs = document.match(/<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g) ?? [];

  for (const paragraph of paragraphs) {
    const style = /<w:pStyle[^>]*w:val="([^"]+)"/.exec(paragraph)?.[1] ?? '';
    const isList = /<w:numPr[ >]/.test(paragraph);
    const text = runsToText(paragraph).trim();

    if (text === '') {
      out.push('');
      continue;
    }

    const headingLevel = /^Heading(\d)$/i.exec(style)?.[1];
    if (headingLevel !== undefined) {
      out.push('', `${'#'.repeat(Math.min(6, Number(headingLevel)))} ${stripMarks(text)}`, '');
      continue;
    }
    if (/^Title$/i.test(style)) {
      out.push('', `# ${stripMarks(text)}`, '');
      continue;
    }
    if (isList) {
      out.push(`- ${text}`);
      continue;
    }
    out.push(text);
  }

  const tables = (document.match(/<w:tbl[ >]/g) ?? []).length;
  if (tables > 0) {
    // Word tables are commonly used purely for two-column layout, so turning
    // them into Markdown tables produces something worse than flat text.
    warnings.push(
      `${tables} table${tables === 1 ? '' : 's'} in the document were flattened to plain lines. Check the layout.`,
    );
  }

  const markdown = collapseBlankRuns(out.join('\n')).trim();
  if (markdown === '') throw new ImportProblem('No text could be read out of that .docx.');
  return { markdown, via: 'docx', warnings };
}

function runsToText(paragraph: string): string {
  let out = '';
  const runs = paragraph.match(/<w:r[ >][\s\S]*?<\/w:r>/g) ?? [];
  for (const run of runs) {
    // Text, tabs and breaks can alternate inside one run. Run boundaries
    // must not change the text that arrives in the resume editor.
    const pieces = [
      ...run.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(tab|br|cr)\b[^>]*>/g),
    ];
    let text = pieces
      .map((piece) => (piece[1] !== undefined ? decodeXml(piece[1]) : piece[2] === 'tab' ? '  ' : '\n'))
      .join('');
    if (!pieces.some((piece) => (piece[1] ?? '') !== '')) {
      // Controls alone do not need emphasis markers around them.
      out += text;
      continue;
    }
    if (/<w:b\/>|<w:b\s[^>]*w:val="(?:1|true|on)"/.test(run)) text = `**${text}**`;
    if (/<w:i\/>|<w:i\s[^>]*w:val="(?:1|true|on)"/.test(run)) text = `*${text}*`;
    out += text;
  }
  return out;
}

function stripMarks(value: string): string {
  return value.replace(/\*+/g, '').trim();
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_whole, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

/** Laying text back out of a PDF is poppler's job, not ours. */
export async function pdfToMarkdown(bytes: Buffer): Promise<ImportResult> {
  const text = await withTempFile(bytes, 'pdf', async (path) => {
    try {
      // -layout keeps columns apart, which is the difference between a
      // readable resume and every line of a two-column CV interleaved.
      const { stdout } = await run('pdftotext', ['-layout', '-nopgbrk', '-enc', 'UTF-8', path, '-'], {
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      if (isMissingBinary(error)) {
        throw new ImportProblem(
          'This board cannot read PDFs because pdftotext is not installed. Install poppler-utils, or upload a .md, .txt or .docx instead.',
        );
      }
      throw new ImportProblem(
        `pdftotext could not read that PDF: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  const markdown = textToMarkdown(text);
  if (markdown.replace(/[#\s-]/g, '') === '') {
    throw new ImportProblem(
      'That PDF has no extractable text. It is probably a scan; upload a .md, .txt or .docx instead.',
    );
  }
  return {
    markdown,
    via: 'pdf',
    warnings: [
      'Converted from a PDF, so the structure is a guess. Check the headings before you save.',
    ],
  };
}

/** .doc, .odt, .rtf and HTML, if pandoc happens to be installed. */
async function legacyToMarkdown(bytes: Buffer, extension: string): Promise<ImportResult> {
  return withTempFile(bytes, extension || 'bin', async (path) => {
    try {
      const { stdout } = await run(
        'pandoc',
        ['--from', pandocFormat(extension), '--to', 'gfm', '--wrap=none', path],
        { maxBuffer: 16 * 1024 * 1024 },
      );
      return { markdown: collapseBlankRuns(stdout).trim(), via: 'pandoc' as const, warnings: [] };
    } catch (error) {
      if (isMissingBinary(error)) {
        throw new ImportProblem(
          `This board cannot read .${extension} files because pandoc is not installed. Upload a .md, .txt, .docx or .pdf instead.`,
        );
      }
      throw new ImportProblem(
        `That .${extension} could not be converted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

function pandocFormat(extension: string): string {
  if (extension === 'odt') return 'odt';
  if (extension === 'rtf') return 'rtf';
  if (extension === 'html' || extension === 'htm') return 'html';
  return 'doc';
}

function isMissingBinary(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

async function withTempFile<T>(
  bytes: Buffer,
  extension: string,
  work: (path: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'agenticjobs-'));
  const path = join(directory, `upload.${extension}`);
  try {
    await writeFile(path, bytes);
    return await work(path);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
