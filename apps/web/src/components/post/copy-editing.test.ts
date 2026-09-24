import type { CopywriterOutput } from "@enmo/shared";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import {
  bannedHitsOf,
  copyMatcher,
  describeHits,
  hitsByPath,
  ruleIssuesOf,
  scanCopy,
} from "./copy-editing";

const copy: CopywriterOutput = {
  caption: "Cheap thrills? Not here.",
  hashtags: ["#icedlatte", "instantcoffee"],
  cta: "Order ahead",
  altText: "An iced latte",
  platformCaptions: [
    { platform: "INSTAGRAM", caption: "Never cheap." },
    { platform: "TIKTOK", caption: "Iced." },
  ],
  script: {
    totalDurationSec: 6,
    hookTimestampSec: 1,
    hookText: "Hook",
    scenes: [
      {
        index: 0,
        startSec: 0,
        durationSec: 6,
        voiceover: "Better than instant coffee.",
        overlayText: "Iced",
        visualNote: "Close-up",
      },
    ],
  },
  slides: null,
  onScreenText: null,
};

describe("scanCopy", () => {
  it("flags every field the API would, by the same paths", () => {
    const hits = scanCopy(copy, copyMatcher(["cheap", "instant coffee"]));
    expect([...hitsByPath(hits).keys()]).toEqual([
      "caption",
      "hashtags[1]",
      "platformCaptions[0].caption",
      "script.scenes[0].voiceover",
    ]);
  });

  it("finds nothing with an empty list", () => {
    expect(scanCopy(copy, copyMatcher([]))).toEqual([]);
  });
});

describe("bannedHitsOf", () => {
  it("reads the hits from a 422", () => {
    const hit = { path: "caption", term: "cheap", index: 0, length: 5, match: "Cheap" };
    const error = new ApiError(422, "UNPROCESSABLE", "The copy uses banned words", {
      bannedWords: [hit],
    });
    expect(bannedHitsOf(error)).toEqual([hit]);
  });

  it("ignores other errors", () => {
    expect(bannedHitsOf(new ApiError(409, "CONFLICT", "Busy"))).toEqual([]);
    expect(bannedHitsOf(new Error("boom"))).toEqual([]);
  });
});

describe("describeHits", () => {
  it("names each matched word once", () => {
    const hits = scanCopy(copy, copyMatcher(["cheap"]));
    expect(describeHits(hitsByPath(hits).get("caption"))).toBe("Banned word: “Cheap”");
    expect(describeHits(undefined)).toBeNull();
  });
});

describe("ruleIssuesOf", () => {
  it("reads the broken Copywriter rules from a 422, first message per path", () => {
    const error = new ApiError(422, "UNPROCESSABLE", "The copy doesn't fit this STATIC post.", {
      issues: [
        { path: "caption", message: "The caption is empty." },
        { path: "hashtags[1]", message: '"iced latte" is not a hashtag.' },
        { path: "hashtags[1]", message: "#x is listed twice." },
      ],
    });
    expect([...ruleIssuesOf(error)]).toEqual([
      ["caption", "The caption is empty."],
      ["hashtags[1]", '"iced latte" is not a hashtag.'],
    ]);
  });

  it("reads them next to banned-word hits, and ignores other errors", () => {
    const hit = { path: "caption", term: "cheap", index: 0, length: 5, match: "Cheap" };
    const both = new ApiError(422, "UNPROCESSABLE", "The copy uses banned words", {
      bannedWords: [hit],
      issues: [{ path: "cta", message: "Write the call to action." }],
    });
    expect(bannedHitsOf(both)).toEqual([hit]);
    expect(ruleIssuesOf(both).get("cta")).toBe("Write the call to action.");
    expect(ruleIssuesOf(new ApiError(409, "CONFLICT", "Busy")).size).toBe(0);
    expect(ruleIssuesOf(new Error("boom")).size).toBe(0);
  });
});
