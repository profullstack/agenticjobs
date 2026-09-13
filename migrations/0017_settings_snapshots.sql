-- Settings sync (@profullstack/synconfig): a member's agenticjobs settings
-- (the boards they use, the directories they discover through) as one
-- snapshot under a monotonic revision, so `agenticjobs sync load` on another
-- machine gets them. The body is the client's JSON, stored opaque; the
-- client's policy keeps tokens out of it. The insert allocates max + 1 under
-- a precondition on max, and the unique constraint is the backstop. Ten are
-- kept per member.
create table if not exists settings_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  revision integer not null,
  digest text not null,
  host text,
  version text,
  size integer not null,
  body jsonb not null,
  created_at timestamptz not null default now(),
  unique (user_id, revision)
);

create index if not exists settings_snapshots_user_recent on settings_snapshots (user_id, revision desc);
