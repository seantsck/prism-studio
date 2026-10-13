// Single source of truth for what the generation worker's database role may do (migration 0015).
// Used by `npm run worker:db:check` and `npm run db:worker-role` so the tests cannot drift from the grants.
export const WORKER_ROLE = "prism_generation_worker";

const ALL = "*";

/**
 * Expected column-level privileges per table. "*" = every column.
 * Any privilege on any other relation, and DELETE/TRUNCATE/TRIGGER/REFERENCES anywhere, is a violation.
 */
export const EXPECTED = {
  "public.generation_jobs": {
    select: ALL,
    insert: [],
    update: [
      "status",
      "provider_job_id",
      "provider_status",
      "next_run_at",
      "attempt_count",
      "poll_count",
      "submitted_at",
      "started_at",
      "completed_at",
      "failed_at",
      "cancelled_at",
      "cancel_outcome",
      "lease_owner",
      "lease_token",
      "lease_expires_at",
      "heartbeat_at",
      "last_polled_at",
      "last_error_code",
      "last_error_category",
      "last_error_message",
      "actual_cost",
    ],
  },
  "public.generation_attempts": {
    select: ALL,
    insert: [],
    update: ["status", "output_asset_id", "duration_ms", "cost_usd"],
  },
  "public.projects": { select: ["id", "user_id"], insert: [], update: [] },
  "public.assets": {
    select: [
      "id",
      "project_id",
      "type",
      "mime",
      "bucket",
      "object_path",
      "byte_size",
      "checksum",
      "storage_provider",
      "purpose",
    ],
    insert: ALL,
    update: [],
  },
  "public.generation_outputs": { select: [], insert: ALL, update: [] },
  "public.generation_costs": { select: [], insert: ALL, update: [] },
  "public.generation_job_events": { select: [], insert: ALL, update: [] },
};

/** Tables the worker must never be able to read or write (creative content, auth, ledger). */
export const FORBIDDEN_TABLES = [
  "public.characters",
  "public.character_looks",
  "public.character_identity_refs",
  "public.voice_profiles",
  "public.dialogue_lines",
  "public.action_blocks",
  "public.shots",
  "public.scenes",
  "public.episodes",
  "public.project_bibles",
  "public.locations",
  "public.props",
  "public.performance_takes",
  "public.performance_directions",
  "public.storyboard_frames",
  "auth.users",
  "storage.objects",
];
