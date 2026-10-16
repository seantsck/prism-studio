-- 0032: Phase 2F M2A.1 performance-audio provenance for local previs.
--
-- A previs can now carry the Shot's selected performance audio (several dialogue takes mixed onto the Shot
-- timeline). 0031 modelled audio as ONE asset (`audio_asset_id`), which would misrepresent a mix of several takes
-- as a single source. This migration records the mix truthfully and by value:
--
--   audio_mix_json         prism.previs-audio-mix.v1: sample rate, channels, codec, durations and every cue
--                          (asset id + checksum, timeline start, source start, length). Ids and checksums only:
--                          never a URL, a signed URL or a blob URL.
--   audio_mix_fingerprint  deterministic identity of what the mix contains, used for staleness
--
-- `has_audio` is kept and now means "audio_mix_json is present". `audio_asset_id` is left in place for history but
-- stays null: a mix is not one asset. Forward-only; 0019-0031 untouched. Owner-only RLS from 0031 still applies and
-- no worker grants are added.

alter table shot_previs_clips add column audio_mix_json jsonb;
alter table shot_previs_clips add column audio_mix_fingerprint text;

-- 0031's unnamed check tied has_audio to audio_asset_id; replace it (found by definition, not by generated name)
do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'shot_previs_clips'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%audio_asset_id IS NOT NULL%'
  loop
    execute format('alter table shot_previs_clips drop constraint %I', c);
  end loop;
end;
$$;

alter table shot_previs_clips add constraint shot_previs_clips_audio_mix_check check (
  has_audio = (audio_mix_json is not null)
  and has_audio = (audio_mix_fingerprint is not null)
  and (audio_mix_fingerprint is null or char_length(audio_mix_fingerprint) = 64)
  and (audio_mix_json is null or audio_mix_json ->> 'schema' = 'prism.previs-audio-mix.v1')
  -- a mix of several takes is not one source asset
  and audio_asset_id is null
);
