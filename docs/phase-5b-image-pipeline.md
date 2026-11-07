# Phase 5B: Image pipeline (architecture; slice I1)

**Status: I1 (image generation foundation) is implemented on `phase-5b-i1-image-foundation`, a draft into the
integration branch `phase-5b-image-pipeline`.** `main` and the deployed owner-review site are untouched. Migration
**0051** exists in the repository only. It is proven on a disposable local Postgres and is **not applied to hosted DEV**
(§6). No paid provider was called.

Target workflow: Character Bible → Location Bible → Production Frame candidates → edit / refine → choose the canonical
Production Frame → animate (the existing image-to-video) → Episode Edit. 3D stays optional.

## 1. Audit: what already existed (reused, not rebuilt)

| Need                                                      | Already built                                                                                                                                                                | Where                                                               |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Queue, leases, retries, worker, ingest to private Storage | `generation_jobs` + `GenerationWorker` + `SupabaseSink` (worker secret)                                                                                                      | 0013–0017, `src/generation/worker.ts`, `ingest.ts`, `sink.ts`       |
| Outputs, costs, events, provenance                        | `generation_outputs`, `generation_costs`, `generation_job_events`; each output Asset has `metadata.generation.attemptId`, a checksum and the path `<project>/<asset>/<file>` | 0014, `ingest.ts`                                                   |
| Derived-asset lineage                                     | `asset_derivations` (crop, pad, trim, scale, conform, thumbnail, frame_extract, contact_sheet)                                                                               | 0020                                                                |
| Image models                                              | Runway-hosted `gpt_image_2_5_flare`, `muse_image` and `seedream5_lite` (typed, priced; 0 live calls), and the free mock image models                                         | `image-catalog.ts`, `runway/image-families.ts`, `providers/mock.ts` |
| Shot Production Frame candidates                          | `production_frame` purpose, candidate sets, `promoteGeneratedFrame`, `shot_production_frames.source = 'generation_output'`                                                   | Phase 2G.2 ([image-shot-generator](image-shot-generator.md))        |
| Image → video handoff                                     | `animate_production_frame`                                                                                                                                                   | Phase 2H ([image-to-video](image-to-video.md))                      |
| Character references                                      | `character_identity_refs` (slots front, three_quarter, profile, full_body, additional, each lockable); `character_looks.reference_asset_ids`; Continuity Locks               | 0001, 0041                                                          |
| Location references                                       | `locations.reference_asset_ids`; Location Views (immutable, deduplicated) created from a Location reference                                                                  | 0001, 0040                                                          |
| Capability flags for later slices                         | `capabilities.image.editing` and `capabilities.image.transparency` per model                                                                                                 | `schemas.ts`                                                        |
| Spend gate                                                | `registry.billsMoney` plus `spendBlockers`, checked at submit and again in the worker before the provider call                                                               | `gate.ts`, `worker.ts`                                              |

**The one real gap:** every generation attempt belonged to a Shot (`generation_attempts.shot_id NOT NULL`, numbered and
deduplicated per Shot, and the submission path builds a Shot `GenerationPackage`). Nothing could represent an image
generated _for a Character or a Location_.

The worker, ingest, sink, adapters, jobs, outputs, costs and worker policies never use the Shot, so the gap is confined
to the attempt row and the submission path.

## 2. I1 design: subjects on the existing pipeline

- **One migration (0051).**
  - `generation_attempts.shot_id` becomes nullable, and `character_id` / `location_id` are added.
  - **Exactly one subject** per row, enforced by a check.
  - Composite same-project foreign keys, cascading when the subject is deleted.
  - A subject attempt is always an **image** and is **never approved**: approval stays a Shot concept, and "use as" is
    a separate, explicit act.
  - Attempts are numbered per subject (partial unique indexes).
  - The append-only guard also freezes the subject.
  - No row is rewritten. There is no grant or policy change, and no SECURITY DEFINER.
- **Purposes.** `character_image` and `location_image` are frozen on the request JSON, which needs no database enum.
  Candidate sets narrow to the Shot purposes (`ShotGenerationPurpose`).
- **Shot views are untouched by construction.** `ProjectData.attempts`, the project generations listing and the model
  history read `shot_id is not null` only. Subject attempts have their own repository methods (`createSubjectImageAttempt`,
  `listSubjectImageAttempts`, `getSubjectImageAttempt`) in both twins.
