-- 0047: automatic Sequence Continuity orchestration (Phase 3A.4F).
--
--   project_qa_policies          gains its own standing authorisation for cuts: `sequence_semantic_mode` (default off, so
--                                no existing Project opts into anything) and `max_transitions_per_batch`. Independent of
--                                the Shot `semantic_mode` in both directions.
--   cut settling clocks          automatic Sequence QA waits until a cut has been quiet for 10 minutes. Settling is a
--                                safety boundary, so every mutation that can change a cut's fingerprints must move a
--                                clock. These writes moved none, and a deleted row leaves nothing to read:
--                                  delete from shot_location_view_selections          (also: a Location View deleted)
--                                  delete from shot_character_continuity_selections   (also: a Lock deleted)
--                                  delete from shot_props                             (also: a Prop deleted)
--                                  any write to character_identity_refs               (also: its Asset deleted)
--                                The triggers below cover direct writes and FK cascades alike.
--
-- A trigger only moves `updated_at` (through the existing `set_updated_at` trigger). It changes no creative state,
-- revision counter, selection or fingerprint. Consequence, intended: `shots.updated_at` is the generation submit's
-- staleness token and is part of the project revision, so clearing a selection while a generation is being prepared now
-- refuses that submission as stale; the cleared selection changes what the package would contain.
--
-- Trust model (unchanged): the signed-in application applies the policy and freezes an authorised job; the continuity
-- worker executes the frozen job and never reads this policy. No new table and no new grant. Forward-only; 0001-0046
-- untouched.

-- ───────────────────────── Project QA policy ─────────────────────────

alter table project_qa_policies
  add column sequence_semantic_mode text not null default 'off'
    check (sequence_semantic_mode in ('off', 'suggest', 'automatic')),
  add column max_transitions_per_batch integer not null default 20
    check (max_transitions_per_batch between 1 and 20),
  -- automatic Sequence QA is never implicit: an analyzer, both media permissions and two finite ceilings, all explicit
  -- (numeric 'NaN' compares as >= 0, so "finite" is stated here)
  add constraint project_qa_policies_sequence_automatic_is_explicit check (
    sequence_semantic_mode <> 'automatic'
    or (analyzer is not null and external_media_allowed and direct_video_allowed
        and max_cost_per_run_usd is not null and max_cost_per_run_usd <> 'NaN'::numeric
        and max_cost_per_day_usd is not null and max_cost_per_day_usd <> 'NaN'::numeric)
  );

-- ───────────────────────── cut settling clocks ─────────────────────────

-- Runs AFTER the delete: a cascade from the Shot itself finds no row and does nothing. It lists no location_id, so
-- `shots_location_view_selection_clear` (0040) does not fire again when that trigger's own delete arrives here.
create or replace function touch_shot_after_child_delete() returns trigger
language plpgsql as $$
begin
  update shots set updated_at = now() where id = old.shot_id;
  return null;
end;
$$;

create trigger shot_location_view_selections_touch_shot
  after delete on shot_location_view_selections
  for each row execute function touch_shot_after_child_delete();
create trigger shot_character_continuity_selections_touch_shot
  after delete on shot_character_continuity_selections
  for each row execute function touch_shot_after_child_delete();
create trigger shot_props_touch_shot
  after delete on shot_props
  for each row execute function touch_shot_after_child_delete();

create or replace function touch_character_after_identity_ref() returns trigger
language plpgsql as $$
begin
  if tg_op <> 'INSERT' then
    update characters set updated_at = now() where id = old.character_id;
  end if;
  if tg_op <> 'DELETE' then
    update characters set updated_at = now() where id = new.character_id;
  end if;
  return null;
end;
$$;

create trigger character_identity_refs_touch_character
  after insert or update or delete on character_identity_refs
  for each row execute function touch_character_after_identity_ref();
