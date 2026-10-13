-- 0016: let the worker read back the generated assets of a job that is currently ingesting.
--
-- Why: (1) INSERT ... ON CONFLICT is evaluated against SELECT policies, so an insert-only grant is not enough;
--      (2) crash-safe ingestion looks up an already-uploaded output (deterministic id) before re-uploading.
-- Scope stays narrow: only `generation_output` assets of a project that has a job in `ingesting`.
create policy assets_worker_select_outputs on assets for select to prism_generation_worker
  using (
    purpose = 'generation_output'
    and exists (
      select 1 from generation_jobs j
      where j.project_id = assets.project_id and j.status = 'ingesting'
    )
  );
