import { describe, expect, it } from "vitest";
import {
  compileBannedWords,
  findBannedWords,
  foldForBannedWords,
  scanForBannedWords,
  type CopywriterOutput,
} from "../src";

const terms = (text: string, list: string[]) => findBannedWords(text, list).map((m) => m.term);
const matches = (text: string, list: string[]) => findBannedWords(text, list).map((m) => m.match);

describe("findBannedWords: whole words only", () => {
  it("reports the term, offset and original slice", () => {
    expect(findBannedWords("This is CHEAP!", ["cheap"])).toEqual([
      { term: "cheap", index: 8, length: 5, match: "CHEAP" },
    ]);
  });

  it("never matches inside a longer word", () => {
    expect(findBannedWords("cheapest, Cheapside, noncheap, cheap123, 4cheap", ["cheap"])).toEqual(
      [],
    );
  });

  it("treats punctuation, underscores and line edges as boundaries", () => {
    expect(matches("cheap. (cheap) 'cheap' cheap_deal\ncheap", ["cheap"])).toHaveLength(5);
  });

  it("returns nothing for an empty list or blank entries", () => {
    expect(findBannedWords("anything cheap", [])).toEqual([]);
    expect(findBannedWords("anything cheap", ["", "   ", "#"])).toEqual([]);
  });

  it("escapes regex syntax in terms", () => {
    expect(matches("I love c++ and (new) things", ["c++", "(new)"])).toEqual(["c++", "(new)"]);
    expect(() => findBannedWords("x", ["[", "a|b", "\\", "e-cig"])).not.toThrow();
  });

  it("orders hits by position and reports overlapping terms separately", () => {
    expect(findBannedWords("iced coffee is iced", ["iced", "iced coffee"])).toEqual([
      { term: "iced", index: 0, length: 4, match: "iced" },
      { term: "iced coffee", index: 0, length: 11, match: "iced coffee" },
      { term: "iced", index: 15, length: 4, match: "iced" },
    ]);
  });

  it("keeps the first spelling of fold-equal duplicates", () => {
    const matcher = compileBannedWords([
      "Cheap",
      "cheap",
      "CHEAP ",
      "free shipping",
      "Free-Shipping",
    ]);
    expect(matcher.terms).toEqual(["Cheap", "free shipping"]);
    expect(terms("so cheap", ["Cheap", "cheap"])).toEqual(["Cheap"]);
  });
});

describe("findBannedWords: multi-word phrases", () => {
  it("matches across any run of spaces, hyphens, underscores or line breaks", () => {
    const text = "free shipping / free   shipping / Free-shipping / free\nshipping / free_shipping";
    expect(matches(text, ["free shipping"])).toEqual([
      "free shipping",
      "free   shipping",
      "Free-shipping",
      "free\nshipping",
      "free_shipping",
    ]);
  });

  it("does not match the words run together, or only one of them", () => {
    expect(
      findBannedWords("freeshipping, free delivery, fast shipping", ["free shipping"]),
    ).toEqual([]);
  });

  it("treats a hyphenated term like a phrase", () => {
    expect(matches("an e-cig, an e cig", ["e-cig"])).toEqual(["e-cig", "e cig"]);
  });
});

describe("findBannedWords: hashtags", () => {
  it("matches a banned word used as a hashtag, without the #", () => {
    expect(findBannedWords("Get it #cheap", ["cheap"])).toEqual([
      { term: "cheap", index: 8, length: 5, match: "cheap" },
    ]);
  });

  it("does not match a single word inside a compound hashtag", () => {
    expect(findBannedWords("#cheapcoffee #CheapEats", ["cheap"])).toEqual([]);
  });

  it("matches a phrase written as one hashtag, but not a longer one", () => {
    expect(matches("#FreeShipping #free_shipping #FreeShippingDay", ["free shipping"])).toEqual([
      "FreeShipping",
      "free_shipping",
    ]);
  });

  it("strips a leading # from list entries", () => {
    expect(matches("Paid #ad. Also an ad, adorable, bad, ads", ["#ad"])).toEqual(["ad", "ad"]);
  });
});

