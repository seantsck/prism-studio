-- 0027: allow ONLY the foreign-key action of 0026 through the review append-only guard.
--
-- generation_reviews.candidate_set_id is `on delete set null (candidate_set_id)` so deleting a candidate set keeps
-- the human reviews. That action is an UPDATE of exactly one column, which 0026's guard rejected. Fix forward
-- (0026 is applied and immutable): permit a row update whose ONLY difference is candidate_set_id → NULL; every
-- other update (any content column, or setting the link to another value) is still refused.

create or replace function guard_generation_append_only() returns trigger
language plpgsql as $$
begin
  if tg_table_name = 'generation_reviews'
     and old.candidate_set_id is not null
     and new.candidate_set_id is null
     and (to_jsonb(new) - 'candidate_set_id') = (to_jsonb(old) - 'candidate_set_id') then
    return new;
  end if;
  raise exception '% rows are append-only (history is never rewritten)', tg_table_name;
end;
$$;
