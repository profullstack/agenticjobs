-- The shared Profullstack profile (@profullstack/profile): email, first and
-- last name, company domain, job title and LinkedIn URL, one row per member.
-- Its own table rather than columns on users, so nothing that reads users
-- (sessions, candidate pages, the API's /me) starts carrying it by accident.
-- Never public: only the member reads it, through /api/v1/me/profile and /me.

create table if not exists "user_profiles" (
  "user_id" uuid primary key,
  "email" text,
  "first_name" text,
  "last_name" text,
  "company_domain" text,
  "job_title" text,
  "linkedin_url" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);
create index if not exists "user_profiles_email" on "user_profiles" (lower("email"));
create index if not exists "user_profiles_company_domain" on "user_profiles" ("company_domain");

-- The account does not exist until the link is followed, so what the signup
-- form validated rides on the link and is saved when it is spent.
alter table magic_links add column if not exists profile jsonb;

-- One-time backfill: members who already have a name. First word to
-- first_name, the rest to last_name; nothing a member typed is overwritten.
insert into user_profiles (user_id, email, first_name, last_name)
select u.id,
       lower(u.email),
       split_part(btrim(u.name), ' ', 1),
       nullif(btrim(substr(btrim(u.name), length(split_part(btrim(u.name), ' ', 1)) + 1)), '')
  from users u
 where nullif(btrim(u.name), '') is not null
on conflict (user_id) do update
   set email = coalesce(user_profiles.email, excluded.email),
       first_name = coalesce(user_profiles.first_name, excluded.first_name),
       last_name = coalesce(user_profiles.last_name, excluded.last_name);

