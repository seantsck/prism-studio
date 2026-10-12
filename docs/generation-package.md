# Generation package

The generation package is the contract between Prism Studio and any downstream model. It is **normalized and
provider-independent**; provider adapters (Phase 2) translate it into provider-specific payloads.

```ts
import { buildGenerationPackage } from "@/server/generation-package";
const pkg = await buildGenerationPackage(shotId); // GenerationPackage
```

- `src/domain/generation-package.ts` — `assembleGenerationPackage(ctx)` (pure) and `renderGenerationBrief(pkg)`.
- `src/server/generation-package.ts` — `buildGenerationPackage(shotId)` loads the shot and calls the pure function.

## Shape (abridged)

| Key                              | Contents                                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `shot`                           | id, code, title, status                                                                                               |
| `storyIntent`                    | beat, dramatic purpose, scene (slugline, summary, emotional arc), episode                                             |
| `style`                          | visual style, color language, cinematography rules, aspect ratio (from Bible)                                         |
| `characters[]`                   | identity reference asset ids, **exact Look** (wardrobe, shoes, jewelry, hair, makeup…), expression, posture, gestures |
| `set`                            | location, locked flag, geography, zone, lighting, reference assets                                                    |
| `camera`, `blocking`, `lighting` | verbatim shot sections                                                                                                |
| `performance[]`                  | line text, language, locked flag, direction, **selected take** (duration, audio asset)                                |
| `timing`                         | effective duration + source + breakdown, action beats, poses, ambience/foley/music/silence                            |
| `continuity`                     | previous shot, weather, time of day, vehicle orientation, named count, project continuity rules                       |
| `constraints`                    | hard (shot + **derived**), negative, **project guardrails**, forbidden objects/people/actions                         |
| `references`                     | start/end frame (falls back to approved storyboard frame), reference assets/video/audio                               |
| `generation`                     | modality, provider, model, resolution, fps                                                                            |
| `readiness`                      | preflight result (ready, score, blockers, warnings)                                                                   |
| `prompt`                         | convenience positive/negative strings (adapters may ignore)                                                           |

### Derived constraints

Explicit stored state becomes explicit constraints so the model never has to infer them:

- named character count → `Only these named characters appear: … Do not add anyone else.`
- vehicle in play → `Vehicle orientation: …`
- locked location → `Set is locked: … Do not alter its geography.`
- locked Look → `<Name> wears locked Look "<Look>". Do not change it.`
- weather → `Weather: … Do not change it.`

## Generation Brief

`renderGenerationBrief(pkg)` produces titled sections for humans (shown in Shot Prep → Preflight and on the
Generations page): Story intent, Look & style, Characters, Set, Camera, Blocking, Performance, Timing, Audio,
Continuity, Hard/Negative constraints, Guardrails, References, Target, Readiness.

## Attempts

`logAttempt` snapshots the package into `generation_attempts.package_snapshot`. Attempts are append-only:
review fields (status, rejection reason, notes, approved) can change; prompt, snapshot and settings cannot.
Only one attempt per shot may be approved.
