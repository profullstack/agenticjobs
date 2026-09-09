/**
 * Markdown to media: the same resume as HTML, PDF and DOCX.
 *
 * The counterpart to media2markdown, and deliberately built in rather than
 * stood up as a second site: this board already holds the document, already
 * parses it, and a converter behind its own domain is a second thing to keep
 * running for one button.
 *
 * The Markdown stays canonical. Everything here is a rendering of it, made on
 * request and never stored, so there is no second copy to drift.
 *
 * The layout is adapted from the resume generator at ralyodio/resume, which
 * used Puppeteer. Chromium is ~350MB in an image whose builds already take ten
 * minutes, and a browser per download is a slow way to set type, so the CSS is
 * written for a print engine instead: no grid, and flex only where a row of
 * items genuinely is a row. That renders under weasyprint, which is a tenth of
 * the size, and under a browser if one is ever there.
 */

import { spawn } from 'node:child_process';
import type { OpenResume } from '../markup/resume.ts';
import { escapeHtml } from '../markup/escape.ts';
import { renderMarkdown } from '../markup/markdown.ts';

export type MediaFormat = 'html' | 'pdf' | 'docx';

export class ConversionProblem extends Error {}

/** Long enough for a resume, short enough that a hung converter is not a leak. */
const TIMEOUT_MS = 20_000;
/** A resume that renders to more than this is not a resume. */
const MAX_BYTES = 12 * 1024 * 1024;

/**
 * Print stylesheet, adapted from the resume generator.
 *
 * Kept as one string rather than a file because it has to be inlined: a PDF
 * engine reading `file://` HTML fetches nothing, and a stylesheet link that
 * silently fails is an unstyled resume nobody notices until it is sent.
 */
const STYLE = `
  @page { size: Letter; margin: 0.5in 0.55in; }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto; max-width: 8.5in; color: #20242a; background: #fff;
    font-family: "Inter", "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 10pt; line-height: 1.35;
  }
  a { color: #1f4f82; text-decoration: none; }
  .header { padding-bottom: 0.16in; margin-bottom: 0.2in; border-bottom: 2px solid #1f2937; }
  .header h1 {
    margin: 0 0 0.04in; color: #111827; font-size: 26pt; font-weight: 800;
    line-height: 1; letter-spacing: -0.8px;
  }
  .header .subtitle {
    margin: 0 0 0.11in; color: #374151; font-size: 10.5pt; font-weight: 600; line-height: 1.25;
  }
  .contact { display: flex; flex-wrap: wrap; color: #4b5563; font-size: 8.8pt; }
  .contact span { white-space: nowrap; margin: 0 0.16in 0.045in 0; }
  h2 {
    margin: 0.2in 0 0.07in; padding-bottom: 0.025in; border-bottom: 1px solid #d1d5db;
    color: #111827; font-size: 9.2pt; font-weight: 800; line-height: 1.15;
    text-transform: uppercase; letter-spacing: 1.1px;
  }
  h3 {
    margin: 0.115in 0 0.02in; color: #111827; font-size: 10.1pt; font-weight: 700;
    line-height: 1.18; break-after: avoid; page-break-after: avoid;
  }
  h3 + p { color: #4b5563; font-size: 8.9pt; margin: 0 0 0.04in; }
  p { margin: 0 0 0.07in; }
  ul { margin: 0 0 0.08in; padding-left: 0.17in; }
  li { margin: 0 0 0.02in; }
  /* An entry should not be split across a page if it can be helped. */
  h3, li { break-inside: avoid; page-break-inside: avoid; }
  code { font-family: "SFMono-Regular", Consolas, monospace; font-size: 0.92em; }
  hr { border: 0; border-top: 1px solid #e5e7eb; margin: 0.14in 0; }
  @media print { body { max-width: none; } }
`;

/**
 * The resume as a standalone HTML document.
 *
 * Built from the parsed document where it has structure, so the name and the
 * contact line get the treatment they deserve, and from the rendered Markdown
 * for the body, which is the same renderer the site uses. A resume that parsed
 * as nothing still renders: it just gets the body and no header.
 */
