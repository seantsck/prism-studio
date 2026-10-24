# Production workflow

How work flows through the app, and which signals tell you something upstream changed.

```
Script ─► Breakdown ─► Perform ─► Shot Prep ─► Storyboard ─► Animatic ─► Generations
 (scenes,    (shots from   (takes,     (18 sections,   (frames,      (timed        (package,
  lines,      script,       selected    preflight)      approval)     playback)     attempts)
  actions)    coverage)     take)
```

| Step        | Where                    | Produces                                                                                                   |
| ----------- | ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Script      | `/script`                | Scenes, dialogue lines, action blocks with stable ids ([script-coverage](script-coverage.md))              |
| Breakdown   | `/breakdown`             | Shots created or linked from selected script content; coverage per scene                                   |
| Perform     | `/perform`               | Directions, takes, a selected take per line, locked text ([performance-workflow](performance-workflow.md)) |
| Shot Prep   | `/episodes/:e/shots/:id` | Everything a shot needs; live preflight ([shot-prep](shot-prep.md))                                        |
| Storyboard  | `/storyboard`            | Versioned frames, one approved per shot, drag-reorder                                                      |
| Animatic    | `/animatic`              | Timed playback of approved frames + selected takes ([animatic](animatic.md))                               |
| Generations | `/generations`           | Package export, brief, append-only attempt log ([generation-package](generation-package.md))               |

## Shot Prep

20 sections: Story, Source script, Performance, Character, Look, Location/set, Camera, Composition, Blocking,
Action timing, Continuity, Props, Lighting, Audio, Storyboard/keyframes, **Production Frame**, Generation intent,
Preflight, Generation brief, Generate. A right rail shows the frame, the timing breakdown and preflight. A warning banner appears
when the approved storyboard is stale or the package changed since the last attempt.

The default filmmaking path is image-first and needs no 3D set, GPU or reconstruction:
`script → performance → Shot Prep → storyboard → Production Frame → image-to-video → edit`. The 3D / splat / blocking /
camera tools of Phase 2F are optional: a 3D Master Frame can be promoted into a Production Frame, but 3D never gates one.

## Gates

Preflight rules are `required` (blockers; the shot is not ready) or `recommended` (warnings). Approval gates
(`approval.performance`, `approval.continuity`, storyboard approved) are explicit user actions. Readiness is
computed live and never stored.

## Freshness (migrations 0009, 0011)

Freshness answers "is this approved thing still true of the shot?" without event sourcing: hash the current
state and compare with hashes recorded when the artifact was made.

### Per-part fingerprints (`src/domain/fingerprint.ts`)

`computeShotParts(ctx)` returns one SHA-256 hash (`src/domain/hash.ts`, pure TS) per part:

| Part          | Hashes                                                                                 | Visual? |
| ------------- | -------------------------------------------------------------------------------------- | ------- |
| `story`       | beat, dramatic purpose, scene slugline/summary/purpose                                 | no      |
| `camera`      | `shot.composition`                                                                     | yes     |
| `blocking`    | `shot.spatial`                                                                         | yes     |
| `characters`  | assignments, physical description, identity refs                                       | yes     |
| `looks`       | each assigned Look's wardrobe, shoes, jewelry, hair, makeup, …, reference assets, lock | yes     |
| `location`    | description, geography, zones, entrances, lighting, references, lock                   | yes     |
| `props`       | prop ids, names, descriptions                                                          | yes     |
| `lighting`    | `shot.lighting`                                                                        | yes     |
| `action`      | beats (order, time, text, ids excluded), beginning/ending pose                         | yes     |
| `continuity`  | `shot.continuity`                                                                      | yes     |
| `constraints` | shot constraints + project guardrails                                                  | no      |
| `performance` | lines, directions, selected take id/duration/audio asset/checksum                      | no      |
| `timing`      | total duration, source, segment kinds and bounds                                       | no      |

`visualFingerprint` combines the visual parts; `overallFingerprint` combines all.

### Storyboard frames

On approval a frame stores `approved_fingerprint` and `approved_snapshot = { parts, durationMs }`
(`storyboard_frames`, migrations 0009 and 0011). `storyboardFreshness(ctx, frame)` returns:

