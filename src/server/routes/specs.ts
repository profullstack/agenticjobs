/**
 * The conventions this board implements, served from the repository's own
 * docs so the page and the file cannot drift apart.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown, toPlainText } from '../../markup/markdown.ts';

export interface Spec {
  title: string;
  summary: string;
  html: string;
}

const TITLES: Record<string, string> = {
  openresume: 'OpenResume.md',
  openjob: 'OpenJob',
  openprofile: 'OpenProfile.md',
};

function docsDir(): string {
  // dist/server/routes/specs.js -> package root -> docs
  return join(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))), 'docs');
}

const cache = new Map<string, Spec>();

export async function readSpec(name: string): Promise<Spec | null> {
  if (!Object.hasOwn(TITLES, name)) return null;
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  let source: string;
  try {
    source = await readFile(join(docsDir(), `${name}.md`), 'utf8');
  } catch {
    return null;
  }

  // The file's own h1 becomes the page heading, so it is dropped from the body
  // rather than rendered twice.
  const body = source.replace(/^#\s+.*\n/, '');
  const spec: Spec = {
    title: TITLES[name] ?? name,
    summary: toPlainText(body, 160),
    html: renderMarkdown(body, { headingOffset: 0 }),
  };
  cache.set(name, spec);
  return spec;
}
