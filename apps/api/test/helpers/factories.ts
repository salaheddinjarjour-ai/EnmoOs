import type { Asset, Client, Prisma, User } from "@enmo/db";
import { assetStorageKey } from "@enmo/providers";
import {
  AssetParams,
  CreateClientRequest,
  MASTER_ASPECT_RATIO,
  pixelSizeFor,
  ROLE_LABEL,
  slugify,
  type AspectRatio,
  type AssetKind,
  type AssetReview,
  type AssetRole,
  type AssetStatus,
  type CreateClientInput,
  type Role,
  type Shot,
} from "@enmo/shared";
import { hash } from "@node-rs/argon2";
import { testDb } from "./db";

/* Rows created straight through Prisma, bypassing the API, for arranging test state. */

export const DEFAULT_TEST_PASSWORD = "correct-horse-battery-staple";

let sequence = 0;
const nextId = () => ++sequence;

export interface CreateUserInput {
  role?: Role;
  password?: string;
  email?: string;
  name?: string;
  isActive?: boolean;
}

/** The stored user plus the plaintext password, so tests can log in as them. */
export type TestUser = User & { password: string };

export async function createUser(input: CreateUserInput = {}): Promise<TestUser> {
  const n = nextId();
  const role = input.role ?? "EDITOR";
  const password = input.password ?? DEFAULT_TEST_PASSWORD;
  const user = await testDb().user.create({
    data: {
      email: (input.email ?? `${role.toLowerCase()}-${n}@enmo.test`).trim().toLowerCase(),
      name: input.name ?? `Test ${ROLE_LABEL[role]} ${n}`,
      role,
      isActive: input.isActive ?? true,
      passwordHash: await hash(password),
    },
  });
  return { ...user, password };
}

export type CreateTestClientInput = Partial<CreateClientInput> & { archivedAt?: Date | null };

/** Fills every field with the same defaults as POST /v1/clients; the slug gets a unique suffix. */
export async function createClient(input: CreateTestClientInput = {}): Promise<Client> {
  const n = nextId();
  const { archivedAt = null, ...request } = input;
  const data = CreateClientRequest.parse({ name: `Test Client ${n}`, ...request });
  return testDb().client.create({
    data: { ...data, slug: data.slug ?? `${slugify(data.name)}-${n}`, archivedAt },
  });
}

/* ─── assets (Phase 3) ───────────────────────────────────────────────────────────────────────── */

/** Where READY fixture assets claim to live; nothing is written there. */
export const FIXTURE_ASSET_BASE_URL = "https://files.enmo.test";

export interface CreateAssetInput {
  client: Pick<Client, "id">;
  campaignId?: string | null;
  postId?: string | null;
  role?: AssetRole;
  kind?: AssetKind;
  /** Defaults to READY, with a PNG url, storage key and pixel size filled in. */
  status?: AssetStatus;
  shotId?: string;
  sceneIndex?: number | null;
  slideIndex?: number | null;
  aspectRatio?: AspectRatio;
  prompt?: string;
  /** Merged over the defaults (a Shot from the fields above, origin "direct"). */
  params?: Partial<AssetParams>;
  review?: AssetReview | null;
  version?: number;
  parentAssetId?: string | null;
  rootAssetId?: string | null;
  isCurrent?: boolean;
  regenCount?: number;
  createdById?: string | null;
  createdAt?: Date;
}

/**
 * A shot Asset written straight through Prisma, as the visual loop would have left it: by default
 * a READY 9:16 master mock PNG, v1 and current. Its storage key follows assetStorageKey, but no file is
 * written; tests that serve the file put one in deps.storage themselves.
 */
export async function createAsset(input: CreateAssetInput): Promise<Asset> {
  const n = nextId();
  const kind = input.kind ?? "IMAGE";
  const status = input.status ?? "READY";
  const aspectRatio = input.aspectRatio ?? MASTER_ASPECT_RATIO;
  const prompt = input.prompt ?? `Fixture shot ${n}: an iced latte at golden hour`;
  const shot: Shot = {
    shotId: input.shotId ?? "s1",
    sceneIndex: input.sceneIndex ?? null,
    slideIndex: input.slideIndex ?? null,
    kind,
    aspectRatio,
    durationSec: kind === "VIDEO" ? 4 : null,
    prompt,
    negativePrompt: "",
    cameraNote: "Static, eye level",
    seed: null,
  };
  // A loose object parses to an index-signature type Prisma's Json input doesn't accept.
  const params = AssetParams.parse({
    shot,
    origin: "direct",
    ...input.params,
  }) as Prisma.InputJsonObject;
  const db = testDb();
  const asset = await db.asset.create({
    data: {
      clientId: input.client.id,
      campaignId: input.campaignId ?? null,
      postId: input.postId ?? null,
      role: input.role ?? "SHOT",
      kind,
      status,
      provider: "mock",
      prompt,
      negativePrompt: null,
      params,
      shotId: shot.shotId,
      sceneIndex: shot.sceneIndex,
      version: input.version ?? 1,
      parentAssetId: input.parentAssetId ?? null,
      rootAssetId: input.rootAssetId ?? null,
      isCurrent: input.isCurrent ?? true,
      regenCount: input.regenCount ?? 0,
      review: input.review ?? undefined,
      createdById: input.createdById ?? null,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    },
  });
  if (status !== "READY") return asset;

  const mimeType = "image/png";
  const storageKey = assetStorageKey({ clientId: input.client.id, assetId: asset.id, mimeType });
  const url = `${FIXTURE_ASSET_BASE_URL}/${storageKey}`;
  const size = pixelSizeFor(aspectRatio);
  return db.asset.update({
    where: { id: asset.id },
    data: {
      providerJobId: `mock-${asset.id}`,
      storageKey,
      url,
      posterUrl: kind === "VIDEO" ? url : null,
      mimeType,
      width: size.width,
      height: size.height,
      durationSec: shot.durationSec,
      bytes: 48_000,
    },
  });
}

/**
 * The next version of `previous`'s lineage (parent → previous, root → its v1). By default it
 * becomes current and `previous` stops being current, as an accepted regeneration leaves them.
 */
export async function createAssetVersion(
  previous: Asset,
  input: Partial<Omit<CreateAssetInput, "client">> = {},
): Promise<Asset> {
  const isCurrent = input.isCurrent ?? true;
  if (isCurrent) {
    await testDb().asset.update({ where: { id: previous.id }, data: { isCurrent: false } });
  }
  const params = AssetParams.parse(previous.params);
  return createAsset({
    client: { id: previous.clientId },
    campaignId: previous.campaignId,
    postId: previous.postId,
    role: previous.role,
    kind: previous.kind,
    shotId: previous.shotId ?? undefined,
    sceneIndex: previous.sceneIndex,
    slideIndex: params.shot?.slideIndex ?? null,
    aspectRatio: params.shot?.aspectRatio,
    version: previous.version + 1,
    parentAssetId: previous.id,
    rootAssetId: previous.rootAssetId ?? previous.id,
    regenCount: previous.regenCount + 1,
    ...input,
    params: { origin: "review", taskId: params.taskId, ...input.params },
    isCurrent,
  });
}
