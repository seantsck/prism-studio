-- 0011: a storyboard frame remembers WHICH shot parts it was approved against (not just a single hash),
-- so the UI can say "Character Look changed after approval" rather than only "stale".
alter table storyboard_frames add column approved_snapshot jsonb;
alter table storyboard_frames add constraint frames_snapshot_shape
  check (approved_snapshot is null or (jsonb_typeof(approved_snapshot) = 'object' and approved_snapshot ? 'parts'));
