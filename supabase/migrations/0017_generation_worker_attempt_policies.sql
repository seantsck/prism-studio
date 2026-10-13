-- 0017: attempt visibility for the worker follows ACTIVE JOBS, not the attempt's own status.
--
-- Why: an UPDATE must leave the new row visible under the SELECT policy. With the 0015 policy
-- (status in queued/running) a worker could never move an attempt to succeeded/failed/cancelled. The worker
-- now writes the attempt BEFORE it closes the job, so "has an active job" is true for both old and new rows,
-- and a finished attempt (no active job) is out of the worker's reach.
drop policy generation_attempts_worker_select on generation_attempts;
drop policy generation_attempts_worker_update on generation_attempts;

create policy generation_attempts_worker_select on generation_attempts for select to prism_generation_worker
  using (exists (
    select 1 from generation_jobs j
    where j.attempt_id = generation_attempts.id
      and j.status in ('queued', 'submitting', 'submitted', 'processing', 'ingesting', 'cancel_requested')
  ));
create policy generation_attempts_worker_update on generation_attempts for update to prism_generation_worker
  using (exists (
    select 1 from generation_jobs j
    where j.attempt_id = generation_attempts.id
      and j.status in ('queued', 'submitting', 'submitted', 'processing', 'ingesting', 'cancel_requested')
  ))
  with check (true);
