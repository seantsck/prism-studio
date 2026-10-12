-- 0010: private production-assets bucket + ownership policies.
--
-- One private bucket, "prism-assets". Object path convention (enforced by policy, not by trusting filenames):
--     <project_id>/<asset_id>/<original filename>
-- The first path segment must be a project the caller owns (is_project_owner from 0003). Nothing is public;
-- reads go through short-lived signed URLs minted for an authorised session.
--
-- Idempotent: safe to re-run via scripts/db-storage-setup.mjs, which applies exactly this bucket upsert.

-- Returns the project uuid encoded in an object path, or null when the first segment is not a uuid.
-- (A bare ::uuid cast would raise instead of denying.)
create or replace function public.storage_object_project_id(object_name text) returns uuid
language sql immutable as $$
  select case
    when split_part(object_name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then split_part(object_name, '/', 1)::uuid
    else null end;
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'prism-assets', 'prism-assets', false, 52428800,
  array[
    'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif',
    'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/flac', 'audio/webm', 'audio/x-m4a',
    'video/mp4', 'video/webm', 'video/quicktime',
    'application/pdf', 'text/plain', 'application/json', 'model/gltf-binary'
  ]
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy prism_assets_select on storage.objects for select to authenticated
  using (bucket_id = 'prism-assets' and public.is_project_owner(public.storage_object_project_id(name)));
create policy prism_assets_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'prism-assets' and public.is_project_owner(public.storage_object_project_id(name)));
create policy prism_assets_update on storage.objects for update to authenticated
  using (bucket_id = 'prism-assets' and public.is_project_owner(public.storage_object_project_id(name)))
  with check (bucket_id = 'prism-assets' and public.is_project_owner(public.storage_object_project_id(name)));
create policy prism_assets_delete on storage.objects for delete to authenticated
  using (bucket_id = 'prism-assets' and public.is_project_owner(public.storage_object_project_id(name)));
