# Adding a provider

Adding provider X touches **one new folder and one registration line**. Nothing in the filmmaking domain, the
queue, the worker or the UI changes.

> Read first: [provider-contract](../provider-contract.md), [generation-jobs](../generation-jobs.md),
> [security-model](../security-model.md#generation-and-outputs).

## 0. Before writing code

1. Read the provider's **current official API documentation**. Do not rely on remembered request shapes.
2. Confirm an official API and a usable account exist. Do not scrape, reverse-engineer or use unofficial wrappers.
3. Decide how output is delivered (inline bytes vs. a provider-issued URL), whether it is async, whether it
   supports idempotency keys, cancellation and webhooks.
4. Never run paid test generations without explicit approval from the person who owns the account.

## 1. Create `src/generation/providers/<id>.ts`

```ts
export const X_PROVIDER_ID = "x";

export class XProvider implements GenerationProviderAdapter {
  constructor(private readonly credentials: { apiKey: string }) {}

  info() {
    return {
      provider: X_PROVIDER_ID,
      displayName: "Provider X",
      kind: "real" as const,
      description: "…",
      requiredConfig: [providerEnvName(X_PROVIDER_ID, "api_key")], // PRISM_STUDIO_PROVIDER_X_API_KEY
      webhooks: false,
    };
  }
  listModels() {
    /* declare ONLY capabilities the provider documents */
  }
  compileRequest(req, plan) {
    /* pure, no secrets; fixture-tested */
  }
  validateRequest(req, model) {
    /* provider-specific limits */
  }
  estimateCost(req, model) {
    /* from declared pricing; null amount if unknown */
  }
  async submit(req, plan, ctx) {
    /* map → HTTP; honour req.idempotencyKey */
  }
  async poll(ref, ctx) {
    /* map provider states → queued|processing|succeeded|failed */
  }
  async fetchResult(ref, req, ctx) {
    /* outputs + provenance + cost */
  }
  allowedOutputHosts() {
    return ["*.cdn.x.example"];
  }
}
```

### Rules

- **Capabilities**: declare exactly what the provider documents. Unknown pricing → `unitCost: null`.
- **Request compilation**: render `PromptPlan` sections the way this model wants them (single paragraph, tagged
  fields, separate inputs). Do not concatenate `GenerationPackage` yourself.
- **Inputs**: use `ctx.assets.read(assetId)` for frames/references/audio. Report which inputs you actually used
  in `provenance.usedInputs` (anything the model ignored must already be an acknowledged ignored feature).
- **Errors**: classify every failure with `GenerationProviderError`. Map HTTP 429 → `rate_limit`, 5xx/network →
  `provider_unavailable`/`transient`, policy refusals → `content_rejected` (never retried), 401/403 → `auth`,
  billing → `quota`, 400 → `invalid_request`.
- **Async**: return a `providerJobId` from `submit`; make `poll` stateless (everything it needs is the job id and
  the persisted poll count) so any worker, after any restart, can continue.
- **Outputs**: bytes, or URLs **returned by the provider** that match `allowedOutputHosts()`. Report
  width/height/duration/fps; Prism re-inspects the bytes and trusts those, not your claims.
- **Cost**: return `amount: null` when the provider does not bill-report. Prism records `unknown`; never guess.
- **Secrets**: read credentials from the constructor only; never log them, never put them in errors, request
  summaries or provenance. Use the redaction helpers (`src/lib/auth/redact.ts`).
- **Webhooks** (optional): implement `verifyWebhook` (constant-time signature check over the raw body) and
  `handleWebhook`; add a route that calls verify **before** parsing and transitions the job idempotently.

## 2. Register it

`src/generation/registry.ts`, in `createRegistry`:

```ts
const key = env[providerEnvName(X_PROVIDER_ID, "api_key")];
if (key) adapters.push(new XProvider({ apiKey: key }));
```

Enable it per deployment: `PRISM_STUDIO_GENERATION_PROVIDERS=x`. A registered-but-unconfigured provider shows
as **not configured (missing: PRISM_STUDIO_PROVIDER_X_API_KEY)** and cannot be selected.

Add the variable **names** (not values) to `.env.example`.

## 3. Tests (required)

| Kind             | What                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------- |
| Request fixtures | `compileRequest` snapshots for representative requests (no network)                      |
| Result fixtures  | canned provider responses → `fetchResult`/`poll` mapping, including every error category |
| Capability tests | compatibility results for 3A-like packages against your declared capabilities            |
| Contract test    | run the shared worker tests with your adapter behind a fake HTTP transport               |
| Opt-in live test | behind an explicit env flag, never in CI by default, never without approval of the spend |

Provider responses drift. Unit tests must not depend on live responses.

## 4. Security checklist

- [ ] no credential reaches the browser bundle, a snapshot, a brief export, a log line or an error message
- [ ] output URLs only from the provider response; host allow-list set; no redirects off the allow-list
- [ ] `allowedOutputHosts()` is as narrow as the provider's CDN allows
- [ ] webhooks (if any) verify the signature before parsing and are idempotent
- [ ] idempotency key forwarded when the provider supports it
- [ ] model ids and capabilities come from the provider's documentation, with a link in the file header

## 5. What is intentionally out of scope

Model routing, budgets, billing, automatic fallbacks and continuity QA are separate phases
([roadmap](../roadmap.md)). An adapter should not decide between models; it executes the one it was given.
