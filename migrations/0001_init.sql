-- The board itself: who posts, what they post, and who applies.
--
-- Forward-only. Each file in this directory runs exactly once, in filename
-- order, inside one transaction, and is never edited afterwards.

create table if not exists organisations (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,
  name         text not null,
  website      text,
  logo_url     text,
  description  text,
  created_at   timestamptz not null default now()
);

create table if not exists users (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,
  name         text,
  is_admin     boolean not null default false,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz
);

-- Addresses are compared case-insensitively but stored as the person typed
-- them, so mail to them looks the way they expect.
create unique index if not exists users_email_key on users (lower(email));

create table if not exists memberships (
  user_id  uuid not null references users (id) on delete cascade,
  org_id   uuid not null references organisations (id) on delete cascade,
  role     text not null default 'owner',
  created_at timestamptz not null default now(),
  primary key (user_id, org_id)
);

create table if not exists jobs (
  id                uuid primary key default gen_random_uuid(),
  slug              text not null unique,
  org_id            uuid not null references organisations (id) on delete cascade,
  title             text not null,
  description       text not null default '',
  employment_type   text not null default 'full-time',
  workplace         text not null default 'remote',
  seniority         text,
  location          text,
  remote_regions    text[] not null default '{}',
  salary_min        integer,
  salary_max        integer,
  salary_currency   text not null default 'USD',
  salary_period     text not null default 'year',
  salary_equity     text,
  tags              text[] not null default '{}',
  stack             text[] not null default '{}',
  requirements      text[] not null default '{}',
  responsibilities  text[] not null default '{}',
  agent_policy      text not null default 'disclose',
  apply_via         text not null default 'board',
  apply_url         text,
  apply_email       text,
  apply_schema      jsonb,
  status            text not null default 'draft',
  published_at      timestamptz,
  expires_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  search            tsvector
);

-- The search vector is maintained by a trigger rather than a generated
-- column: array_to_string is not immutable in every server version, and a
-- generated column that fails to create takes the whole migration with it.
create or replace function jobs_search_update() returns trigger as $$
begin
  new.search :=
    setweight(to_tsvector('english', coalesce(new.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(array_to_string(new.tags, ' '), '')), 'B') ||
    setweight(to_tsvector('english', coalesce(array_to_string(new.stack, ' '), '')), 'B') ||
    setweight(to_tsvector('english', coalesce(new.description, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(new.location, '')), 'D');
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists jobs_search_trigger on jobs;
create trigger jobs_search_trigger
  before insert or update on jobs
  for each row execute function jobs_search_update();

create index if not exists jobs_search_idx on jobs using gin (search);
create index if not exists jobs_tags_idx on jobs using gin (tags);
create index if not exists jobs_stack_idx on jobs using gin (stack);
create index if not exists jobs_org_idx on jobs (org_id);
-- The list page and every federated search read exactly this order.
create index if not exists jobs_published_idx
  on jobs (published_at desc)
  where status = 'published';

create table if not exists applications (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references jobs (id) on delete cascade,
  answers    jsonb not null default '{}'::jsonb,
  agent      jsonb,
  status     text not null default 'new',
  created_at timestamptz not null default now()
);

create index if not exists applications_job_idx on applications (job_id, created_at desc);
