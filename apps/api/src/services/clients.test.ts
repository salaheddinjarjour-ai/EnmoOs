import { CLIENT_SLUG_MAX_LENGTH, Slug } from "@enmo/shared";
import { describe, expect, it } from "vitest";
import { normalizeBannedWords, slugCandidate } from "./clients";

describe("normalizeBannedWords", () => {
  it("applies NFKC, trims and collapses whitespace", () => {
    expect(normalizeBannedWords(["  ｃｈｅａｐ ", "ﬁnest", "iced \t coffee", " deal　"])).toEqual([
      "cheap",
      "finest",
      "iced coffee",
      "deal",
    ]);
  });

  it("de-duplicates case-insensitively, keeping the first spelling", () => {
    expect(normalizeBannedWords(["Cheap", "cheap", "CHEAP", "ＣＨＥＡＰ", "Instant"])).toEqual([
      "Cheap",
      "Instant",
    ]);
  });

  it("keeps Arabic and other scripts intact", () => {
    expect(normalizeBannedWords(["رخيص", " رخيص", "مجاني"])).toEqual(["رخيص", "مجاني"]);
  });

  it("drops entries that normalise to nothing", () => {
    expect(normalizeBannedWords(["   ", "　", "ok"])).toEqual(["ok"]);
  });
});

describe("slugCandidate", () => {
  it("returns the base for the first candidate and suffixes the rest", () => {
    expect(slugCandidate("qahwa-co", 1)).toBe("qahwa-co");
    expect(slugCandidate("qahwa-co", 2)).toBe("qahwa-co-2");
    expect(slugCandidate("qahwa-co", 12)).toBe("qahwa-co-12");
  });

  it("truncates long bases so the result is still a valid slug", () => {
    const base = "a".repeat(CLIENT_SLUG_MAX_LENGTH);
    for (const n of [2, 99, 12_345]) {
      const slug = slugCandidate(base, n);
      expect(slug.length).toBeLessThanOrEqual(CLIENT_SLUG_MAX_LENGTH);
      expect(slug.endsWith(`-${n}`)).toBe(true);
      expect(Slug.safeParse(slug).success).toBe(true);
    }
  });

  it("never leaves a double hyphen where the truncation lands on one", () => {
    // Truncating to 46 characters for "-2" ends this base on its hyphen.
    const base = `${"a".repeat(45)}-bc`;
    expect(slugCandidate(base, 2)).toBe(`${"a".repeat(45)}-2`);
    expect(Slug.safeParse(slugCandidate(base, 2)).success).toBe(true);
  });
});
