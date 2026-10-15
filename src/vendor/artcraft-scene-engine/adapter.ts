// PRISM PATCH (replaces upstream adapter.ts, 336 LOC): the upstream interface mirrors the ArtCraft/Tauri host
// (generation enqueue, media listing, CDN URLs, accounts). The engine only ever calls the members below, so the
// boundary is reduced to exactly those. Prism implements it in `src/lib/previs/` (asset-id -> authorised URL).

export interface PageSceneSavePayload {
  saveJson: string;
  sceneTitle: string;
  sceneToken?: string;
  sceneThumbnail: Blob | undefined;
}

export interface PageSceneAdapter {
  saveScene(payload: PageSceneSavePayload): Promise<string>;
  loadScene(token: string): Promise<unknown>;
  fetchAsset(url: string, init?: { signal?: AbortSignal }): Promise<Response>;
  getMediaUrlByToken(token: string): Promise<string>;
  getMediaUrlsByTokens?(tokens: string[]): Promise<Record<string, string>>;
  getCurrentUserToken?(): string | undefined;
  onSceneTitleChange?(meta: {
    title: string;
    token?: string;
    ownerToken?: string;
    isModified: boolean;
  }): void;
}
