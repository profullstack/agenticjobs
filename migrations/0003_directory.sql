-- The directory: which instances exist, and what each of them last said about
-- itself.
--
-- nixamp's stream directory keeps its entries in memory with a TTL, because a
-- stream that stops should vanish. A job board that goes down for an afternoon
-- has not stopped existing, and the URLs people bookmarked still have to
-- resolve, so these rows are durable and `online` is derived from
-- `checked_at` instead.

create table if not exists instances (
  id           uuid primary key default gen_random_uuid(),
  -- The origin, with no path, query or credentials. One row per origin.
  url          text not null unique,
  -- The last descriptor the directory successfully fetched from the instance
  -- itself. Never what an announcement claimed.
  descriptor   jsonb not null,
  first_seen_at timestamptz not null default now(),
  checked_at   timestamptz not null default now(),
  failures     integer not null default 0,
  -- An operator can refuse an instance without deleting it, so that it does
  -- not simply re-announce itself a minute later.
  blocked      boolean not null default false,
  blocked_reason text
);

create index if not exists instances_checked_idx on instances (checked_at desc);
create index if not exists instances_failures_idx on instances (failures) where blocked = false;
