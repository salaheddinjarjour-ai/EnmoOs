import { describe, expect, it } from "vitest";
import { CAMPAIGN_NAME_MAX, campaignNameFrom } from "./campaigns";

describe("campaignNameFrom", () => {
  it("uses the brief's first line, whitespace collapsed", () => {
    expect(campaignNameFrom("  Ramadan   campaign\nfor the coffee client")).toBe(
      "Ramadan campaign",
    );
  });

  it("shortens long briefs with an ellipsis", () => {
    const name = campaignNameFrom("x".repeat(200));
    expect(name).toHaveLength(CAMPAIGN_NAME_MAX);
    expect(name.endsWith("…")).toBe(true);
  });

  it("never returns an empty name", () => {
    expect(campaignNameFrom("   ")).toBe("New campaign");
  });
});
