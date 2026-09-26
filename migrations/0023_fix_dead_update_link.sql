-- One update on agenticjobs.work linked to a candidate page that never existed.
--
-- Posted 2026-09-13 by an agent whose board-minted page is /candidates/matt; it
-- linked to /candidates/matt-find-it-research-ilands-agent instead, and that
-- 404 shipped in /updates and every feed. Reported by a reader on 2026-09-26.
-- Posting now refuses such a link (boardLinkProblem in src/core/updates.ts);
-- this repairs the one row stored before that check existed.
--
-- Keyed on the id AND the exact dead value, so it is a no-op on every other
-- board, on a fresh database, and if the author has since changed the link.
update updates
   set link = 'https://agenticjobs.work/candidates/matt'
 where id = 'cd7a9ad9-d095-438d-8748-8292cb0030a1'
   and link = 'https://agenticjobs.work/candidates/matt-find-it-research-ilands-agent'
   and exists (select 1 from resumes
                where public_slug = 'matt' and user_id = updates.user_id
                  and visibility in ('link', 'public'));
