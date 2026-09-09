/**
 * Resume CRUD.
 *
 * The Markdown column is the only thing anyone writes. `parsed` and `search`
 * are both recomputed from it on every save - `parsed` here, `search` by the
 * trigger - so there is no path by which the structured view and the document
 * can disagree.
 */

import type pg from 'pg';
import { parseResume, resumeTemplate, type OpenResume } from '../markup/resume.ts';
import { clean, slugify, suffix } from '../schema/text.ts';
import { nameOf } from './candidates.ts';

export const VISIBILITIES = ['private', 'link', 'public'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export function isVisibility(value: unknown): value is Visibility {
  return typeof value === 'string' && (VISIBILITIES as readonly string[]).includes(value);
}

export interface Resume {
  id: string;
  userId: string;
  slug: string;
  title: string;
  markdown: string;
  parsed: OpenResume | null;
  visibility: Visibility;
  /** The board-wide address, minted when a resume is first shared. */
  publicSlug: string | null;
  sourceName: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ResumeRow {
  id: string;
  user_id: string;
  slug: string;
  title: string;
  markdown: string;
  parsed: OpenResume | null;
  visibility: string;
  public_slug: string | null;
  source_name: string | null;
  created_at: string;
  updated_at: string;
}

function toResume(row: ResumeRow): Resume {
  return {
    id: row.id,
    userId: row.user_id,
    slug: row.slug,
    title: row.title,
    markdown: row.markdown,
    parsed: row.parsed,
    visibility: isVisibility(row.visibility) ? row.visibility : 'private',
    publicSlug: row.public_slug,
    sourceName: row.source_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// The source bytes are never in the default projection: they are megabytes of
// PDF that no page needs, and selecting them by habit is how a list endpoint
// starts moving 40MB.
const SELECT = `select id, user_id, slug, title, markdown, parsed, visibility, public_slug,
                       source_name, created_at, updated_at from resumes`;

export async function listResumes(pool: pg.Pool, userId: string): Promise<Resume[]> {
  const result = await pool.query<ResumeRow>(
    `${SELECT} where user_id = $1 order by updated_at desc`,
    [userId],
  );
  return result.rows.map(toResume);
}

export async function getResume(
  pool: pg.Pool,
  userId: string,
  slug: string,
): Promise<Resume | null> {
  const result = await pool.query<ResumeRow>(`${SELECT} where user_id = $1 and slug = $2`, [
    userId,
    slug,
  ]);
  const row = result.rows[0];
  return row === undefined ? null : toResume(row);
}

export async function getResumeById(pool: pg.Pool, id: string): Promise<Resume | null> {
  const result = await pool.query<ResumeRow>(`${SELECT} where id = $1`, [id]);
  const row = result.rows[0];
  return row === undefined ? null : toResume(row);
}

/** For a shared link: only resumes the owner has opened up. */
/** Slugs are capped at this many characters, cut back to a whole word. */
const SLUG_MAX = 60;

function publicSlugBase(name: string): string {
  const full = slugify(name);
  if (full === '') return 'candidate';
  if (full.length <= SLUG_MAX) return full;
  const cut = full.slice(0, SLUG_MAX);
  const lastDash = cut.lastIndexOf('-');
  const trimmed = lastDash > 20 ? cut.slice(0, lastDash) : cut;
  return trimmed.replace(/-+$/, '') || 'candidate';
}

/**
 * Give a shared resume a board-wide address, once.
 *
 * Named after the person, because the point of a candidate page is that it
 * carries their name. Falls back to the resume's own title, and then to a
 * random suffix, so a resume with no name in it is still addressable.
 *
 * The slug is minted on first share and then kept even if the resume is made
 * private again and shared later: a URL that someone has already sent to an
 * employer must not come back pointing at a different person.
 */
export async function ensurePublicSlug(pool: pg.Pool, resume: Resume): Promise<string | null> {
  if (resume.visibility === 'private') return resume.publicSlug;
  if (resume.publicSlug !== null) return resume.publicSlug;

  // Bounded, and cut at a word boundary. A slug is a URL, and a URL built out
  // of somebody's document has to survive that document being malformed: an
  // unbounded one produced a three thousand character address the first time
  // this ran against a resume whose line breaks had been flattened.
  const base = publicSlugBase(nameOf(resume));
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const claimed = await pool.query(
      `update resumes set public_slug = $2 where id = $1 and public_slug is null
         and not exists (select 1 from resumes where public_slug = $2)
       returning public_slug`,
      [resume.id, candidate],
    );
    if (claimed.rows.length > 0) return candidate;
  }
  return null;
}

/** The directory: resumes their owner chose to list. */
export async function listPublicResumes(pool: pg.Pool, limit = 100): Promise<Resume[]> {
  const result = await pool.query<ResumeRow>(
    `${SELECT} where visibility = 'public' and public_slug is not null
      order by updated_at desc limit $1`,
    [Math.min(200, Math.max(1, limit))],
  );
  return result.rows.map(toResume);
}

/**
 * One candidate page.
 *
 * Serves `link` as well as `public`, which is the difference between the two:
 * a link resume is reachable by anyone holding the URL and is not listed.
 */
export async function getPublicResume(pool: pg.Pool, publicSlug: string): Promise<Resume | null> {
  const result = await pool.query<ResumeRow>(
    `${SELECT} where public_slug = $1 and visibility in ('link', 'public')`,
    [publicSlug],
  );
  const row = result.rows[0];
  return row === undefined ? null : toResume(row);
}

export async function getSharedResume(pool: pg.Pool, id: string): Promise<Resume | null> {
  const result = await pool.query<ResumeRow>(
    `${SELECT} where id = $1 and visibility in ('link', 'public')`,
    [id],
  );
  const row = result.rows[0];
  return row === undefined ? null : toResume(row);
}

export interface SaveResume {
  title?: string;
  markdown: string;
  visibility?: Visibility;
  source?: { name: string; mime: string; bytes: Buffer } | null;
}

async function uniqueSlug(pool: pg.Pool, userId: string, title: string): Promise<string> {
  const base = slugify(title);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${suffix(4)}`;
    const taken = await pool.query(`select 1 from resumes where user_id = $1 and slug = $2`, [
      userId,
      candidate,
    ]);
    if (taken.rows.length === 0) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export async function createResume(
  pool: pg.Pool,
  userId: string,
  input: SaveResume,
): Promise<Resume> {
  // OpenResume Markdown: the line breaks are the document.
  const markdown = clean(input.markdown, 200_000, { multiline: true });
  const parsed = parseResume(markdown);
  // The document's own h1 is a better title than "Resume", and it is what the
  // candidate would have typed anyway.
  const title = clean(input.title, 120) || parsed.name || 'Resume';
  const slug = await uniqueSlug(pool, userId, title);

  const result = await pool.query<ResumeRow>(
    `insert into resumes (user_id, slug, title, markdown, parsed, visibility,
                          source_name, source_mime, source_bytes)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
     returning id, user_id, slug, title, markdown, parsed, visibility, public_slug, source_name,
               created_at, updated_at`,
    [
      userId,
      slug,
      title,
      markdown,
      JSON.stringify(parsed),
      input.visibility ?? 'private',
      input.source?.name ?? null,
      input.source?.mime ?? null,
      input.source?.bytes ?? null,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('resume insert returned no row');
  return toResume(row);
}

export async function updateResume(
  pool: pg.Pool,
  userId: string,
  slug: string,
  input: SaveResume,
): Promise<Resume | null> {
  // OpenResume Markdown: the line breaks are the document.
  const markdown = clean(input.markdown, 200_000, { multiline: true });
  const parsed = parseResume(markdown);
  const result = await pool.query<ResumeRow>(
    `update resumes
        set markdown = $3,
            parsed = $4::jsonb,
            title = coalesce(nullif($5, ''), title),
            visibility = coalesce($6, visibility)
      where user_id = $1 and slug = $2
      returning id, user_id, slug, title, markdown, parsed, visibility, public_slug,
                source_name, created_at, updated_at`,
    [userId, slug, markdown, JSON.stringify(parsed), clean(input.title, 120), input.visibility ?? null],
  );
  const row = result.rows[0];
  return row === undefined ? null : toResume(row);
}

export async function deleteResume(pool: pg.Pool, userId: string, slug: string): Promise<boolean> {
  const result = await pool.query(`delete from resumes where user_id = $1 and slug = $2`, [
    userId,
    slug,
  ]);
  return (result.rowCount ?? 0) > 0;
}

/** The original upload, for re-converting a document that came out badly. */
export async function getResumeSource(
  pool: pg.Pool,
  userId: string,
  slug: string,
): Promise<{ name: string; mime: string; bytes: Buffer } | null> {
  const result = await pool.query<{
    source_name: string | null;
    source_mime: string | null;
    source_bytes: Buffer | null;
  }>(`select source_name, source_mime, source_bytes from resumes where user_id = $1 and slug = $2`, [
    userId,
    slug,
  ]);
  const row = result.rows[0];
  if (row === undefined || row.source_bytes === null) return null;
  return {
    name: row.source_name ?? 'resume',
    mime: row.source_mime ?? 'application/octet-stream',
    bytes: row.source_bytes,
  };
}

/** A first resume, so the editor is never an empty box. */
export async function ensureFirstResume(
  pool: pg.Pool,
  userId: string,
  name: string | null,
): Promise<Resume> {
  const existing = await listResumes(pool, userId);
  const first = existing[0];
  if (first !== undefined) return first;
  return createResume(pool, userId, {
    title: 'Resume',
    markdown: resumeTemplate(name ?? 'Your Name'),
  });
}
