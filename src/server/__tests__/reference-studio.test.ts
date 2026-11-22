import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { readGenerationConfig } from "@/generation/config";
import { defaultStartingImages, opensOnStartingImages } from "@/domain/generation/reference-studio";
import { busyFixturePng, portraitFixturePng } from "@/generation/matting/fixture";
import { jpegHeader } from "@/lib/__tests__/jpeg-fixture";
import { createRegistry } from "@/generation/registry";
import { LocalDiskSink } from "@/generation/sink";
import { GenerationWorker } from "@/generation/worker";

/**
 * The Reference Studio through its REAL server actions on the memory store: the price before spending, the paid
 * confirmation, upload, creative review and the read model. GPT Image is listed as a PAID, worker-backed model with
 * NO key anywhere: the web prices and queues it, and nothing in this file can reach a provider.
 */
vi.setConfig({ testTimeout: 60_000 });
const world = vi.hoisted(() => ({
  repo: null as unknown,
  stored: new Map<string, Uint8Array>(),
  workerStarts: 0,
  env: {
    NODE_ENV: "test",
    PRISM_STUDIO_MOCK_STAGE_DELAY_MS: "0",
    PRISM_STUDIO_ENABLE_MOCK_PROVIDER: "1",
    PRISM_STUDIO_GENERATION_PROVIDERS: "mock,openai-image",
    PRISM_STUDIO_WORKER_BACKED_PROVIDERS: "openai-image",
    PRISM_STUDIO_ALLOW_PAID_GENERATION: "true",
    PRISM_STUDIO_MAX_GENERATION_USD: "2",
    // this server lists a real model AND the test models (a real deployment shows the test ones only when nothing
    // real can be used: see "where a real model can be used" below)
    PRISM_STUDIO_SHOW_TEST_MODELS: "1",
  } as Record<string, string>,
}));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/server/auth", () => ({ requireUser: async () => ({ kind: "memory", id: "tester" }) }));
vi.mock("@/server/repo", async () => {
  const { UserFacingError } = await import("@/server/action-result");
  return {
    getRepo: async () => world.repo,
    requireProjectFresh: async (slug: string) => {
      const r = world.repo as MemoryRepository;
      const data = await r.loadProject(slug);
      if (!data) throw new UserFacingError("That project no longer exists.");
      const lv = await r.locationViews.listForProject(data.project.id);
      const pf = await r.productionFrames.listForProject(data.project.id);
      const cc = await r.characterContinuity.listForProject(data.project.id);
      return {
        ...data,
        locationViews: lv.views,
        shotLocationViewSelections: lv.selections,
        productionFrames: pf.frames,
        productionFrameSelections: pf.selections,
        characterContinuityLocks: cc.locks,
        shotCharacterContinuitySelections: cc.selections,
      };
    },
  };
});
vi.mock("@/server/generation", async () => {
  const { readGenerationConfig: read } = await import("@/generation/config");
  const { createRegistry: create } = await import("@/generation/registry");
  return {
    getGenerationRepo: async (opts?: { startInlineWorker?: boolean }) => {
      if (opts?.startInlineWorker !== false) world.workerStarts += 1;
      return (world.repo as MemoryRepository).generation;
    },
    getGenerationConfig: () => read(world.env),
    getRegistry: () => create(world.env, read(world.env)),
  };
});
vi.mock("@/server/storage", () => ({
  checksum: (b: Uint8Array) => createHash("sha256").update(b).digest("hex"),
  getUploadStorage: async () => ({
    name: "local",
    bucket: null,
    put: async (p: string, b: Uint8Array) => void world.stored.set(p, b),
    get: async (p: string) => world.stored.get(p) ?? null,
    signedUrl: async () => null,
    remove: async (p: string) => void world.stored.delete(p),
  }),
  storageForAsset: async () => ({
    remove: async (p: string) => void world.stored.delete(p),
  }),
}));

import { archiveStudioImage, restoreStudioImage } from "../archive-actions";
import { deleteFromTrash, emptyTrash, moveToTrash, restoreFromTrash } from "../trash-actions";
import { purgeExpiredTrash } from "../trash";
import { trashOf } from "@/domain/trash";
import { referenceStudioState } from "../reference-studio";
import { quoteReferenceImage, reviewReferenceImage, uploadReferencePhoto } from "../reference-studio-actions";
import { replaceLookReference, saveAsCharacterReference, startSubjectImage } from "../subject-image-actions";
import {
  addToReferenceSet,
  approveCharacter,
  saveCharacterAppearance,
  setCanonicalIdentity,
} from "../visual-bible-actions";

const sinkRoot = mkdtempSync(path.join(tmpdir(), "prism-studio-"));
afterAll(() => rmSync(sinkRoot, { recursive: true, force: true }));
let repo: MemoryRepository;
let t = Date.now();
beforeEach(() => {
  repo = new MemoryRepository();
  world.repo = repo;
  world.stored.clear();
  world.workerStarts = 0;
});

const form = (fields: Record<string, string | File | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ projectSlug: "ojousama", ...fields }))
    if (Array.isArray(v)) for (const x of v) f.append(k, x);
    else f.set(k, v);
  return f;
};
const data = async () => (await repo.loadProject("ojousama"))!;
const yumekoOf = async () => (await data()).characters.find((c) => c.name === "Yumeko")!;
const lobbyOf = async () => (await data()).locations.find((l) => l.name === "Grand Celeste Lobby")!;
const png = (name: string, bytes = portraitFixturePng(96, 128)) =>
  new File([bytes as BlobPart], name, { type: "image/png" });
const attempts = async (characterId: string) =>
  repo.generation.listSubjectImageAttempts({ kind: "character", characterId });

/** The free test models only (the paid model has no key, so it could never be executed here anyway). */
async function work(ticks = 8) {
  const env = {
    ...world.env,
    PRISM_STUDIO_GENERATION_PROVIDERS: "mock",
    PRISM_STUDIO_WORKER_BACKED_PROVIDERS: "",
  };
  const config = readGenerationConfig(env);
  const worker = new GenerationWorker({
    store: repo.generation,
    registry: createRegistry(env, config),
    sink: new LocalDiskSink(sinkRoot),
    config,
    logger: { info() {}, warn() {}, error() {} },
    clock: () => new Date(t),
  });
  for (let i = 0; i < ticks; i++) {
    await worker.tick(5);
    t += 2000;
  }
}

const FREE = "mock/mock-image-1";
const PAID = "openai-image/gpt-image-2.5-flare";
const make = (characterId: string, extra: Record<string, string | string[]> = {}) => ({
  subjectKind: "character",
  subjectId: characterId,
  intent: "three_quarter",
  sources: "chosen",
  presetValue: "",
  direction: "",
  model: FREE,
  aspectRatio: "1:1",
  ...extra,
});

