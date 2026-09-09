-- Clear the public slugs that came out of a flattened resume.
--
-- 0008 built each slug from the resume's parsed name. A resume saved before
-- job descriptions, resumes and cover letters stopped having their newlines
-- flattened parses as one h1 holding the entire document, so "the name" was
-- the whole CV and the slug it produced was thousands of characters long.
--
-- Those slugs are machine-made from a bug rather than an address anybody has
-- ever been given, so clearing them costs nothing and leaving them means a
-- candidate page whose URL is a paragraph. Nulling them lets ensurePublicSlug
-- mint a sane one on the next save, now that it is bounded and checks that a
-- name is name-shaped.
--
-- The cutoff is generous on purpose: a real name that slugifies past 80
-- characters is not something to guess at, and the application caps new ones
-- at 60, so nothing it mints can be caught by this.

update resumes
   set public_slug = null
 where public_slug is not null
   and length(public_slug) > 80;
