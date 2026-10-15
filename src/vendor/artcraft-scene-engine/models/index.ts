// PRISM PATCH: the upstream models barrel pulls in the ArtCraft media-library types. The store only needs an
// opaque drag item, which Prism never sets (it has no asset-drag UI in M1).
export type MediaItem = { media_id: string; name?: string; [key: string]: unknown };
export type { SceneGenereationMetaData } from "./sceneGenerationMetadata";
