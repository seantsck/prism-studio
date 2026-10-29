# Automatic Shot QA (Phase 3A.2)

**Why should the filmmaker have to remember to press "Run QA"?** Phase 3A.2 establishes QA automatically whenever a
succeeded Shot output becomes reviewable and whenever its delivery subject changes. The default path is:

`generation succeeds → free deterministic QA appears automatically`

No provider credential, no paid call, no external media, no button. Semantic (model) QA can also become automatic, but
only under an explicit, persisted Project policy. Automatic QA **creates QA runs only**: it never approves, rejects,
retries, regenerates or selects anything, and it never changes `reviewStatus`, the approved attempt, Best, Production
Frame / Location View / Character Lock selections or Episode Edits.

## Orchestration boundary

| Role                  | What it does in 3A.2                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| Signed-in application | Decides from reads whether QA is due; runs the explicit `reconcileAttemptQa` under the user's owner RLS |
| Generation worker     | **Nothing new.** It still cannot read QA tables, Project truth or the QA policy                         |
| Continuity worker     | Executes an already-frozen, already-authorised semantic job, as in 2D. It never reads the policy        |

`reconcileAttemptQa` (`src/continuity/automation.ts`) reloads the attempt, its current delivery, its runs and jobs, the
Project policy, the runnable analyzers and the server's global analysis policy, then returns transparent outcomes:
`not_eligible`, `already_current`, `deterministic_created`, `semantic_suggested`, `semantic_queued`,
`semantic_already_queued`, `semantic_blocked`, `failed`, each with concrete reasons.

Reads stay reads: `loadProject`, `loadAttemptMedia` and repository GETs never write. `loadAttemptMedia` only computes an
`AutoQaView` (is QA due? what is the automation state?).

## Triggers: eventually automatic, authenticated

- **Generation completes while the page is open.** The existing `GenerationPoller` refreshes the page when the job
  succeeds; the Attempt card (and the continuity page) sees `autoQa.due` and a small client component
  (`AutoQaReconciler`) calls the reconciliation once per due truth (`dueKey`).
- **Prism was closed when the generation finished.** The next authenticated visit to a surface showing that attempt
  does it. There is **no always-on privileged scheduler**: this is an _eventually automatic authenticated
  reconciliation_, not background automation.
- **Delivery conform** and **delivery-master selection** reconcile right after their own write succeeds. If QA fails,
  the conform / selection stays done; the failure is reported separately (and the card retries when it is next shown).

Duplicate observations (two tabs, re-renders, a retry) are harmless: the reconciliation is idempotent and the database
is the authority.

## Eligibility

The same as a manual continuity review: the attempt belongs to the Project, its status is `succeeded`, a subject exists
(selected delivery master, else the provider primary output) and the Shot's production truth can be assembled.
Running, failed and cancelled generations get no QA run.

## Automatic deterministic QA (the baseline)

`ensureDeterministicQaRun` probes the subject on the server and records the frozen criteria, references, fingerprints
and the deterministic findings (duration, aspect ratio, resolution, fps, container, audio, delivery master). It uses
**no analyzer** (not even Mock, which is demo semantic analysis), makes **no external request**, costs **$0**, needs no
provider configuration or consent, and **creates no review frames or contact sheet**. The run is visible through the
3A.1 Shot QA projection like any other.

**Idempotency.** Each automatic deterministic run carries `automation_key =
hash(auto-deterministic-v1 | attempt | subject | criteria | references | package | rulesVersion)` (no wall-clock time).
`continuity_runs_automation_key` is unique per Project when set, and creation runs under the attempt row lock, so two
tabs or two requests create **one** run. Manual runs leave the key null, so a person can always re-run the same truth.

## Semantic modes (Project policy)

| Mode        | Behaviour                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| `off`       | Default for every Project (also with no policy row). Deterministic only; 0 external calls, 0 media sent |
| `suggest`   | Deterministic QA plus "Semantic QA suggested". No job, no request, no spend; the manual flow stays      |
| `automatic` | Queues semantic QA through the existing `submitAnalysis` when every gate passes                         |

**Standing consent.** Manual analysis asks for a per-run acknowledgement. Automatic mode cannot, so saving `automatic`
**is** the standing authorisation, and it is never implied: the policy needs an analyzer, explicit consent to send the
frozen media named by each run's external-media manifest, a finite per-run ceiling and a finite 24-hour Project
ceiling (enforced by the database too), and the settings page requires an explicit confirmation that summarises the
analyzer, the media that may leave Prism, both ceilings and that it is standing. Possessing an API key implies nothing,
and `suggest` is never promoted.

**Gates, in order** (any failure → `semantic_blocked` with the reason, and deterministic QA still runs):

