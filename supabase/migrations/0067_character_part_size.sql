-- 0067: how big a Character's part is in its project: a lead, a supporting role, or a minor part / extra. It decides
-- what "Fill in with Prism" writes (a lead gets every field; an extra only how they look and what must stay the same)
-- and which fields the page marks optional. One nullable column: null = not chosen (treated as a lead), so every
-- existing row stays as it is. It belongs to the project: a Character copied from the library starts without it. No
-- RLS change: the owner's existing policies on characters cover it. The app writes the column only when a size is
-- chosen, so code that ships before this migration keeps working (choosing a size then says it is not remembered yet).

alter table characters add column if not exists part_size text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'characters_part_size_check') then
    alter table characters
      add constraint characters_part_size_check check (part_size in ('lead', 'supporting', 'minor'));
  end if;
end $$;