| Status    | Meaning                                                                                                           |
| --------- | ----------------------------------------------------------------------------------------------------------------- |
| `none`    | No approved frame.                                                                                                |
| `fresh`   | No visual part differs from the snapshot.                                                                         |
| `stale`   | One or more visual parts differ. `changedParts` names them ("Character Look changed after storyboard approval."). |
| `unknown` | Approved before tracking existed; re-approve to start tracking.                                                   |

`timingChange { fromMs, toMs }` is reported separately when the derived duration moved
("derived duration changed from 4.5s → 5.1s"). With only a legacy fingerprint (no snapshot) the status can be
`stale` but cannot say which part.

Preflight rule `storyboard.fresh` (recommended) turns stale, unknown or changed-timing into a **warning**; it does
not block generation. Shot Prep, Storyboard and Animatic show the same messages.

### Production Frames (Phase 2G.1, migration 0039)

The Shot's canonical approved still. Immutable history + one selection pointer per Shot; made by promoting the approved
Storyboard, promoting an optional 3D Master Frame, or uploading an image at the Shot's production aspect (a wrong aspect is
refused, never cropped). Each frame freezes the visual intent it represents and the named-part fingerprints, so
`productionFrameFreshness(ctx, frame)` says `fresh` or `stale` and WHICH parts changed (camera, blocking, characters,
Looks, location, props, lighting, action, continuity, performance). A stale frame stays selected and is never rewritten.
Preflight `production_frame.fresh` blocks image-to-video on a stale selected frame unless an explicit start frame is set.
Start frame precedence: explicit override > selected Production Frame > approved Storyboard. See
[production-frames](production-frames.md).

### Animate Production Frame (Phase 2H, no migration)

Shot Prep → **16A · Animate Production Frame** animates the selected, CURRENT Production Frame: it is the exact first
frame of an image-to-video candidate (no Storyboard, override or text-to-video fallback; a stale frame or a different
manual override blocks). Compare the video models (exact first frame, production / provider / delivery duration,
provider canvas, audio, cost), create a candidate set, review the clips, mark Best, conform the delivery master when a
crop / trim is planned, and approve the final output with the existing human approval. Generic Generate stays for
other experiments. See [image-to-video](image-to-video.md).

### Production Frame candidates (Phase 2G.2, no migration)

From Shot Prep → Production Frame the filmmaker can **generate candidates**: several still images from image models (the
same model comparison and candidate-set workflow, filtered to still-image models), compare and review them (Good /
Shortlist / Best / Reject), and **Use as Production Frame**. The generation _purpose_ `production_frame` is independent of
the Shot's own modality: generating stills never changes `shot.generation.modality`, the start-frame override, the selection
or any 3D state. One attempt is one image. A candidate is judged by its **candidate input basis** (the named parts it was generated from, plus a Production Frame only if it used one as a reference), not by the Shot's current `parts.overall`: a named input that changed, or a referenced frame that is no longer canonical, makes it **stale** and refused, while choosing a sibling never does; a provider canvas
that is not the production aspect needs the production conform first. Production Frame selection is the one canonical
pointer (never `attempt.approved`); ⭐ Best is only the experiment's preference. See
[image-shot-generator](image-shot-generator.md).

### Location Views (Phase 2G.3, migration 0040)

A Location owns immutable canonical **Location Views** (one named viewpoint = one image + a semantic view spec). Shot
Prep → Production Frame starts with a **Location View** block: the Shot chooses one view of its own Location (or none;
none is never a blocker). The choice is part of the Shot's **location** part, so changing it stales the approved
Storyboard, the selected Production Frame and earlier Production Frame candidates, and changes `parts.overall`.
Production Frame candidates then receive the view's image as the `location_view` reference (after the Production Frame,
Storyboard and Character references, before generic Location references); a fresh selected Production Frame can be saved
as a new view ("Save as Location View", same Asset). A selection of another Location's view never resolves (preflight
`set.location_view` blocks). See [location-views](location-views.md).

### Character Continuity Locks (Phase 2G.4, migrations 0041 + 0042)

