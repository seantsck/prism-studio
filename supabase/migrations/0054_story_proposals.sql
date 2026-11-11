-- 0054: Story Intelligence — Production Proposals (Phase 5B-S1). Additive: one table, one least-privilege worker role.
--
-- A Production Proposal is what Prism Story Intelligence proposes from a screenplay / treatment / outline. It is DATA:
-- the model never writes Characters, Locations, Scenes or Shots. One row per IMMUTABLE proposal version:
--   * the frozen INPUT (source kind, source Asset or Episode, source fingerprint, the exact analysed text, the provider,
--     model, schema / prompt versions, the estimate and the creator's cost confirmation) never changes after insert;
--   * the RESULT (proposal, usage, cost, error) is written ONCE, by the Story worker only;
--   * the creator changes only the REVIEW, only while the proposal is `ready`; applying is `ready → applied`, once, and
--     freezes the review;
--   * a revision is a NEW row (version + 1, parent_id): nothing is rewritten in place. No delete policy: history stays.
-- The original uploaded file is an ordinary immutable project Asset referenced by source_asset_id.
-- NOT applied to hosted DEV until the owner authorizes it (like 0051–0053).

create table story_proposals (
  id                 uuid primary key,
  project_id         uuid not null references projects (id) on delete cascade,
  version            integer not null check (version >= 1),
  parent_id          uuid references story_proposals (id),
  status             text not null check (status in ('queued', 'running', 'ready', 'failed', 'applied')),
  scope              jsonb not null check (jsonb_typeof(scope) = 'object' and scope ->> 'kind' in ('full', 'section')),
  source_kind        text not null check (source_kind in ('paste', 'upload', 'episode_script')),
  source_asset_id    uuid references assets (id),
  source_episode_id  uuid references episodes (id) on delete set null,
  source_fingerprint text not null check (source_fingerprint ~ '^[0-9a-f]{64}$'),
  source_meta        jsonb not null check (jsonb_typeof(source_meta) = 'object'),
  input_text         text not null check (length(input_text) between 1 and 1500000),
  title              text,
  base_proposal      jsonb,
  provider           text not null check (length(provider) between 1 and 64),
  model              text not null check (length(model) between 1 and 96),
  schema_version     text not null,
  prompt_version     text not null,
  estimate           jsonb not null check (jsonb_typeof(estimate) = 'object'),
  confirmed_usd      numeric(12, 6) check (confirmed_usd is null or confirmed_usd >= 0),
  proposal           jsonb,
  usage              jsonb,
  actual_usd         numeric(12, 6),
  provider_calls     integer not null default 0 check (provider_calls between 0 and 10),
  error              jsonb,
  review             jsonb,
  applied_summary    jsonb,
  attempts           integer not null default 0 check (attempts between 0 and 10),
  next_run_at        timestamptz not null default now(),
  lease_owner        text,
  lease_expires_at   timestamptz,
  created_by         uuid,
  created_at         timestamptz not null default now(),
  completed_at       timestamptz,
  applied_at         timestamptz,
  unique (project_id, version),
  check (source_kind <> 'upload' or source_asset_id is not null),
  check ((scope ->> 'kind' = 'section') = (base_proposal is not null and parent_id is not null)),
  check (status not in ('ready', 'applied') or proposal is not null),
  check (status <> 'applied' or (applied_at is not null and applied_summary is not null))
);
create index story_proposals_project_idx on story_proposals (project_id, version desc);
create index story_proposals_queue_idx on story_proposals (next_run_at) where status = 'queued';
create index story_proposals_asset_idx on story_proposals (source_asset_id) where source_asset_id is not null;

-- same-project references: the source Asset, the source Episode and the revised proposal are this project's own
create or replace function check_story_proposal_refs() returns trigger
language plpgsql as $$
begin
  if new.source_asset_id is not null and not exists (
    select 1 from assets a where a.id = new.source_asset_id and a.project_id = new.project_id and a.type = 'document'
  ) then
    raise exception 'the story source must be a document of this project';
  end if;
  if new.source_episode_id is not null and not exists (
    select 1 from episodes e where e.id = new.source_episode_id and e.project_id = new.project_id
  ) then
    raise exception 'the story source Episode is not in this project';
  end if;
  if new.parent_id is not null and not exists (
    select 1 from story_proposals p where p.id = new.parent_id and p.project_id = new.project_id
  ) then
    raise exception 'the revised proposal is not in this project';
  end if;
  return new;
end;
$$;
create trigger story_proposals_refs before insert on story_proposals
  for each row execute function check_story_proposal_refs();

-- a user inserts only a fresh, queued proposal (never a result)
create or replace function guard_story_proposal_insert() returns trigger
language plpgsql as $$
begin
  if current_user <> 'prism_story_worker' and (
    new.status <> 'queued' or new.proposal is not null or new.usage is not null or new.actual_usd is not null
    or new.error is not null or new.review is not null or new.applied_summary is not null or new.attempts <> 0
    or new.provider_calls <> 0 or new.lease_owner is not null or new.completed_at is not null or new.applied_at is not null
  ) then
    raise exception 'a new proposal starts queued, without a result';
  end if;
  return new;
end;
$$;
create trigger story_proposals_insert_guard before insert on story_proposals
  for each row execute function guard_story_proposal_insert();

-- immutability: frozen input; the result written once by the worker; the review only while ready; applied once
create or replace function guard_story_proposal_update() returns trigger
language plpgsql as $$
begin
  if (new.id, new.project_id, new.version, new.parent_id, new.scope, new.source_kind, new.source_asset_id,
      new.source_fingerprint, new.source_meta, new.input_text, new.title, new.base_proposal, new.provider,
      new.model, new.schema_version, new.prompt_version, new.estimate, new.confirmed_usd, new.created_by,
      new.created_at)
     is distinct from
     (old.id, old.project_id, old.version, old.parent_id, old.scope, old.source_kind, old.source_asset_id,
      old.source_fingerprint, old.source_meta, old.input_text, old.title, old.base_proposal, old.provider,
      old.model, old.schema_version, old.prompt_version, old.estimate, old.confirmed_usd, old.created_by,
      old.created_at) then
    raise exception 'a proposal''s input is immutable';
  end if;
  if old.status = 'applied' then
    raise exception 'an applied proposal is frozen';
  end if;
  if old.proposal is not null and new.proposal is distinct from old.proposal then
    raise exception 'a proposal is immutable once written';
  end if;
  if old.status in ('ready', 'failed') and (new.usage, new.actual_usd, new.provider_calls, new.error, new.completed_at)
     is distinct from (old.usage, old.actual_usd, old.provider_calls, old.error, old.completed_at) then
    raise exception 'a proposal''s result is written once';
  end if;
  if old.status = 'failed' and new.status <> 'failed' then
    raise exception 'a failed proposal stays failed (start a new analysis)';
  end if;
  if new.status is distinct from old.status and not (
    (old.status = 'queued' and new.status in ('running', 'failed'))
    or (old.status = 'running' and new.status in ('ready', 'failed', 'queued'))
    or (old.status = 'ready' and new.status = 'applied')
  ) then
    raise exception 'invalid proposal status change';
  end if;
  if new.review is distinct from old.review and old.status <> 'ready' then
    raise exception 'a proposal is reviewed only while ready';
  end if;
  if current_user = 'prism_story_worker' then
    if (new.review, new.applied_summary, new.applied_at) is distinct from (old.review, old.applied_summary, old.applied_at)
       or new.status = 'applied' then
      raise exception 'the Story worker does not review or apply proposals';
    end if;
  elsif (new.proposal, new.usage, new.actual_usd, new.provider_calls, new.error, new.completed_at, new.attempts,
         new.next_run_at, new.lease_owner, new.lease_expires_at)
        is distinct from
        (old.proposal, old.usage, old.actual_usd, old.provider_calls, old.error, old.completed_at, old.attempts,
         old.next_run_at, old.lease_owner, old.lease_expires_at)
        or (new.status is distinct from old.status and new.status <> 'applied') then
    raise exception 'only the Story worker writes a proposal''s result';
  end if;
  return new;
end;
$$;
create trigger story_proposals_update_guard before update on story_proposals
  for each row execute function guard_story_proposal_update();

-- ───────────────────────── RLS: owner only; no delete ─────────────────────────
alter table story_proposals enable row level security;
create policy story_proposals_select on story_proposals for select to authenticated
  using (is_project_owner(project_id));
create policy story_proposals_insert on story_proposals for insert to authenticated
  with check (is_project_owner(project_id));
create policy story_proposals_update on story_proposals for update to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));