export function resumeHtml(options: {
  markdown: string;
  parsed: OpenResume | null;
  title: string;
}): string {
  const name = options.parsed?.name ?? options.title;
  const headline = options.parsed?.headline ?? null;
  const contact = options.parsed?.contact ?? [];

  // The h1 and the contact bullets are rendered as the header, so the body
  // starts after them rather than repeating them as ordinary Markdown.
  const body = options.parsed === null ? options.markdown : withoutHeader(options.markdown);

  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${escapeHtml(name)}</title>`,
    `<style>${STYLE}</style>`,
    '</head><body>',
    '<header class="header">',
    `<h1>${escapeHtml(name)}</h1>`,
    headline === null ? '' : `<p class="subtitle">${escapeHtml(headline)}</p>`,
    contact.length === 0
      ? ''
      : `<div class="contact">${contact
          .map((item) =>
            item.href === null
              ? `<span>${escapeHtml(item.value)}</span>`
              : `<span><a href="${escapeHtml(item.href)}">${escapeHtml(item.value)}</a></span>`,
          )
          .join('')}</div>`,
    '</header>',
    renderMarkdown(body, { noImages: true }),
    '</body></html>',
  ].join('\n');
}

/** Drop the leading h1 and the contact bullets that follow it. */
function withoutHeader(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let index = 0;
  while (index < lines.length && (lines[index] ?? '').trim() === '') index += 1;
  if (!(lines[index] ?? '').startsWith('# ')) return markdown;
  index += 1;
  // Everything up to the first heading or paragraph is the contact block.
  while (index < lines.length) {
    const line = (lines[index] ?? '').trim();
    if (line === '' || line.startsWith('- ') || line.startsWith('* ')) {
      index += 1;
      continue;
    }
    break;
  }
  return lines.slice(index).join('\n');
}

/**
 * Run a converter and hand back what it wrote.
 *
 * The document goes in on stdin and comes back on stdout, so nothing touches
 * the filesystem: a converter that writes temp files is a converter that
 * leaves them behind when it is killed.
 */
async function convert(command: string, args: string[], input: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let size = 0;
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new ConversionProblem(`${command} took longer than ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        child.kill('SIGKILL');
        reject(new ConversionProblem(`${command} produced more than ${MAX_BYTES} bytes`));
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(0, 2000);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new ConversionProblem(`${command} could not be run: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new ConversionProblem(`${command} exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(Buffer.concat(out));
    });

    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

/** Word, straight from the Markdown, by the converter already in the image. */
export async function resumeDocx(markdown: string): Promise<Buffer> {
  return convert('pandoc', ['-f', 'markdown', '-t', 'docx', '-o', '-'], markdown);
}

/**
 * PDF, from the styled HTML rather than from the Markdown.
 *
 * Going through HTML is what keeps the PDF and the web page the same document:
 * pandoc's own PDF output would be a different design maintained separately.
 *
 * Engines are tried in order and the first one present wins, so an image with
 * a browser in it uses that and an image with neither says which are missing
 * instead of failing with "exit 127".
 */
export async function resumePdf(html: string): Promise<Buffer> {
  const engines: [string, string[]][] = [
    ['weasyprint', ['-', '-']],
    ['wkhtmltopdf', ['-q', '-', '-']],
    ['chromium', ['--headless', '--no-sandbox', '--print-to-pdf=/dev/stdout', '-']],
  ];

  const problems: string[] = [];
  for (const [command, args] of engines) {
    try {
      return await convert(command, args, html);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Only a missing binary is worth trying the next engine for. An engine
      // that ran and failed has something to say, so it is not swallowed.
      if (!message.includes('could not be run')) throw error;
      problems.push(command);
    }
  }
  throw new ConversionProblem(
    `No PDF engine on this instance. Install one of: ${problems.join(', ')}.`,
  );
}

/** What to call the file the reader saves. */
export function filename(name: string, format: MediaFormat): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'resume';
  return `${base}.${format}`;
}

export const CONTENT_TYPE: Record<MediaFormat, string> = {
  html: 'text/html; charset=utf-8',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
