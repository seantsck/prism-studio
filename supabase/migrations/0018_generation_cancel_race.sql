-- 0018: a cancellation that loses the race against provider completion must not discard the paid output.
-- Adds cancel_requested -> ingesting to the job state machine (mirrors src/domain/generation/job-state.ts).
create or replace function guard_generation_job() returns trigger
language plpgsql as $$
begin
  if new.project_id is distinct from old.project_id
     or new.attempt_id is distinct from old.attempt_id
     or new.provider is distinct from old.provider
     or new.model is distinct from old.model
     or new.idempotency_key is distinct from old.idempotency_key then
    raise exception 'generation job % identity columns are immutable', old.id;
  end if;

  if new.status is distinct from old.status then
    if not (
      (old.status = 'queued' and new.status in ('submitting', 'cancelled', 'cancel_requested', 'failed'))
      or (old.status = 'submitting' and new.status in
          ('submitted', 'processing', 'ingesting', 'queued', 'failed', 'cancel_requested', 'cancelled'))
      or (old.status = 'submitted' and new.status in ('processing', 'ingesting', 'failed', 'cancel_requested'))
      or (old.status = 'processing' and new.status in ('ingesting', 'failed', 'cancel_requested'))
      or (old.status = 'ingesting' and new.status in ('succeeded', 'failed', 'cancel_requested'))
      or (old.status = 'cancel_requested' and new.status in ('cancelled', 'failed', 'ingesting'))
    ) then
      raise exception 'illegal generation job transition: % -> %', old.status, new.status
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