describe("findBannedWords: Arabic", () => {
  const cheap = "رخيص";

  it("matches a whole Arabic word with Arabic punctuation around it", () => {
    expect(findBannedWords("قهوة رخيص، جدا", [cheap])).toEqual([
      { term: cheap, index: 5, length: 4, match: "رخيص" },
    ]);
  });

  it("does not match inside a longer word or with attached clitics", () => {
    expect(findBannedWords("قهوة رخيصة", [cheap])).toEqual([]);
    expect(findBannedWords("والرخيص بالرخيص", [cheap])).toEqual([]);
  });

  it("ignores harakat (tashkeel) and tatweel", () => {
    expect(matches("قهوة رَخِيص", [cheap])).toEqual(["رَخِيص"]);
    expect(matches("قهوة رخيـــص", [cheap])).toEqual(["رخيـــص"]);
  });

  it("matches hamza-on-alef spellings against bare alef", () => {
    expect(terms("افضل قهوة", ["أفضل"])).toEqual(["أفضل"]);
    expect(terms("أفضل قهوة", ["افضل"])).toEqual(["افضل"]);
    expect(terms("إفضل قهوة", ["افضل"])).toEqual(["افضل"]);
  });

  it("folds presentation forms (NFKC)", () => {
    expect(findBannedWords("\uFEFB", ["لا"])).toEqual([
      { term: "لا", index: 0, length: 1, match: "\uFEFB" },
    ]);
  });

  it("matches Arabic phrases and Arabic hashtags", () => {
    expect(matches("عرض خاص اليوم #عرض_خاص", ["عرض خاص"])).toEqual(["عرض خاص", "عرض_خاص"]);
  });

  it("works in mixed-direction text", () => {
    expect(matches("Iced latte — لاتيه رخيص — only today", [cheap, "latte"])).toEqual([
      "latte",
      "رخيص",
    ]);
  });
});

describe("findBannedWords: case, compatibility forms and diacritics", () => {
  it("is case-insensitive, including full case folding", () => {
    expect(matches("CHEAP Cheap cHeAp", ["cheap"])).toHaveLength(3);
    expect(terms("Straße", ["strasse"])).toEqual(["strasse"]);
    expect(terms("STRASSE", ["straße"])).toEqual(["straße"]);
    expect(terms("ΟΔΟΣ", ["οδος"])).toEqual(["οδος"]);
  });

  it("folds full-width letters and ligatures", () => {
    expect(matches("ＣＨＥＡＰ", ["cheap"])).toEqual(["ＣＨＥＡＰ"]);
    expect(terms("ﬁne print", ["fine"])).toEqual(["fine"]);
  });

  it("treats composed and decomposed accents as the same text", () => {
    const decomposed = "Cafe\u0301";
    expect(findBannedWords(`Café or ${decomposed}`, ["café"])).toEqual([
      { term: "café", index: 0, length: 4, match: "Café" },
      { term: "café", index: 8, length: 5, match: decomposed },
    ]);
  });

  it("ignores Latin accents in both directions", () => {
    expect(terms("CAFÉ", ["cafe"])).toEqual(["cafe"]);
    expect(terms("cafe", ["café"])).toEqual(["café"]);
    expect(terms("naïve", ["naive"])).toEqual(["naive"]);
  });

  it("sees through zero-width and bidi control characters", () => {
    expect(matches("che\u200Bap and \u200Fcheap", ["cheap"])).toEqual(["che\u200Bap", "cheap"]);
  });

  it("keeps letter-forming marks in other scripts", () => {
    // Devanagari vowel signs change the word: कम (less) must not match काम (work).
    expect(findBannedWords("काम", ["कम"])).toEqual([]);
    expect(terms("कम", ["कम"])).toEqual(["कम"]);
  });

  it("maps offsets back to the original text", () => {
    const text = "Ｗｏｗ, so ＣＨＥＡＰ!";
    const [hit] = findBannedWords(text, ["cheap"]);
    expect(text.slice(hit!.index, hit!.index + hit!.length)).toBe("ＣＨＥＡＰ");
  });

  it("exposes the folded form", () => {
    expect(foldForBannedWords("Ｃａｆé رَخِيـص")).toBe("cafe رخيص");
  });
});