A Character owns immutable **Continuity Locks**: an approved appearance (identity facts + one exact Look, or
intentionally none) and the exact stored reference images it was approved with. Creating one generates nothing and
copies no bytes.

- **Selecting:** Shot Prep → 5 · Look → **Character continuity** lets each assigned Character rely on a Lock made for
  the assignment's CURRENT Look; a Lock of another Look is never offered and is refused in the database. A selection
  is optional: no Lock is never a blocker.
- **Locked Shot:** the Lock is the authoritative identity / Look truth for generation, the package (v5), Production
  Frame / Storyboard / candidate freshness and continuity QA references. Later edits to the Look or IdentityRefs do
  not change it.
- **Unlocked Shot:** reads the live library, exactly as before.
- **Changes that clear or stale it:**
  - changing the assignment's Look clears the selection;
  - removing the Character from the Shot removes it;
  - switching Locks stales the frame and the candidates.

See [character-continuity-locks](character-continuity-locks.md).

### Shot Sequence Board (Phase 2G.5, no migration)

Episode → **Sequence** (between Storyboard and Animatic) reviews the episode as a sequence of canonical stills, in the
actual order (Scene order, then Shot order). Each card shows ONE labelled image:

1. the selected Production Frame (current or ⚠ stale, still shown);
2. otherwise the approved Storyboard as a **fallback**;
3. otherwise a **draft** Storyboard (not canonical);
4. otherwise NO PRODUCTION IMAGE.

Each card also shows the Location and View, each Character's Continuity Lock or live appearance, and integrity
blockers. Every cut lists what changes across it (Location / View, Characters entering or leaving, Lock or Look, screen
direction, weather, time of day) as review notes, not failures. **Compare** opens the two stills side by side.

- **Reorder:** drag reorders within a Scene, the same rules as the Storyboard. It never changes a Shot's stored previous
  Shot, so the board then shows **link mismatches**.
- **Sync continuity links:** previews exactly which links change and warns that dependent Storyboards / Production Frames
  / generations may become stale. Only an explicit confirmation writes, and only to the differing Shots.
- **Refusals:** the sync is refused whole if it would touch a locked Shot, and refused if the sequence changed since the
  preview.

Nothing is stored for the board and the package stays v5. See [shot-sequence-board](shot-sequence-board.md).

### Generation attempts

- `generation_attempts.package_fingerprint` stores the package fingerprint at logging time. The trigger
  `guard_attempt_history` makes it (and prompt, negative prompt, package snapshot, model settings, input assets,
  shot id, attempt number) immutable; only review fields can change.
