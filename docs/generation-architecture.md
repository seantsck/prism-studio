# Generation architecture (Phase 2A)

Prism Studio's generation system is a durable, provider-independent pipeline. Providers will change often; the
filmmaking domain, the history of what was attempted, and the user's approval must not.

```
 Shot (live, editable)
   │  preflight + freshness + compatibility gate        (domain/generation/gate.ts)
   ▼
 GenerationPackage  ── frozen by value ──►  GenerationAttempt   immutable creative record
   │                                           │  promptPlan, request, compatibility, acknowledgements
   │ PromptPlan (sectioned intent)             ▼
   ▼                                        GenerationJob       mutable execution state (Postgres queue)
 GenerationRequest ── adapter compiles ──►  provider payload   private to src/generation/providers/*
                                              │
                          worker: submit → poll → fetch → validate → store → finalize
                                              ▼
                      Prism private Storage  ◄── GenerationOutput (ordered, role-tagged) → Asset rows
```

## The three layers that stay separate

| Layer               | What it is                                                         | Where it lives                                            | Changes?               |
| ------------------- | ------------------------------------------------------------------ | --------------------------------------------------------- | ---------------------- |
| `GenerationPackage` | What the filmmaker decided (characters, Looks, set, timing, audio) | `domain/generation-package.ts`, frozen in the attempt     | Never after submission |
| `PromptPlan`        | Provider-independent, sectioned statement of intent                | `domain/generation/prompt-plan.ts`, frozen in the attempt | Never after submission |
| `GenerationRequest` | Package + chosen model + normalized settings                       | `domain/generation/schemas.ts`, frozen in the attempt     | Never after submission |
| provider payload    | Whatever the provider's API wants                                  | Inside one adapter module                                 | Per provider           |

A provider adapter never sees loose UI state or a live `Shot`. The domain never sees a provider request body.

## Attempt ≠ Job

|           | `GenerationAttempt` (`generation_attempts`)                                    | `GenerationJob` (`generation_jobs`)                        |
| --------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Meaning   | "This exact brief, sent to this model, on this date" — historical evidence     | "The work of getting that attempt executed"                |
| Mutable?  | Creative request: **never**. Only execution result + review fields             | Constantly: status, lease, retry counters, provider job id |
| Contains  | frozen package, plan, request, compatibility, acknowledged ignored features    | provider job id, retry/lease/poll state, sanitized error   |
| Survives? | Forever (even if the model is retired, the character changes, pricing changes) | As operational record; events and costs are append-only    |

One attempt normally has one job. The schema allows several jobs per attempt (e.g. re-executing the **same frozen**
attempt after a provider outage) but a partial unique index guarantees at most one **active** job per attempt.
Operational retry reuses the same job and never alters creative intent. **"Generate again" creates a new
attempt** (new package, new fingerprint, new number).

Execution status (`attempt.status`: queued, running, succeeded, failed, cancelled) mirrors the job. **Review**
(`review_status`: unreviewed, approved, rejected, plus structured `rejection_categories`) is a separate column:
a successful generation is not an approved shot, and a rejected generation did execute.

## Derived shot lifecycle

Nothing about "where is this shot in generation" is stored on the shot. It is derived from three independent
state machines (`domain/generation/lifecycle.ts`):

| Derived state     | Source                                                        |
| ----------------- | ------------------------------------------------------------- |
| NOT READY / READY | preflight (prep state)                                        |
| QUEUED            | an attempt's job is `queued`                                  |
| GENERATING        | a job is submitting/submitted/processing/ingesting/cancelling |
| READY FOR REVIEW  | latest attempt succeeded and is unreviewed                    |
| NEEDS REDO        | latest attempt rejected, failed or cancelled (none approved)  |
| APPROVED          | one attempt approved (its output is the canonical result)     |

## Submission (atomic)

`startGeneration` (server action) → `prepareSubmission` (pure) → `createAttemptWithJob` (one transaction):

1. authorise (verified session; RLS) and load fresh project data;
2. preflight must be ready; approved storyboard must not be stale;
3. model must be enabled and configured; compatibility errors block;
4. every ignored feature must be **acknowledged** by id;
5. build package, plan, request; adapter-level validation; cost estimate;
6. in one transaction: lock the project row, replay-by-idempotency-key, refuse a second active generation for
   the shot, enforce the project's active cap and per-user submit rate, assign the attempt number, insert
   attempt + job + estimated cost + first event;
