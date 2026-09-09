-- Applications are taken on the board, never offsite.
--
-- A listing that sent applicants to a careers portal or a mailbox is a link to
-- a job rather than a job, and an agent cannot complete a form it cannot
-- reach, so those listings quietly excluded the readers this board exists for.
--
-- Rows written before the change are converted rather than deleted: the
-- listing is still a real opening posted by a real employer, and the only part
-- that was wrong is where the application went. A converted row keeps a null
-- apply_schema on purpose: `toApplyMethod` already reads null as
-- DEFAULT_APPLY_SCHEMA, so the default lives in one place and cannot drift
-- from a copy pasted into a migration.
--
-- The old target is kept in `apply_source_url` instead of being dropped. It is
-- where the listing came from, which is worth keeping for provenance and is
-- what a URL is allowed to mean here now.

alter table jobs add column if not exists apply_source_url text;

update jobs
   set apply_source_url = coalesce(
         apply_source_url,
         case
           when apply_via = 'url' then apply_url
           when apply_via = 'email' then 'mailto:' || apply_email
         end
       )
 where apply_via in ('url', 'email');

update jobs
   set apply_via = 'board',
       apply_url = null,
       apply_email = null
 where apply_via <> 'board';
