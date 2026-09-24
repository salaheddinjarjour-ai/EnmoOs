import { QA_STILL_OPEN_HEADING, type CopywriterOutput } from "@enmo/shared";
import { describe, expect, it } from "vitest";
import {
  formatCalendarDay,
  formatCalendarRange,
  formatSeconds,
  previewText,
  qaNoteOf,
} from "./format";

const copy: CopywriterOutput = {
  caption: "One sip and the evening slows down.\n\nIced cardamom, made for Ramadan nights.",
  hashtags: ["#Ramadan"],
  cta: "Order ahead",
  altText: "An iced latte",
  platformCaptions: [{ platform: "INSTAGRAM", caption: "One sip." }],
  script: null,
  slides: null,
  onScreenText: null,
};

describe("calendar dates", () => {
  it("formats days in UTC, so no time zone moves them", () => {
    expect(formatCalendarDay("2027-03-01")).toBe("1 Mar");
    expect(formatCalendarDay("2027-12-31")).toBe("31 Dec");
  });

  it("writes the year once for a range inside one year", () => {
    expect(formatCalendarRange("2027-03-01", "2027-03-30")).toBe("1 Mar – 30 Mar 2027");
    expect(formatCalendarRange("2027-12-20", "2028-01-05")).toBe("20 Dec 2027 – 5 Jan 2028");
  });
});

describe("formatSeconds", () => {
  it("prints minutes and seconds, keeping tenths", () => {
    expect(formatSeconds(0)).toBe("0:00");
    expect(formatSeconds(15)).toBe("0:15");
    expect(formatSeconds(2.5)).toBe("0:02.5");
    expect(formatSeconds(92)).toBe("1:32");
  });
});

describe("previewText", () => {
  const post = { type: "REEL" as const, hook: null, angle: "Ramadan nights: iced cardamom" };

  it("leads with the script's hook and lists the later overlays", () => {
    const text = previewText(post, {
      ...copy,
      script: {
        totalDurationSec: 12,
        hookTimestampSec: 1,
        hookText: "This is what Ramadan tastes like.",
        scenes: [
          {
            index: 0,
            startSec: 0,
            durationSec: 3,
            voiceover: "",
            overlayText: "Hook",
            visualNote: "",
          },
          {
            index: 1,
            startSec: 3,
            durationSec: 5,
            voiceover: "",
            overlayText: "Iced Line",
            visualNote: "",
          },
          {
            index: 2,
            startSec: 8,
            durationSec: 4,
            voiceover: "",
            overlayText: " ",
            visualNote: "",
          },
        ],
      },
    });
    expect(text).toEqual({
      hook: "This is what Ramadan tastes like.",
      lines: ["Iced Line"],
      meta: "0:12 · 3 scenes",
    });
  });

  it("uses the first slide for carousels and on-screen text for statics", () => {
    const slides = previewText(
      { ...post, type: "CAROUSEL" },
      {
        ...copy,
        slides: [
          { index: 0, headline: "Swipe", body: "" },
          { index: 1, headline: "Why it works", body: "" },
          { index: 2, headline: "Your move", body: "" },
        ],
      },
    );
    expect(slides).toMatchObject({ hook: "Swipe", lines: ["Why it works", "Your move"] });
    expect(previewText({ ...post, type: "STATIC" }, { ...copy, onScreenText: "Iced." })).toEqual({
      hook: "Iced.",
      lines: [],
      meta: "Static",
    });
  });

  it("falls back to the caption's first line", () => {
    expect(previewText({ ...post, type: "STORY" }, copy).hook).toBe(
      "One sip and the evening slows down.",
    );
  });
});

describe("qaNoteOf", () => {
  it("shows QA's summary when nothing was left open", () => {
    expect(qaNoteOf("On brief and on voice.")).toEqual({
      text: "On brief and on voice.",
      open: false,
    });
    expect(qaNoteOf(null)).toBeNull();
    expect(qaNoteOf("  ")).toBeNull();
  });

  it("leads with the issues the automatic revision left open", () => {
    const notes = `Sent back once.\n\n${QA_STILL_OPEN_HEADING}\n- caption: too long`;
    expect(qaNoteOf(notes)).toEqual({
      text: `${QA_STILL_OPEN_HEADING}\n- caption: too long`,
      open: true,
    });
  });
});
