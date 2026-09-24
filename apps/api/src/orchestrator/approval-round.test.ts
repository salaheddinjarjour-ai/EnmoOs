import { describe, expect, it } from "vitest";
import { canonicalJson, contentHash } from "./approval-round";

const copy = {
  caption: "Iced, finally.",
  hashtags: ["#iced"],
  cta: "Order",
  nested: { b: 1, a: 2 },
};

describe("contentHash", () => {
  it("sorts object keys at every level", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 0, y: 1 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,{"y":1,"z":0}]},"b":1}',
    );
  });

  it("is stable across key, variant and asset order", () => {
    const a = contentHash({
      copy,
      variants: [
        { platform: "TIKTOK", caption: "t", hashtags: ["#a"] },
        { platform: "INSTAGRAM", caption: "i", hashtags: [] },
      ],
      assetIds: ["b", "a"],
    });
    const b = contentHash({
      copy: {
        nested: { a: 2, b: 1 },
        cta: "Order",
        hashtags: ["#iced"],
        caption: "Iced, finally.",
      },
      variants: [
        { platform: "INSTAGRAM", caption: "i", hashtags: [] },
        { platform: "TIKTOK", caption: "t", hashtags: ["#a"] },
      ],
      assetIds: ["a", "b"],
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when anything reviewers approved changes", () => {
    const original = contentHash({ copy, variants: [], assetIds: [] });
    expect(
      contentHash({ copy: { ...copy, caption: "Iced, finally!" }, variants: [], assetIds: [] }),
    ).not.toBe(original);
    expect(contentHash({ copy, variants: [], assetIds: ["asset_1"] })).not.toBe(original);
    expect(
      contentHash({
        copy,
        variants: [{ platform: "INSTAGRAM", caption: "x", hashtags: [] }],
        assetIds: [],
      }),
    ).not.toBe(original);
  });
});