describe("add my photo", () => {
  it("keeps the original bytes, attaches it as an extra reference, and replaces nothing", async () => {
    const yumeko = await yumekoOf();
    const before = await data();
    const bytes = portraitFixturePng(96, 128);
    expect(
      await uploadReferencePhoto(
        form({
          subjectKind: "character",
          subjectId: yumeko.id,
          as: "reference",
          file: png("yumeko.png", bytes),
        }),
      ),
    ).toEqual({ ok: true, assetId: expect.any(String) });
    const after = await data();
    const added = after.assets.find((a) => !before.assets.some((b) => b.id === a.id))!;
    // the chosen file as it is: nothing says it is a copy
    expect(added.tags).toEqual(["identity"]);
    expect(added.metadata).toEqual({});
    expect(added).toMatchObject({
      type: "image",
      purpose: "identity_ref",
      source: "upload",
      mime: "image/png",
      width: 96,
      height: 128,
      byteSize: bytes.length,
      checksum: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(Buffer.from(world.stored.get(added.objectPath!)!).equals(Buffer.from(bytes))).toBe(true);
    const ref = after.identityRefs.find((r) => r.assetId === added.id)!;
    expect(ref).toMatchObject({ characterId: yumeko.id, slot: "additional", label: "Reference photo" });
    // every seeded slot is exactly as it was
    for (const r of before.identityRefs) expect(after.identityRefs.find((x) => x.id === r.id)).toEqual(r);
  });

  it("fills an EMPTY slot, and never replaces a slot that already holds an image", async () => {
    const yumeko = await yumekoOf();
    const file = () => png("front.png");
    expect(
      await uploadReferencePhoto(
        form({ subjectKind: "character", subjectId: yumeko.id, as: "front", file: file() }),
      ),
    ).toMatchObject({ ok: true });
    const front = (await data()).identityRefs.find((r) => r.characterId === yumeko.id && r.slot === "front")!;
    expect((await data()).assets.find((a) => a.id === front.assetId)!.source).toBe("upload");
    const assetsBefore = (await data()).assets.length;
    expect(
      await uploadReferencePhoto(
        form({ subjectKind: "character", subjectId: yumeko.id, as: "front", file: file() }),
      ),
    ).toEqual({
      ok: false,
      error:
        "Yumeko already has a front reference. Add this photo as an extra reference, or replace that slot on the Character page.",
    });
    // refused BEFORE storing: no orphan file, no new Asset
    expect((await data()).assets.length).toBe(assetsBefore);
    expect((await data()).identityRefs.find((r) => r.id === front.id)!.assetId).toBe(front.assetId);
  });

  it("a wardrobe photo joins its Look; a Location photo joins the Location; locks are respected", async () => {
    const yumeko = await yumekoOf();
    const d = await data();
    const look = d.looks.find((l) => l.characterId === yumeko.id)!;
    expect(look.locked, "the seeded Look is locked").toBe(true);
    const lookForm = () =>
      form({ subjectKind: "character", subjectId: yumeko.id, as: `look:${look.id}`, file: png("gown.png") });
    expect(await uploadReferencePhoto(lookForm())).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Look is locked/),
    });
    await repo.upsert(d.project.id, "looks", { ...look, locked: false });
    const worn = await uploadReferencePhoto(lookForm());
    expect(worn).toMatchObject({ ok: true });
    // the result names the stored image, so the Studio can show exactly that one
    expect((await data()).looks.find((l) => l.id === look.id)!.referenceAssetIds).toEqual([
      (worn as { assetId?: string }).assetId,
    ]);

    const lobby = await lobbyOf();
    if (lobby.locked) await repo.upsert(d.project.id, "locations", { ...lobby, locked: false });
    expect(
      await uploadReferencePhoto(
        form({ subjectKind: "location", subjectId: lobby.id, file: png("lobby.png") }),
      ),
    ).toMatchObject({ ok: true });
    const after = (await data()).locations.find((l) => l.id === lobby.id)!;
    expect(after.referenceAssetIds).toHaveLength(lobby.referenceAssetIds.length + 1);
    expect((await data()).assets.find((a) => a.id === after.referenceAssetIds.at(-1))).toMatchObject({
      purpose: "location_ref",
      source: "upload",
    });
  });

  it("a copy the browser made is stored as a copy: tagged, with the chosen file on record", async () => {
    const yumeko = await yumekoOf();
    const chosen = {
      name: "IMG_2041.jpg",
      bytes: 8598323,
      width: 3024,
      height: 4032,
      reasons: ["turned", "too_large"],
    };
    const result = await uploadReferencePhoto(
      form({
        subjectKind: "character",
        subjectId: yumeko.id,
        file: png("IMG_2041-copy-96x128.png"),
        copyOf: JSON.stringify(chosen),
      }),
    );
    expect(result).toMatchObject({ ok: true });
    const stored = (await data()).assets.find((a) => a.id === (result as { assetId?: string }).assetId)!;
    expect(stored.tags).toEqual(["identity", "browser-copy"]);
    expect(stored.metadata).toEqual({ uploadCopy: chosen });
    expect(stored.notes).toMatch(
      /^An upright, smaller copy made in the browser .* The file chosen was IMG_2041\.jpg \(3024 × 4032, 8\.2 MB\); it was not uploaded\.$/,
    );
    // what Prism itself read from the bytes is the copy's own size, never the browser's word
    expect(stored).toMatchObject({ width: 96, height: 128, originalFilename: "IMG_2041-copy-96x128.png" });
    // the Studio repeats the record where the picture is inspected
    const state = await referenceStudioState(await data(), `character:${yumeko.id}`);
    expect(state.images.find((i) => i.assetId === stored.id)!.inspection.notes.join(" ")).toMatch(
      /An upright, smaller copy made in the browser/,
    );

    // a record that does not hold together is dropped: the photo is stored as an ordinary upload
    const plain = await uploadReferencePhoto(
      form({
        subjectKind: "character",
        subjectId: yumeko.id,
        file: png("b.png"),
        copyOf: '{"name":"x","reasons":["because"]}',
      }),
    );
    const other = (await data()).assets.find((a) => a.id === (plain as { assetId?: string }).assetId)!;
    expect(other.tags).toEqual(["identity"]);
    expect(other.metadata).toEqual({});
    expect(other.notes).toBe("");
  });

  it("a photograph its camera stored turned keeps its bytes, and is described the way it is shown", async () => {
    const yumeko = await yumekoOf();
    // a portrait phone photograph: stored 4032 wide, flagged "turn a quarter"
    const bytes = jpegHeader({ width: 4032, height: 3024 }, { orientation: 6, littleEndian: true });
    const result = await uploadReferencePhoto(
      form({
        subjectKind: "character",
        subjectId: yumeko.id,
        file: new File([bytes as BlobPart], "IMG_0001.jpg", { type: "image/jpeg" }),
      }),
    );
    expect(result).toMatchObject({ ok: true });
    const stored = (await data()).assets.find((a) => a.id === (result as { assetId?: string }).assetId)!;
    expect(Buffer.from(world.stored.get(stored.objectPath!)!).equals(Buffer.from(bytes))).toBe(true);
    // the stored layout is recorded as it is, with the flag beside it
    expect(stored).toMatchObject({ mime: "image/jpeg", width: 4032, height: 3024 });
    expect(stored.metadata).toEqual({ exifOrientation: 6 });
    const state = await referenceStudioState(await data(), `character:${yumeko.id}`);
    expect(state.images.find((i) => i.assetId === stored.id)!.inspection).toMatchObject({
      width: 3024,
      height: 4032,
      orientation: "portrait",
      turned: true,
    });
    // an upright JPEG records nothing
    const upright = await uploadReferencePhoto(
      form({
        subjectKind: "character",
        subjectId: yumeko.id,
        file: new File(
          [jpegHeader({ width: 1200, height: 1600 }, { orientation: 1 }) as BlobPart],
          "upright.jpg",
          { type: "image/jpeg" },
        ),
      }),
    );
    expect(
      (await data()).assets.find((a) => a.id === (upright as { assetId?: string }).assetId)!.metadata,
    ).toEqual({});
  });

  it("refuses a file that is not an image, and a missing file", async () => {
    const yumeko = await yumekoOf();
    const text = new File(["not an image at all, just words"], "notes.png", { type: "image/png" });
    expect(
      await uploadReferencePhoto(form({ subjectKind: "character", subjectId: yumeko.id, file: text })),
    ).toMatchObject({ ok: false });
    expect(await uploadReferencePhoto(form({ subjectKind: "character", subjectId: yumeko.id }))).toEqual({
      ok: false,
      error: "Choose a photo to upload.",
    });
  });
});

