# FLUX host decision record (research only, no code)

Researched 2026-11-07 from provider primary documentation, pricing and legal pages. **[V]** means verified on the
provider's own page, **[S]** means a secondary source only, **[U]** means not verified. No FLUX adapter exists, and none
will be written until the owner chooses a host.

New since the brief: **FLUX 3 Image** is BFL's latest model family, and FLUX.2 "remains fully supported" [V].

## Comparison

|                   | BFL direct (`api.bfl.ai`)                                                                                                                                | fal.ai                                                                                     | Replicate                                           | Together AI                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------ |
| Async             | submit, then `polling_url`, or a signed `webhook_url` + `webhook_secret` [V]                                                                             | queue: `status_url` / `response_url`, plus a webhook [V]                                   | predictions plus a signed webhook [V]               | synchronous only, no webhook [V]                 |
| Auth              | `x-key`; keys scoped per project [V]                                                                                                                     | `Authorization: Key` [V]                                                                   | `Bearer r8_…` [V]                                   | `Bearer` [V]                                     |
| Node SDK          | not listed [U]                                                                                                                                           | `@fal-ai/client` [V]                                                                       | `replicate` [U]                                     | `together-ai` [U]                                |
| Models            | FLUX 3 Image, FLUX.2 pro / max / flex / klein, Kontext pro / max, Fill pro, Expand, 1.1 pro / ultra [V, by page titles]                                  | FLUX 3 edit, FLUX.2 pro edit / flex, dev, schnell [V]                                      | 35 ids, including FLUX 3, FLUX.2, Kontext, Fill [V] | FLUX.2, Kontext, 1.1 pro [V]; no FLUX 3, no Fill |
| Inpainting        | Fill pro: a base64 black/white mask or the alpha channel [V]. FLUX 3 uses bounding boxes [V]                                                             | [U]                                                                                        | `flux-fill-pro` [V]; mask format [U]                | none [V]                                         |
| References        | FLUX.2 pro: 8 [V]. FLUX 3: 1–10, as URL or base64 [V]                                                                                                    | FLUX.2 edit: 9 [V]. FLUX 3 edit: 10 [V]                                                    | FLUX.2 pro: 8 [V]                                   | yes [V]                                          |
| Price             | FLUX.2 pro: $0.03 for the first MP, + $0.015 per extra MP. Kontext pro $0.04, max $0.08. Fill $0.05. FLUX 3: $0.048 (1K) / $0.10 (2K) / $0.607 (4K) [V]  | FLUX.2 edit: the same as BFL [V]                                                           | 1.1 pro $0.04 [V]; FLUX.2 [S, conflicting]          | FLUX.2 pro $0.03 [V]                             |
| Output            | a signed URL that **expires in 10 min** and has no CORS; jpeg / png / webp [V]                                                                           | CDN URL with a configurable expiry; I/O is retained 30 days unless `X-Fal-Store-IO: 0` [V] | authenticated URL, deleted after 1 h [V]            | `url` or `b64_json` [V]                          |
| Transparency      | not documented by any host; assume opaque [U]                                                                                                            |                                                                                            |                                                     |                                                  |
| Safety            | `safety_tolerance` 0–7, capped per org; above the cap returns 422 [V]                                                                                    | `safety_tolerance` plus a checker toggle [V]                                               | [U]                                                 | checker [V]                                      |
| Commercial / data | you own outputs and may use them commercially [V]. **BFL may train on inputs and outputs, and no opt-out is stated** [V]. EU and US region endpoints [V] | "Commercial use" badge [V]; the terms themselves [U]                                       | [U]                                                 | [U]                                              |

## Recommendation

**BFL's own API** (`api.bfl.ai`, or `api.eu.bfl.ai` if data residency matters).

- It is the only host where every needed capability was verified on one surface: FLUX 3 and FLUX.2, multi-reference
  editing, real pixel-mask inpainting (Fill), and Kontext.
- No reseller markup.
- Signed webhooks or polling, which fit the worker-owned key.
- Per-project keys.
- Region endpoints.
- It is the licence source of truth.

**Fallback: fal.ai.** Opt out of its 30-day I/O retention if chosen. Not recommended: Together (no inpainting, no
webhooks) and Replicate (FLUX.2 pricing not verified).

Fit with Prism: the worker must ingest the result into private Storage within BFL's 10-minute URL lifetime. The existing
worker already downloads and validates provider URLs through an allowed-host list, so that fits.

## Owner decisions needed before an adapter

1. **Training.** BFL's terms allow training on inputs and outputs. Is that acceptable for unreleased client material? If
   not, an enterprise no-training clause is needed.
2. **Region.** EU or US.
3. **v1 model scope.** FLUX 3 Image (box edits) or FLUX.2 pro (8 references, cheaper per MP)? Is true pixel-mask Fill
   needed?
4. **Safety-tolerance ceiling** for film content (raising it is an application to BFL).
5. **Resolution and budget:** 1K / 2K / 4K, and the spend cap.
6. **Transparency.** No FLUX host documents alpha output; use GPT Image or I3 background removal.
7. **Confirm before coding:** the exact endpoint paths (Kontext, Expand, ultra) and FLUX.2 `input_image` URL-vs-base64
   handling, from `https://api.bfl.ai/openapi.json`.

Key sources: bfl.ai/pricing; docs.bfl.ml (integration guidelines, FLUX 3 reference); bfl.ai/legal/developer-terms-of-service;
bfl.ai/legal/flux-api-service-terms; fal.ai/models/fal-ai/flux-2-pro/edit; fal.ai/docs (queue, media expiration);
replicate.com/docs (HTTP, data retention); together.ai/pricing; docs.together.ai/docs/images-overview.
