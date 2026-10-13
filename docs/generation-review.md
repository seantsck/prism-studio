# Generation review

Provider output is never automatically canonical. A person reviews it, and only that decision changes what the
shot points at.

## Two independent states

| Field                | Values                                        | Written by           |
| -------------------- | --------------------------------------------- | -------------------- |
| `status` (execution) | queued, running, succeeded, failed, cancelled | the worker (via job) |
| `review_status`      | unreviewed, approved, rejected                | the user             |

`approved` (boolean) must equal `review_status = 'approved'` (a CHECK constraint) and a unique partial index
allows **at most one approved attempt per shot**.

## Actions (`reviewGeneration`)

| Decision | Effect                                                                                                                       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| approve  | only a **succeeded** attempt; supersedes the shot's previously approved attempt (it returns to _unreviewed_, history intact) |
| reject   | structured categories and/or free text; the attempt, its output and its package stay forever                                 |
| clear    | back to unreviewed                                                                                                           |
| notes    | notes only                                                                                                                   |

Rejection categories: identity drift, wrong wardrobe, wrong set, wrong camera, bad motion, extra person, bad
anatomy, bad lip sync, bad audio, timing, artifact, other. A rejection requires at least one category or a reason.

Approving does **not** touch the storyboard or the shot's production data. The canonical result is simply
`attempt.output_asset_id` of the approved attempt, linked through `generation_outputs`.

## Review writes are narrow

`reviewAttempt` is a targeted `UPDATE` of review columns inside one transaction, not a full-row upsert, so a
worker finishing an attempt and a user reviewing it cannot overwrite each other. The history guard trigger
additionally rejects any change to the creative request (package, prompt plan, request, compatibility,
provider/model, attempt number).

## What you can inspect later

For any attempt, forever: the frozen brief and package (JSON or text download), the PromptPlan, the provider
request summary, which features were ignored and acknowledged, every status change with its reason, estimated and
actual (or unknown) cost, and every output with its role and provenance. Two attempts can be compared side by
side, including which production parts (Look, set, camera, timing, …) differed between their packages.

## Automated continuity QA

Not implemented. Outputs are linked so Phase 2C checks can attach to `attempt_id` ([roadmap](roadmap.md)).
