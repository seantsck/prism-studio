-- 0025: durable provider-overload retry state for continuity analysis jobs.
--
-- Provider requests are counted explicitly (a call a local guard stopped is never counted) so a per-run
-- transport ceiling can be enforced and audited, and the answers of already-completed batches are persisted so a
-- durable retry (next_run_at backoff + a later claim) resumes after them instead of re-sending anything.
-- Both columns are execution state: the worker may update them, the frozen snapshot/identity stays immutable.

alter table continuity_analysis_jobs
  add column transport_calls integer not null default 0 check (transport_calls >= 0),
  -- [{batchId, complete, findings (normalized), calls (usage only), correctionUsed, providerRef}] — no raw payloads
  add column batch_results   jsonb   not null default '[]'::jsonb;

grant update (transport_calls, batch_results) on continuity_analysis_jobs to prism_continuity_worker;
