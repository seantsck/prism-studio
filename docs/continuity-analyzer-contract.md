# Continuity analyzer contract

`src/domain/continuity/analyzer.ts`. Provider-independent: no vendor SDK, no network, no project mutation.

```ts
interface ContinuityAnalyzer {
  id;
  version;
  kind: "mock" | "model";
  label;
  capabilities: AnalyzerCapability[]; // image_identity, wardrobe, object_presence, scene_match,
  // character_count, composition, lighting, video_temporal,
  // lip_sync, audio
  analyze(input: AnalyzerInput): Promise<AnalyzerFinding[]>;
}
```

**Input** (frozen): run/attempt ids, the subject (asset id, checksum, kind), review frames
(`atMs`, asset id, checksum), the reference set, and **only the criteria whose capability the analyzer declared**
(`criteriaFor`). Each criterion carries its expected value and where it came from: the analyzer is never asked to
infer production truth.

**Output**: per criterion `result` (`pass|warn|fail|n_a|unchecked`), `actual`, `confidence`, `notes`, `evidence`
(frame times / time range). Results are written while the run is `running`; the run then becomes `complete`
(or `failed` with a sanitized message) and is frozen. Humans can override any finding afterwards.

## Rules for implementers

- An analyzer **advises**. It must not approve, reject, retry generation or modify any project data.
- Declare exactly what you can judge; criteria outside your capabilities stay `unchecked` (that is information).
- Be deterministic where possible and record `version`; changing behaviour bumps it.
- Never put credentials, signed URLs or raw provider payloads in findings.

## Phase 2D: plugging in real analyzers

A real analyzer is a new class registered in `getContinuityAnalyzer()` (server) — nothing else changes:

| Candidate                       | Fits                                                          | Notes                                                                                      |
| ------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Gemini / OpenAI / Claude vision | wardrobe, scene_match, character_count, composition, lighting | send the contact sheet + reference thumbnails via signed URLs, server-side; budget per run |
| Face-identity models            | image_identity                                                | compare embeddings of frames vs identity refs; thresholds per project                      |
| CLIP / embedding models         | scene_match, object_presence                                  | similarity to location/prop references, calibrated per project                             |
| Temporal / audio models         | video_temporal, lip_sync, audio                               | would need frame sequences or the audio track                                              |

Because runs freeze analyzer id/version, kind and inputs, results from different analyzers remain comparable and
auditable. Cost of analysis would be recorded separately from generation cost (Phase 2F).

## Phase 2D: the real analyzer contract

`src/continuity/analysis/provider.ts` — `ContinuityAnalysisProvider`: `capabilities()`, `modes()`
(`image_set`, `direct_video`), `videoCapabilities()`, `plannerView()`, `estimate(input)`, `actualCost(calls)`,
`analyzeBatch({ batch, input, media, ctx })`, optional `cleanupFiles(refs)`. The Phase 2C `ContinuityAnalyzer`
remains for simple synchronous analyzers; `MockAnalysisProvider` is the free implementation of the new contract
and shares the contract suite with `GeminiAnalysisProvider` and `OpenAIContinuityAnalyzer`
(`src/continuity/analysis/__tests__/provider-contract.test.ts`: one finding per criterion, enums valid, evidence only
from the request's own inputs, no provider-supplied severity/approval, refusal ⇒ unchecked, usage absent ⇒ cost
unknown, estimate non-negative). Provider differences live behind the adapter; **Gemini and OpenAI implement the
same normalized analyzer contract**, so a finding looks identical whichever produced it.

Capability vocabulary (unchanged ids → the product's names): `image_identity` = identity visual similarity,
`wardrobe` = wardrobe/hair/makeup/jewelry, `object_presence` = props, `scene_match` = location/set/weather,
`character_count`, `composition` = composition/camera, `lighting` = lighting/time of day, `video_temporal` =
action/screen direction/eyelines over time, `lip_sync`, `audio`. An analyzer lists only what it can really judge.

Result schema (strict): `criterionId`, `result` (pass|warn|fail|unchecked), `confidence`, `summary`,
`evidence[]`, `contradictions[]`, `limitations[]`. Severity, expected value, approval and aggregate scores are
Prism-owned and rejected if returned. See [providers/gemini-continuity](providers/gemini-continuity.md) and
[providers/openai-continuity](providers/openai-continuity.md).

Adapter obligations (any provider): call `ctx.beforeTransportCall` immediately before **every** outbound request
(the worker counts it and enforces the ceiling); make exactly one transport invocation per call (no hidden retries,
SDK retries off); classify failures into the shared taxonomy; treat a timeout as ambiguous (`outcome_unknown`),
never re-send; map a provider refusal to `unchecked` + `provider_refusal`; report usage only as the provider
returned it. The analyzer model registry (`src/continuity/analysis/models.ts`) lists every provider/model pair
Prism will send to; provider capability is never product policy (media budgets come from the plan).
