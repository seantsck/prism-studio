-- 0065: a project can have the purpose `library`: one per account, holding the Characters a creator makes on their own
-- (from the home page, "Create a character"), outside any story. It never appears among their projects; its
-- Characters are in their library and are copied into projects from there. Only the allowed values of the existing
-- check change; every existing project keeps its purpose. No RLS change. The app reads it defensively: until this is
-- applied, creating a character on its own says the migration is needed, and nothing else changes.

alter table projects drop constraint if exists projects_purpose_check;
alter table projects add constraint projects_purpose_check
  check (purpose in ('production', 'benchmark', 'test', 'library'));
