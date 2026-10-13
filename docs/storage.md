# Storage

Assets are database rows that record where their bytes live (`storage_provider`, `bucket`, `object_path`).
`src/server/storage.ts` hides the provider behind:

```ts
interface StorageProvider {
  name: "local" | "supabase";
  bucket: string | null;
  put(objectPath, bytes, contentType);
  get(objectPath);
  signedUrl(objectPath, ttlSeconds?): Promise<string | null>; // null = cannot sign (local disk)
  remove(objectPath);
}
```

| Provider           | Mode     | Where                                       | Access                                                                                 |
| ------------------ | -------- | ------------------------------------------- | -------------------------------------------------------------------------------------- |
| `LocalDiskStorage` | memory   | `.local-storage/<objectPath>` (git-ignored) | Streamed by `/api/assets/[id]`; path escapes rejected. **Dev only.**                   |
| `SupabaseStorage`  | supabase | private bucket `prism-assets`               | The signed-in user's own session client, so Storage RLS applies; reads via signed URL. |

`getUploadStorage()` chooses the provider for new uploads; `storageForAsset(asset)` the provider that already
holds an asset's bytes (returns `null` for placeholders without an object, or a Supabase asset while in memory mode).

## Bucket and policies (`0010_storage.sql`)

- Bucket `prism-assets`: `public = false`, `file_size_limit = 52428800` (50 MB), `allowed_mime_types` list of
  images (png, jpeg, webp, gif, avif), audio (wav, mpeg, mp4, aac, ogg, flac, webm, x-m4a), video (mp4, webm,
  quicktime), `application/pdf`, `text/plain`, `application/json`, `model/gltf-binary`.
- Helper `public.storage_object_project_id(name)` returns the uuid in the first path segment, or `null` if it is
  not a uuid (a bare cast would raise instead of deny).
- Four policies on `storage.objects` for role `authenticated` (select / insert / update / delete), each:

```sql
bucket_id = 'prism-assets' and public.is_project_owner(public.storage_object_project_id(name))
```

No `anon`/`public` policy touches the bucket; `db:validate` fails if one does or if the bucket is public.

## Object keys

```
<project_id>/<asset_id>/<sanitised filename>        e.g. 5b1c…/9f2e…/take_2.wav
```

Built only by `buildObjectPath` (`src/lib/storage-paths.ts`): both ids must be UUIDs; `safeFileName` strips
directories, control characters, `..`, non-letter/digit punctuation, caps at 100 characters. The first segment is
what the policy authorises on, so it is never user input. `assertPathInProject` validates the three-segment shape.
`assets` has a unique index on `(bucket, object_path)`.

## Reads: `/api/assets/[id]`

1. Reject non-UUID ids (404) and unauthenticated callers (401).
2. `repo.findAsset(id)` through the RLS-bound repository. Not visible → plain 404 (no existence hint).
3. Supabase asset → `307` to a signed URL valid **300 seconds**, `cache-control: private, no-store`.
4. Local asset → bytes streamed with `Content-Type` from the row, `nosniff`, `Accept-Ranges`, **HTTP Range**
   support (206/416) so audio can seek; only image/audio/video/pdf render inline, everything else is an attachment.

## Upload policy (`src/lib/upload-policy.ts`)

Applied in `ingestUpload` (`src/server/actions.ts`) before anything is stored. The browser's `file.type` and
filename are never trusted.

| Check                | Rule                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Not empty            | zero-byte files rejected                                                                                                                       |
| Extension block-list | exe, dll, bat, cmd, msi, ps1, sh, js, mjs, jar, html, htm, svg, xml, php, py, wasm, … rejected                                                 |
| Magic bytes          | PNG, JPEG, GIF, WebP, AVIF, WAV, MP3 (ID3/frame sync), MP4/M4A/MOV (`ftyp`), OGG, FLAC, WebM (EBML), PDF, glTF; anything else is "unsupported" |
| Allowed kinds        | per call site (a take accepts only `audio`; the library accepts image/audio/video/document)                                                    |
| Size                 | image 25 MB, audio 50 MB, video 50 MB (matches the bucket), document 10 MB; server-action body limit 55 MB                                     |
| Spoof check          | declared MIME family must match the sniffed family (audio/video container overlap tolerated)                                                   |

Audio-only call sites reinterpret WebM/MP4 containers as audio (MediaRecorder output); `analyzeAudio` then proves
they contain playable audio. See [asset-lifecycle](asset-lifecycle.md).

## Write ordering and cleanup

Upload order is: validate → analyse → `storage.put` → `repo.upsert(asset)`. If the database write fails the
object is removed (`discardUpload`, best effort). Deleting an asset removes the row, then the object. A failed
object removal can leave an orphaned object that nothing references.

## Not covered

No virus scanning, no image re-encoding/EXIF stripping, no per-user quotas, no CDN, no resumable uploads
(single server-action request, 55 MB cap). See [security-model](security-model.md) and [roadmap](roadmap.md).

## Generated outputs (Phase 2A)

Provider output never stays at the provider. The worker downloads/receives bytes, validates them with the
upload policy, writes them to `prism-assets/<project_id>/<asset_id>/<filename>` (same key convention, same RLS
policies for reads) and creates `assets` rows with `purpose = generation_output`, `source = provider_output`
and provenance in `metadata.generation`. `generation_outputs` links attempt → asset with role and position.
Outputs of an attempt cannot be deleted from the library while that attempt exists (history stays
interpretable). How the worker is authorised to write: [security-model](security-model.md#generation-and-outputs).
