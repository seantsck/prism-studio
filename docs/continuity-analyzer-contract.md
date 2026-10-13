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
