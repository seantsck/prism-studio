-- 0060: a project can be archived (hidden from the Projects list, everything kept) and restored.
-- One nullable timestamp: null = active (every existing row stays active), set = archived at that moment.
-- No RLS change: the owner's existing `projects_owner` policy (for all) already covers the update, and the app only
-- ever touches it through its own project rows. The app reads it defensively, so code that ships before this
-- migration keeps working (Archive is simply unavailable until it is applied).

alter table projects add column if not exists archived_at timestamptz;
