# Shot QA (Phase 3A.1)

**Shot QA asks: did the generated output produce the Shot we asked for, what specifically appears wrong, and what
should the filmmaker review?** It is advisory. **Prism never approves or rejects a generation**: a person does.

Shot QA is a decision layer over the Phase 2C/2D continuity infrastructure (deterministic checks → frozen criteria and
reference set → analysis plan → durable analysis jobs → Gemini / OpenAI / Mock adapters → evidence → immutable findings
→ human overrides). It adds **no table, no column and no migration**: the assessment is a pure projection computed on
read from the stored run, its findings, the human overrides and the run's freshness.

## Three separate questions

| Question                                           | Answered by                          | Authority    |
| -------------------------------------------------- | ------------------------------------ | ------------ |
| Did the provider return media?                     | Generation status (`attempt.status`) | system       |
| Does the media appear to satisfy production truth? | **Shot QA** (this document)          | advice only  |
| Does the filmmaker accept it?                      | Creative review (`reviewStatus`)     | **a person** |

They are never collapsed into one score or status. Shot QA cannot change `reviewStatus`, the approved pointer, Best,
Production Frame / Location View / Character Continuity Lock selections, Episode Edit sources or any other creative
state. Nothing in it calls `reviewAttempt`.

## The decision projection (`src/domain/continuity/shot-qa.ts`)

`assessShotQa({ run, findings, freshness })` → `ShotQaAssessment`. Same inputs, same assessment. There is **no score**:
it reports concrete facts.

| State                  | Label                      | Meaning                                                                    |
| ---------------------- | -------------------------- | -------------------------------------------------------------------------- |
| `no_qa`                | No QA yet                  | No continuity run exists for this output.                                  |
| `qa_stale`             | QA stale                   | The run no longer describes the current output / production truth (why).   |
| `critical_mismatch`    | Critical mismatch          | A fresh, effective critical FAIL exists.                                   |
| `analysis_running`     | QA running                 | Analysis is queued / running; results are partial.                         |
| `needs_attention`      | Needs attention            | Fresh major / minor FAILs or any WARNING, no critical FAIL.                |
| `incomplete`           | Incomplete                 | Nothing failing, but a critical / major criterion is unchecked.            |
| `no_blocking_mismatch` | No blocking mismatch found | Nothing failing or warning in the evaluated criteria. **Not an approval.** |

Precedence is the table order: a stale run is reported as stale even if it recorded a critical failure, because an old
finding is not evidence about the current Shot. Minor unchecked criteria alone do not make a run "incomplete"; they stay
listed and counted.

The assessment also carries: the run (number, analysis status, analyzer kind), freshness and its reasons, counts
(critical / major / minor failures, warnings, unchecked, important unchecked, evaluated, n/a, overridden), the highest
problem severity, whether a human decision changed any result, every issue in priority order, and the suggested
rejection reasons.

### Issues and their order

An issue is every effective FAIL, WARNING and UNCHECKED criterion. It keeps the criterion key, category, severity,
effective result, system result, the latest human override, title, `sourceRef`, expected value, the observation
exactly as recorded (never invented; empty when nobody judged it), confidence (advisory), evidence items,
contradictions, limitations and, for an unchecked one, the frozen plan's reason.

