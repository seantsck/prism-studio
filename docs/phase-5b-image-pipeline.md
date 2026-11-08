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
2. **Remove Background from an existing image.** Built in I3: see
   [phase-5b-i3-background-removal](phase-5b-i3-background-removal.md).
   - It runs as the local `prism-matting` provider on the existing generation queue and worker, behind a
     provider-neutral `MattingEngine` boundary (matte only; the source RGB is never changed).
   - The shipped engine is Prism's own deterministic plain-background keyer: free, private, no model weights.
   - A segmentation model (BiRefNet) waits on an owner / legal decision and a CPU benchmark.
   - The earlier plan (an `asset_derivations` operation in the media worker) was superseded: the media-job worker does
     not exist yet, and attempt lineage is already exact.

## 5. Lineage

- **Generation.** Attempt → job → `generation_outputs` → Asset (with `metadata.generation`), plus estimated and actual
  `generation_costs`.
- **Reuse.** "Use as …" points a reference at the Asset; the Asset is never changed. The identity ref's metadata
  records `{ source: "generated", attemptId }`.
- **Edits (I2).** An edit is a new image attempt whose input names the source Asset. The edited image is a **new**
  Asset, so the source is never overwritten, and it can be promoted like any generated image.
- **Background removal (I3).** A new Asset plus an `asset_derivations` row, with the parent kept.
- **Deleting a generated Character / Location image** (the 0051 shared-database compatibility gate). The asset-usage
  guard reflects actual references, not "generated":
  - **In use, so refused:** a Character reference slot, a Look reference, a Location reference, a Location View
    (immutable, so permanently), a Production Frame, a Storyboard frame, a Continuity Lock, a Shot attempt's input or
    output, and a Character / Location image attempt that sent it as an **input** reference
    (`subjectImageAssetPins`).
  - **Its own attempt is provenance, not a use.** An unreferenced generated subject image is deletable. The attempt is
    kept (status, cost, prompt), its `output_asset_id` becomes null through its existing key, and only that subject
    attempt's `generation_outputs` link is dropped, atomically with the Asset delete (0051's
    `assets_release_subject_image_outputs` trigger; the memory twin is `releaseSubjectOutputs`).
  - **Shot behaviour is unchanged.** A Shot attempt's output is still pinned by asset-usage, and its output link is
    never released, so Postgres's key refuses the delete as before.
  - Evidence: `src/server/__tests__/asset-usage-0051-gate.test.ts` (memory, through the real `deleteAsset`),
    `src/data/__tests__/migration-0051.test.ts` (the trigger's exact shape), and three checks in
    `scripts/db-generation-subjects.mts` (Postgres, as the RLS-bound owner).

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

- **Disposable Postgres at 0051** (`scripts/db-generation-subjects.mts`, 25/25, including the three asset-delete
  checks of the 0051 shared-database compatibility gate):
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

## 9. I1b: Shot image entry points

**Branch:** `phase-5b-i1b-shot-image-entrypoints`. It is stacked on I1 (it needs 0051 for the compatibility gate) and
retargets to `phase-5b-image-pipeline` when #64 merges. The integration branch now contains 5A by history: merge
`b667cdd` of `e99c7a1`, plus `352a663` (below).

- **Shot Prep → Production Frame: Generate Image, Alternate Composition, Generate Storyboard.** Each submits a
  **one-model `production_frame` candidate set through the existing `createCandidateSet`**. That brings the same gate,
  spend confirmation (a paid model needs the creator's confirmed total), candidate page and disclosure of ignored
  inputs. There is no new selection system.
  - The Production Frame purpose already exempts the Storyboard rules and needs no 3D.
  - Shot context comes from the existing GenerationPackage, unchanged: Character, Look, identity references (or Lock
    images), Location and Location View, camera, composition, blocking, lighting, continuity, props, the story beat
    and the prompt plan.
  - Nothing replaces the current Storyboard or Production Frame.
- **The Shot's recent generated stills:**
  - **Use as Production Frame** is the existing `chooseGeneratedFrameAsProductionFrame`.
  - **Use as Storyboard Frame** is new. It adds a **new, unapproved** Storyboard frame version (`source = 'generated'`,
    which 0002 already allows) pointing at the generated Asset. Existing frames and the Asset are untouched. It refuses
    another Shot's still, a Character or Location image, and an unfinished image.
- **Model** is under Advanced. A free model is suggested and paid ones are labelled; the human chooses.

**Integration fix:** `352a663`. `ModelRegistry.availabilityOf` crashed (`undefined.includes`) for a config without
`workerBackedProviders` (`runway.test.ts` failed on the 5A head itself). A missing list now means none, so it fails
closed. The same fix belongs on #63.

## 10. 0051 migration-compatibility gate

**The rule.** Before 0051 is applied to any database that a deployed build reads (shared DEV, later Production), every
reader that build uses must handle Shot, Character and Location attempts without crashing.

**Inventory of Shot-only assumptions:**

| Reader                                                                                                                                                                                                                                                                    | Assumption                                                                           | Status                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loadProject` attempts (Postgres `postgres-repository.ts`; memory `ProjectData.attempts`)                                                                                                                                                                                 | every attempt has a Shot                                                             | **Shot-only by query** (`shot_id is not null`; memory keeps subjects separately)                                                                                        |
| `listProjectGenerations` (Generations page)                                                                                                                                                                                                                               | `attempt.shotId` maps to a Shot; `generations-view.tsx:197` uses `shotById.get(..)!` | **Shot-only by query**; the `!` is preceded by a `shotById.has` filter                                                                                                  |
| Model history (`candidates-postgres.ts`)                                                                                                                                                                                                                                  | per-Shot attempt rows                                                                | **Shot-only by query**                                                                                                                                                  |
| `getAttemptView(id)` (`/generations/[attemptId]`, the continuity page, media actions)                                                                                                                                                                                     | parses a Shot attempt                                                                | **fixed**: a subject id is "not found" (the page 404s)                                                                                                                  |
| `reviewAttempt(id)` (approve / reject)                                                                                                                                                                                                                                    | parses a Shot attempt                                                                | **fixed**: a subject id is "not found"                                                                                                                                  |
| Shot submission replay (idempotency key)                                                                                                                                                                                                                                  | the key's attempt is a Shot attempt                                                  | **fixed**: a cross-kind key is refused ("belongs to another generation")                                                                                                |
| Subject submission replay                                                                                                                                                                                                                                                 | the key's attempt is a subject attempt                                               | **fixed**, the same way                                                                                                                                                 |
| Episode-edit readers (`episode-edit-postgres.ts` by id, and approved-by-shot)                                                                                                                                                                                             | edit references are Shot attempts                                                    | **Shot-only by query**                                                                                                                                                  |
| Worker claim, update, finalize, cancel                                                                                                                                                                                                                                    | none (frozen request and plan only)                                                  | **subject-neutral** (`WorkerAttempt`)                                                                                                                                   |
| `attempt.shotId` consumers in domain, pages and continuity: `asset-usage`, `edit/eligibility`, `edit/proposal`, `generated-production-frame`, `animation`, `shot-sequence`, `pipeline`, `media-actions`, `episode-edit-media`, `continuity/service`, the generation pages | Shot attempts                                                                        | **safe by construction**: their inputs are the Shot-only readers above                                                                                                  |
| `asset-usage` for a subject output Asset                                                                                                                                                                                                                                  | its attempt is in Shot history                                                       | **fixed (0051 shared-database compatibility gate, #64)**: deletion follows actual references; an unreferenced subject image is deletable with its attempt kept (see §5) |

**Evidence:**

- Memory: `src/data/__tests__/attempt-subject-compat.test.ts`, 5/5, with subject attempts present (queued and
  succeeded).
  - Old Shot data reads exactly as before.
  - The generations listing stays Shot-only.
  - The Shot attempt view and review say "not found" for a subject id.
  - A cross-kind key is refused.
  - Asset usage does not crash.
- Postgres (disposable, at 0051): `scripts/db-generation-subjects.mts`, **28/28**, now including the three Shot-reader and three asset-delete
  gate checks. The existing `db:generation` passes 71/71 on the same database.

**Remaining before 0051 reaches shared DEV:** the asset-usage gap is closed (§5); what remains is re-running this gate against whatever
build is then deployed.

## 11. Preview strategy (prepared, not created)

When owner acceptance needs a hosted run:

1. Create a **Supabase preview branch** of the Prism Studio project, which gets its own database and ref. Apply
   0001 → head (including 0051) there only.
2. Add **Preview-scoped** environment variables to the existing `prism-studio` Vercel project. Production variables are
   never touched. Deploy the integration branch as a **preview** deployment, never with `--prod`, so the live alias
   `prism-studio-tawny.vercel.app` is unaffected. All Deployments protection already covers previews.
3. **Environment guard:** a preview branch has its own ref, and 5A's guard allows a non-DEV ref only for `rehearsal` or
   `production`. The preview therefore runs as `rehearsal` (test tooling allowed, never DEV), or a `preview`
   environment is added to both guards with the parity test.
4. Workers for that preview: the staging workers project at 0 instances is not pointed at the branch. A preview run
   uses the in-process mock path or a temporary worker container against the branch.
