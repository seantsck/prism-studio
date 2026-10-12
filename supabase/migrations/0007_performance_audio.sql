-- 0007: performance audio pipeline.
--   * takes can be archived (kept for history, never selectable) instead of deleted
--   * duration provenance: server metadata wins over a browser hint
--   * waveform is a versioned object {version, sampleCount, peaks[], durationMs}; legacy arrays are wrapped

alter table performance_takes add column archived        boolean not null default false;
alter table performance_takes add column archived_at     timestamptz;
alter table performance_takes add column duration_source text not null default 'manual';

alter table performance_takes add constraint takes_duration_source_check
  check (duration_source in ('server_metadata', 'browser_hint', 'manual', 'seed'));
alter table performance_takes add constraint takes_archived_not_selected
  check (not (archived and selected));

-- Seed/demo takes carry synthetic durations, not measured ones.
update performance_takes set duration_source = 'seed';

update performance_takes
   set waveform = jsonb_build_object(
         'version', 1,
         'sampleCount', jsonb_array_length(waveform),
         'peaks', waveform,
         'durationMs', duration_ms)
 where waveform is not null and jsonb_typeof(waveform) = 'array';

alter table performance_takes add constraint takes_waveform_shape
  check (waveform is null or (jsonb_typeof(waveform) = 'object' and waveform ? 'peaks' and waveform ? 'version'));
