# Phase 5B V4: deterministic segmented Episode render → final MP4

> Episode Edit → Save revision → **Render Episode** → segmented rendering → titles / cross dissolves / existing audio
> → assembly → verification → an immutable rendered Episode Asset → Play Final → Download.

V4 branches from `phase-5b-story-intelligence` at `776ed2a`, after V3. It is local / test only: one **local**
migration (`0059`), no hosted change, no renderer provisioning and no paid call.

## 1. Audit

### What already existed

| Concern           | Existing architecture                                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FFmpeg            | `src/media/ffmpeg.ts` `FfmpegMediaProcessor` (Phase 2C). The safety model: an argument array (no shell), the container sniffed from the bytes and forced with `-f`, `-protocol_whitelist file`, timeouts and size limits, a minimal child environment (no credentials), private temp directories removed in `finally`, path-free errors. H.264 / AAC with bitexact flags. |
| Media operations  | Probe, frames, thumbnails, contact sheets, delivery conform (crop / pad / trim), scale, extract window.                                                                                                                                                                                                                                                                   |
| Conform policy    | `src/media/delivery.ts` + `domain/framing/conform`. The original is never modified, derivations have deterministic ids and keys, there is no silent crop, and the Production Frame guard refuses a wrong-aspect image.                                                                                                                                                    |
| Where media runs  | Delivery conforms run in the app server under the user's session (short operations). No render job existed.                                                                                                                                                                                                                                                               |
| Workers / queues  | Generation (lease + role, `scripts/generation-worker.mts`), continuity analysis (lease + `prism_continuity_worker` role with column grants), Story. In memory mode each runs in-process.                                                                                                                                                                                  |
| Storage           | `StorageProvider` (local disk / private Supabase bucket, short-lived signed URLs), the `<project>/<id>/<file>` key layout that Storage RLS authorises on, the owner-checked `/api/assets/<id>` route.                                                                                                                                                                     |
| Edit → manifest   | V3 `buildRenderManifest` over the canonical timeline (`editTimeline`). No render or export existed in 2I.                                                                                                                                                                                                                                                                 |
| Delivery settings | The Bible's `aspectRatio` (Ojou-sama 2.39:1), the optional `deliveryWidth` / `deliveryHeight` (null), the edit rate (24/1).                                                                                                                                                                                                                                               |

### What V4 reuses

- `execMediaTool` / `mediaToolEnv`: the processor's exec, factored out unchanged and shared.
- The storage layout, `safeFileName` and the asset route.
- The `derivedAssetId` deterministic ids.
- The lease / role worker pattern.
- The V3 manifest and timeline.
- The no-crop conform policy (fit inside and letterbox).

### What V4 adds

A render job, a segmented renderer, a render worker, a segment cache, the final Asset, the Render panel, and a least-privilege render worker role.

## 2. Architecture

```
saved Edit revision ──► V3 render manifest (frozen in the job) ──► render plan (pure)
        pieces: title │ body (1 picture) │ transition (2 pictures) — each its own ffmpeg process
        ──► normalized H.264 segment (exact frames) + exact-length PCM, cached by deterministic key
        ──► concat (sequential) ──► AAC once ──► ffprobe verification ──► immutable MP4 Asset
```

- **Worker choice:** a dedicated **render worker** (`src/render/worker.ts`, `npm run worker:render`) with its own
  role, `prism_render_worker`.
  - Not the generation worker: rendering needs no provider and must not hold provider credentials.
  - Not a request: a render takes minutes.
  - In memory / demo mode the same worker runs in-process and is started when a render is requested.
- **Concurrency:** one render at a time, and one ffmpeg process at a time inside a render. Correctness over speed.
- **Plan** (`src/render/plan.ts`):
  - Every timeline instant belongs to exactly one piece.
  - An item of D ms with dissolves d_in / d_out gives a body of D − d_in − d_out; each dissolve is rendered once, as
    a transition piece of its exact length.
  - Piece boundaries are frames of absolute positions (`frameAtMs`, the V3 math), so the piece frames sum exactly to
    the manifest's `totalFrames`.
  - Audio boundaries are the samples of those frames.
- **Bounded:** at most 2 picture sources per piece and at most 16 sounds per piece. The assembly reads the pieces
  sequentially through the concat demuxer. Enforced by the plan and asserted in tests (a 60-item Episode, and the
  recorded ffmpeg argument lists).

## 3. Normalization profile `prism-5b-delivery-h264-v1`

