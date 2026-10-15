import { describe, expect, it, vi } from "vitest";
import { ArtCraftSceneAdapter } from "../scene-adapter";

type Boundary = {
  getMediaUrlByToken(token: string): Promise<string>;
  fetchAsset(url: string, init?: { signal?: AbortSignal }): Promise<Response>;
  saveScene(): Promise<string>;
  loadScene(): Promise<unknown>;
};
const boundary = (a: ArtCraftSceneAdapter) => (a as unknown as { engineAdapter(): Boundary }).engineAdapter();

describe("ArtCraftSceneAdapter engine boundary", () => {
  it("resolves a Prism asset token to an application URL (an id, never a signed or storage URL)", async () => {
    const a = new ArtCraftSceneAdapter({ resolveAssetUrl: (id) => `/api/assets/${id}` });
    await expect(boundary(a).getMediaUrlByToken("m_6c1568797fb6-asset")).resolves.toBe(
      "/api/assets/6c1568797fb6-asset",
    );
  });

  it("rejects tokens that are not Prism asset ids (no ArtCraft media tokens or raw URLs)", async () => {
    const a = new ArtCraftSceneAdapter({ resolveAssetUrl: (id) => `/api/assets/${id}` });
    for (const bad of ["Parim", "https://cdn.example/a.glb", "", "m_"]) {
      await expect(boundary(a).getMediaUrlByToken(bad)).rejects.toThrow(/Unsupported asset token/);
    }
  });

  it("fetches assets with the browser's same-origin credentials only", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const a = new ArtCraftSceneAdapter({ resolveAssetUrl: (id) => `/api/assets/${id}`, fetchImpl });
    await boundary(a).fetchAsset("/api/assets/x");
    expect(fetchImpl).toHaveBeenCalledWith("/api/assets/x", {
      signal: undefined,
      credentials: "same-origin",
    });
  });

  it("never lets the engine persist a scene itself: persistence is Prism's", async () => {
    const a = new ArtCraftSceneAdapter({ resolveAssetUrl: (id) => id });
    await expect(boundary(a).saveScene()).rejects.toThrow(/Prism does/);
    await expect(boundary(a).loadScene()).rejects.toThrow(/Prism passes/);
  });

  it("reports nothing before it is mounted", () => {
    const a = new ArtCraftSceneAdapter({ resolveAssetUrl: (id) => id });
    expect(a.listObjects()).toEqual([]);
    expect(a.getProductionCamera()).toBeNull();
    expect(a.selectedId()).toBeNull();
    expect(a.canUndo()).toBe(false);
    expect(() => a.serializeScene()).toThrow(/not mounted/);
    expect(() => a.dispose()).not.toThrow();
  });
});
