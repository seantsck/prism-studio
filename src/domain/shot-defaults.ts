import type { Shot } from "./schemas";

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export function emptyShot(
  base: Pick<Shot, "id" | "projectId" | "episodeId" | "sceneId" | "shotCode" | "title" | "order">,
): Shot {
  const now = new Date().toISOString();
  return {
    ...base,
    storyBeat: "",
    dramaticPurpose: "",
    status: "draft",
    targetDurationMs: null,
    durationMode: "manual",
    composition: {
      framing: "",
      shotSize: "",
      aspectRatio: "",
      cameraPosition: "",
      cameraHeight: "",
      cameraAngle: "",
      lens: "",
      aperture: "",
      movement: "",
      movementSpeed: "",
      notes: "",
    },
    spatial: {
      locationId: null,
      setZone: "",
      subjectBlocking: "",
      marks: [],
      facingDirection: "",
      eyelines: "",
      screenDirection: "",
      entryPoint: "",
      exitPoint: "",
      backgroundActivity: "",
    },
    characters: [],
    propIds: [],
    continuity: {
      previousShotId: null,
      wardrobe: "",
      hair: "",
      makeup: "",
      jewelry: "",
      props: "",
      lighting: "",
      weather: "",
      timeOfDay: "",
      vehicleInPlay: false,
      vehicleOrientation: "",
      characterCount: null,
      geography: "",
    },
    action: { beats: [], beginningPose: "", endingPose: "" },
    audio: {
      dialogueLineIds: [],
      preRollMs: 0,
      postRollMs: 0,
      interLineGapMs: 300,
      ambience: "",
      foley: "",
      musicCue: "",
      silenceRequirements: "",
    },
    lighting: {
      keyDirection: "",
      fill: "",
      practicals: "",
      colorTemperature: "",
      mood: "",
      referenceAssetId: null,
    },
    constraints: {
      hard: [],
      negative: [],
      forbiddenObjects: [],
      forbiddenPeople: [],
      forbiddenActions: [],
      generatorNotes: "",
    },
    scriptSources: { actionBlockIds: [], dialogueLineIds: [] },
    generation: {
      modality: "video",
      provider: null,
      model: null,
      referenceAssetIds: [],
      startFrameAssetId: null,
      endFrameAssetId: null,
      referenceVideoAssetId: null,
      referenceAudioAssetId: null,
      resolution: "1920x1080",
      fps: 24,
      protectedComposition: [],
    },
    approval: { storyboardApproved: false, performanceApproved: false, continuityApproved: false },
    createdAt: now,
    updatedAt: now,
  };
}

/** Build a shot from the empty template plus nested overrides (used by seeds and tests). */
export function makeShot(
  base: Parameters<typeof emptyShot>[0],
  overrides: DeepPartial<Omit<Shot, keyof Parameters<typeof emptyShot>[0]>> & Partial<Pick<Shot, "id">> = {},
): Shot {
  const shot = emptyShot(base);
  const merged: Record<string, unknown> = { ...shot };
  for (const [key, value] of Object.entries(overrides)) {
    const current = (shot as unknown as Record<string, unknown>)[key];
    merged[key] =
      value && typeof value === "object" && !Array.isArray(value) && current && typeof current === "object"
        ? { ...(current as object), ...(value as object) }
        : value;
  }
  return merged as unknown as Shot;
}