describe("the price before spending", () => {
  it("a free test model costs nothing and says exactly what it would send; nothing is queued or started", async () => {
    const yumeko = await yumekoOf();
    await uploadReferencePhoto(form({ subjectKind: "character", subjectId: yumeko.id, file: png("a.png") }));
    const photo = (await data()).identityRefs.find((r) => r.label === "Reference photo")!.assetId!;
    world.workerStarts = 0;
    const q = await quoteReferenceImage(form(make(yumeko.id, { startAssetId: [photo] })));
    expect(q).toMatchObject({
      ok: true,
      paid: false,
      estimateUsd: null,
      operation: "reference",
      sending: [{ assetId: photo, label: "Yumeko reference photo" }],
      notSent: 0,
    });
    if (!q.ok) throw new Error("unreachable");
    expect(q.prompt).toMatch(/The same person as in the identity reference image/);
    expect(await attempts(yumeko.id)).toEqual([]);
    expect(world.workerStarts, "a price is a read: it never starts the worker").toBe(0);
  });

  it("a paid model shows the server's upper bound for THIS request: more for a starting image, more for higher quality", async () => {
    const yumeko = await yumekoOf();
    await uploadReferencePhoto(form({ subjectKind: "character", subjectId: yumeko.id, file: png("a.png") }));
    const photo = (await data()).identityRefs.find((r) => r.label === "Reference photo")!.assetId!;
    const paid = { model: PAID, aspectRatio: "2:3" };
    const words = await quoteReferenceImage(form(make(yumeko.id, paid)));
    const from = await quoteReferenceImage(form(make(yumeko.id, { ...paid, startAssetId: [photo] })));
    const high = await quoteReferenceImage(
      form(make(yumeko.id, { ...paid, startAssetId: [photo], quality: "high" })),
    );
    if (!words.ok || !from.ok || !high.ok) throw new Error("a quote was refused");
    expect(words).toMatchObject({ paid: true, operation: "text", sending: [] });
    expect(words.estimateUsd!).toBeGreaterThan(0);
    expect(from.estimateUsd!).toBeGreaterThan(words.estimateUsd!);
    expect(high.estimateUsd!).toBeGreaterThan(from.estimateUsd!);
    expect(from.endpoint).toBe("POST /v1/images/edits (gpt-image-2.5-flare)");
    expect(from.prompt).toMatch(
      /^Create a new image\. The reference images show who or what must be reproduced/,
    );
    expect(await attempts(yumeko.id)).toEqual([]);
  });

  it("says why a request cannot be made instead of pricing it", async () => {
    const yumeko = await yumekoOf();
    const other = (await data()).characters.find((c) => c.name === "Sean")!;
    await uploadReferencePhoto(
      form({ subjectKind: "character", subjectId: other.id, file: png("sean.png") }),
    );
    const seans = (await data()).identityRefs.find(
      (r) => r.characterId === other.id && r.label === "Reference photo",
    )!;
    expect(await quoteReferenceImage(form(make(yumeko.id, { startAssetId: [seans.assetId!] })))).toEqual({
      ok: false,
      reasons: ["That image does not belong to this subject."],
    });
    expect(await quoteReferenceImage(form(make(yumeko.id, { intent: "expression_variant" })))).toEqual({
      ok: false,
      reasons: ["Expression: say what it should be."],
    });
    expect(await quoteReferenceImage(form(make(yumeko.id, { model: "openai-image/nope" })))).toMatchObject({
      ok: false,
    });
  });
});

describe("a paid image starts only after the amount shown was confirmed", () => {
  it("is refused with no confirmation and with a smaller one, and queued with the quoted amount", async () => {
    const yumeko = await yumekoOf();
    const request = make(yumeko.id, { model: PAID, aspectRatio: "2:3" });
    const q = await quoteReferenceImage(form(request));
    if (!q.ok) throw new Error(q.reasons.join(" "));
    // one click with no price shown (the older panels): refused, and nothing is queued
    expect(await startSubjectImage(form(request))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^This image costs money: up to \$0\.0\d+\. Open the Reference Studio/),
    });
    expect(await startSubjectImage(form({ ...request, confirmedTotalUsd: "0.001" }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^The price is now up to \$0\.0\d+\. Confirm that amount/),
    });
    expect(await attempts(yumeko.id)).toEqual([]);

    expect(await startSubjectImage(form({ ...request, confirmedTotalUsd: String(q.estimateUsd) }))).toEqual({
      ok: true,
    });
    const [queued] = await attempts(yumeko.id);
    expect(queued!.attempt).toMatchObject({ provider: "openai-image", status: "queued" });
    expect(queued!.costs.find((c) => c.kind === "estimated")!.amount).toBe(q.estimateUsd);
  });

  it("a free model needs no confirmation (there is nothing to confirm)", async () => {
    const yumeko = await yumekoOf();
    expect(await startSubjectImage(form(make(yumeko.id)))).toEqual({ ok: true });
  });
});

