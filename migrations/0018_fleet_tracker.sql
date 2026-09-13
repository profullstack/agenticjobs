create table fleets (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  owner_id uuid not null references users(id) on delete cascade,
  operator_resume_id uuid not null references resumes(id) on delete cascade,
  agents integer not null check (agents between 1 and 1000),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  rate numeric(16,6) not null check (rate >= 0),
  retained_target numeric(16,6) not null default 50 check (retained_target >= 0),
  assumed_direct_cost numeric(16,6) not null default 100 check (assumed_direct_cost >= 0),
  public_listing boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index fleets_owner on fleets(owner_id);

create table fleet_events (
  fleet_id uuid not null references fleets(id) on delete cascade,
  source text not null,
  event_id text not null,
  kind text not null check (kind in ('cost','work','receipt','commission','fee','affiliate')),
  occurred_at timestamptz,
  amount numeric(16,6) check (amount >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  seconds integer check (seconds >= 0),
  agents integer check (agents between 1 and 1000),
  billable boolean not null default false,
  provenance text not null check (provenance in ('engine','estimated','reported')),
  partial boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (fleet_id, source, event_id),
  check ((kind = 'work' and amount is null) or (kind <> 'work' and seconds is null and agents is null and billable = false))
);
