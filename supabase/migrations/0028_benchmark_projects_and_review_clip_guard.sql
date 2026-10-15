-- 0028: benchmark / synthetic-fixture projects, and a "reviews need a clip" guard.
--
-- 1. projects.is_benchmark: an explicit, owner-set classification of infrastructure-validation projects (a
--    disposable provider-contract fixture, a model benchmark). It is NEVER inferred from a slug or title. A
--    benchmark project still persists reviews, winners, costs and comparison data (so the tooling can be
--    tested end to end); the application excludes its records from production model-performance aggregates,
--    production routing recommendations and approval-rate statistics, and labels the data TEST / BENCHMARK.
--    Existing projects are production (default false); nothing is reclassified here (no slug matching).
-- 2. generation_reviews can only be written for an attempt that SUCCEEDED. A failed, cancelled or still-running
--    attempt has no clip, so a human verdict on it would be a fabricated quality signal. The application already
--    refuses it; this makes the database agree. Existing rows are untouched (the check is on insert only).

alter table projects add column is_benchmark boolean not null default false;

comment on column projects.is_benchmark is
  'Explicit owner classification: infrastructure/benchmark/synthetic-fixture project. Excluded from production model intelligence by the application. Never inferred from slug.';

create or replace function guard_generation_review_clip() returns trigger
language plpgsql as $$
declare
  s text;
begin
  select status into s
    from generation_attempts
   where id = new.attempt_id and project_id = new.project_id;
  if s is distinct from 'succeeded' then
    raise exception 'a human review needs a completed generation (attempt status is %)', coalesce(s, 'missing');
  end if;
  return new;
end;
$$;

create trigger generation_reviews_require_clip before insert on generation_reviews
  for each row execute function guard_generation_review_clip();