describe("scanForBannedWords", () => {
  const copy: CopywriterOutput = {
    caption: "Iced coffee, never cheap.",
    hashtags: ["#IcedCoffee", "FreeShipping", "cheap"],
    cta: "Order now",
    altText: "A glass of iced coffee",
    platformCaptions: [
      { platform: "INSTAGRAM", caption: "So cheap on Instagram" },
      { platform: "TIKTOK", caption: "Fine" },
    ],
    script: {
      totalDurationSec: 6,
      hookTimestampSec: 1,
      hookText: "Wait for it",
      scenes: [
        {
          index: 0,
          startSec: 0,
          durationSec: 6,
          voiceover: "Free shipping today",
          overlayText: "",
          visualNote: "cheap-looking props, avoid",
        },
      ],
    },
    slides: null,
    onScreenText: null,
  };

  it("reports every hit with the JSON path of its field", () => {
    const hits = scanForBannedWords(copy, ["cheap", "free shipping"]);
    expect(hits.map(({ path, match }) => [path, match])).toEqual([
      ["caption", "cheap"],
      ["hashtags[1]", "FreeShipping"],
      ["hashtags[2]", "cheap"],
      ["platformCaptions[0].caption", "cheap"],
      ["script.scenes[0].voiceover", "Free shipping"],
      ["script.scenes[0].visualNote", "cheap"],
    ]);
  });

  it("reads hashtag array items as hashtags, with offsets into the stored item", () => {
    const [hit] = scanForBannedWords({ hashtags: ["FreeShipping"] }, ["free shipping"]);
    expect(hit).toEqual({
      path: "hashtags[0]",
      term: "free shipping",
      index: 0,
      length: 12,
      match: "FreeShipping",
    });
  });

  it("only treats the configured keys as hashtags", () => {
    expect(scanForBannedWords({ tags: ["FreeShipping"] }, ["free shipping"])).toEqual([]);
    expect(
      scanForBannedWords({ tags: ["FreeShipping"] }, ["free shipping"], { hashtagKeys: ["tags"] }),
    ).toHaveLength(1);
  });

  it("skips ignored keys", () => {
    const hits = scanForBannedWords(copy, ["instagram"], { ignoreKeys: ["platform"] });
    expect(hits.map((hit) => hit.path)).toEqual(["platformCaptions[0].caption"]);
    expect(scanForBannedWords(copy, ["instagram"]).map((hit) => hit.path)).toEqual([
      "platformCaptions[0].platform",
      "platformCaptions[0].caption",
    ]);
  });

  it("handles bare strings, nulls, numbers and cycles", () => {
    expect(scanForBannedWords("cheap", ["cheap"])[0]?.path).toBe("");
    expect(scanForBannedWords({ a: null, b: 3, c: true }, ["cheap"])).toEqual([]);
    const cyclic: Record<string, unknown> = { text: "cheap" };
    cyclic.self = cyclic;
    expect(scanForBannedWords(cyclic, ["cheap"])).toHaveLength(1);
  });

  it("accepts a precompiled matcher", () => {
    const matcher = compileBannedWords(["cheap"]);
    expect(scanForBannedWords(copy, matcher)).toEqual(scanForBannedWords(copy, ["cheap"]));
    expect(findBannedWords("cheap", matcher)).toHaveLength(1);
  });

  it("stops at `limit` hits, keeping the first ones in walk order", () => {
    const all = scanForBannedWords(copy, ["cheap", "free shipping"]);
    const capped = scanForBannedWords(copy, ["cheap", "free shipping"], { limit: 3 });
    expect(capped).toEqual(all.slice(0, 3));
    expect(scanForBannedWords({ caption: "cheap ".repeat(500) }, ["cheap"], { limit: 50 })).toEqual(
      findBannedWords("cheap ".repeat(500), ["cheap"])
        .slice(0, 50)
        .map((match) => ({ ...match, path: "caption" })),
    );
  });
});

describe("banned-word matching cost", () => {
  it("stays linear in the number of hits", () => {
    // A quadratic dedupe took tens of seconds here; a linear one takes well under a second.
    const text = "cheap #cheap ".repeat(50_000);
    const started = Date.now();
    const hits = findBannedWords(text, ["cheap", "free shipping"]);
    expect(hits).toHaveLength(100_000);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("reports a hashtag the phrase pattern also matched only once", () => {
    // "#free_shipping" matches the phrase pattern (underscore separator) and the hashtag rule.
    expect(findBannedWords("#free_shipping", ["free shipping"])).toEqual([
      { term: "free shipping", index: 1, length: 13, match: "free_shipping" },
    ]);
  });
});