- `package.provenance.fingerprint` is the **exact package identity**: it hashes the whole package content
  **excluding `builtAt`** (and the provenance block itself, the schema-version fields included), so rebuilding an
  unchanged shot yields the same value, and a v3 package differs from a v2 package of the same Shot.
  `provenance.parts` carries the per-part hashes and `parts.overall`, the **Shot's production-input identity** (the 13
  named parts, plus the selected Production Frame's identity while one is selected). The two are not interchangeable
  ([generation-package](generation-package.md#two-fingerprints-two-questions-never-interchangeable)).
- Shot Prep compares the `parts.overall` recorded in the latest attempt's frozen snapshot with the current package's; a
  difference shows "this shot has changed since generation attempt N". A schema upgrade alone never does. Only a
  snapshot that recorded no `parts.overall` falls back to the exact package fingerprint. The attempt itself stays
  interpretable and is never rewritten.

## Generate (Phase 2A)

Shot Prep section **19 · Generate**. A shot may be sent to a model only when **all** of these hold (same gate in
the UI and the server action):

1. every required preflight rule passes (the shot is READY);
2. the approved storyboard is not **stale** (unknown/changed-timing only warn);
3. the model is enabled, configured and not retired;
4. the model is compatible: duration unchanged, aspect ratio, reference limits, required start frame;
5. every feature the model would ignore (end frame, performed audio, style references, …) is **acknowledged**.

Then an immutable attempt is created and a job queued. The shot's generation state is derived (READY → QUEUED →
GENERATING → READY FOR REVIEW → APPROVED / NEEDS REDO); reviewing never edits the storyboard or the shot.
Details: [generation-architecture](generation-architecture.md), [generation-review](generation-review.md).

## Framing adaptation and conform (Phase 2C)

When a model cannot generate the production frame/duration, Generate shows the choice (nothing preselected), the
crop overlay on the approved storyboard frame (full provider canvas, protected crop, discarded regions, safe
guides) and the acknowledgements, **before any spend**. The attempt records the plan; after the output arrives
you can **create a delivery conform** (crop/pad/trim → a new derived asset, original kept) and preview
original vs final. The animatic and every production-facing view keep the production frame and timing.
[framing-adaptation](framing-adaptation.md), [delivery-conform](delivery-conform.md).

## Continuity review

Two layers, both advisory: the legacy manual `continuity_checks` (Shot Prep → Preflight; the continuity approval
gate is separate) and the Phase 2C **continuity review** of a generated attempt (criteria from production
truth, deterministic checks, review frames + contact sheet, reference set, human overrides, optional Mock
analysis). See [continuity-qa](continuity-qa.md).

## Compare models and review fast (Phase 2E)

The primary quality loop is **human**: prep the shot → compare models → generate a candidate set (explicit spend
confirmation) → watch them side by side → one-click verdicts with reasons → mark **Best** → **Promote to Shot**
(explicit). Rejected and losing candidates are kept: they are the project's R&D history (_Experiments_) and the data
behind model recommendations (_Models_). Automated continuity analysis is an optional, separate action
("Run AI Continuity Check") for hard cases or unattended batches; it is never required before approval and never
auto-runs. Details: [human-generation-review](human-generation-review.md),
[generation-candidate-sets](generation-candidate-sets.md), [model-performance](model-performance.md),
[model-recommendation-v1](model-recommendation-v1.md).

## 3D camera motion and previs (Phase 2F M2A)

A Shot's camera motion is authored in the 3D Set (Camera motion section) and stored as `prism.camera-path.v1`:
keyframes of production-camera pose and focal length, interpolated by one deterministic evaluator. Timing comes from the
Shot (selected performance duration, else the manual target; frame rate from `generation.fps`). A local previs video
can be rendered in the browser and is kept as a private asset with the path and set revisions it came from.

- **Not a freshness part.** Camera motion and previs do not change the 13 shot freshness parts, so authoring them never
  stales an existing storyboard approval.
- **Frozen in the package.** `spatialReference.cameraMotion` carries the path by value plus the asset id of the previs
  rendered from exactly that path. It is context for future provider adapters; nothing is injected into prompts.
- **Stale, not deleted.** Changing the set after a path/previs was made marks them stale; history is kept.
- **Performance audio in the previs (M2A.1).** "Include selected performance audio" muxes the Shot's selected takes into
  the previs on the same timeline as the camera (pre-roll, takes, gaps, post-roll). It is composed and encoded locally;
  with no compatible audio encoder the previs is rendered silent and says so. A previs with audio goes stale
  ("STALE AUDIO") when the selected takes or timing change; a silent previs does not, since it never contained the audio.

## Character blocking in the 3D Set (Phase 2F M2B)

In a Shot's 3D Set, **Add Character Proxy** places a neutral rigged mannequin for a Project Character; move and turn it
with the root gizmo (or position / body yaw / height fields) and pose it in **Pose Mode** (click a joint, drag the
rotate gizmo; presets: Neutral Stand, Seated, Walk A/B, Hands on Hips; head yaw/pitch). Save the blocking; it belongs to
that Shot only. The proxy shows where and how the Character stands, not who they are.

- **Renders.** Master frames and local previs show the proxies (static pose through the clip); editor helpers never
  appear. Each render records the blocking it showed.
- **Stale, not deleted.** Changing the blocking stales earlier master frames and previs ("STALE BLOCKING"); changing the
  set stales the blocking itself, which you can **Re-anchor to current set** explicitly. History is kept.
- **Not a freshness part.** Blocking does not change the 13 shot freshness parts or any existing approval.
- **Frozen in the package.** `spatialReference.shotBlocking` carries each figure's root and pose by value plus a
  deterministic summary. Nothing is injected into provider prompts in M2B.

## Spatial control passes in the 3D Set (Phase 2F M2C)

When the Set, the Shot's character blocking and the production camera are right, **Capture Control Passes** turns that
spatial truth into machine-readable data for one frame: **depth** (linear metres), **object IDs** (which Set object or
Character proxy owns each pixel) and an **exact mask for every visible blocked Character**, all at the full 1912×800
Production Frame from the same camera.

- **Camera source.** With a saved camera path the capture uses the **timeline playhead** ("Camera Path · 2.000 s");
  without one it uses the Production Camera bookmark. The navigation camera is never a source.
- **Saved state only.** The Set, the blocking and the camera path must be saved, current and not playing. The panel
  lists what is missing, so a bundle can always be reconstructed.
- **Stale, not deleted.** A bundle goes `STALE SCENE`, `STALE CAMERA` or `STALE BLOCKING` when what it represents
  changes. Audio never stales it (the passes contain none). Old bundles stay.
- **Private.** The rasters are private assets of a dedicated `data` type; previews are drawn from the stored bytes and are
  display-only.
- **Frozen in the package.** `spatialReference.controlPasses` carries the current bundle by value (asset ids, manifest,
  camera, per-Character mask identity). Nothing is injected into provider prompts and no provider is called: later
  adapters decide how to use depth and masks.

## A reconstructed environment in the 3D Set (Phase 2F M2D.1)

A Location can carry a **Gaussian-splat environment** reconstructed elsewhere (Prism does not create one yet).

1. In the Location's 3D Set choose **Import Gaussian splat** (`.splat`, `.spz` or a Gaussian `.ply`, up to 50 MB).
   Optionally tick the Location reference images it was reconstructed from: that is provenance, not a Shot reference.
2. The file is validated, stored as a **private** Asset with an immutable reconstruction record, and placed in the Set.
3. Move, rotate and scale it like any object; **Set as ground level** and **Flip 180° (X)** help with raw reconstructions.
   Prism never assumes the splat is in metres: enter **metres per source unit** to make its scale metric (or leave it
   "unknown"). **Lock environment** makes it safe to block Characters and move the camera around it.
4. Link the Production Camera, add Character proxies and render master frames and previs exactly as before: the
   environment is part of them, and a Character proxy stands in front of or behind it correctly.
5. **Capture Control Passes is unavailable while the splat is visible** (exact depth and masks cannot include a splat yet).
   Hide the splat to capture mesh-and-Character passes.
6. The GenerationPackage records the environment (`spatialReference.spatialEnvironment`) by value; moving the splat later
   produces a different package and leaves the earlier one untouched. No prompt text is added.

## Generating a spatial environment from reference images (Phase 2F M2D.2)

1. Put reference photos of the Location in the asset library (purpose **Location reference**).
2. In the Location's 3D Set, **Create reconstruction**: pick the images, order them (the first is the primary image;
   ↑ ↓ ★ ×), pick the provider and model. Each provider says first what it costs and where it runs (**Local Capture**:
   free, runs on this machine, not installed until a later update; **World Labs Marble**: paid provider, optional;
   **Mock Reconstruction**: development only), then its status (ready / not installed / not configured / switched
   off). Nothing paid is ever pre-selected. For a paid provider the panel shows the documented price and you must
   tick "provider charges may apply". If a provider is unavailable or fails, Prism never switches to another one.
3. **Generate Reconstruction** creates a job and submits it once. Progress appears in the job list. You can leave the
   page: the job is stored and resumes when you come back.
4. When the result is ready, Prism has already downloaded it, checked it and stored it privately. Your Set is not
   changed. Press **Use as Spatial Environment** (or **Replace current spatial environment** if the Set already has
   one), align it, and save the Set.
5. A failed job can be **retried** (a new attempt; the failed one stays in history). **Cancel** tells you truthfully
   whether the provider stopped the work or Prism only stopped tracking it.
6. Scale is never assumed: a provider's metric estimate is labelled "provider-estimated"; otherwise it is "unknown"
   until you calibrate it. Control passes stay blocked while a splat is visible, as with imported splats.
