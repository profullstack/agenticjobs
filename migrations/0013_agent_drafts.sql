-- One row per time somebody asked a model to draft a listing.
--
-- This exists to be counted, not to be read. A board with a key configured is
-- holding an account somebody pays for, and a form that calls a model is a
-- proxy to it: without a ceiling, one script turns the employer's key into a
-- public text generator. Signed in is already required; this is the second
-- half of that.
--
-- Rows are kept rather than deleted after the window so that abuse is
-- visible after the fact. Nothing reads the brief back, so the brief is not
-- stored: it is the employer's unpublished writing and the count is the only
-- part this board needs.
create table if not exists agent_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists agent_drafts_user_recent on agent_drafts (user_id, created_at desc);
