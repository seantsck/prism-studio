"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PhotoDropZone, usePhotoUpload } from "@/components/studio/photo-upload";
import type { StudioState } from "@/server/reference-studio";

type Subject = NonNullable<StudioState["selected"]>;

/**
 * "3. Photos" on a Character's page: the Reference Studio's own upload (drop or choose several photos, each checked and
 * shown for what will really be sent, then uploaded). Uploaded photos join the Character's pictures and are what
 * "4. Six views" makes every view from.
 */
export function CharacterPhotoUpload({
  slug,
  subject,
  maxUploadBytes,
  hasPhotos,
}: {
  slug: string;
  subject: Subject;
  maxUploadBytes: number;
  /** true: the Character already has photos, so the drop area stays compact */
  hasPhotos: boolean;
}) {
  const router = useRouter();
  const upload = usePhotoUpload({ slug, subject, maxUploadBytes, onAdded: () => router.refresh() });
  const [dragging, setDragging] = useState(false);
  return (
    <div
      data-testid="character-photo-upload"
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer.types).includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        upload.add(Array.from(e.dataTransfer.files));
      }}
    >
      <PhotoDropZone
        upload={upload}
        subject={subject}
        maxUploadBytes={maxUploadBytes}
        roomy={!hasPhotos}
        dragging={dragging}
      />
    </div>
  );
}