-- ───────────────────────── the Story worker: claim and write results, nothing else ─────────────────────────
-- Created NOLOGIN without a password (no secret in a migration); provisioned out of band like the other workers. It
-- reads only proposals in flight and no project content at all (no Characters, Locations, scripts or assets).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'prism_story_worker') then
    create role prism_story_worker nologin noinherit;
  end if;
end $$;
alter role prism_story_worker set statement_timeout = '60s';
alter role prism_story_worker set idle_in_transaction_session_timeout = '120s';
alter role prism_story_worker set search_path = public, pg_temp;
revoke all on all tables in schema public from prism_story_worker;
revoke all on all sequences in schema public from prism_story_worker;
revoke create on schema public from prism_story_worker;
grant usage on schema public to prism_story_worker;
grant select on story_proposals to prism_story_worker;
grant update (status, proposal, usage, actual_usd, provider_calls, error, attempts, next_run_at, lease_owner,
              lease_expires_at, completed_at) on story_proposals to prism_story_worker;
-- Visibility follows ACTIVE WORK (like 0017 for attempts): an UPDATE must leave the new row visible under the SELECT
-- policy, so the worker sees a proposal while it is queued / running, or while its lease is still valid (the result is
-- written under the lease, which is kept). Once the lease expires a finished proposal is out of the worker's reach.
create policy story_proposals_worker_select on story_proposals for select to prism_story_worker
  using (status in ('queued', 'running') or (lease_owner is not null and lease_expires_at > now()));
create policy story_proposals_worker_update on story_proposals for update to prism_story_worker
  using (status in ('queued', 'running') or (lease_owner is not null and lease_expires_at > now())) with check (true);
-- NOTE: no grant on story_proposals to prism_generation_worker or prism_continuity_worker.
