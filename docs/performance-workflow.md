# Performance workflow

Performance is a first-class early production stage (`Perform`), not a post-production afterthought.

```
Script line ─► DialogueLine ─► PerformanceDirection ─► PerformanceTake(s) ─► canonical take ─► shot timeline ─► animatic
```

## Records

- **DialogueLine**: character (or `speakerLabel`), original text, language, translation, pronunciation notes,
  dramatic context, subtext, `locked`, source line range (`source_start_line`/`source_end_line`, migration 0008).
- **PerformanceDirection**: emotion, objective, subtext, intensity 0–100, pace, volume, pauses, breaths,
  emphasis, physical behaviour notes.
- **PerformanceTake**: `source_type` (`human_recording` | `generated_voice` | `temp_voice`), audio asset,
  `duration_ms`, `duration_source`, `waveform`, transcript, take number, notes, rating 0–5, `selected`,
  `archived`/`archived_at`.
- **VoiceProfile**: per-character voice description (data + UI only; no provider calls).

## Workflow

1. Write or import the script. Dialogue becomes structured lines with stable ids ([script-coverage](script-coverage.md)).
2. Open **Perform**; write the direction for each line.
3. Add a take: upload an audio file, **record in the browser** (MediaRecorder), or log a temp/generated take by
   typing a duration. Uploaded audio is analysed on the server: duration, sample rate, channels and waveform.
4. **Select** one canonical take per line. Selecting another deselects the previous one. The first take of a
   line is selected automatically.
5. **Archive** takes you no longer want. Archiving keeps the take and its audio, deselects it and makes it
   unselectable until restored. Takes are never deleted.
6. **Lock** line text once approved; script sync cannot change it (conflicts are reported on the Script page).
7. Link lines to shots (Shot Prep → Performance) and approve the performance gate.

## Audio analysis

Server-side, pure JS (`music-metadata` for container metadata, `audio-decode` for PCM). Server duration is
canonical; the browser's value is a hint kept in `asset.metadata.browserHintMs`. Waveform:
`{ version: 1, sampleCount, peaks: number[0..1], durationMs }`, deterministic, 500 buckets by default, stored on
`performance_takes.waveform`. Exotic codecs fall back to metadata-only (no waveform). Full details and the
ffmpeg trade-off: [asset-lifecycle](asset-lifecycle.md).

## Timing rules

Two functions share one layout and agree (a unit test asserts it):

- `buildShotTimeline` / `timelineFromContext` (`src/domain/timeline.ts`): labelled, contiguous segments.
- `computeShotDuration` (`src/domain/duration.ts`): the numeric duration and its breakdown.

| `durationMode` / state                                            | `source`          | Total                                                                    |
| ----------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------ |
| `derived_from_performance`, every linked line has a selected take | `performance`     | `preRoll + Σ takes + (n−1)·interLineGap + postRoll`                      |
| `derived_from_performance`, a line lacks a selected take          | `manual_fallback` | `targetDurationMs`; missing line ids listed; placed takes still appear   |
| `manual`                                                          | `manual`          | `targetDurationMs`; selected takes are still placed so they can be heard |
| manual and no target                                              | `unset`           | 0                                                                        |

Segment kinds: `pre_roll`, `dialogue`, `pause`, `reaction`, `manual`. Example, shot 3A:

```
0.00–0.80  Pre-roll / expression
0.80–3.60  Yumeko · selected Take 1
3.60–4.50  Reaction hold            total 4.50 s = 0.8 + 2.8 + 0.9
```

`buildSceneAudioAssembly(data, sceneId)` concatenates shot timelines into scene-level cues, adding placeholder
cues for ambience, foley and music written in each shot's Audio section.

Where the selected take surfaces: Shot Prep (Performance, Audio, timing rail), Shots list, Storyboard cards,
[Animatic](animatic.md), and the [generation package](generation-package.md)
(`performance[].selectedTake`, `timing.segments`, `references.referenceAudioAssetId`).

## Freshness

A take change (selection, duration, audio asset, checksum) changes the shot's `performance` and `timing` parts.
A frame approved before that is reported as changed, with "derived duration changed from 4.5s → 5.1s" when the
total moved. See [production-workflow](production-workflow.md).