describe("making, reviewing and promoting", () => {
  async function scene() {
    const yumeko = await yumekoOf();
    await uploadReferencePhoto(
      form({ subjectKind: "character", subjectId: yumeko.id, file: png("yumeko.png") }),
    );
    const photo = (await data()).identityRefs.find((r) => r.label === "Reference photo")!.assetId!;
    for (const intent of ["three_quarter", "profile_left"])
      expect(await startSubjectImage(form(make(yumeko.id, { intent, startAssetId: [photo] })))).toEqual({
        ok: true,
      });
    await work();
    const [second, first] = await attempts(yumeko.id);
    return { yumeko, photo, first: first!, second: second! };
  }

  it("each take records what it started from; the read model puts the creator's photo first and labels what Prism made", async () => {
    const { yumeko, photo, first, second } = await scene();
    expect(first.attempt.status).toBe("succeeded");
    expect(first.attempt.inputAssetIds).toEqual([photo]);
    expect(first.attempt.modelSettings).toMatchObject({
      intent: "three_quarter",
      operation: "reference",
      sourceAssetIds: [photo],
    });
    const state = await referenceStudioState(await data(), `character:${yumeko.id}`);
    expect(state.selected).toMatchObject({ kind: "character", name: "Yumeko", filledSlots: [] });
    expect(state.images.map((i) => [i.origin, i.label])).toEqual([
      ["uploaded", "yumeko.png"],
      ["generated", "Generated #2 · Left profile"],
      ["generated", "Generated #1 · 3/4 view"],
    ]);
    expect(state.images[0]).toMatchObject({
      originLabel: "uploaded original",
      roles: ["Reference"],
      inspection: { width: 96, height: 128, format: "PNG", verdict: "low", usableAsInput: true },
    });
    expect(state.images[1]!.originLabel).toBe("generated reference");
    // a picture a test model made is marked as one: a placeholder pattern, never a picture of the subject
    expect(state.images.map((i) => i.test)).toEqual([false, true, true]);
    expect(state.takes.map((t) => [t.number, t.what, t.operation, t.status])).toEqual([
      [2, "Left profile", "reference", "succeeded"],
      [1, "3/4 view", "reference", "succeeded"],
    ]);
    expect(state.takes[0]!.inputs).toEqual([
      { assetId: photo, label: "yumeko.png", url: `/api/assets/${photo}` },
    ]);
    expect(state.takes[1]!.attemptId).toBe(first.attempt.id);
    expect(second.attempt.attemptNumber).toBe(2);
    // a free test model reports a pretend cost: it is never shown as money billed
    expect(state.spent).toEqual({ usd: 0, images: 0 });
    expect(state.costHistory).toEqual([]);
    expect(state.takes[0]).toMatchObject({ paid: false, actualUsd: null, estimateUsd: null });
    // and its result is marked as what it is: a test model's placeholder pattern, never a real picture
    expect(state.takes.map((t) => t.test)).toEqual([true, true]);
    const subjects = state.subjects.filter((s) => s.kind === "character");
    expect(subjects.find((s) => s.name === "Yumeko")).toMatchObject({
      images: 3,
      thumbUrl: `/api/assets/${photo}`,
    });
    expect(subjects.find((s) => s.name === "Sean")).toMatchObject({ images: 0, thumbUrl: null });
  });

  it("a take is rejected with a reason, leaves the starting images, and can be restored; nothing is deleted", async () => {
    const { yumeko, second } = await scene();
    expect(
      await reviewReferenceImage(
        form({ attemptId: second.attempt.id, decision: "reject", category: "nope" }),
      ),
    ).toEqual({ ok: false, error: "Say what is wrong with it." });
    expect(
      await reviewReferenceImage(
        form({
          attemptId: second.attempt.id,
          decision: "reject",
          category: "identity_drift",
          reason: "nose is wrong",
        }),
      ),
    ).toEqual({ ok: true });
    let state = await referenceStudioState(await data(), `character:${yumeko.id}`);
    expect(state.takes[0]).toMatchObject({
      rejected: true,
      rejection: "Identity drift · nose is wrong",
      status: "succeeded",
    });
    expect(state.takes[0]!.asset, "the rejected picture is kept").not.toBeNull();
    expect(state.images.find((i) => i.attemptId === second.attempt.id)).toMatchObject({ rejected: true });
    expect(
      state.subjects.find((s) => s.name === "Yumeko")!.images,
      "it no longer counts as a usable picture",
    ).toBe(2);
    const stored = (await attempts(yumeko.id))[0]!.attempt;
    expect(stored).toMatchObject({
      reviewStatus: "rejected",
      approved: false,
      rejectionCategories: ["identity_drift"],
    });

    expect(await reviewReferenceImage(form({ attemptId: second.attempt.id, decision: "restore" }))).toEqual({
      ok: true,
    });
    state = await referenceStudioState(await data(), `character:${yumeko.id}`);
    expect(state.takes[0]).toMatchObject({ rejected: false, rejection: null });
    expect((await attempts(yumeko.id))[0]!.attempt).toMatchObject({
      reviewStatus: "unreviewed",
      rejectionCategories: [],
      rejectionReason: "",
      reviewedAt: null,
    });
  });

  it("promotion is the approval: the slot and the canonical identity point at the take, and a picture in use cannot be rejected", async () => {
    const { yumeko, first } = await scene();
    expect(
      await saveAsCharacterReference(
        form({
          characterId: yumeko.id,
          attemptId: first.attempt.id,
          slot: "three_quarter",
          guardReplace: "1",
        }),
      ),
      "the seeded slot is a locked placeholder with no image: there is nothing to protect",
    ).toEqual({ ok: true });
    expect(await setCanonicalIdentity(form({ characterId: yumeko.id, attemptId: first.attempt.id }))).toEqual(
      {
        ok: true,
      },
    );
    const state = await referenceStudioState(await data(), `character:${yumeko.id}`);
    expect(state.selected!.filledSlots).toEqual(["three_quarter"]);
    expect(state.takes.find((t) => t.attemptId === first.attempt.id)!.roles).toEqual([
      "Three quarter reference",
      "Canonical identity",
    ]);
    expect(state.subjects.find((s) => s.name === "Yumeko")!.thumbUrl).toBe(
      `/api/assets/${first.outputs[0]!.asset.id}`,
    );
    // the read model says which picture stands for the Character, and which one is the creator's own photograph:
    // that is what the Studio chooses its starting images from
    const pictures = state.images.map((i) => ({
      origin: i.origin,
      canonical: i.canonical,
      w: i.wardrobeOnly,
    }));
    expect(pictures.filter((i) => i.canonical)).toEqual([{ origin: "generated", canonical: true, w: false }]);
    expect(pictures.filter((i) => i.origin === "uploaded")).toEqual([
      { origin: "uploaded", canonical: false, w: false },
    ]);
    expect(defaultStartingImages(state.images)).toEqual([
      state.images.find((i) => i.origin === "uploaded")!.assetId,
    ]);
    expect(
      await reviewReferenceImage(
        form({ attemptId: first.attempt.id, decision: "reject", category: "artifact" }),
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/^This image is in use \(Yumeko · /) });
  });

  it("a Look's wardrobe photo is marked as such, so it is never offered as who the Character is", async () => {
    const yumeko = await yumekoOf();
    const d = await data();
    const look = d.looks.find((l) => l.characterId === yumeko.id)!;
    await repo.upsert(d.project.id, "looks", { ...look, locked: false });
    const gown = await uploadReferencePhoto(
      form({ subjectKind: "character", subjectId: yumeko.id, as: `look:${look.id}`, file: png("gown.png") }),
    );
    const face = await uploadReferencePhoto(
      form({
        subjectKind: "character",
        subjectId: yumeko.id,
        file: png("face.png", portraitFixturePng(100, 130)),
      }),
    );
    const state = await referenceStudioState(await data(), `character:${yumeko.id}`);
    const of = (r: unknown) => state.images.find((i) => i.assetId === (r as { assetId?: string }).assetId)!;
    expect(of(gown)).toMatchObject({ origin: "uploaded", wardrobeOnly: true, canonical: false });
    expect(of(face)).toMatchObject({ origin: "uploaded", wardrobeOnly: false, canonical: false });
    expect(defaultStartingImages(state.images)).toEqual([of(face).assetId]);
    // each picture carries when it was stored, which is what decides whether the stage opens on a photograph added
    // since the newest picture was made, or on that picture
    const stored = (await data()).assets.find((a) => a.id === of(face).assetId)!;
    expect(of(face).addedAt).toBe(stored.createdAt);
    expect(opensOnStartingImages(state.images, "2000-01-01T00:00:00.000Z")).toBe(true);
    expect(opensOnStartingImages(state.images, "2999-01-01T00:00:00.000Z")).toBe(false);
  });

  it("refuses to review another project's image, an unfinished one and an unknown decision", async () => {
    const yumeko = await yumekoOf();
    await startSubjectImage(form(make(yumeko.id)));
    const [queued] = await attempts(yumeko.id);
    expect(
      await reviewReferenceImage(
        form({ attemptId: queued!.attempt.id, decision: "reject", category: "artifact" }),
      ),
    ).toEqual({ ok: false, error: "Only a finished image can be reviewed." });
    expect(await reviewReferenceImage(form({ attemptId: queued!.attempt.id, decision: "bless" }))).toEqual({
      ok: false,
      error: "Choose Reject or Restore.",
    });
    expect(
      await reviewReferenceImage(
        form({ attemptId: "00000000-0000-4000-8000-000000000000", decision: "reject", category: "artifact" }),
      ),
    ).toEqual({ ok: false, error: "That image no longer exists." });
  });
});

describe("changing one image through the Studio's presets", () => {
  it("builds the instruction on the server from the preset, and never together with starting images", async () => {
    const yumeko = await yumekoOf();
    await uploadReferencePhoto(form({ subjectKind: "character", subjectId: yumeko.id, file: png("y.png") }));
    const photo = (await data()).identityRefs.find((r) => r.label === "Reference photo")!.assetId!;
    const change = {
      subjectKind: "character",
      subjectId: yumeko.id,
      intent: "portrait",
      model: FREE,
      aspectRatio: "1:1",
      sourceAssetId: photo,
    };
    expect(await quoteReferenceImage(form({ ...change, editPreset: "hair_color", editValue: "" }))).toEqual({
      ok: false,
      reasons: ["New hair colour: say what it should be."],
    });
    expect(
      await quoteReferenceImage(
        form({ ...change, editPreset: "hair_color", editValue: "auburn", startAssetId: [photo] }),
      ),
    ).toEqual({
      ok: false,
      reasons: ["Choose either an image to change or images to start from, not both."],
    });
    expect(
      await startSubjectImage(form({ ...change, editPreset: "hair_color", editValue: "auburn" })),
    ).toEqual({ ok: true });
    await work();
    const [edit] = await attempts(yumeko.id);
    expect(edit!.attempt.status).toBe("succeeded");
    expect(edit!.attempt.prompt).toMatch(
      /Change only this in the image being edited: Change the hair colour to auburn\. Keep the same hairstyle/,
    );
    expect(edit!.attempt.modelSettings).toMatchObject({
      editSourceAssetId: photo,
      operation: "edit",
      composer: { editPreset: "hair_color", editValue: "auburn" },
    });
    expect(edit!.attempt.inputAssetIds).toEqual([photo]);
    const state = await referenceStudioState(await data(), `character:${yumeko.id}`);
    expect(state.takes[0]).toMatchObject({ what: "Change", operation: "edit" });
    expect(state.takes[0]!.settings).toMatchObject({
      editSourceAssetId: photo,
      composer: { editPreset: "hair_color", editValue: "auburn" },
    });
    // the photograph itself is untouched
    expect(
      Buffer.from(world.stored.get((await data()).assets.find((a) => a.id === photo)!.objectPath!)!),
    ).toEqual(Buffer.from(portraitFixturePng(96, 128)));
  });

  it("a busy photograph is still accepted as an upload (the cutout tool's limits are its own)", async () => {
    const yumeko = await yumekoOf();
    expect(
      await uploadReferencePhoto(
        form({
          subjectKind: "character",
          subjectId: yumeko.id,
          file: png("busy.png", busyFixturePng(128, 128)),
        }),
      ),
    ).toMatchObject({ ok: true });
  });
});

