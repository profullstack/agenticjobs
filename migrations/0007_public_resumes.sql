-- Candidates, so a resume that says "public" is actually somewhere.
--
-- `visibility` has had three values since the resumes table was written, and
-- the column comment says what they mean: "private: only the owner. link:
-- anyone with the URL. public: listed". Nothing ever listed them and nothing
-- served a URL, so choosing either of the last two did nothing at all.
--
-- A resume slug is unique per user, deliberately, because two people may both
-- have a "backend" one. That is fine for /me/resumes/<slug> and useless for a
-- public address, so a shared resume gets a second slug that is unique across
-- the board. It is minted when a resume is first shared rather than for every
-- resume, so a private resume claims no name in a namespace everyone shares.

alter table resumes add column if not exists public_slug text;

create unique index if not exists resumes_public_slug_key
  on resumes (public_slug)
  where public_slug is not null;

-- Listing the directory is "the public ones, newest first", so it reads by
-- visibility and orders by when the resume was last touched.
create index if not exists resumes_visibility_idx
  on resumes (visibility, updated_at desc)
  where visibility = 'public';
