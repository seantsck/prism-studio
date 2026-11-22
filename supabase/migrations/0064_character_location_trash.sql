-- 0064: a deleted Character or Location goes to the project's Trash for 30 days before it is deleted for good. One
-- nullable timestamp on each: null = not in the Trash (every existing row stays as it is), set = moved to the Trash at
-- that moment. Nothing else changes while it is in the Trash (its references, Looks, voices, views, locks and
-- generation history all stay, untouched), so Restore brings it back exactly as it was; the app hides it everywhere.
-- After 30 days (or "Delete now") the app deletes the row with the existing foreign-key behaviour. Deleting is refused
-- while a Shot, a Scene or a dialogue line still uses it. No RLS change: the owner's existing policies cover the
-- update. The app writes the column only when it is set, so code that ships before this migration keeps working
-- (Delete says the migration is needed until it is applied).

alter table characters add column if not exists trashed_at timestamptz;
alter table locations add column if not exists trashed_at timestamptz;
