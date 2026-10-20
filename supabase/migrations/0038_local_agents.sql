-- 0038: Phase 2F M2D.3C1 remote Local Agent IDENTITY: a user's workstation paired to ONE Prism project.
--
--   local_agent_pairings  a one-time pairing offer created by the project owner. Only a SHA-256 digest of the
--                         high-entropy pairing secret is stored (never the secret itself). ~10 minutes to live,
--                         single use: consumed (a device was created) or cancelled (the owner made a newer one).
--   local_agents          a paired device: an opaque id, the project it is bound to, its Ed25519 PUBLIC key (SPKI DER,
--                         base64) and fingerprint, safe self-reported metadata, the last accepted request counter
--                         (anti-replay), last-seen time and safe capability facts. Revocation is terminal history;
--                         there is no delete (a device may later be named in job provenance).
--
-- Authority. The workstation NEVER connects to the database: it talks only to Prism's HTTPS agent endpoints, and the
-- Prism SERVER runs a few fixed statements for pairing redemption and request authentication. So there is
-- deliberately NO anon policy and no policy that lets a device authenticate itself. The project owner (RLS,
-- is_project_owner) may create/cancel pairings, list the project's devices, rename and revoke them; column grants
-- keep every other column (key, counter, capabilities) server-written. No worker or service role gets a grant.
-- Forward-only; 0001-0037 untouched.

-- ───────────────────────── pairing offers ─────────────────────────

create table local_agent_pairings (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects (id) on delete cascade,
  created_by    uuid not null,
  -- sha256 hex of the domain-separated canonical secret (docs/local-agent-protocol.md); the secret is never stored
  secret_hash   text not null unique check (secret_hash ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  consumed_at   timestamptz,
  cancelled_at  timestamptz,
  unique (id, project_id),
  check (expires_at > created_at and expires_at <= created_at + interval '15 minutes'),
  check (consumed_at is null or cancelled_at is null)
);
create index local_agent_pairings_project_idx on local_agent_pairings (project_id, created_at desc);

-- A pairing offer made through the owner's session always gets the server clock and the standard 10-minute life.
create or replace function local_agent_pairing_insert() returns trigger
language plpgsql as $$
begin
  if current_user = 'authenticated' then
    new.created_at := now();
    new.expires_at := now() + interval '10 minutes';
  end if;
  new.consumed_at := null;
  new.cancelled_at := null;
  return new;
end;
$$;
create trigger local_agent_pairings_insert before insert on local_agent_pairings
  for each row execute function local_agent_pairing_insert();

-- Single use: an offer is consumed or cancelled exactly once and then never changes again.
create or replace function guard_local_agent_pairing() returns trigger
language plpgsql as $$
begin
  if old.consumed_at is not null or old.cancelled_at is not null then
    raise exception 'a used or cancelled local agent pairing is immutable';
  end if;
  if new.id is distinct from old.id or new.project_id is distinct from old.project_id
     or new.created_by is distinct from old.created_by or new.secret_hash is distinct from old.secret_hash
     or new.created_at is distinct from old.created_at or new.expires_at is distinct from old.expires_at then
    raise exception 'a local agent pairing offer is frozen at creation';
  end if;
  return new;
end;
$$;
create trigger local_agent_pairings_guard before update on local_agent_pairings
  for each row execute function guard_local_agent_pairing();

-- ───────────────────────── paired devices ─────────────────────────

create table local_agents (
  id                      uuid primary key default gen_random_uuid(),
  project_id              uuid not null references projects (id) on delete cascade,
  created_by              uuid not null,
  pairing_id              uuid not null unique,
  schema_version          text not null check (schema_version = 'prism.local-agent.v1'),
  protocol_version        integer not null check (protocol_version between 1 and 1000),
  label                   text not null check (char_length(label) between 1 and 64 and label !~ '[[:cntrl:]]'),
  platform                text not null check (platform in ('win32', 'linux', 'darwin')),
  arch                    text not null check (arch ~ '^[a-z0-9_]{1,16}$'),
  agent_version           text not null check (agent_version ~ '^[0-9A-Za-z.+_-]{1,40}$'),
  -- Ed25519 SubjectPublicKeyInfo DER (44 bytes), standard base64
  public_key              text not null check (public_key ~ '^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$'),
  -- sha256 hex of the DER bytes; unique: a key is never reused by a second device (re-pairing = a new key)
  public_key_fingerprint  text not null unique check (public_key_fingerprint ~ '^[0-9a-f]{64}$'),
  status                  text not null default 'active' check (status in ('active', 'revoked')),
  revoked_at              timestamptz,
  revoked_by              uuid,
  -- the highest request counter accepted; the next request must carry a strictly greater one
  last_counter            bigint not null default 0 check (last_counter >= 0 and last_counter <= 9007199254740991),
  last_seen_at            timestamptz,
  capabilities_json       jsonb check (capabilities_json is null or
                                       (jsonb_typeof(capabilities_json) = 'object'
                                        and octet_length(capabilities_json::text) <= 4096)),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (id, project_id),
  foreign key (pairing_id, project_id) references local_agent_pairings (id, project_id),
  check ((status = 'revoked') = (revoked_at is not null))
);
create index local_agents_project_idx on local_agents (project_id, created_at desc);

-- A device exists only because its project's owner's pairing offer was consumed for it, and starts clean.
create or replace function local_agent_insert() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from local_agent_pairings p
    where p.id = new.pairing_id and p.project_id = new.project_id and p.created_by = new.created_by
      and p.consumed_at is not null
  ) then
    raise exception 'a local agent is created only by consuming its project''s pairing offer';
  end if;
  new.status := 'active';
  new.revoked_at := null;
  new.revoked_by := null;
  new.last_counter := 0;
  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;