describe("the Studio's read model", () => {
  it("with no subject it lists who and where; with an unknown one it selects nothing", async () => {
    const d = await data();
    const none = await referenceStudioState(d, undefined);
    expect(none.selected).toBeNull();
    expect(none.subjects.filter((s) => s.kind === "character").map((s) => s.name)).toEqual(
      d.characters.map((c) => c.name),
    );
    expect(none.subjects.filter((s) => s.kind === "location")).toHaveLength(d.locations.length);
    expect((await referenceStudioState(d, "character:not-a-real-id")).selected).toBeNull();
    expect((await referenceStudioState(d, "planet:mars")).selected).toBeNull();
  });

  it("names the Shots a subject appears in (where its references become a Production Frame), and what is locked", async () => {
    const d = await data();
    const yumeko = await yumekoOf();
    const state = await referenceStudioState(d, `character:${yumeko.id}`);
    const expected = d.shots.filter((s) => s.characters.some((c) => c.characterId === yumeko.id));
    expect(expected.length).toBeGreaterThan(0);
    expect(state.shots.map((s) => s.id).sort()).toEqual(expected.map((s) => s.id).sort());
    expect(state.shots.find((s) => s.code === "3A")).toMatchObject({
      href: expect.stringMatching(/^\/projects\/ojousama\/episodes\/[^/]+\/shots\/[0-9a-f-]+$/),
      hasFrame: false,
    });
    expect(state.selected).toMatchObject({ locked: false });
    expect(state.selected!.looks[0]).toMatchObject({ locked: true, references: 0 });
    const lobby = await lobbyOf();
    const place = await referenceStudioState(d, `location:${lobby.id}`);
    expect(place.selected).toMatchObject({ kind: "location", locked: true, looks: [], filledSlots: [] });
    expect(place.shots.map((s) => s.id).sort()).toEqual(
      d.shots
        .filter((s) => s.spatial.locationId === lobby.id)
        .map((s) => s.id)
        .sort(),
    );
  });

  it("lists every model with what it can do and, when it cannot be chosen, why", async () => {
    const state = await referenceStudioState(await data(), undefined);
    const mock = state.models.find((m) => m.value === FREE)!;
    expect(mock).toMatchObject({ available: true, paid: false, test: true, images: true, text: true });
    const gpt = state.models.find((m) => m.value === PAID)!;
    expect(gpt).toMatchObject({
      available: true,
      paid: true,
      test: false,
      images: true,
      maxImages: 16,
      transparency: true,
      formats: ["1:1", "3:2", "2:3", "16:9", "9:16"],
      defaultQuality: "medium",
    });
    expect(gpt.qualities.map((q) => q.id)).toEqual(["low", "medium", "high"]);
    const runway = state.models.find((m) => m.provider === "runway")!;
    expect(runway).toMatchObject({ available: false, unavailable: "not switched on for this server" });
  });
});

/**
 * A real deployment: no PRISM_STUDIO_SHOW_TEST_MODELS. The owner made two "pictures" on the hosted review site with the
 * test model the Studio suggested, got two gradients, and asked for the test model to go.
 */
describe("where a real model can be used, the Studio offers no test model and shows none of its results", () => {
  /** Runs `body` the way a deployment without the test-server switch behaves. */
  async function realDeployment<T>(body: () => Promise<T>, env: Record<string, string> = {}): Promise<T> {
    const before = { ...world.env };
    delete world.env.PRISM_STUDIO_SHOW_TEST_MODELS;
    Object.assign(world.env, env);
    try {
      return await body();
    } finally {
      for (const key of Object.keys(world.env)) delete world.env[key];
      Object.assign(world.env, before);
    }
  }
  /** A photograph, then two test patterns made from it. */
  async function patterns() {
    const yumeko = await yumekoOf();
    await uploadReferencePhoto(
      form({ subjectKind: "character", subjectId: yumeko.id, file: png("yumeko.png") }),
    );
    const photo = (await data()).identityRefs.find((r) => r.label === "Reference photo")!.assetId!;
    for (const intent of ["portrait", "three_quarter"])
      expect(await startSubjectImage(form(make(yumeko.id, { intent, startAssetId: [photo] })))).toEqual({
        ok: true,
      });
    await work();
    const [second, first] = await attempts(yumeko.id);
    return { yumeko, photo, first: first!, second: second! };
  }

  it("lists the real model and no test model; the test patterns are out of sight, and nothing is deleted", async () => {
    const { yumeko, photo } = await patterns();
    const shown = await referenceStudioState(await data(), `character:${yumeko.id}`);
    expect(shown.takes.map((t) => [t.number, t.test])).toEqual([
      [2, true],
      [1, true],
    ]);

    const state = await realDeployment(async () =>
      referenceStudioState(await data(), `character:${yumeko.id}`),
    );
    expect(state.models.filter((m) => m.test)).toEqual([]);
    expect(state.models.find((m) => m.value === PAID)).toMatchObject({ available: true, paid: true });
    // the Studio shows the photograph and nothing a test model made: no take, no picture to start from, no count
    expect(state.takes).toEqual([]);
    expect(state.images.map((i) => [i.assetId, i.origin, i.test])).toEqual([[photo, "uploaded", false]]);
    expect(state.subjects.find((s) => s.name === "Yumeko")).toMatchObject({ images: 1 });
    expect(state.spent).toEqual({ usd: 0, images: 0 });
    // with no take in sight, the stage opens on the photograph
    expect(defaultStartingImages(state.images)).toEqual([photo]);
    expect(opensOnStartingImages(state.images, state.takes[0]?.createdAt ?? null)).toBe(true);

    // out of sight is all it is: both attempts and their stored files are still there, and are shown again where
    // test models are
    expect((await attempts(yumeko.id)).map((a) => a.attempt.status)).toEqual(["succeeded", "succeeded"]);
    const again = await referenceStudioState(await data(), `character:${yumeko.id}`);
    expect(again.takes).toHaveLength(2);
    expect(again.images.filter((i) => i.test)).toHaveLength(2);
  });

  it("a test pattern the Visual Bible uses stays in view, named as a test pattern, so it can be replaced", async () => {
    const { yumeko, first, second } = await patterns();
    expect(await setCanonicalIdentity(form({ characterId: yumeko.id, attemptId: first.attempt.id }))).toEqual(
      { ok: true },
    );
    const state = await realDeployment(async () =>
      referenceStudioState(await data(), `character:${yumeko.id}`),
    );
    expect(state.takes.map((t) => [t.attemptId, t.test, t.roles])).toEqual([
      [first.attempt.id, true, ["Canonical identity"]],
    ]);
    expect(state.takes.some((t) => t.attemptId === second.attempt.id)).toBe(false);
    expect(state.images.filter((i) => i.test).map((i) => i.canonical)).toEqual([true]);
  });

  it("where no real model can be used, the test models are all there is, so they are offered, with why", async () => {
    const yumeko = await yumekoOf();
    // the real model is listed but paid generation is switched off on this server
    const state = await realDeployment(
      async () => referenceStudioState(await data(), `character:${yumeko.id}`),
      { PRISM_STUDIO_ALLOW_PAID_GENERATION: "false" },
    );
    expect(state.models.find((m) => m.value === FREE)).toMatchObject({ available: true, test: true });
    expect(state.models.find((m) => m.value === PAID)).toMatchObject({
      available: false,
      unavailable: "paid generation is switched off",
    });
    // a test model that is not switched on is not listed at all (a real one is, with its reason)
    const off = await realDeployment(
      async () => referenceStudioState(await data(), `character:${yumeko.id}`),
      { PRISM_STUDIO_ALLOW_PAID_GENERATION: "false", PRISM_STUDIO_DISABLE_MOCK_PROVIDER: "1" },
    );
    expect(off.models.filter((m) => m.test)).toEqual([]);
    expect(off.models.find((m) => m.value === PAID)).toMatchObject({ available: false });
  });
});