- **The worker** claims any attempt through a subject-neutral type (`WorkerAttempt`). It reads only the frozen request
  and plan, as before. Memory mode keeps subject attempts in their own collection.
- **Prompting** (`src/domain/generation/subject-image.ts`). This is a pure builder: Character or Location plus intent,
  then a `PromptPlan` (subject, identity, wardrobe from the Look, environment, composition per intent, the creator's
  direction, Bible visual style, canon and guardrails, and what to avoid).
  - References come only from **stored** images: identity refs, then Look refs, then Location references.
  - The package is frozen by value with a fingerprint, like a Shot's.
  - Intents. Character: portrait, character reference, look sheet, outfit variant, expression variant. Location:
    location concept, background, establishing view, alternate angle.
- **Submission** (`src/generation/subject-submission.ts`).
  - **The human's model** is used as is and never substituted.
  - Its availability is checked. It uses text-to-image, or image-to-image when the subject has references and the
    model takes them.
  - References are trimmed to the model's limit, and the aspect ratio must be one the model offers.
  - The adapter's own validation runs, then the cost estimate, then the **spend gate**: a paid model is refused while
    paid generation is off.
  - Project active-job and per-user rate limits apply, and the submission is idempotent by key.
- **Saving as a reference** (`src/server/subject-image-actions.ts`). Each save verifies that the image is a finished
  output of this project and this subject, and that it has a stored file.
  - **Use as Character Reference** points an identity slot at the generated Asset. A locked slot is refused, so
    changing the canonical reference is an explicit unlock-then-replace.
  - **Use as Look** adds it to the Look's references (refused while the Look is locked).
  - **Use as Location Reference** adds it to the Location's references. The existing "create Location View from
    reference" action (2G.3) then makes a **Location View** from it, unchanged.
  - The generated Asset itself is **never modified**: it keeps its attempt provenance, and a reference only points at
    it.
- **UI.**
  - The Character page and each Location card get an **Images** panel. Its main path is one button, **Generate
    Image**, with "What to make" and, for Characters, the Look.
  - **Advanced** holds the model, aspect ratio and direction. Prism pre-selects an available free model; paid models
    are labelled "(paid)", and unavailable ones are shown disabled.
  - Results show their status and preview, and offer "Use as Character Reference / Use as Look / Use as Location
    Reference".
  - The panel refreshes only while something is generating. There is no provider jargon on the main path.

## 3. Provider paths