Order (deterministic; ties by the criterion's frozen position, then key):

1. critical FAIL · 2. major FAIL · 3. minor FAIL · 4. critical / major WARNING · 5. minor WARNING ·
2. critical / major UNCHECKED · 7. minor UNCHECKED.

A Production Frame opening failure and a locked Character identity failure are critical, so they lead.

## Shot fidelity criteria (rules `3a.1`)

`CONTINUITY_RULES_VERSION` moved from `2c.1` to `3a.1` because criteria construction changed. Runs recorded under
`2c.1` stay readable exactly as frozen and are never rewritten; projected against today's rules they show **QA stale**
with the reason `Prism's QA criteria changed after this run (rules 2c.1 → 3a.1)…`. New criteria appear only on runs
created after the change.

### Production Frame fidelity

When the attempt was generated from a Production Frame (its frozen package carries `references.productionFrame`), the
run gets a `production_frame` criterion built from **that frozen frame** (id, version, Asset, checksum), never from the
frame selected today:

- **Image-to-video** (`animate_production_frame`, the frame was the exact first frame): critical, “Opening image —
  Production Frame vN”, expecting the opening image to preserve it.
- **Other Shot outputs generated from a frame**: major, “Production Frame vN fidelity”, expecting its visual intent.

It is judged semantically from the output review frames against that one reference (`referenceRoles:
["production_frame"]`: no Storyboard sketch is sent with it); without its reference image it stays unchecked. There is
no pixel equality on provider video.

### Location View fidelity

When the frozen package carries `references.locationView`, a `location_view` criterion (category location / set; major,
critical when the Location is locked) asks whether the output is recognisably that place and viewpoint, using the frozen
view's name and viewpoint words, against its frozen image only.

### Frozen truth vs today's selection

The reference set uses the attempt's frozen Production Frame / Location View image. If the Shot later selects another
frame or view (or none), the reference set gains a `selection_change` item (“The Shot now selects Production Frame v4;
this output was generated from v3.”). Its presence changes the reference fingerprint, so an older run becomes **QA
stale** through the normal freshness comparison and the reason says exactly what moved. The stored run is untouched.
Attempts generated without a frame / view behave exactly as before (today's selection is still offered as a reference
role to other criteria).

### Character Continuity Locks

Unchanged and authoritative: identity / wardrobe / hair / makeup / jewelry criteria already use a selected Lock's frozen
facts and images ([character-continuity-locks](character-continuity-locks.md)); newer library images never replace them.
Shot QA only surfaces those findings prominently: a locked identity or locked-Look failure is critical and is among the
first issues, and its suggestion names the Lock.

### Camera

The `2c.1` `camera` criterion combined shot size, framing and movement and was judged from stills. It is split:

- `camera_framing` (shot size + framing) — `composition`, judged from review frames;
- `camera_movement` (dolly, pan, tilt, crane, handheld…) — `video_temporal`, **unchecked** unless direct-video analysis
  is enabled and the analyzer declares `video_temporal`.

### Constraints

| Constraint         | Routing                           | Result without the capability    |
| ------------------ | --------------------------------- | -------------------------------- |
| `forbiddenObjects` | analyzer · `object_presence`      | unchecked                        |
| `forbiddenActions` | analyzer · `video_temporal`       | unchecked (temporal)             |
| `forbiddenPeople`  | manual (no reference to judge by) | unchecked until a person decides |
| hard constraints   | manual                            | unchecked until a person decides |

Lack of capability is never inferred as a pass.

### Temporal limitations

Action beats, screen direction, eyelines, geography, camera movement, forbidden actions and lip sync need temporal or
audio analysis. While direct-video analysis is disabled or uncalibrated they stay **unchecked** with the plan's reason
(“Needs direct-video analysis, which is not enabled. Stays unchecked.”). Phase 3A.3 addresses temporal QA.

## Suggested rejection reasons

Deterministic text composed from each finding's own fields (no model prose): every effective FAIL, and every critical /
major WARNING (prefixed “Possibly:”). Never from an unchecked criterion. Examples:

- `Yumeko's identity does not match the locked Character reference "Yumeko — evening".`
- `Yumeko's wardrobe differs from the locked Look "Black Evening".`
- `The opening image does not preserve Production Frame v3.`
- `The generated set does not match the selected Location View "Doorway".`
- `The Shot contains a forbidden object: red umbrella.`

The analyzer's observation is appended (`Observed: …`) only when it supports the effective result. A human override
changes the suggestion set: a reviewer FAIL → PASS removes it; a reviewer PASS → FAIL adds it with the reviewer's note
(`Reviewer: …`) instead of the analyzer's contrary observation. The immutable system finding stays in history.
Suggestions are withheld while the run is stale.

They are suggestions only: the Attempt card lists them inside the reject form and offers them as autocomplete options for
the reason field. The field is never pre-filled and nothing is submitted for the reviewer.

## UI

- **Continuity workspace** (`/generations/<attempt>/continuity`): a **Shot QA** summary sits above the detailed
  workspace: state, headline sentence, stale reasons, counts, the highest-priority issues (expected / observed / source,
  reviewer decisions, contradictions, limitations) and the suggestions. For Production Frame, Location View and Character
  issues it shows the expected reference image beside the output evidence frame, through the existing private Asset route
  (no new media). The criterion table, evidence, overrides and history stay underneath unchanged.
- **Attempt card**: “Shot QA: <state>” with counts, the top issues and **Review QA →**; the advisory beside Approve names
  the Shot QA state and first issue. Approve stays enabled whatever QA says.

## Freshness, privacy and cost

Freshness is the existing comparison of the run's frozen subject / criteria / reference fingerprints with current truth;
3A.1 adds specific reasons (which reference role changed, which selection moved, a rules-version change). Shot QA makes
**no analyzer call** and spends nothing: semantic analysis stays human-triggered and gated as in Phase 2D. Automatic
post-generation QA is Phase 3A.2.

## Provider independence

Gemini, OpenAI and the Mock analyzer still return the same normalized result (`result`, `confidence`, `summary`,
`evidence`, `contradictions`, `limitations`). Severity, expected values, approval, the assessment state and the
suggestions are Prism-owned; no provider can return or influence them.

## Tests

- `src/domain/continuity/__tests__/shot-qa.test.ts` — the assessment matrix (states, overrides, ordering, suggestions,
  freshness, no score).
- `src/domain/continuity/__tests__/shot-fidelity-criteria.test.ts` — Production Frame / Location View fidelity from
  frozen truth, Lock authority, camera split, constraint routing, fingerprints, backward compatibility.
- `src/continuity/__tests__/shot-qa-service.test.ts` — real stored runs (memory repositories, ffmpeg, Mock analyzer).
- `e2e/zzz-continuity-analysis.spec.ts` (memory, free) — summary, reviewer FAIL → mismatch + suggestion, card, human
  approval independent of QA, reviewer PASS clears it, stale and restored.
