-- Give the resumes that were already shared their public address.
--
-- 0007 added public_slug and the application mints it when a resume is saved
-- as shared. That leaves every resume shared BEFORE the candidate directory
-- existed with a null slug, and `listPublicResumes` requires one, so a resume
-- its owner had already set to "public" stayed invisible. They are the exact
-- resumes the directory was built for: someone asked to be listed and the
-- board had nowhere to list them.
--
-- Named after the person, like the application does, falling back to the
-- resume title and then to "candidate". Duplicates get a numeric suffix, and
-- the whole thing is guarded by `not exists` so it can never collide with a
-- slug the application has already handed out.
--
-- This is deliberately a one-time correction rather than a rule: new resumes
-- get their slug from ensurePublicSlug on save.

with base as (
  select
    id,
    trim(
      both '-' from
      lower(
        regexp_replace(
          coalesce(nullif(parsed ->> 'name', ''), nullif(title, ''), 'candidate'),
          '[^a-zA-Z0-9]+', '-', 'g'
        )
      )
    ) as raw
  from resumes
  where visibility in ('link', 'public')
    and public_slug is null
),
named as (
  select id, case when raw = '' then 'candidate' else raw end as slug from base
),
numbered as (
  select
    id,
    slug,
    row_number() over (partition by slug order by id) as position
  from named
)
update resumes as r
   set public_slug = case
         when numbered.position = 1 then numbered.slug
         else numbered.slug || '-' || numbered.position
       end
  from numbered
 where r.id = numbered.id
   and not exists (
     select 1 from resumes as taken
      where taken.public_slug = case
              when numbered.position = 1 then numbered.slug
              else numbered.slug || '-' || numbered.position
            end
   );