describe("a Character's reference set", () => {
  async function scene() {
    const yumeko = await yumekoOf();
    await uploadReferencePhoto(
      form({ subjectKind: "character", subjectId: yumeko.id, file: png("yumeko.png") }),
    );
    const photo = (await data()).identityRefs.find((r) => r.label === "Reference photo")!.assetId!;
    for (const intent of ["three_quarter", "portrait"])
      expect(await startSubjectImage(form(make(yumeko.id, { intent, startAssetId: [photo] })))).toEqual({
        ok: true,
      });
    await work();
    const [front, threeQuarter] = await attempts(yumeko.id);
    return { yumeko, photo, front: front!, threeQuarter: threeQuarter! };
  }
  const setOf = async (id: string) =>
    (await referenceStudioState(await data(), `character:${id}`)).referenceSet.map((v) => [v.id, v.from]);
  const put = (characterId: string, view: string, source: Record<string, string>) =>
    addToReferenceSet(form({ projectSlug: "ojousama", characterId, view, ...source }));

  it("starts empty, and a take or a photo goes into a view with one act", async () => {
    const { yumeko, photo, threeQuarter } = await scene();
    expect(await setOf(yumeko.id)).toEqual([
      ["front", null],
      ["three_quarter", null],
      ["profile", null],
      ["right_profile", null],
      ["half_body", null],
      ["full_body", null],
    ]);
    expect(await put(yumeko.id, "three_quarter", { attemptId: threeQuarter.attempt.id })).toEqual({
      ok: true,
    });
    expect(await put(yumeko.id, "half_body", { assetId: photo })).toEqual({ ok: true });
    expect(await setOf(yumeko.id)).toEqual([
      ["front", null],
      ["three_quarter", `take #${threeQuarter.attempt.attemptNumber}`],
      ["profile", null],
      ["right_profile", null],
      ["half_body", "your photo"],
      ["full_body", null],
    ]);
    // the seeded 3/4 slot was a placeholder with no image: it was filled, not duplicated
    const refs = (await data()).identityRefs.filter((r) => r.characterId === yumeko.id);
    expect(refs.filter((r) => r.slot === "three_quarter")).toHaveLength(1);
    expect(refs.find((r) => (r.metadata as { view?: string }).view === "half_body")).toMatchObject({
      slot: "additional",
      assetId: photo,
    });
  });

  it("the front view is the canonical identity; replacing either asks first, and the old image is kept", async () => {
    const { yumeko, photo, front } = await scene();
    expect(await put(yumeko.id, "front", { assetId: photo })).toEqual({ ok: true });
    let refs = (await data()).identityRefs.filter((r) => r.characterId === yumeko.id);
    expect(refs.find((r) => r.slot === "front")!.assetId).toBe(photo);
    expect(
      refs.find((r) => (r.metadata as { visualRole?: string }).visualRole === "canonical")!.assetId,
    ).toBe(photo);
    expect((await setOf(yumeko.id))[0]).toEqual(["front", "your photo"]);

    const frontTake = front.outputs[0]!.asset.id;
    expect(await put(yumeko.id, "front", { attemptId: front.attempt.id })).toMatchObject({
      ok: false,
      error: "Yumeko already has a front. Confirm to replace it (the old image stays in the library).",
    });
    expect(await put(yumeko.id, "front", { attemptId: front.attempt.id, confirmReplace: "1" })).toEqual({
      ok: true,
    });
    refs = (await data()).identityRefs.filter((r) => r.characterId === yumeko.id);
    expect(refs.find((r) => r.slot === "front")!.assetId).toBe(frontTake);
    expect(
      refs
        .filter((r) => (r.metadata as { visualRole?: string }).visualRole === "canonical")
        .map((r) => r.assetId),
    ).toEqual([frontTake]);
    // the photo is still in the library, and still one of her references
    expect((await data()).assets.some((a) => a.id === photo)).toBe(true);
    expect(refs.some((r) => r.assetId === photo)).toBe(true);
  });

  it("refuses a view that is not in the set, another Character's picture, and a locked view holding an image", async () => {
    const { yumeko, photo, threeQuarter } = await scene();
    expect(await put(yumeko.id, "back", { assetId: photo })).toMatchObject({
      ok: false,
      error: "Choose a view.",
    });
    const sean = (await data()).characters.find((c) => c.name === "Sean")!;
    expect(await put(sean.id, "front", { assetId: photo })).toMatchObject({
      ok: false,
      error: "That image does not belong to this character.",
    });
    expect(await put(yumeko.id, "three_quarter", { assetId: photo })).toEqual({ ok: true });
    const d = await data();
    const slot = d.identityRefs.find((r) => r.characterId === yumeko.id && r.slot === "three_quarter")!;
    await repo.upsert(d.project.id, "identityRefs", { ...slot, locked: true });
    expect(
      await put(yumeko.id, "three_quarter", { attemptId: threeQuarter.attempt.id, confirmReplace: "1" }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/is locked/) });
  });
});

describe("a Look's picture", () => {
  it("a wardrobe reference replaces the Look's picture (asked first, refused while locked); the old one is kept", async () => {
    const yumeko = await yumekoOf();
    let d = await data();
    const look = d.looks.find((l) => l.characterId === yumeko.id)!;
    await repo.upsert(d.project.id, "looks", { ...look, locked: false });
    // an older picture with another face, already on the Look
    const old = await uploadReferencePhoto(
      form({
        subjectKind: "character",
        subjectId: yumeko.id,
        as: `look:${look.id}`,
        file: png("old-gown.png"),
      }),
    );
    expect(old).toMatchObject({ ok: true });
    expect(
      await startSubjectImage(
        form(make(yumeko.id, { intent: "outfit_variant", lookId: look.id, sources: "" })),
      ),
    ).toEqual({ ok: true });
    await work();
    const [made] = await attempts(yumeko.id);
    const fields = { projectSlug: "ojousama", lookId: look.id, attemptId: made!.attempt.id };
    expect(await replaceLookReference(form(fields))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already has a picture. Confirm to replace it/),
    });
    expect(await replaceLookReference(form({ ...fields, confirmReplace: "1" }))).toEqual({ ok: true });
    d = await data();
    const after = d.looks.find((l) => l.id === look.id)!;
    expect(after.referenceAssetIds).toEqual([made!.outputs[0]!.asset.id]);
    expect(d.assets.some((a) => a.id === (old as { assetId: string }).assetId)).toBe(true);
    // a locked Look is not changed
    await repo.upsert(d.project.id, "looks", { ...after, locked: true });
    expect(await replaceLookReference(form({ ...fields, confirmReplace: "1" }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/is locked/),
    });
  });
});

describe("Approve from the Production checklist", () => {
  it("locks the person's reference images and the named Looks, and nothing without an image", async () => {
    const yumeko = await yumekoOf();
    expect(await approveCharacter(form({ projectSlug: "ojousama", characterId: yumeko.id }))).toMatchObject({
      ok: false,
      error: "Yumeko has no reference image to approve yet.",
    });
    let d = await data();
    const look = d.looks.find((l) => l.characterId === yumeko.id)!;
    await repo.upsert(d.project.id, "looks", { ...look, locked: false });
    await uploadReferencePhoto(
      form({ subjectKind: "character", subjectId: yumeko.id, file: png("yumeko.png") }),
    );
    d = await data();
    const photo = d.identityRefs.find((r) => r.characterId === yumeko.id && r.label === "Reference photo")!;
    await repo.upsert(d.project.id, "identityRefs", { ...photo, locked: false });
    expect(
      await approveCharacter(form({ projectSlug: "ojousama", characterId: yumeko.id, lookId: look.id })),
    ).toEqual({ ok: true });
    d = await data();
    expect(d.identityRefs.find((r) => r.id === photo.id)!.locked).toBe(true);
    expect(d.looks.find((l) => l.id === look.id)!.locked).toBe(true);
  });
});

