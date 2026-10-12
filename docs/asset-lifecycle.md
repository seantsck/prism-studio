# Asset lifecycle

## Record (migration 0006)

An `assets` row carries: `purpose`, `storage_provider` (`none` | `local` | `supabase`), `bucket`, `object_path`,
`original_filename`, `byte_size`, `checksum` (SHA-256), `width`/`height`, `duration_ms`, `frame_rate`,
`sample_rate`, `channels`, `tags`, `notes`, `created_by`, `created_at`, `updated_at` (plus `type`, `mime`,
`source`, `name`, free-form `metadata` JSONB). A check constraint requires `bucket` and `object_path` when
`storage_provider = 'supabase'`.

`purpose` is one of: `identity_ref`, `look_ref`, `location_ref`, `prop_ref`, `storyboard`, `performance_audio`,
`reference_audio`, `generation_input`, `generation_output`, `video_reference`, `document`, `waveform`,
`model_3d`, `other`.

## Stages

```
choose file ─► validate (policy) ─► inspect (server) ─► store bytes ─► insert row ─► use ─► where-used ─► delete (if unreferenced)
```

| Stage    | What happens                                                                                                                                                                                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Validate | `checkUpload`: block-list, magic bytes, kind, size, MIME-family spoof check. See [storage](storage.md).                                                                                                                                                                                          |
| Inspect  | Audio: `analyzeAudio` (below). Images: `readImageSize` reads width/height from the bytes. Always: byte size and SHA-256.                                                                                                                                                                         |
| Store    | Object key `<project>/<asset>/<filename>` via the current `StorageProvider`.                                                                                                                                                                                                                     |
| Persist  | `repo.upsert("assets", …)` (RLS-bound). On failure the stored object is removed.                                                                                                                                                                                                                 |
| Browse   | Asset library (`/projects/:p/assets`): filters (all, image, audio, video, storyboard, character, look, location, generation input/output) and text search over name, filename, tags, purpose, notes and where-used labels (character, scene, shot, location) from `src/domain/asset-library.ts`. |
| Edit     | `updateAsset` changes name, purpose, notes, tags only; bytes and checksum are immutable.                                                                                                                                                                                                         |
| Delete   | Refused while referenced. See below.                                                                                                                                                                                                                                                             |

## Where-used and deletion protection (`src/domain/asset-usage.ts`)

`findAssetUsage(data, assetId)` scans explicit references and returns `direct` usages, the `shots` affected
(directly, or because they use the character / Look / location / prop that owns the asset), `inUse` and a summary.

Usage kinds: `identity_ref`, `look_ref`, `location_ref`, `prop_ref`, `voice_sample`, `shot_reference`,
`shot_start_frame`, `shot_end_frame`, `shot_reference_video`, `shot_reference_audio`,
`shot_lighting_reference`, `performance_take`, `storyboard_frame`, `attempt_input`, `attempt_output`,
`set3d_model`.

`deleteAsset` throws a `UserFacingError` naming up to three usages when `inUse`; nothing is silently orphaned.
Archived takes still count as a usage of their audio asset, so a take's audio cannot be deleted from the library
while the take exists.

## Audio pipeline (`src/lib/audio-analysis.ts`)

```
bytes ─► music-metadata.parseBuffer   → duration, sample rate, channels, codec, container, bitrate
      └► audio-decode                 → PCM channels ─► domain/waveform.computePeaks ─► {version:1, sampleCount, peaks[0..1], durationMs}
```

- **Server duration is canonical.** The browser's measured length is posted as `durationHintSec`, stored in
  `asset.metadata.browserHintMs`, and used only as a provisional display value while uploading.
- `take.durationSource`: `server_metadata` (uploaded file), `manual` (no file; user typed a duration), `seed`
  (demo data). The DB check also allows `browser_hint`, which the current actions never write.
- Duration comes from metadata when present, otherwise from decoded samples; no playable audio → a
  user-facing error and no take is created.
- Waveform: deterministic (`computePeaks`), 500 buckets by default (fewer for very short audio), max absolute
  amplitude across channels per bucket, normalised so the loudest bucket is 1. Stored on
  `performance_takes.waveform` (JSONB). If decoding fails the take is created with duration but no waveform and
  `metadata.waveformStatus = "unavailable"`.
- Asset `metadata` records `codec`, `container`, `bitrate`, `durationFrom`, `waveformStatus`.

### Trade-off: pure JavaScript instead of ffmpeg

| Pure JS (`music-metadata` + `audio-decode`, chosen)                    | ffmpeg                                                   |
| ---------------------------------------------------------------------- | -------------------------------------------------------- |
| No native binary; runs unchanged on serverless hosts and in tests      | Broad codec coverage, robust with damaged files          |
| Deterministic output in CI; small dependency surface                   | Needs a binary on the host; version drift changes output |
| Whole file is decoded in memory (50 MB upload cap bounds this)         | Streaming decode, lower peak memory                      |
| Exotic codecs outside `audio-decode`'s list fall back to metadata-only | Almost anything decodes                                  |

The packages are listed in `serverExternalPackages` in `next.config.ts` so the bundler does not try to resolve
their optional codec modules.

## Recording in the browser

`components/audio-file-input.tsx` offers "choose a file" or record with `MediaRecorder` (microphone permission
is allowed for this origin by `Permissions-Policy: microphone=(self)`). Recorded audio is an ordinary upload:
same policy, same server analysis.

## Takes and archiving

Takes are never deleted. `setTakeArchived` archives (and deselects) a take; an archived take cannot be selected
(action error plus DB check `takes_archived_not_selected`). The first non-archived take of a line becomes
selected by default; at most one take per line is selected (`takes_one_selected_per_line`).
See [performance-workflow](performance-workflow.md).