- **GPT Image, available now with no new code:** Runway-hosted `gpt_image_2_5_flare` through the existing `runway`
  adapter. It takes tagged references and a quality ladder, and is priced. Its first live call needs owner
  authorization (#60).
- **GPT Image direct, the I2/I3 adapter (design).** It is needed for **editing with masks** and **transparent
  backgrounds**, which the Runway route does not expose. A new `openai-image` adapter behind the existing
  `GenerationProviderAdapter` interface:
  - `images.generate` and `images.edit` (SDK `openai` 7.32.0, already a dependency).
  - Models from the installed SDK's `ImageModel` union, for example `gpt-image-2.5-flare` and
    `gpt-image-2.5-sunburst`.
  - The SDK documents `background: transparent` (PNG or WebP output) for the 2.5 models, `mask` on edits, up to 16
    input images on edits, `quality` (low … max), `input_fidelity`, `output_format` and `moderation`.
  - `n` is always 1 (one attempt equals one image, as now).
  - Prices are recorded per model, with a pricing version, before registration. Unknown prices are refused by the spend
    gate.
  - The key (`OPENAI_API_KEY`) lives **only** in the worker project. The web registry treats the provider as
    worker-backed, the change already on the 5A.2 branch (`workerBackedProviders`). I1 needs that change in this
    integration branch before a real model can be queued from a web app that holds no provider secret.
- **FLUX, after GPT Image (design).** A `bfl` adapter (or a hosted route) behind the same interface: submit, then poll,
  then fetch. There is no SDK in the repository, the request shape, pricing and the edit/fill endpoints are not yet
  verified from the provider's documentation, and the host (direct or an aggregator) is an owner decision. The model is
  registered only when its shape, limits and price can be verified (the existing rule).
- **Provider neutrality.** Everything above is behind the existing registry and adapter interface. A model declares
  `image.editing` / `image.transparency`, and the UI offers Edit / Remove Background only for models that declare them.

## 4. Background removal (I3): decision

Two operations, both provider-neutral:

1. **Generate with a transparent background.** This is a provider capability (GPT Image direct
   `background: transparent`). It is an ordinary generation, priced and gated.
2. **Remove Background from an existing image.** This runs in the **media worker** (5A's ffmpeg image plus an open
   segmentation model, CPU, no spend):
   - **deterministic**: the same input gives the same cutout, with a derivation key;
   - **private**: bytes never leave Prism;
   - **free**.

   It records `asset_derivations.operation = 'background_removal'` (an enum extension, in I3's migration) and writes a
   PNG with an alpha channel. The asset metadata records `hasAlpha: true`, so later references and compositions treat
   it correctly.

   A provider route remains possible per model where quality demands it, but it is opt-in and priced.

## 5. Lineage

- **Generation.** Attempt → job → `generation_outputs` → Asset (with `metadata.generation`), plus estimated and actual
  `generation_costs`.
- **Reuse.** "Use as …" points a reference at the Asset; the Asset is never changed. The identity ref's metadata
  records `{ source: "generated", attemptId }`.
- **Edits (I2).** An edit is a new image attempt whose input names the source Asset. The edited image is a **new**
  Asset, so the source is never overwritten, and it can be promoted like any generated image.
- **Background removal (I3).** A new Asset plus an `asset_derivations` row, with the parent kept.

## 6. Isolation rule (deployment)

- **The rule.** The deployed owner-review site runs `main`'s code against the shared DEV database, and `main` assumes
  every attempt has a Shot. If a Character or Location attempt ever existed in that database, `main`'s project pages
  would fail to parse it. Therefore:
  - **0051 is not applied to hosted DEV** while the playable site depends on that database. It is applied only together
    with code that understands subjects, after owner authorization.
  - Image-pipeline testing uses **memory mode**, the **disposable local Postgres**, or a **separate** Supabase project
    (for example the rehearsal project from [phase-5a-production-bootstrap](phase-5a-production-bootstrap.md)).
- **No preview deployment of I1 yet.** A Vercel preview in memory mode is unreliable: each serverless instance has its
  own memory, so state would vanish between requests. A preview against DEV would break the rule above. An isolated
  preview needs a separate database, which is a rehearsal or preview Supabase project (owner action).

## 7. Acceptance gates (I1)

- **Disposable Postgres at 0051** (`scripts/db-generation-subjects.mts`, 22/22):
  - constraints: one subject, image-only, never approved, project-scoped subjects, per-subject numbering;
  - idempotency and RLS (a stranger reads and creates nothing);
  - the project load, generations listing and model history stay Shot-only;
  - the append-only guard freezes the subject;
  - the worker role reads subject attempts;
  - deleting the subject cascades;
  - exact cleanup.

  The existing `db:generation` suite passes 71/71 on the same database.

- **Unit tests:**
  - **Flow on the memory twin with the real worker and sink:** a Character portrait and a Location concept go queued →
    executed → stored output with provenance → listed per subject. Shot history is unchanged, replays are idempotent,
    numbering is per subject, unknown subjects are refused, a paid model is refused while paid generation is off, and
    the failure mocks are absent in production.
  - **Server actions:** Generate Image → Use as Character Reference (an explicit unlock of a locked slot), Use as
    Location Reference. Refused: a locked slot, another character's image, an unknown attempt, an unfinished image, an
    unknown intent, a model the server does not offer.
  - **Migrations:** static checks for 0051, and 0050 is unchanged.
- **Unchanged:** existing video generation, candidate sets, Production Frames and image-to-video. The full suite
  passes.

## 8. Next slices

- **I1b, finishing the foundation:**
  - the Shot entry points (Generate Storyboard Frame, Alternate Composition), wired to the existing Production Frame
    candidate flow on the Shot page;
  - bringing 5A's `workerBackedProviders` into the integration branch;
  - an isolated preview database;
  - a Playwright story in memory mode.
- **I2:** the `openai-image` adapter (generate and edit, with masks) behind the worker, and edit attempts with
  source-Asset lineage. The first live call needs owner authorization and a cap.
- **I3:** Remove Background in the media worker, `background_removal` lineage, alpha metadata.
- **I4 and I5:** the Character and Location visual bibles (canonical selection UI, angle and expression sets,
  time-of-day sets, background plates as a Location reference role).
- **I6:** Production Frame composition from the bibles (Shot 3A acceptance on 「お嬢様、僕と結婚してください。」).
