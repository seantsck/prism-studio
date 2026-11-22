-- 0061: an Episode (or a film's single screenplay) can have a target length in minutes, set by the creator. Prism
-- sizes the plan, the scenes and the script to it (about a page a minute). One nullable integer: null = no length
-- set (every existing Episode keeps writing exactly as before). No RLS change: the owner's existing episode policies
-- already cover it. The app writes the column only when a length is set, so code that ships before this migration
-- keeps working (setting a length says the migration is needed until it is applied).

alter table episodes add column if not exists target_minutes integer
  check (target_minutes is null or target_minutes between 1 and 600);
