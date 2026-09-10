-- Recommendations: what somebody who worked with you says about you, shown
-- on your page once you have agreed to it.
--
-- Not a rating. A star out of five from a stranger who paid you once is a
-- number that says nothing and cannot be answered; it is the thing that
-- makes a marketplace profile a scoreboard. A recommendation is a paragraph
-- with a name on it, from an employer who hired you or a person you hired,
-- and it goes on your page only when you approve it. You can reject one,
-- and nothing is shown. That is LinkedIn's model, and it is the right one
-- for a board where every profile is a person's own document.
--
-- Both directions, because the board is symmetric: an employer recommends a
-- candidate, and a candidate recommends an employer. Each side is a person
-- or an employer, the same way a message is.
create table if not exists recommendations (
  id              uuid primary key default gen_random_uuid(),
  -- Who is saying it: a person as themselves, or an employer through a
  -- member. Exactly one.
  author_user_id  uuid references users (id) on delete cascade,
  author_org_id   uuid references organisations (id) on delete cascade,
  -- The person who typed it, kept even for an employer's, so "who wrote
  -- this" has an answer after they leave the company.
  written_by      uuid not null references users (id) on delete cascade,
  -- Who it is about. Exactly one.
  user_id         uuid references users (id) on delete cascade,
  org_id          uuid references organisations (id) on delete cascade,
  -- The words. Text, rendered as text.
  body            text not null check (length(body) between 20 and 2000),
  -- "Hired them for a three-month contract", "Worked with them at Acme".
  relationship    text,
  -- pending until the subject approves; approved is public; rejected is
  -- kept so the author can see it was, and so it cannot be re-sent daily.
  status          text not null default 'pending'
                  check (status in ('pending', 'approved', 'rejected')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  decided_at      timestamptz,
  constraint recommendations_one_author check (
    (author_user_id is null) <> (author_org_id is null)
  ),
  constraint recommendations_one_subject check ((user_id is null) <> (org_id is null)),
  -- Nobody recommends themselves, and an employer does not recommend itself.
  constraint recommendations_not_self check (
    (author_user_id is null or user_id is null or author_user_id <> user_id)
    and (author_org_id is null or org_id is null or author_org_id <> org_id)
  )
);

-- One per author per subject. Writing it again replaces the words and goes
-- back to pending for the subject to read again.
create unique index if not exists recommendations_user_user_key
  on recommendations (author_user_id, user_id) where author_user_id is not null and user_id is not null;
create unique index if not exists recommendations_user_org_key
  on recommendations (author_user_id, org_id) where author_user_id is not null and org_id is not null;
create unique index if not exists recommendations_org_user_key
  on recommendations (author_org_id, user_id) where author_org_id is not null and user_id is not null;
create unique index if not exists recommendations_org_org_key
  on recommendations (author_org_id, org_id) where author_org_id is not null and org_id is not null;

-- A page reads "approved, newest first" for one subject.
create index if not exists recommendations_user_idx on recommendations (user_id, status, decided_at desc)
  where user_id is not null;
create index if not exists recommendations_org_idx on recommendations (org_id, status, decided_at desc)
  where org_id is not null;
create index if not exists recommendations_written_idx on recommendations (written_by, created_at desc);
