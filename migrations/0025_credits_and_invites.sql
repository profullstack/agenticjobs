-- Credit codes and invites (@profullstack/redeem-credits, @profullstack/affiliates).
--
-- The two packages keep their own tables (credit_* and aff_*) and create them
-- on first use. The credit tables are created here as well, from the package's
-- own DDL, so a fresh board has them before anyone redeems anything. What is
-- this board's own lives below.

create table if not exists credit_codes (
  id text primary key,
  hash text not null unique,
  label text not null,
  unit text not null,
  amount double precision not null,
  recur text,
  months integer,
  max_redemptions integer not null,
  redemptions integer not null default 0,
  expires_at bigint,
  created_at bigint not null,
  revoked_at bigint,
  created_by text
);

create table if not exists credit_redemptions (
  code_id text not null,
  user_id text not null,
  at bigint not null,
  primary key (code_id, user_id)
);

create table if not exists credit_ledger (
  id bigserial primary key,
  user_id text not null,
  unit text not null,
  amount double precision not null,
  kind text not null,
  recur text,
  months integer,
  source text not null,
  at bigint not null
);

create index if not exists credit_ledger_user_unit on credit_ledger (user_id, unit, at);

create table if not exists credit_accounts (
  user_id text not null,
  unit text not null,
  version integer not null default 0,
  primary key (user_id, unit)
);

-- An invite or a ?ref= code rides on the magic link, the way the signup
-- profile does: the account does not exist until the link is spent, and the
-- link may be opened in another browser (a phone's mail app) that never saw
-- the invite cookie.
alter table magic_links add column if not exists invite_code text;
alter table magic_links add column if not exists ref_code text;

-- One row per person per accepted invite: whether the bonus was granted, and
-- if not, why. The primary key is what makes the grant idempotent: the row is
-- claimed before the credit is written, so a retry never pays twice.
create table if not exists invite_bonuses (
  invite_id   text not null,
  user_id     uuid not null references users (id) on delete cascade,
  role        text not null check (role in ('inviter', 'invitee')),
  cents       integer not null default 0,
  status      text not null,
  created_at  timestamptz not null default now(),
  primary key (invite_id, user_id)
);

create index if not exists invite_bonuses_user_idx on invite_bonuses (user_id, created_at desc);