1. policy completeness (analyzer, consent, finite ceilings);
2. the analyzer is enabled and runnable here (credential / config present, model known);
3. the plan has at least one analysable criterion;
4. the Project per-run ceiling and the Project 24-hour ceiling (an unknown estimate never auto-submits);
5. the server's **global** analysis gate (paid analysis switched on, per-run and rolling daily limits), unchanged;
6. the existing per-Project active-job limit and transport ceilings.

A Project ceiling can only be stricter: it never raises a global limit. Spend uses the existing ledger
(`continuity_analysis_costs`); there is no second ledger.

**One run per truth.** When automatic semantic QA is queued, its run already contains the deterministic findings, so no
separate deterministic run is created for the same truth. The job uses the existing idempotency key
(subject, criteria, references, analyzer, version, model, rubric) with the stable nonce `auto-semantic-v1`; the
existing `unique (project_id, idempotency_key)` makes repeats return the same job. A manual analysis keeps a fresh nonce,
so a person can still re-run on purpose (with the per-run acknowledgement).

The frozen external-media manifest is the same as for a manual run: eligible assets, what was sent, checksums,
derivatives, omissions, analyzer and model. No signed URL is stored.

## Freshness and history

A changed Production Frame, Location View, Character Lock, delivery master, production truth or rules version makes the
old run stale exactly as in 3A.1, and gives a **new** automatic identity, so the next reconciliation establishes QA for
the new truth. Old runs are never refreshed or rewritten.

Policy changes govern **new** submissions only: `off → automatic` lets the next reconciliation queue semantic QA;
`automatic → off` stops future semantic jobs and does not cancel a job that was validly authorised and queued.

**Phase 3A.3 coverage** ([temporal-video-qa](temporal-video-qa.md)): an automatic semantic run includes the full
output video only with the Project's separate `direct_video_allowed` (0045, default false) AND the standing
`external_media_allowed`. The automatic identity names the analyzer version and, only when the full video is planned,
a `temporal` coverage flag. So a newer analyzer, or newly allowed full video, queues ONE new run for unchanged truth
without calling the older run stale. Turning full video off again queues nothing new.

## Failure behaviour

A QA infrastructure failure (ffmpeg unavailable, object missing, checksum mismatch, database error) returns `failed`
with "Automatic QA could not run: …". Generation stays succeeded, the delivery selection stays selected, creative review
is unchanged. A QA infrastructure failure is not a creative failure.

## UI

- **Shot QA page** (`/projects/<slug>/qa`): "Automatic deterministic QA · Always on" (server-side, no external model,
  no AI fee); semantic mode, analyzer, per-run and 24-hour ceilings, media consent, server blockers, and the standing
  authorisation confirmation for Automatic. Revisioned with optimistic concurrency: a stale page gets a conflict and
  overwrites nothing.
- **Attempt card / continuity page**: automation facts (`Automatic deterministic QA · current`, `Semantic QA suggested`,
  `Semantic QA queued automatically`, `Semantic auto-analysis blocked — …`, `Semantic automation off`) shown next to,
  never merged with, the 3A.1 Shot QA state.

## Persistence: migration 0044 (applied to hosted DEV)

- `project_qa_policies`: one owner-only row per Project (`semantic_mode` default `off`, `analyzer`,
  `external_media_allowed` default false, `max_cost_per_run_usd`, `max_cost_per_day_usd`, `revision`, `updated_by`,
  `updated_at`), with database checks that `automatic` is fully explicit and the run ceiling ≤ the day ceiling. RLS
  owner read/write; `anon`, `prism_generation_worker` and `prism_continuity_worker` get nothing.
- `continuity_runs.automation_key`: nullable, unique per Project when set, frozen by the run guard; historical rows
  stay null. The continuity worker's column-level grants on runs do not include it.

Before 0044 is applied, a Supabase-mode app keeps working: the policy reads as the default (off), and a cheap catalog
check (`automationReady`) makes every attempt "not eligible: Automatic Shot QA needs database migration 0044", so no
reconciliation is due, the page fires none, and nothing reads or probes media for a run the database cannot record.
Manual Run QA and manual analysis are unchanged. 0044 was applied to hosted DEV on 2026-10-28 through the
explicitly authorised gate (`db:migrate:check`, `db:migrate`, then `db:validate`, `db:behavior`, `db:rls`,
`db:worker-role`).

## Tests

- `src/continuity/__tests__/automation.test.ts`: policy validation, decisions, budgets, identities, and the real
  service over the memory repositories (ffmpeg, Mock, OpenAI fake transport): one automatic run under concurrency,
  manual re-runs, delivery changes, suggest/off/automatic, every blocker, costs, failures.
- `src/data/__tests__/migration-0044.test.ts`: static SQL checks (0043 ledger checksum unchanged, narrow scope, frozen
  key, explicit automatic, owner RLS, no worker grant).
- `e2e/zzzzzzzzzzzzzzzzzzzzzz-automatic-qa.spec.ts` on its own memory server (it changes the Project policy).
