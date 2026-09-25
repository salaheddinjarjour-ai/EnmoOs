import { describe, expect, it } from "vitest";
import {
  HiggsfieldProvider,
  InvalidStorageKeyError,
  LocalStorage,
  MockProvider,
  R2Storage,
  assertStorageKey,
  assetStorageKey,
  createStorage,
  createVisualProvider,
  extensionForMimeType,
  isValidStorageKey,
  mimeTypeForKey,
  rendersPlaceholders,
  type HiggsfieldConfig,
  type R2Config,
} from "../src";

const higgsfield: HiggsfieldConfig = {
  keyId: null,
  keySecret: null,
  baseUrl: "https://api.higgsfield.ai",
  imageModel: null,
  videoModel: null,
};

const r2: R2Config = {
  accountId: null,
  accessKeyId: null,
  secretAccessKey: null,
  bucket: null,
  endpoint: null,
};

describe("createVisualProvider", () => {
  it("switches on VISUAL_PROVIDER without I/O or credentials", () => {
    const mock = createVisualProvider({ provider: "mock", higgsfield });
    expect(mock).toBeInstanceOf(MockProvider);
    expect(mock.name).toBe("mock");

    const fetch = () => Promise.resolve(new Response(null));
    const real = createVisualProvider({ provider: "higgsfield", higgsfield }, { fetch });
    expect(real).toBeInstanceOf(HiggsfieldProvider);
    expect(real.name).toBe("higgsfield");
  });

  it("knows which providers render placeholders instead of generated images", () => {
    expect(rendersPlaceholders("mock")).toBe(true);
    expect(rendersPlaceholders("higgsfield")).toBe(false);
  });
});

describe("createStorage", () => {
  it("switches on STORAGE_DRIVER without I/O or credentials", () => {
    const base = { publicBaseUrl: "http://localhost:4000/files", localDir: ".data/x", r2 };
    const local = createStorage({ ...base, driver: "local" });
    expect(local).toBeInstanceOf(LocalStorage);
    expect(local.driver).toBe("local");
    const remote = createStorage({ ...base, driver: "r2" });
    expect(remote).toBeInstanceOf(R2Storage);
    expect(remote.driver).toBe("r2");
  });
});

describe("storage keys", () => {
  it("accepts relative slash-separated keys", () => {
    for (const key of ["a.png", "clients/c1/assets/a1.png", "x/y_z-1/v2.poster.jpg"]) {
      expect(isValidStorageKey(key), key).toBe(true);
    }
  });

  it("rejects traversal, absolute paths, empty or hidden segments and odd characters", () => {
    for (const key of [
      "",
      "/etc/passwd",
      "../secret",
      "a/../../b",
      "a/./b",
      "a//b",
      "a/",
      ".env",
      "a\\b",
      "a b",
      "a/%2e%2e/b",
      "é.png",
      "x".repeat(513),
    ]) {
      expect(isValidStorageKey(key), key).toBe(false);
    }
    expect(() => assertStorageKey("../x")).toThrow(InvalidStorageKeyError);
  });

  it("names asset files by client and asset id", () => {
    expect(assetStorageKey({ clientId: "c1", assetId: "a1", mimeType: "image/png" })).toBe(
      "clients/c1/assets/a1.png",
    );
    expect(
      assetStorageKey({ clientId: "c1", assetId: "a1", mimeType: "image/jpeg", poster: true }),
    ).toBe("clients/c1/assets/a1-poster.jpg");
    expect(() =>
      assetStorageKey({ clientId: "../c", assetId: "a", mimeType: "image/png" }),
    ).toThrow(InvalidStorageKeyError);
  });

  it("maps content types and extensions both ways", () => {
    expect(extensionForMimeType("IMAGE/PNG; charset=binary")).toBe("png");
    expect(extensionForMimeType("video/mp4")).toBe("mp4");
    expect(extensionForMimeType("application/x-unknown")).toBe("bin");
    expect(mimeTypeForKey("clients/c1/assets/a1.png")).toBe("image/png");
    expect(mimeTypeForKey("a.JPEG")).toBe("image/jpeg");
    expect(mimeTypeForKey("a.jpg")).toBe("image/jpeg");
    expect(mimeTypeForKey("noextension")).toBe("application/octet-stream");
  });
});
