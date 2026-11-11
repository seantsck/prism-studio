-- 0057: Story Intelligence — Storyboard Direction Proposals (Phase 5B-S5). Additive: one table, Story worker grants.
--
-- A Storyboard Direction Proposal is Prism AI's direction for ONE approved Shot (framing, lens intent, camera,
-- blocking, lighting, depth, emotional intent, continuity, storyboard description). It is DATA: the model never changes
-- a Shot. Applying writes the reviewed direction into the Shot's EXISTING composition / spatial / lighting fields (the
-- ones the I6 Production Frame package already reads); no second Shot record, no S5-only Shot columns.
-- One row per IMMUTABLE version per Shot (the same rules as 0054 / 0056):
--   * the frozen INPUT — the Shot snapshot (Characters + Looks, Location, selected Location View, adjacent Shots,
--     established screen sides), the Scene and Shot fingerprints, the creator's variant note, provider, model, schema /
--     prompt versions, estimate and spend authorization — never changes after insert;
--   * the RESULT (direction, usage, cost, error) is written ONCE, by the Story worker only;
--   * the creator changes only the REVIEW, only while `ready`; applying is `ready → applied`, once, and freezes it;
--   * regenerating or a variant is a NEW row (version + 1 per Shot, parent_id). No delete policy.
-- A proposal is STALE when the Scene text or the Shot's fingerprint changed (Apply refuses it).
-- NOT applied to hosted DEV until the owner authorizes it (like 0051–0056).

create table shot_direction_proposals (
  id                  uuid primary key,
  project_id          uuid not null references projects (id) on delete cascade,
  episode_id          uuid not null references episodes (id) on delete cascade,
  scene_id            uuid not null references scenes (id) on delete cascade,
  shot_id             uuid not null references shots (id) on delete cascade,
  version             integer not null check (version >= 1),
  parent_id           uuid references shot_direction_proposals (id),
  status              text not null check (status in ('queued', 'running', 'ready', 'failed', 'applied')),
  instruction         text not null default '' check (length(instruction) <= 2000),
  scene_fingerprint   text not null check (scene_fingerprint ~ '^[0-9a-f]{64}$'),
  shot_fingerprint    text not null check (shot_fingerprint ~ '^[0-9a-f]{64}$'),
  context             jsonb not null check (jsonb_typeof(context) = 'object'),
  provider            text not null check (length(provider) between 1 and 64),
  model               text not null check (length(model) between 1 and 96),
  schema_version      text not null,
  prompt_version      text not null,
  estimate            jsonb not null check (jsonb_typeof(estimate) = 'object'),
  confirmed_usd       numeric(12, 6) check (confirmed_usd is null or confirmed_usd >= 0),
  spend_authorization text not null check (spend_authorization in ('free', 'confirmed', 'session')),
  direction           jsonb,
  usage               jsonb,
  actual_usd          numeric(12, 6),
  provider_calls      integer not null default 0 check (provider_calls between 0 and 10),
  error               jsonb,
  review              jsonb,
  applied_summary     jsonb,
  attempts            integer not null default 0 check (attempts between 0 and 10),
  next_run_at         timestamptz not null default now(),
  lease_owner         text,
  lease_expires_at    timestamptz,
  created_by          uuid,
  created_at          timestamptz not null default now(),
  completed_at        timestamptz,
  applied_at          timestamptz,
  unique (shot_id, version),
  check (status not in ('ready', 'applied') or direction is not null),
  check (status <> 'applied' or (applied_at is not null and applied_summary is not null)),
  check ((spend_authorization = 'free') = (confirmed_usd is null))
);
create index shot_direction_proposals_shot_idx on shot_direction_proposals (shot_id, version desc);
create index shot_direction_proposals_project_idx on shot_direction_proposals (project_id);
create index shot_direction_proposals_queue_idx on shot_direction_proposals (next_run_at) where status = 'queued';

-- same-project references: the Shot is of the Scene, the Scene of the Episode, the Episode of the project
create or replace function check_shot_direction_refs() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from shots sh join scenes s on s.id = sh.scene_id join episodes e on e.id = s.episode_id
     where sh.id = new.shot_id and sh.scene_id = new.scene_id and s.episode_id = new.episode_id
       and e.project_id = new.project_id and sh.project_id = new.project_id
  ) then
    raise exception 'the Shot is not of this Scene of this project';
  end if;
  if new.parent_id is not null and not exists (
    select 1 from shot_direction_proposals p where p.id = new.parent_id and p.shot_id = new.shot_id
  ) then
    raise exception 'the revised direction is not of this Shot';
  end if;
  return new;
end;
$$;
create trigger shot_direction_proposals_refs before insert on shot_direction_proposals
  for each row execute function check_shot_direction_refs();

