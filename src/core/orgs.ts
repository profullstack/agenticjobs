/**
 * Employers.
 *
 * A person can belong to several, which is the difference between a job board
 * and a blog with a jobs page: the agency posting on behalf of four clients is
 * the normal case, not the exception.
 */

import type pg from 'pg';
import type { Organisation } from '../schema/index.ts';
import { clean, slugify, suffix } from '../schema/text.ts';

interface OrgRow {
  id: string;
  slug: string;
  name: string;
  website: string | null;
  logo_url: string | null;
  description: string | null;
  created_at: string;
}

function toOrg(row: OrgRow): Organisation {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    website: row.website,
    logoUrl: row.logo_url,
    description: row.description,
    createdAt: row.created_at,
  };
}

const SELECT = `select id, slug, name, website, logo_url, description, created_at from organisations`;

export async function getOrgBySlug(pool: pg.Pool, slug: string): Promise<Organisation | null> {
  const result = await pool.query<OrgRow>(`${SELECT} where slug = $1`, [slug]);
  const row = result.rows[0];
  return row === undefined ? null : toOrg(row);
}

export async function getOrgById(pool: pg.Pool, id: string): Promise<Organisation | null> {
  const result = await pool.query<OrgRow>(`${SELECT} where id = $1`, [id]);
  const row = result.rows[0];
  return row === undefined ? null : toOrg(row);
}

export async function listOrgsForUser(pool: pg.Pool, userId: string): Promise<Organisation[]> {
  const result = await pool.query<OrgRow>(
    `select o.id, o.slug, o.name, o.website, o.logo_url, o.description, o.created_at
       from organisations o
       join memberships m on m.org_id = o.id
      where m.user_id = $1
      order by o.name asc`,
    [userId],
  );
  return result.rows.map(toOrg);
}

export async function isMember(pool: pg.Pool, userId: string, orgId: string): Promise<boolean> {
  const result = await pool.query(
    `select 1 from memberships where user_id = $1 and org_id = $2`,
    [userId, orgId],
  );
  return result.rows.length > 0;
}

export interface OrgInput {
  name: string;
  website?: string | null;
  description?: string | null;
  logoUrl?: string | null;
}

function normaliseUrl(value: unknown): string | null {
  const raw = clean(value, 500);
  if (raw === '') return null;
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export async function createOrg(
  pool: pg.Pool,
  ownerId: string,
  input: OrgInput,
): Promise<Organisation | string> {
  const name = clean(input.name, 120);
  if (name.length < 2) return 'An employer name of at least 2 characters is required.';

  const base = slugify(name);
  let slug = base;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const taken = await pool.query(`select 1 from organisations where slug = $1`, [slug]);
    if (taken.rows.length === 0) break;
    slug = `${base}-${suffix(4)}`;
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const created = await client.query<OrgRow>(
      `insert into organisations (slug, name, website, description, logo_url)
       values ($1, $2, $3, $4, $5)
       returning id, slug, name, website, logo_url, description, created_at`,
      [
        slug,
        name,
        normaliseUrl(input.website),
        clean(input.description, 2000) || null,
        normaliseUrl(input.logoUrl),
      ],
    );
    const row = created.rows[0];
    if (row === undefined) throw new Error('organisation insert returned no row');
    // The membership is part of the same transaction: an employer with no
    // members is one nobody can post to or delete.
    await client.query(
      `insert into memberships (user_id, org_id, role) values ($1, $2, 'owner')`,
      [ownerId, row.id],
    );
    await client.query('commit');
    return toOrg(row);
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Change an employer's details, one field at a time.
 *
 * Only the fields that were sent move. An employer edited from a form that
 * only carries a name must not have its website silently cleared, and an
 * agent updating a description has no business also blanking a logo it never
 * read. `null` is therefore a value that clears a field and `undefined` is
 * "leave it", which is the distinction the whole signature exists to keep.
 *
 * The slug never moves, even when the name does. It is the URL that listings,
 * links and the directory all point at, and a rename is the most ordinary
 * thing an employer does: a company that becomes "Example Works Inc" has not
 * become a different employer, and every link to it must survive that.
 */
export async function updateOrg(
  pool: pg.Pool,
  slug: string,
  input: Partial<OrgInput>,
): Promise<Organisation | string> {
  const existing = await getOrgBySlug(pool, slug);
  if (existing === null) return `No employer here with the slug ${slug}.`;

  let name = existing.name;
  if (input.name !== undefined) {
    name = clean(input.name, 120);
    if (name.length < 2) return 'An employer name of at least 2 characters is required.';
  }

  const website = input.website === undefined ? existing.website : normaliseUrl(input.website);
  const logoUrl = input.logoUrl === undefined ? existing.logoUrl : normaliseUrl(input.logoUrl);
  const description =
    input.description === undefined
      ? existing.description
      : clean(input.description, 2000) || null;

  const result = await pool.query<OrgRow>(
    `update organisations set name = $2, website = $3, description = $4, logo_url = $5
      where id = $1
      returning id, slug, name, website, logo_url, description, created_at`,
    [existing.id, name, website, description, logoUrl],
  );
  const row = result.rows[0];
  return row === undefined ? `No employer here with the slug ${slug}.` : toOrg(row);
}

/** An employer's listings, split by whether they were ever public. */
export async function countJobsForOrg(
  pool: pg.Pool,
  orgId: string,
): Promise<{ total: number; live: number }> {
  const result = await pool.query<{ total: string; live: string }>(
    `select count(*)::text as total,
            count(*) filter (where status <> 'draft')::text as live
       from jobs where org_id = $1`,
    [orgId],
  );
  const row = result.rows[0];
  return { total: Number(row?.total ?? 0), live: Number(row?.live ?? 0) };
}

/**
 * Delete an employer that never published anything.
 *
 * `jobs.org_id` cascades and `applications.job_id` cascades behind it, so a
 * plain delete here would quietly take published listings and every
 * application people sent to them. A listing that has been public is part of
 * a record other people are in, and one line of SQL is not the right amount
 * of ceremony for removing it.
 *
 * Drafts are different: nobody has seen them, nothing can have been sent to
 * one, and an employer whose listings are all drafts is almost always an
 * employer typed in wrong five minutes ago. Those cascade, which is what
 * makes this useful rather than a delete that always refuses.
 *
 * The refusal is permanent by design and says so, because there is no
 * unpublish-and-then-delete path to send somebody down: closing a listing
 * keeps it, which is the point of closing it.
 */
export async function deleteOrg(pool: pg.Pool, orgId: string): Promise<true | string> {
  const jobs = await countJobsForOrg(pool, orgId);
  if (jobs.live > 0) {
    return `That employer has ${jobs.live} listing${jobs.live === 1 ? '' : 's'} that went live, and the applications sent to them would go too. An employer that has posted publicly stays.`;
  }
  const result = await pool.query(`delete from organisations where id = $1`, [orgId]);
  return result.rowCount === 0 ? 'No such employer.' : true;
}

export async function listOrgs(pool: pg.Pool, limit = 100): Promise<Organisation[]> {
  const result = await pool.query<OrgRow>(
    `select o.id, o.slug, o.name, o.website, o.logo_url, o.description, o.created_at
       from organisations o
      where exists (
        select 1 from jobs j
         where j.org_id = o.id and j.status = 'published'
           and j.published_at is not null and j.published_at <= now()
           and (j.expires_at is null or j.expires_at > now())
      )
      order by o.name asc
      limit $1`,
    [Math.min(500, Math.max(1, limit))],
  );
  return result.rows.map(toOrg);
}