describe("describing a fictional Character", () => {
  it("the Studio shows the written appearance and the Bible's context; saving it changes what a picture is made from", async () => {
    const takumi = (await data()).characters.find((c) => c.name === "Takumi")!;
    let state = await referenceStudioState(await data(), `character:${takumi.id}`);
    expect(state.selected).toMatchObject({ appearance: takumi.physicalDescription });
    expect(state.selected!.about).toContain(takumi.role);
    const text =
      "Mid 30s Japanese man, oval face, narrow dark eyes, swept-back black hair, clean-shaven, tall and slim.";
    expect(
      await saveCharacterAppearance(
        form({ projectSlug: "ojousama", characterId: takumi.id, appearance: text }),
      ),
    ).toEqual({ ok: true });
    state = await referenceStudioState(await data(), `character:${takumi.id}`);
    expect(state.selected!.appearance).toBe(text);
    // and a picture from words alone is made from it
    const q = await quoteReferenceImage(form(make(takumi.id, { intent: "portrait", sources: "chosen" })));
    expect(q).toMatchObject({ ok: true });
    expect((q as { prompt: string }).prompt).toContain("narrow dark eyes");
    expect(
      await saveCharacterAppearance(
        form({ projectSlug: "ojousama", characterId: takumi.id, appearance: " " }),
      ),
    ).toMatchObject({ ok: false, error: "Describe how they look first." });
  });
});