create or replace function guard_shot_direction_insert() returns trigger
language plpgsql as $$
begin
  if current_user <> 'prism_story_worker' and (
    new.status <> 'queued' or new.direction is not null or new.usage is not null or new.actual_usd is not null
    or new.error is not null or new.review is not null or new.applied_summary is not null or new.attempts <> 0
    or new.provider_calls <> 0 or new.lease_owner is not null or new.completed_at is not null or new.applied_at is not null
  ) then
    raise exception 'a new direction starts queued, without a result';
  end if;
  return new;
end;
$$;
create trigger shot_direction_proposals_insert_guard before insert on shot_direction_proposals
  for each row execute function guard_shot_direction_insert();

create or replace function guard_shot_direction_update() returns trigger
language plpgsql as $$
begin
  if (new.id, new.project_id, new.episode_id, new.scene_id, new.shot_id, new.version, new.parent_id, new.instruction,
      new.scene_fingerprint, new.shot_fingerprint, new.context, new.provider, new.model, new.schema_version,
      new.prompt_version, new.estimate, new.confirmed_usd, new.spend_authorization, new.created_by, new.created_at)
     is distinct from
     (old.id, old.project_id, old.episode_id, old.scene_id, old.shot_id, old.version, old.parent_id, old.instruction,
      old.scene_fingerprint, old.shot_fingerprint, old.context, old.provider, old.model, old.schema_version,
      old.prompt_version, old.estimate, old.confirmed_usd, old.spend_authorization, old.created_by, old.created_at) then
    raise exception 'a direction''s input is immutable';
  end if;
  if old.status = 'applied' then
    raise exception 'an applied direction is frozen';
  end if;
  if old.direction is not null and new.direction is distinct from old.direction then
    raise exception 'a direction is immutable once written';
  end if;
  if old.status in ('ready', 'failed') and (new.usage, new.actual_usd, new.provider_calls, new.error, new.completed_at)
     is distinct from (old.usage, old.actual_usd, old.provider_calls, old.error, old.completed_at) then
    raise exception 'a direction''s result is written once';
  end if;
  if new.status is distinct from old.status and not (
    (old.status = 'queued' and new.status in ('running', 'failed'))
    or (old.status = 'running' and new.status in ('ready', 'failed', 'queued'))
    or (old.status = 'ready' and new.status = 'applied')
  ) then
    raise exception 'invalid direction status change';
  end if;
  if new.review is distinct from old.review and old.status <> 'ready' then
    raise exception 'a direction is reviewed only while ready';
  end if;
  if current_user = 'prism_story_worker' then
    if (new.review, new.applied_summary, new.applied_at) is distinct from (old.review, old.applied_summary, old.applied_at)
       or new.status = 'applied' then
      raise exception 'the Story worker does not review or apply directions';
    end if;
  elsif (new.direction, new.usage, new.actual_usd, new.provider_calls, new.error, new.completed_at, new.attempts,
         new.next_run_at, new.lease_owner, new.lease_expires_at)
        is distinct from
        (old.direction, old.usage, old.actual_usd, old.provider_calls, old.error, old.completed_at, old.attempts,
         old.next_run_at, old.lease_owner, old.lease_expires_at)
        or (new.status is distinct from old.status and new.status <> 'applied') then
    raise exception 'only the Story worker writes a direction''s result';
  end if;
  return new;
end;
$$;
create trigger shot_direction_proposals_update_guard before update on shot_direction_proposals
  for each row execute function guard_shot_direction_update();

-- ───────────────────────── RLS: owner only; no delete ─────────────────────────
alter table shot_direction_proposals enable row level security;
create policy shot_direction_proposals_select on shot_direction_proposals for select to authenticated
  using (is_project_owner(project_id));
create policy shot_direction_proposals_insert on shot_direction_proposals for insert to authenticated
  with check (is_project_owner(project_id));
create policy shot_direction_proposals_update on shot_direction_proposals for update to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));

-- ───────────────────────── the Story worker: directions in flight, result columns only ─────────────────────────
grant select on shot_direction_proposals to prism_story_worker;
grant update (status, direction, usage, actual_usd, provider_calls, error, attempts, next_run_at, lease_owner,
              lease_expires_at, completed_at) on shot_direction_proposals to prism_story_worker;
create policy shot_direction_proposals_worker_select on shot_direction_proposals for select to prism_story_worker
  using (status in ('queued', 'running') or (lease_owner is not null and lease_expires_at > now()));
create policy shot_direction_proposals_worker_update on shot_direction_proposals for update to prism_story_worker
  using (status in ('queued', 'running') or (lease_owner is not null and lease_expires_at > now())) with check (true);
-- NOTE: no grant to prism_generation_worker or prism_continuity_worker; the Story worker still reads no Shots,
-- Scenes, Characters, Looks or Location Views (the textual snapshot is frozen on the row).
