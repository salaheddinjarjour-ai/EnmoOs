import { access } from "node:fs/promises";
import { LocalStorage, MockProvider } from "@enmo/providers";
import { AssetParams } from "@enmo/shared";
import { describe, expect, it } from "vitest";
import { storageConfigFrom, visualProviderConfigFrom } from "../../src/deps";
import { escalateTask } from "../../src/orchestrator/escalation";
import { buildTestApp } from "../helpers/app";
import { testDb } from "../helpers/db";
import { createAsset, createAssetVersion, createClient, createUser } from "../helpers/factories";
import { seedPipeline } from "../helpers/route-fixtures";

/*
 * The Phase 3 Step A wiring the visual units build on: Deps carries VISUAL_PROVIDER's provider
 * and STORAGE_DRIVER's storage (overridable), test apps get a private LocalStorage directory, and
 * the asset factories write valid, versioned rows. A direct task waiting on its renders can be
 * escalated, and asks people to accept the best take.
 */

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe("visual deps", () => {
  it("builds MockProvider and LocalStorage in a temporary directory removed on close", async () => {
    const t = await buildTestApp();
    try {
      expect(t.deps.visual).toBeInstanceOf(MockProvider);
      expect(t.deps.storage).toBeInstanceOf(LocalStorage);
      expect(t.deps.storage.driver).toBe("local");
      expect(storageConfigFrom(t.deps.config)).toMatchObject({
        driver: "local",
        localDir: t.storageDir,
        publicBaseUrl: `${t.deps.config.API_PUBLIC_URL}/files`,
      });
      expect(visualProviderConfigFrom(t.deps.config)).toMatchObject({ provider: "mock" });
      expect(await exists(t.storageDir)).toBe(true);
    } finally {
      await t.close();
    }
    expect(await exists(t.storageDir)).toBe(false);
  });

  it("takes injected providers", async () => {
    const visual = new MockProvider();
    const storage = new LocalStorage({ dir: "/nonexistent", publicBaseUrl: "http://x.test/f" });
    const t = await buildTestApp({ visual, storage });
    try {
      expect(t.deps.visual).toBe(visual);
      expect(t.deps.storage).toBe(storage);
    } finally {
      await t.close();
    }
  });
});

describe("asset factories", () => {
  it("write a READY v1 and versions that move isCurrent along the lineage", async () => {
    const client = await createClient();
    const v1 = await createAsset({ client, shotId: "s2", slideIndex: 1 });
    expect(v1).toMatchObject({
      status: "READY",
      version: 1,
      isCurrent: true,
      rootAssetId: null,
      width: 1080,
      height: 1920,
      mimeType: "image/png",
      storageKey: `clients/${client.id}/assets/${v1.id}.png`,
    });
    expect(AssetParams.parse(v1.params).shot).toMatchObject({ shotId: "s2", slideIndex: 1 });

    const v2 = await createAssetVersion(v1, { status: "QUEUED" });
    const v3 = await createAssetVersion(v2);
    expect(v2).toMatchObject({ version: 2, parentAssetId: v1.id, rootAssetId: v1.id, url: null });
    expect(v3).toMatchObject({ version: 3, parentAssetId: v2.id, rootAssetId: v1.id });
    expect(AssetParams.parse(v3.params)).toMatchObject({ origin: "review" });

    const current = await testDb().asset.findMany({ where: { isCurrent: true } });
    expect(current.map((asset) => asset.id)).toEqual([v3.id]);
  });
});

describe("visual escalations", () => {
  it("hand a WAITING direct task to people with accept_best as the way out", async () => {
    const t = await buildTestApp();
    try {
      const admin = await createUser({ role: "ADMIN" });
      const client = await createClient();
      const { graph, posts } = await seedPipeline({
        createdBy: admin,
        client,
        postCount: 1,
        postStatus: "VISUALIZING",
      });
      const post = posts[0]!;
      const direct = await testDb().agentTask.create({
        data: {
          graphId: graph.id,
          nodeKey: "n9",
          agent: "VISUAL_DIRECTOR",
          action: "direct",
          postId: post.id,
          status: "WAITING",
        },
      });

      const escalated = await escalateTask(t.deps, direct.id, {
        reason: "WEAK_TAKES",
        issues: [],
        message: "kept rendering weak takes of s1.",
      });

      expect(escalated).toBe(true);
      const stored = await testDb().agentTask.findUniqueOrThrow({ where: { id: direct.id } });
      expect(stored.status).toBe("ESCALATED");
      expect(
        (await testDb().post.findUniqueOrThrow({ where: { id: post.id } })).needsAttention,
      ).toBe(true);
      const message = await testDb().chatMessage.findFirstOrThrow({
        where: { kind: "ESCALATION" },
      });
      expect(message.content).toContain("accept the best take or retry it from the task list");
    } finally {
      await t.close();
    }
  });
});