7. a shot that changed after the package was built (`shots.updated_at`) is refused (`stale_shot`), and so is ANY
   change to another package input (Look, take, location, asset, neighbouring shot...): the action reads
   `projectRevision()` before loading the project and the transaction compares it again (`stale_package`).

No job is created if any step fails. Double clicks replay (same key) or are refused (shot already active).

## Where the code lives

| Concern                       | Path                                                                |
| ----------------------------- | ------------------------------------------------------------------- |
| Pure domain (Zod, no I/O)     | `src/domain/generation/*`                                           |
| Provider contract, registry   | `src/generation/provider.ts`, `registry.ts`, `config.ts`            |
| Mock provider                 | `src/generation/providers/mock*.ts`                                 |
| Worker, ingestion, SSRF fetch | `src/generation/worker.ts`, `ingest.ts`, `safe-fetch.ts`, `sink.ts` |
| Persistence                   | `src/data/generation-{repository,memory,postgres}.ts`               |
| App integration               | `src/server/generation*.ts`, `src/components/generation/*`          |
| Worker process                | `scripts/generation-worker.mts` (`npm run worker:generation`)       |

See also: [generation-jobs](generation-jobs.md), [provider-contract](provider-contract.md),
[generation-review](generation-review.md), [providers/adding-a-provider](providers/adding-a-provider.md).

## Adaptation, conform and continuity QA (Phase 2C)

The compatibility engine now also builds a **GenerationAdaptationPlan** per model: when a provider cannot offer
the production ratio/duration the plan lists the usable strategies and recommends one, but the model stays
incompatible until the user explicitly chooses (and acknowledges) one. The chosen plan is frozen on the attempt
(`adaptation_plan`), the request carries the **provider canvas/duration** (`modelSettings.aspectRatio/durationMs`)
while the package snapshot keeps the **production** values. Provider-side prompt guidance lives in its own
PromptPlan section (`provider_adaptation`). After ingestion, an optional **delivery conform** (app server, ffmpeg)
creates a derived delivery master; **continuity QA** judges it. None of this touches the worker: see
[framing-adaptation](framing-adaptation.md), [delivery-conform](delivery-conform.md),
[continuity-qa](continuity-qa.md), [media-processing](media-processing.md).

## Multi-model production (Phase 2E)

```
 Shot ──► ShotGenerationRequirements + ShotFeatureProfile       (domain/generation/models/requirements.ts)
   │
   ├─► Model catalog ─► per-model fit matrix (what each model RECEIVES, adaptation, cost)
   │        │               + recommendation v1 (capability fit · human history · cost; advisory)
   ▼        ▼
 CandidateSet  (ONE frozen package) ─► N × (GenerationAttempt + GenerationJob) ─► worker (unchanged)
   │
   ├─► side-by-side compare ─► HUMAN review (append-only) ─► Best ─► explicit Promote to Shot
   └─► model performance (derived on demand from human reviews)
```

- The catalog is **versioned configuration** ([generation-model-catalog](generation-model-catalog.md)); the existing
  `GenerationModel` is derived from it so the compatibility engine, gate, registry and worker are unchanged.
- One Runway adapter dispatches by model **family** (`runway_gen4`, `veo`, `seedance`, `hailuo`); there is no
  provider class per model.
- A candidate set groups attempts; every candidate keeps its own attempt, job, events and costs. Failure isolation is
  structural. See [generation-candidate-sets](generation-candidate-sets.md).
- Candidate sets and reviews are **user-domain** tables: the generation and continuity workers have no grant on them.
- Nothing here assumes Runway: `CandidateSet`, reviews, performance and recommendation are provider-independent and a
  later direct provider adds a catalog entry and an adapter.

## Image-to-video from the Production Frame (Phase 2H)

The `animate_production_frame` purpose runs through the same package → compatibility → gate → request → attempt + job →
worker path. The domain adds hard source rules (a selected, fresh Production Frame; no conflicting manual override),
image-to-video only, motion-first PromptPlan wording, and one invariant checked twice (submission and the worker, before
`adapter.submit`): the request's start frame is the frozen Production Frame Asset. No new table, job type or package
version. See [image-to-video](image-to-video.md).
