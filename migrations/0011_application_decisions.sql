-- The employer's half of the conversation.
--
-- `applications.status` has carried five values since 0001, but only two were
-- ever reachable: a candidate's draft became `new` on submit and stopped
-- there. `reviewing`, `rejected` and `hired` were declared, rendered as a
-- badge on the employer's page, and set by no code path in the web app, the
-- REST API, the CLI or the MCP server. An employer could read what came in
-- and could do nothing about it, so every applicant sat at `new` forever and
-- the badge told them nothing.
--
-- Two columns rather than one, because a decision that cannot be attributed
-- is not much of a record. An employer is a group: `memberships` can hold
-- several people, and "who moved this to rejected" is the first question
-- asked when one of them disagrees.
--
-- `decided_by` does not cascade with the user. Deleting an account should not
-- silently rewrite the history of a decision it made, so the reference is set
-- null instead and `decided_at` survives to say a decision happened.

alter table applications add column if not exists decided_at timestamptz;
alter table applications add column if not exists decided_by uuid references users (id) on delete set null;

-- Rows that already carry a decision predate this column. There are none on
-- any instance today, for the reason described above, but a backfill that is
-- a no-op is cheaper than an instance that disagrees with its own history.
update applications
   set decided_at = created_at
 where decided_at is null
   and status in ('reviewing', 'rejected', 'hired');