| Property  | Value                                                                                                                                                            |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container | MP4, `+faststart`, metadata stripped, bitexact flags                                                                                                             |
| Video     | H.264 (libx264), yuv420p, CRF 18, constant rate = the edit rate (24/1), closed 2 s GOP, scene-cut off, track timescale with integer frame duration               |
| Audio     | AAC-LC 48 kHz stereo 192 kb/s in the final file; segments carry exact-length 16-bit PCM (no AAC priming drift between segments)                                  |
| Canvas    | The Bible's delivery size when set, else 1920 wide at the aspect ratio: **Ojou-sama 2.39:1 → 1920×804**                                                          |
| Aspect    | Every source is fit inside the canvas and letterboxed / pillarboxed. **Never cropped.** A 2.39:1 production conform fills the frame; a 16:9 clip is pillarboxed. |

The x264 preset (`medium` by default; `PRISM_STUDIO_RENDER_PRESET` for tests and local demos) and the renderer
version are part of the profile identity.

Before the pieces are stream-copied together, each one is probed and must match in codec, canvas, rate and pixel
format. Each piece is also checked to have exactly its frame count when it is rendered.

## 4. Pictures, transitions, titles, audio

- **Shot Clip:** the source is seeked to the trimmed in point and runs at the delivery rate. A short source holds its
  last frame (`tpad`), and the segment is exactly N frames.
- **Production Frame / Storyboard still:** the image is looped for exactly N frames.
- **Cross dissolve:** a transition piece of exactly the dissolve's frames (0.75 s = 18 frames at 24 fps). It is the
  outgoing item's last d ms `xfade`-faded linearly over the incoming item's first d ms, which is the V3 preview's
  `dissolveMix`. Cut is simply adjacent pieces. No other transition exists.
- **Titles:**
  - drawtext on black, text read from files (`expansion=none`: no escaping or format strings);
  - **Film** → Noto Serif JP / CJK, **Plain** → Noto Sans JP / CJK;
  - only open (OFL) fonts are used, from `PRISM_STUDIO_RENDER_FONT_DIR` or the standard system locations. Nothing is
    bundled, and no proprietary face is used even when installed;
  - **fail closed** if neither is present;
  - the font family and checksum are part of the title's cache key and the provenance;
  - Japanese renders correctly (`お嬢様、僕と結婚してください。`, checked in a decoded frame).
- **Audio rule (documented and tested):**
  - every sound keeps its own timeline position: a placed take at its manifest start, and clip audio over its item's
    visible trimmed range only;
  - a cross dissolve moves **no** sound: during it, the two items' clip audio (when included) simply overlap and are
    summed;
  - the mix is a sum without normalization (a lone sound keeps its level), then a −1 dBFS limiter (no clipping);
  - V3 has no volume metadata, so there is none to apply. A take with no stored audio file (timed text, a seed
    placeholder) is silence;
  - an Episode with no sound anywhere renders video-only. The Episode music bed remains **V3b**.
- **Missing media:** a final render **fails closed** before any processing: `Episode contains N items with missing
media: 3D.` A picture whose Asset has no stored bytes counts as missing. No draft or watermark mode.

## 5. Jobs, freeze, restart, cache

- **Freeze:** the request requires the edit's current state to be a **saved** revision. The job stores:
  - the edit, its working revision and the saved revision;
  - the manifest with every source checksum, its fingerprint and the state fingerprint;
  - the profile and the output file name.

  The worker never reads the Edit tables. Each source's bytes are re-hashed and must match the frozen checksum, or the
  render fails `source_changed`. Edit revision B during render A cannot reach A (tested).

- **Lifecycle:**
  - `queued → rendering_segments → assembling → verifying → completed`;
  - `failed`, then a retry of the **same** render (attempt + 1, no duplicate);
  - `queued → cancelled`.

  The database guards every transition. The owner can only request, retry and cancel. A completed or cancelled
  render is immutable.

- **Restart / cache:**
  - every piece has a deterministic key: sha256 of the renderer version, the profile, the piece kind, the frames and
    samples, the source Asset ids + checksums + positions, the title text / style / font, and the audio layout. Its
    timeline position is not part of the key;
  - a cached segment is reused only if its record exists **and** both stored objects re-hash to the recorded
    checksums. A corrupted entry is dropped and rebuilt (tested). A changed source or parameter gives a new key;
  - segments live in private storage inside the project's prefix (`<project>/<uuid-from-key>/segment-…`) and are
    recorded in `render_segment_cache`;
  - **Retention:** kept for re-renders and retries until the project is deleted. A pruning tool is a follow-up.
  - each job's local temp directory is removed in `finally`, success or failure.