create trigger local_agents_insert before insert on local_agents
  for each row execute function local_agent_insert();

-- Identity is frozen, the counter only moves forward, and revocation is terminal (never silently reactivated).
create or replace function guard_local_agent() returns trigger
language plpgsql as $$
begin
  if old.status = 'revoked' then
    raise exception 'a revoked local agent is immutable history (re-pairing creates a new device)';
  end if;
  if new.id is distinct from old.id or new.project_id is distinct from old.project_id
     or new.created_by is distinct from old.created_by or new.pairing_id is distinct from old.pairing_id
     or new.schema_version is distinct from old.schema_version or new.public_key is distinct from old.public_key
     or new.public_key_fingerprint is distinct from old.public_key_fingerprint
     or new.platform is distinct from old.platform or new.arch is distinct from old.arch
     or new.created_at is distinct from old.created_at then
    raise exception 'a local agent''s identity is frozen at pairing';
  end if;
  if new.last_counter < old.last_counter then
    raise exception 'a local agent request counter never moves backwards';
  end if;
  if new.status = 'revoked' then
    new.revoked_at := now();
    new.revoked_by := coalesce(auth.uid(), new.revoked_by);
  elsif new.revoked_at is not null or new.revoked_by is not null then
    raise exception 'revocation is recorded only by revoking';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger local_agents_guard before update on local_agents
  for each row execute function guard_local_agent();

-- ───────────────────────── RLS + grants: the project owner, through Prism, only ─────────────────────────

alter table local_agent_pairings enable row level security;
create policy local_agent_pairings_owner_select on local_agent_pairings for select to authenticated
  using (is_project_owner(project_id));
create policy local_agent_pairings_owner_insert on local_agent_pairings for insert to authenticated
  with check (is_project_owner(project_id) and created_by = auth.uid());
create policy local_agent_pairings_owner_cancel on local_agent_pairings for update to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));

alter table local_agents enable row level security;
create policy local_agents_owner_select on local_agents for select to authenticated
  using (is_project_owner(project_id));
create policy local_agents_owner_update on local_agents for update to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));

-- Start from nothing (Supabase's default privileges would otherwise grant everything), then grant exactly what the
-- owner's session uses. The secret digest is never readable by a session; no session may insert a device, write a
-- key, a counter or capabilities, or delete history.
revoke all on local_agent_pairings from public, anon, authenticated, service_role;
revoke all on local_agents from public, anon, authenticated, service_role;
grant select (id, project_id, created_by, created_at, expires_at, consumed_at, cancelled_at)
  on local_agent_pairings to authenticated;
grant insert (project_id, created_by, secret_hash) on local_agent_pairings to authenticated;
grant update (cancelled_at) on local_agent_pairings to authenticated;
grant select on local_agents to authenticated;
grant update (label, status) on local_agents to authenticated;

-- NOTE: no GRANT to prism_generation_worker or prism_continuity_worker; db:local-agents asserts they have none.
