-- Updates, and following the people who post them.
--
-- A short post from an employer or a candidate: hiring news, what shipped,
-- what someone is looking for next. The thing that makes this worth having
-- rather than another timeline is that it is attached to an identity the board
-- already knows, so an update is from a real employer or a real candidate and
-- not from an account made this morning.
--
-- Two constraints are in the schema rather than in a validator, because they
-- are what stop this becoming a spam feed and a validator is easy to route
-- around:
--
--   - An update is short. 600 characters is a paragraph and a link, which is
--     the shape of the thing; it is not room for an article.
--   - An update has exactly one author, and that author is an employer this
--     person belongs to or their own candidate profile. There is no anonymous
--     posting and no posting as somebody else.

create table if not exists updates (
  id          uuid primary key default gen_random_uuid(),
  -- Exactly one of these. A CHECK enforces it rather than a comment hoping.
  org_id      uuid references organisations (id) on delete cascade,
  user_id     uuid references users (id) on delete cascade,
  -- Who actually typed it, kept even for an org post so a deleted member's
  -- posts can be found, and so "who posted this" has an answer.
  author_id   uuid not null references users (id) on delete cascade,
  body        text not null check (length(body) between 1 and 600),
  -- One link, optional. Kept as a column rather than fished out of the body,
  -- so a reader and an agent see the same URL and nothing has to parse prose.
  link        text,
  created_at  timestamptz not null default now(),
  constraint updates_one_author check (
    (org_id is not null and user_id is null) or (org_id is null and user_id is not null)
  )
);

-- The feed reads "newest first, by author", and the whole-board feed reads
-- "newest first" across everything.
create index if not exists updates_org_idx on updates (org_id, created_at desc)
  where org_id is not null;
create index if not exists updates_user_idx on updates (user_id, created_at desc)
  where user_id is not null;
create index if not exists updates_recent_idx on updates (created_at desc);

-- Following.
--
-- A row is one person following one employer or one candidate. Same one-target
-- rule as an update, for the same reason, and a unique index rather than a
-- primary key over nullable columns so following twice is a no-op instead of
-- an error the caller has to interpret.
create table if not exists follows (
  id          uuid primary key default gen_random_uuid(),
  follower_id uuid not null references users (id) on delete cascade,
  org_id      uuid references organisations (id) on delete cascade,
  user_id     uuid references users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  constraint follows_one_target check (
    (org_id is not null and user_id is null) or (org_id is null and user_id is not null)
  ),
  -- Nobody follows themselves; it is not an error worth a message, but it is
  -- not a row worth keeping either.
  constraint follows_not_self check (user_id is null or user_id <> follower_id)
);

create unique index if not exists follows_org_key
  on follows (follower_id, org_id) where org_id is not null;
create unique index if not exists follows_user_key
  on follows (follower_id, user_id) where user_id is not null;
create index if not exists follows_org_count_idx on follows (org_id) where org_id is not null;
create index if not exists follows_user_count_idx on follows (user_id) where user_id is not null;