- **Output:**
  - a NEW private Asset (`purpose = 'episode_render'`, a deterministic id per render, so a retry never duplicates it);
  - the object path is `<project>/<asset>/ojousama-episode-1-the-arrangement.mp4`;
  - it records the checksum, bytes, duration, frames, size, rate, codecs, profile, manifest fingerprint, Edit
    revision and render, plus the segments reused / rendered, the ffmpeg version and the fonts;
  - earlier renders are never touched.
- **Byte determinism (honest):** the plan, the segment identities, the provenance and the timing are deterministic.
  The MP4 bytes are produced with bitexact flags and stripped metadata, but byte-identical output across ffmpeg / x264
  builds is **not** promised.

## 6. Hosted render worker (path only: nothing provisioned in V4)

| Item        | Requirement                                                                                                                                                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command     | `npm run worker:render` (`tsx scripts/render-worker.mts`), one long-running process                                                                                                                                                                                                                     |
| Database    | `PRISM_STUDIO_RENDER_WORKER_DB_URL`: the LOGIN of `prism_render_worker` itself, attached by `npm run render:db:provision` (closeout; migration 0059: claims / advances active renders, the segment cache, reads the Assets of a project with an active render, inserts only the `episode_render` Asset) |
| Storage     | `PRISM_STUDIO_RENDER_WORKER_SUPABASE_SECRET_KEY`: a server secret key for the private `prism-assets` bucket (sources, segments, the output). Never in the browser and never `NEXT_PUBLIC_*`                                                                                                             |
| Not given   | Any OpenAI / Runway / Photoroom / Story / generation credential (statically tested)                                                                                                                                                                                                                     |
| Tools       | ffmpeg + ffprobe with libx264, aac, drawtext (freetype), xfade; `fonts-noto-cjk` (OFL) or `PRISM_STUDIO_RENDER_FONT_DIR`                                                                                                                                                                                |
| Health      | One line per claim / completion / failure; non-zero exit on configuration errors; a stale lease is reclaimed by the next poll                                                                                                                                                                           |
| Concurrency | 1 render, 1 ffmpeg process. Add workers, not threads                                                                                                                                                                                                                                                    |
| Temp disk   | ≈ 3× the largest render (sources + segments + final) in `PRISM_STUDIO_RENDER_TEMP_DIR`; removed per render                                                                                                                                                                                              |

## 7. Acceptance (local, mock media, real ffmpeg)

- **`episode-render-v4.test.ts` (the Ojou-sama final film):**
  - The cut: opening title, 3A trimmed (0.5–4.5 s), a Shot of another Scene intercut, 3C still (4.5 s), a 0.75 s
    dissolve, 3B trimmed (0.625–4.625 s), a closing title. A real tone take is placed under 3A.
  - The output is decoded and checked:
    - H.264 1920×804 24/1 yuv420p and AAC 48 kHz stereo;
    - frames = the manifest's `totalFrames` exactly, and the duration is within one frame of the V3 timeline;
    - the Japanese title is drawn;
    - 3A's first frame is source 0.5 s and one second later 1.5 s (best match among all source frames);
    - the other Scene's still sits right after 3A;
    - 3C holds its still for its frames, and the mid-dissolve frame is closest to the 50/50 blend;
    - 3B resumes at source 1.375 s;
    - every placed take sounds at its manifest position (silencedetect, within a frame), and placeholders are silent.
  - Interruption, change, failure and reuse:
    - The Edit changed during render A; A is labelled and rendered from A.
    - Interruption: one segment rendered, then a crash → `failed` with no output. Retry → the same render, 1 rebuilt
      and the rest reused, and no duplicate render or Asset.
    - The same revision again → everything reused except a deliberately corrupted cached segment, which is rebuilt.
    - Two or more renders coexist.
    - Sources are unchanged, the ffmpeg environment has no credentials, ffmpeg calls are bounded, and there are zero
      network calls.
- **`plan.test.ts`:** profile and canvas, piece math, missing media, cache identity (deterministic, position-free,
  invalidated by any source, preset or font change), the bounded 60-item plan.
- **`migration-0059.test.ts`:** the schema, guards and grants, and the static credential boundary of `src/render`
  and the worker script.
- **`db:renders`:** on the disposable Postgres, 40 checks, including a real render through
  `PostgresRenderWorkerStore` **as `prism_render_worker`**, owner RLS, the role's limits, immutability, retry and
  cascade.
- **Browser story S:** the full creator flow; the downloaded MP4 is verified with ffprobe and decoded frames.

## 8. Deferred (not in V4)

V3b Episode music bed · split at playhead · an advanced mixer · AI sound design · ADR / voice cloning · advanced
transitions · colour grading · Phase 5D UX consolidation · a hosted renderer rollout · a segment-cache pruning tool ·
billing.
