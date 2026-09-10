-- What a listing pays, in full.
--
-- A salary range per year was the whole vocabulary, and it described one
-- kind of work. The listings this board exists for pay per task, per pull
-- request, per social post, a flat fee for a project, a share of revenue or
-- a bounty, in dollars or in a coin, settled over whatever rail the two sides
-- agree on. This is the same model ugig.net carries as budget_type,
-- budget_unit and payment_coin, so a gig there and a job here describe pay
-- the same way.
--
-- The lines are JSON rather than a child table because they are read and
-- written as one value with the listing, never queried on their own: the
-- salary_* columns stay as the flattened first time-based line, which is
-- what the salary filter, the salary sort and the JobPosting structured
-- data compare on. A price per task has no annual figure and does not belong
-- in any of those.
alter table jobs add column if not exists pay_lines jsonb not null default '[]'::jsonb;
-- How it is settled: a coin such as SOL, or a rail such as "bank transfer".
alter table jobs add column if not exists pay_method text;

-- Every listing that already stated a range becomes one line, so the page
-- and the API say the same thing before and after this migration.
update jobs
   set pay_lines = jsonb_build_array(jsonb_build_object(
         'type', case salary_period
                   when 'hour' then 'hourly'
                   when 'day' then 'daily'
                   when 'week' then 'weekly'
                   when 'month' then 'monthly'
                   else 'yearly'
                 end,
         'min', salary_min,
         'max', salary_max,
         'currency', upper(coalesce(salary_currency, 'USD')),
         'unit', null))
 where pay_lines = '[]'::jsonb
   and salary_unpaid = false
   and (salary_min is not null or salary_max is not null);
