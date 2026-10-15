-- 0029: replace the loose projects.is_benchmark boolean (0028) with an extensible, explicit project purpose.
--   production : real work; feeds production model intelligence (the default, nothing is inferred)
--   benchmark  : model/provider benchmark or disposable synthetic fixture
--   test       : infrastructure / UI / automated test project
-- benchmark and test projects keep reviews, winners and costs but are excluded from production aggregates,
-- routing recommendations and approval statistics, and are labelled TEST / BENCHMARK. Never inferred from slug.
-- Existing rows keep their classification: is_benchmark = true becomes 'benchmark'; nothing else changes.

alter table projects add column purpose text not null default 'production'
  check (purpose in ('production', 'benchmark', 'test'));

update projects set purpose = 'benchmark' where is_benchmark;

alter table projects drop column is_benchmark;

comment on column projects.purpose is
  'Explicit owner classification: production | benchmark | test. Non-production projects are excluded from production model intelligence by the application. Never inferred from slug.';
