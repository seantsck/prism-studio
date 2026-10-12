# Performance workflow

Performance is a first-class early production stage (`Perform`), not a post-production afterthought.

```
Script line ─► DialogueLine ─► PerformanceDirection ─► PerformanceTake(s) ─► canonical take ─► shot timing + animatic
```

## Records

- **DialogueLine** — character (or `speakerLabel`), original text, language, translation, pronunciation notes,
  dramatic context, subtext, `locked`.
- **PerformanceDirection** — emotion, objective, subtext, intensity 0–100, pace, volume, pauses, breaths,
  emphasis, physical behavior notes.
- **PerformanceTake** — `source_type` (`human_recording` | `generated_voice` | `temp_voice`), audio asset,
  `duration_ms`, optional waveform peaks, transcript, take number, notes, rating 0–5, `selected`.
- **VoiceProfile** — per-character voice description (provider, voice id, pitch/timbre, accent, style,
  emotional range, pronunciation rules, samples, `locked`). Data model + UI only; no provider calls.

## Workflow

1. Write or import the script (`Script`). Dialogue becomes structured lines with stable ids.
2. Open **Perform**. For each line write the direction.
3. Add takes: upload a recording (duration is measured in-browser) or log a temp/generated take by duration.
4. **Select** one canonical take. Selecting another automatically deselects the previous one.
5. **Lock** the text once approved. Script edits can no longer change it (conflicts are reported on the Script page).
6. Link lines to shots in Shot Prep → Performance, then approve the performance gate.

## Timing rules

`computeShotDuration()` (`src/domain/duration.ts`):

| Mode                                                        | Result                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `manual`                                                    | `targetDurationMs`                                                             |
| `derived_from_performance`, every line has a canonical take | `preRoll + Σ takes + (n−1)·interLineGap + postRoll`                            |
| `derived_from_performance`, a line lacks a canonical take   | manual target as **fallback**, flagged `manual_fallback`, missing lines listed |

Example (shot 3A): `0.8s pre + 2.8s 「もう帰りたい……」 + 0.9s reaction = 4.5s`.

Where the selected take surfaces: Shot Prep → Performance, Shots list (duration + `perf` tag), Storyboard
card (duration), Animatic (clip length, dialogue cue position, subtitle, audio playback), Generation package
(`performance[].selectedTake`, `references.referenceAudioAssetId`, `timing`).
