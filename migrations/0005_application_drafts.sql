-- A human control point on the candidate's side, matching the one employers
-- already have.
--
-- An employer's agent can write a listing, but it lands as a draft and a
-- person publishes it. Until now a candidate's agent had no equivalent: it
-- either sent the application or it did not. This adds the same seam. An agent
-- prepares an application, the candidate reads it and releases it.
--
-- A draft is visible only to the candidate who owns it. It is not an
-- application until it is submitted, so employers never see one, counts never
-- include one, and the rate limit does not spend on one.

alter table applications add column if not exists submitted_at timestamptz;

-- Everything that already exists was sent, by definition.
update applications set submitted_at = created_at where submitted_at is null and status <> 'draft';

create index if not exists applications_draft_idx
  on applications (user_id, created_at desc)
  where submitted_at is null;
