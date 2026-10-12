# Animatic

The animatic is an episode-level, read-only playback of approved storyboard frames against the selected
performance. It is the first place where "timing originates from the performance" becomes visible.

- Model: `src/domain/animatic.ts` (`buildAnimaticTimeline`, pure).
- Player: `src/components/animatic-player.tsx` (client component), data via `components/views/animatic-view.tsx`.
- Routes: `/projects/:p/animatic`, `/projects/:p/episodes/:e/animatic`.

## Timeline model

`buildAnimaticTimeline(data, episodeId)` returns `{ clips, scenes, totalMs }`, shots in script order, laid out
back to back.

| Field (per clip)                               | Meaning                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `startMs`, `durationMs`, `durationSource`      | From `timelineFromContext`; source is `performance`, `manual`, `manual_fallback` or `unset`.                 |
| `segments`                                     | Labelled time map relative to the clip: pre-roll, dialogue, pause, reaction, manual hold.                    |
| `cues`                                         | One per dialogue segment: line id, speaker, text, take id/number, audio asset, waveform, absolute `startMs`. |
| `frame`, `frameFreshness`, `freshnessMessages` | Approved frame (or first frame); `none`/`fresh`/`stale`/`unknown` and which parts changed.                   |
| `ambience`, `musicCue`                         | Written intent only; no audio is generated or played for these.                                              |

`scenes` are contiguous groups of clips with start/end. Segment maths is documented in
[performance-workflow](performance-workflow.md). Example, shot 3A: `0.8 + 2.8 + 0.9 = 4.5 s`. A shot in manual
mode still places its selected takes inside the manual duration.

## Player

Lanes (zoomable, `minWidth: 900px × zoom`):

1. **Scene lane**: scene numbers over their span.
2. **Shot lane**: one block per shot with code and title; unapproved or stale frames are marked.
3. **Audio lane**: each selected take on the global time axis with its stored waveform; cues that failed to
   play are highlighted.

Beside the frame: the current scene and shot, a **timing breakdown** for the current shot (segment ranges with the
active one highlighted, total), ambience/music text, and freshness warnings. A "storyboard may be stale" badge
overlays the frame when `frameFreshness === "stale"`.

### Two clocks

```
audio element started and playing  →  playhead = cue.startMs + audio.currentTime
audio still buffering (< 1.5 s)    →  playhead holds (does not run ahead of the performance)
otherwise                          →  wall clock (requestAnimationFrame delta)
```

- `AUDIO_START_TIMEOUT_MS = 1500`: if a cue's audio has not reached `playing` within 1.5 s, or errors, or
  `play()` rejects, the cue is marked **failed** (degraded state), the playhead continues on the wall clock and
  the dialogue still shows as a timed subtitle. Playback never stalls on a bad file.
- Cues are started once as the playhead enters them. Seeking into the middle of a line while playing restarts
  that take at the right offset.
- Takes without an audio file (manual duration) are timed subtitles from the start.
- Audio URLs are `/api/assets/:id` ([storage](storage.md)); in supabase mode the request redirects to a signed URL.

### Keyboard

| Key                     | Action                                                          |
| ----------------------- | --------------------------------------------------------------- |
| Space                   | Play / pause (restarts from 0 at the end)                       |
| ← / →                   | Seek ∓/± 1 s (Shift: 5 s)                                       |
| `[` or `,` / `]` or `.` | Previous / next shot (previous first returns to the clip start) |
| M                       | Mute / unmute                                                   |
| Home / End              | Jump to start / end                                             |

Shortcuts are ignored while an input, textarea or select has focus and when Ctrl/Meta/Alt is held.

## Limits

- The animatic does not render motion, camera moves, ambience, foley or music; those lanes are text.
- There is no export (no EDL/XML/video); see [roadmap](roadmap.md).
- Audio drift is bounded only by the audio element's clock; there is no sample-accurate mixing.
