-- 0068: remember which Character a merged Character was merged into. A merge moves reference pointers, Looks and
-- voices, but a generation record never changes hands (generation_attempts is append-only), so the merged Character's
-- pictures stayed listed under it, in the Trash, and vanished from the kept Character's page once its reference set
-- stopped pointing at them. With this column the kept Character shows them too, until they are archived or deleted.
--
-- One nullable column: null = never merged (every existing row stays as it is). Set by "Merge into…" when it sends the
-- merged Character to the Trash; cleared when that Character is restored. ON DELETE SET NULL: deleting the kept
-- Character for good leaves the merged one as a plain trashed Character. No RLS change: the owner's existing policies
-- on characters cover it. The app writes the column only when a merge or restore sets it, so code that ships before
-- this migration keeps working (a merge then still works; its pictures just are not linked yet).
--
-- One-time backfill for merges made before this column existed: a trashed Character is linked to the live Character
-- of the same name in the same project when exactly one such Character exists AND the trashed one has generated
-- pictures (the only thing the link shows). Nothing else changes.

alter table characters
  add column if not exists merged_into_id uuid references characters (id) on delete set null;

update characters t
set merged_into_id = (
  select l.id
  from characters l
  where l.project_id = t.project_id
    and l.trashed_at is null
    and lower(trim(l.name)) = lower(trim(t.name))
)
where t.trashed_at is not null
  and t.merged_into_id is null
  and exists (select 1 from generation_attempts g where g.character_id = t.id)
  and (
    select count(*)
    from characters l
    where l.project_id = t.project_id
      and l.trashed_at is null
      and lower(trim(l.name)) = lower(trim(t.name))
  ) = 1;
