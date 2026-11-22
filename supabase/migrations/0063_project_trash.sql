-- 0063: a deleted project goes to the Trash for 30 days before it is deleted for good. One nullable timestamp:
-- null = not in the Trash (every existing project stays as it is), set = moved to the Trash at that moment. A project
-- in the Trash is out of the Projects list and cannot be opened until it is restored; after 30 days the app deletes
-- it (the same cascade as before) when its owner next opens the Projects page. No RLS change: the owner's existing
-- `projects_owner` policy (for all) already covers the update. The app reads it defensively, so code that ships
-- before this migration keeps working (deleting a project says the migration is needed until it is applied).

alter table projects add column if not exists trashed_at timestamptz;
