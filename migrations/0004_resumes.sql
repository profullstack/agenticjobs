-- Resumes, in Markdown.
--
-- The Markdown is the canonical copy. `parsed` is a derived cache of the
-- OpenResume.md structure and `search` is a derived index; both are rewritten
-- from `markdown` on every save and neither is ever the thing edited. A
-- candidate can keep several, because a resume tailored to one job is the
-- normal case.

create table if not exists resumes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  -- Unique per user, not globally: two people may both have a "backend" one.
  slug        text not null,
  title       text not null default 'Resume',
  markdown    text not null default '',
  parsed      jsonb,
  -- private: only the owner. link: anyone with the URL. public: listed.
  visibility  text not null default 'private',
  -- Set when the Markdown was converted from an upload, so a bad conversion
  -- can be redone from the original instead of retyped.
  source_name text,
  source_mime text,
  source_bytes bytea,
  search      tsvector,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists resumes_user_slug_key on resumes (user_id, slug);
create index if not exists resumes_user_idx on resumes (user_id, updated_at desc);

create or replace function resumes_search_update() returns trigger as $$
begin
  new.search :=
    setweight(to_tsvector('english', coalesce(new.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(new.markdown, '')), 'B');
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists resumes_search_trigger on resumes;
create trigger resumes_search_trigger
  before insert or update on resumes
  for each row execute function resumes_search_update();

create index if not exists resumes_search_idx on resumes using gin (search);

-- An application carries a COPY of the resume, not a reference to it.
--
-- A candidate who rewrites their resume next month must not silently rewrite
-- what an employer already read and replied to, and a resume deleted after an
-- interview must not blank the application it was sent with.
alter table applications add column if not exists resume_markdown text;
alter table applications add column if not exists resume_title text;
-- Kept only so the candidate's own "where did I send this" list can group
-- applications by the resume they came from. Nulled by deleting the resume.
alter table applications add column if not exists resume_id uuid
  references resumes (id) on delete set null;
alter table applications add column if not exists user_id uuid
  references users (id) on delete set null;

create index if not exists applications_user_idx on applications (user_id, created_at desc);
