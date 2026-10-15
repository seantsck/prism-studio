# Media processing (Phase 2C)

Deterministic, bounded post-generation media operations behind a provider-neutral interface. No business or
domain code builds ffmpeg command lines.

## Interface (`src/media/types.ts`)

```ts
interface MediaProcessor {
  identity()  available()  probe(bytes)
  extractFrame(bytes, atMs)  extractFrames(bytes, atMs[])
  cropVideo  trimVideo  scaleVideo  conform(bytes, {crop, pad, trimMs})
  generateThumbnail  generateContactSheet(frames)
}
```

Everything is bytes-in / bytes-out: callers never choose a filesystem location. `conform` applies crop + pad +
trim in **one** re-encode (one generation of quality loss).

## FFmpeg implementation (`src/media/ffmpeg.ts`)

The first implementation shells out to `ffmpeg` / `ffprobe` found on `PATH` (override with
`PRISM_STUDIO_FFMPEG_PATH` / `PRISM_STUDIO_FFPROBE_PATH`). **ffmpeg is a runtime dependency of the app server
for delivery conform and review frames** (not of the generation worker). Availability is detected
(`available()`); when absent the UI says so and every non-media feature keeps working.

Output profile: H.264/AAC MP4 (`libx264`, yuv420p, CRF 18, faststart) when libx264 exists, otherwise VP9/Opus
WebM. Bit-exact flags and stripped metadata make the same input + parameters produce the same bytes.

### Safety (media files are untrusted input)

- **No shell, no string concatenation.** Arguments are an array given to `execFile`. The only strings placed on
  a command line are numbers formatted by the adapter and file names it generated inside a private temp
  directory (`mkdtemp`, removed in `finally`).
- **Container allow-list by magic bytes**, then forced with `-f`: ffmpeg never auto-detects text-based demuxers
  (HLS playlists, concat scripts, SDP) that can reference other files; `-protocol_whitelist file` blocks network
  protocols. Supported: MP4/MOV, WebM/Matroska, PNG, JPEG, WebP.
- **Limits:** input 256 MB, output 512 MB (`-fs`), 8192×4608 px, 10 min duration, 120 s wall-clock timeout per
  invocation (`SIGKILL`), ≤ 64 frames per extraction, ≤ 36 contact-sheet cells.
- **Parameter validation:** crop rectangles must be integer and inside the picture; scale sizes even and bounded.
- **Minimal environment** is passed to the tool (no credentials). Tool stderr is truncated and path-scrubbed.
- Errors are typed (`MediaError`: `unavailable`, `unsupported_media`, `too_large`, `too_long`, `timeout`,
  `process_failed`, `invalid_parameters`) and surfaced as plain sentences.

### Probed metadata

container, video/audio codec, width, height, fps, duration, audio presence/channels/sample rate, bit rate, size.
Stored on the derived Asset's existing columns (`width`, `height`, `duration_ms`, `frame_rate`, `sample_rate`,
`channels`, `mime`, `byte_size`, `checksum`); no duplicate fields.

## Where it runs

In the **app server, under the signed-in user's own session**: it reads the original from private Storage,
writes new derived objects and rows through the RLS-bound repositories. The generation worker is untouched, so
**no worker privilege was added** (migrations 0019–0021 grant it nothing; `db:media-qa` proves the worker role
cannot read the new tables). Conform is synchronous: operations are bounded (limits above) and short.
If conform ever needs to move off the request path, a separate least-privilege "media" role would be the right
shape; it is deliberately not built yet.

## Idempotency and crash safety

Every derived file has a deterministic identity:

```
derivation_key = sha256( parent checksum | operation | normalized parameters | adapter name+version )
asset id       = uuid-v5-style( derivation_key )          object path = <project>/<asset id>/<sanitised name>
```

1. If a derivation with that key exists, it is returned (no work, no duplicate).
2. Otherwise the file is produced, the object is uploaded **unless identical bytes are already there**, and the
   asset + lineage row are inserted in one transaction, idempotent on `(project_id, derivation_key)`.

A crash after upload leaves an object whose id/path are a pure function of the key; the retry finds it, verifies
the checksum and reuses it (`phase-2c.test.ts` simulates exactly this).

## Tests

`src/media/__tests__/ffmpeg.test.ts` runs real ffmpeg against small synthetic fixtures generated at test time
(16:9 / 2.39 / with audio / 5 s / PNG / corrupt / playlist-as-media): probe, frames, crop, trim, pad, scale,
thumbnail, contact sheet, determinism, timeout, limits, path/injection safety, temp-directory cleanup.
It is skipped **only** when ffmpeg/ffprobe are genuinely not installed.
