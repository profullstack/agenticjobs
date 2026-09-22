-- A key the poster chooses, so a POST /api/v1/jobs that is repeated after a
-- lost response returns the listing it already made instead of a second one.
--
-- Stored on the row rather than in a response cache, because the guarantee
-- has to hold across a crash between the insert and the reply: a cache that
-- is written after the handler finishes is empty exactly when it is needed.
-- Scoped per employer, since a key is something a poster's own script picks.
alter table jobs add column if not exists idempotency_key text;
create unique index if not exists jobs_idempotency_key
  on jobs (org_id, idempotency_key)
  where idempotency_key is not null;