describe("archive and delete", () => {
  const upload = async (characterId: string, name: string) => {
    const r = await uploadReferencePhoto(
      form({ subjectKind: "character", subjectId: characterId, file: png(name) }),
    );
    return (r as { assetId: string }).assetId;
  };
  const act = (fn: typeof archiveStudioImage, characterId: string, assetId: string, extra = {}) =>
    fn(form({ subjectKind: "character", subjectId: characterId, assetId, ...extra }));
  const stateOf = async (id: string) => referenceStudioState(await data(), `character:${id}`);

  it("a photo is archived out of the Studio and no longer a reference; Restore puts it back as it was", async () => {
    const yumeko = await yumekoOf();
    const photo = await upload(yumeko.id, "extra.png");
    const ref = (await data()).identityRefs.find((r) => r.assetId === photo)!;
    expect(await act(archiveStudioImage, yumeko.id, photo)).toEqual({ ok: true });
    let d = await data();
    expect(d.identityRefs.some((r) => r.assetId === photo)).toBe(false);
    expect(d.assets.some((a) => a.id === photo)).toBe(true); // nothing deleted
    let state = await stateOf(yumeko.id);
    expect(state.images.some((i) => i.assetId === photo)).toBe(false);
    expect(state.archived).toEqual([
      expect.objectContaining({ assetId: photo, label: "extra.png", deletable: true, keptBecause: null }),
    ]);
    expect(await act(archiveStudioImage, yumeko.id, photo)).toMatchObject({ ok: false });

    expect(await act(restoreStudioImage, yumeko.id, photo)).toEqual({ ok: true });
    d = await data();
    expect(d.identityRefs.find((r) => r.assetId === photo)).toEqual(ref);
    expect(
      (d.assets.find((a) => a.id === photo)!.metadata as { archived?: unknown }).archived,
    ).toBeUndefined();
    state = await stateOf(yumeko.id);
    expect(state.images.some((i) => i.assetId === photo)).toBe(true);
    expect(state.archived).toEqual([]);
  });

  it("a picture with a job (a view of the set, a Look's picture) is refused with what to change first", async () => {
    const yumeko = await yumekoOf();
    const photo = await upload(yumeko.id, "set.png");
    await addToReferenceSet(form({ characterId: yumeko.id, view: "half_body", assetId: photo }));
    const r = await act(archiveStudioImage, yumeko.id, photo);
    expect(r).toMatchObject({
      ok: false,
      error: expect.stringContaining("take it out of the reference set first"),
    });
    // a Look's picture: the seeded Look is given this photo as its picture
    const seeded = (await data()).looks.find((l) => l.characterId === yumeko.id)!;
    const worn = await upload(yumeko.id, "worn.png");
    await repo.upsert((await data()).project.id, "looks", { ...seeded, referenceAssetIds: [worn] });
    const look = (await data()).looks.find((l) => l.id === seeded.id)!;
    {
      expect(await act(archiveStudioImage, yumeko.id, worn)).toMatchObject({
        ok: false,
        error: expect.stringContaining(`Look "${look.name}" (change the Look's picture first)`),
      });
    }
    expect((await stateOf(yumeko.id)).archived).toEqual([]);
  });

  it("a take is archived out of the takes and pictures, and can be deleted; its record and cost stay", async () => {
    const yumeko = await yumekoOf();
    const photo = await upload(yumeko.id, "start.png");
    expect(await startSubjectImage(form(make(yumeko.id, { startAssetId: [photo] })))).toEqual({ ok: true });
    await work();
    const [take] = await attempts(yumeko.id);
    const out = take!.outputs[0]!.asset.id;
    const n = take!.attempt.attemptNumber;
    const spent = (await stateOf(yumeko.id)).spent;
    expect(await act(archiveStudioImage, yumeko.id, out)).toEqual({ ok: true });
    let state = await stateOf(yumeko.id);
    expect(state.takes.some((t) => t.attemptId === take!.attempt.id)).toBe(false);
    expect(state.images.some((i) => i.assetId === out)).toBe(false);
    expect(state.archived.find((a) => a.assetId === out)).toMatchObject({
      label: `Take #${n}`,
      takeNumber: n,
      deletable: true,
      keptBecause: null,
    });
    // the photo it started from can be archived, and deleted too: the take keeps its record, naming it "Picture deleted"
    expect(await act(archiveStudioImage, yumeko.id, photo)).toEqual({ ok: true });
    expect((await stateOf(yumeko.id)).archived.find((a) => a.assetId === photo)).toMatchObject({
      deletable: true,
      keptBecause: null,
    });
    expect(await act(moveToTrash, yumeko.id, photo)).toEqual({ ok: true });
    expect(await deleteFromTrash(form({ assetId: photo, confirm: "1" }))).toEqual({ ok: true });
    // the take's own picture goes to the Trash, then is deleted for good: the take stays in the history, with its
    // cost, and no picture
    expect(await act(moveToTrash, yumeko.id, out)).toEqual({ ok: true });
    expect(await deleteFromTrash(form({ assetId: out, confirm: "1" }))).toEqual({ ok: true });
    expect((await data()).assets.some((a) => a.id === out)).toBe(false);
    const kept = await repo.generation.getSubjectImageAttempt(take!.attempt.id);
    expect(kept!.attempt).toMatchObject({ status: "succeeded", outputAssetId: null });
    state = await stateOf(yumeko.id);
    expect(state.takes.some((t) => t.attemptId === take!.attempt.id)).toBe(false);
    expect(state.archived.some((a) => a.assetId === out)).toBe(false);
    expect(state.spent).toEqual(spent);
  });

  it("an archived photo goes to the Trash, and is deleted for good from there only once confirmed", async () => {
    const yumeko = await yumekoOf();
    const photo = await upload(yumeko.id, "mistake.png");
    const path = (await data()).assets.find((a) => a.id === photo)!.objectPath!;
    await act(archiveStudioImage, yumeko.id, photo);
    expect(await act(moveToTrash, yumeko.id, photo)).toEqual({ ok: true });
    expect((await stateOf(yumeko.id)).archived).toEqual([]);
    expect(trashOf((await data()).assets.find((a) => a.id === photo)!)).toMatchObject({ restore: [] });
    expect(world.stored.has(path)).toBe(true); // kept while it is in the Trash
    expect(await deleteFromTrash(form({ assetId: photo }))).toMatchObject({
      ok: false,
      error: "Confirm that you want to delete it for good.",
    });
    expect(await deleteFromTrash(form({ assetId: photo, confirm: "1" }))).toEqual({ ok: true });
    expect((await data()).assets.some((a) => a.id === photo)).toBe(false);
    expect(world.stored.has(path)).toBe(false);
    // restored from the Trash, an archived picture goes back to the archive
    const again = await upload(yumeko.id, "again.png");
    await act(archiveStudioImage, yumeko.id, again);
    await act(moveToTrash, yumeko.id, again);
    expect(await restoreFromTrash(form({ assetId: again }))).toEqual({ ok: true });
    expect((await stateOf(yumeko.id)).archived.map((x) => x.assetId)).toEqual([again]);
  });

  it("Delete moves a picture to the Trash (its photo slot with it); Restore puts both back as they were", async () => {
    const yumeko = await yumekoOf();
    const photo = await upload(yumeko.id, "oops.png");
    const path = (await data()).assets.find((a) => a.id === photo)!.objectPath!;
    const ref = (await data()).identityRefs.find((r) => r.assetId === photo)!;
    expect(await act(moveToTrash, yumeko.id, photo)).toEqual({ ok: true });
    let d = await data();
    expect(d.identityRefs.some((r) => r.assetId === photo)).toBe(false);
    expect(trashOf(d.assets.find((a) => a.id === photo)!)).toMatchObject({
      subject: `character:${yumeko.id}`,
      restore: [expect.objectContaining({ kind: "identity_ref", refId: ref.id })],
    });
    expect(world.stored.has(path)).toBe(true);
    // gone from every view (the loader sets it apart), but not gone
    let state = await stateOf(yumeko.id);
    expect(state.images.some((i) => i.assetId === photo)).toBe(false);
    expect(state.archived).toEqual([]);
    expect(await act(moveToTrash, yumeko.id, photo)).toMatchObject({ ok: false });
    expect(await restoreFromTrash(form({ assetId: photo }))).toEqual({ ok: true });
    d = await data();
    expect(d.identityRefs.find((r) => r.assetId === photo)).toEqual(ref);
    expect(trashOf(d.assets.find((a) => a.id === photo)!)).toBeNull();
    state = await stateOf(yumeko.id);
    expect(state.images.some((i) => i.assetId === photo)).toBe(true);
  });

  it("after 30 days in the Trash a picture is deleted for good; before that it stays; Empty trash does all", async () => {
    const yumeko = await yumekoOf();
    const old = await upload(yumeko.id, "old.png");
    const recent = await upload(yumeko.id, "recent.png");
    await act(moveToTrash, yumeko.id, old);
    await act(moveToTrash, yumeko.id, recent);
    const d = await data();
    const day = 24 * 60 * 60 * 1000;
    const backdate = async (id: string, days: number) => {
      const a = (await data()).assets.find((x) => x.id === id)!;
      const t = trashOf(a)!;
      await repo.upsert(d.project.id, "assets", {
        ...a,
        metadata: { ...a.metadata, trashed: { ...t, at: new Date(Date.now() - days * day).toISOString() } },
      });
    };
    await backdate(old, 31);
    await backdate(recent, 29);
    const oldPath = d.assets.find((a) => a.id === old)!.objectPath!;
    expect(await purgeExpiredTrash(await data())).toBe(1);
    expect((await data()).assets.some((a) => a.id === old)).toBe(false);
    expect(world.stored.has(oldPath)).toBe(false);
    expect((await data()).assets.some((a) => a.id === recent)).toBe(true);
    expect(await emptyTrash(form({}))).toMatchObject({
      ok: false,
      error: "Confirm that you want to empty the Trash.",
    });
    expect(await emptyTrash(form({ confirm: "1" }))).toMatchObject({ ok: true, message: "1 deleted." });
    expect((await data()).assets.some((a) => a.id === recent)).toBe(false);
  });

  it("Delete refuses what could not be deleted (with what to change first), and changes nothing", async () => {
    const yumeko = await yumekoOf();
    // a view of the reference set: refused with what to change first
    const photo = await upload(yumeko.id, "view.png");
    await addToReferenceSet(form({ characterId: yumeko.id, view: "half_body", assetId: photo }));
    expect(await act(moveToTrash, yumeko.id, photo)).toMatchObject({
      ok: false,
      error: expect.stringMatching(
        /^This picture can't be moved to the Trash yet: .*take it out of the reference set first/,
      ),
    });
    expect((await data()).assets.some((a) => a.id === photo)).toBe(true);
    // a photo a take was made from can go too: the take still lists it as an input, "In the Trash", then "Picture
    // deleted"
    const start = await upload(yumeko.id, "from.png");
    expect(await startSubjectImage(form(make(yumeko.id, { startAssetId: [start] })))).toEqual({ ok: true });
    await work();
    const takeOf = async () =>
      (await stateOf(yumeko.id)).takes.find((t) => t.inputs.some((i) => i.assetId === start))!;
    expect((await takeOf()).inputs.find((i) => i.assetId === start)!.label).not.toMatch(/deleted|Trash/);
    expect(await act(moveToTrash, yumeko.id, start)).toEqual({ ok: true });
    const inTrash = await referenceStudioState(
      {
        ...(await data()),
        assets: (await data()).assets.filter((a) => a.id !== start),
        trashedAssets: [(await data()).assets.find((a) => a.id === start)!],
      },
      `character:${yumeko.id}`,
    );
    expect(inTrash.takes.flatMap((t) => t.inputs).find((i) => i.assetId === start)).toMatchObject({
      label: "In the Trash",
      url: null,
    });
    expect(await deleteFromTrash(form({ assetId: start, confirm: "1" }))).toEqual({ ok: true });
    expect((await takeOf()).inputs.find((i) => i.assetId === start)).toMatchObject({
      label: "Picture deleted",
      url: null,
    });
    // the take's own picture can go: the take stays in the history with its cost
    const [take] = await attempts(yumeko.id);
    const out = take!.outputs[0]!.asset.id;
    expect(await act(moveToTrash, yumeko.id, out)).toEqual({ ok: true });
    // in the Trash, the take is out of the takes (its picture is not among the project's)
    expect((await stateOf(yumeko.id)).takes.some((t) => t.attemptId === take!.attempt.id)).toBe(false);
    expect(await deleteFromTrash(form({ assetId: out, confirm: "1" }))).toEqual({ ok: true });
    expect((await repo.generation.getSubjectImageAttempt(take!.attempt.id))!.attempt).toMatchObject({
      status: "succeeded",
      outputAssetId: null,
    });
  });

  it("a Location's reference photo is archived and restored the same way; a locked Location refuses", async () => {
    let lobby = await lobbyOf();
    const d = await data();
    if (lobby.locked) await repo.upsert(d.project.id, "locations", { ...lobby, locked: false });
    lobby = await lobbyOf();
    const r = await uploadReferencePhoto(
      form({ subjectKind: "location", subjectId: lobby.id, file: png("lobby.png") }),
    );
    expect(r).toMatchObject({ ok: true });
    const photo = (r as { assetId: string }).assetId;
    const loc = (f: string) => (f === "archive" ? archiveStudioImage : restoreStudioImage);
    expect(
      await loc("archive")(form({ subjectKind: "location", subjectId: lobby.id, assetId: photo })),
    ).toEqual({
      ok: true,
    });
    expect((await lobbyOf()).referenceAssetIds).not.toContain(photo);
    // a locked Location keeps its references as they are: Restore waits until it is unlocked
    await repo.upsert(d.project.id, "locations", { ...(await lobbyOf()), locked: true });
    expect(
      await loc("restore")(form({ subjectKind: "location", subjectId: lobby.id, assetId: photo })),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("is locked"),
    });
    await repo.upsert(d.project.id, "locations", { ...(await lobbyOf()), locked: false });
    expect(
      (await referenceStudioState(await data(), `location:${lobby.id}`)).archived.map((a) => a.assetId),
    ).toEqual([photo]);
    expect(
      await loc("restore")(form({ subjectKind: "location", subjectId: lobby.id, assetId: photo })),
    ).toEqual({
      ok: true,
    });
    expect((await lobbyOf()).referenceAssetIds).toContain(photo);
  });
});
