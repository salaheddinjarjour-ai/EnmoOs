import type { ApprovalRequestDto, PostDto } from "@enmo/shared";
import { describe, expect, it } from "vitest";
import {
  approvalsSearch,
  filtersFromSearchParams,
  hasFilters,
  isSelectable,
  keepSelectable,
  NO_FILTERS,
  roundLine,
  selectableIds,
  toApprovalListQuery,
  waitingOn,
} from "./approvals-model";

const AT = "2026-09-25T10:00:00.000Z";

const POST = {
  id: "post-1",
  campaignId: "campaign-1",
  clientId: "client-1",
  ref: "p1",
  type: "REEL",
  platforms: ["INSTAGRAM"],
  status: "PENDING_APPROVAL",
  column: "APPROVAL",
  pill: "PENDING_APPROVAL",
  approved: false,
  failed: false,
  targetDate: null,
  pillar: null,
  angle: null,
  hook: null,
  copy: null,
  currentAssets: [],
  humanEditCount: 0,
  editable: true,
  revision: 0,
  needsAttention: false,
  attentionReason: null,
  qaNotes: null,
  approvedAt: null,
  liveAt: null,
  publishing: [],
  currentApproval: null,
  createdAt: AT,
  updatedAt: AT,
} satisfies PostDto;

function request(overrides: Partial<ApprovalRequestDto> = {}): ApprovalRequestDto {
  return {
    id: "request-1",
    postId: POST.id,
    round: 1,
    status: "PENDING",
    chain: {
      steps: [
        {
          name: "Manager review",
          approverRoles: ["ADMIN", "MANAGER"],
          approverUserIds: [],
          minApprovals: 1,
        },
      ],
    },
    currentStep: 0,
    canDecide: true,
    decisions: [],
    post: POST,
    client: { id: "client-1", name: "Qahwa Co" },
    campaign: { id: "campaign-1", name: "Launch" },
    createdAt: AT,
    resolvedAt: null,
    ...overrides,
  };
}

const TWO_STEPS = {
  steps: [
    {
      name: "Manager review",
      approverRoles: ["MANAGER" as const],
      approverUserIds: [],
      minApprovals: 1,
    },
    { name: "Brand lead", approverRoles: ["ADMIN" as const], approverUserIds: [], minApprovals: 1 },
  ],
};

describe("filters", () => {
  it("reads known filters from the address and drops the rest", () => {
    const params = new URLSearchParams("clientId=c1&platform=FACEBOOK&campaignId=k1&x=1");
    expect(filtersFromSearchParams(params)).toEqual({
      clientId: "c1",
      platform: "FACEBOOK",
      campaignId: "k1",
    });
    expect(filtersFromSearchParams(new URLSearchParams("platform=MYSPACE&clientId="))).toEqual(
      NO_FILTERS,
    );
  });

  it("asks the API only for the filters that are set", () => {
    expect(toApprovalListQuery(NO_FILTERS)).toEqual({});
    expect(toApprovalListQuery({ ...NO_FILTERS, platform: "INSTAGRAM" })).toEqual({
      platform: "INSTAGRAM",
    });
    expect(hasFilters(NO_FILTERS)).toBe(false);
    expect(hasFilters({ ...NO_FILTERS, clientId: "c1" })).toBe(true);
  });

  it("writes the same filters back to the address", () => {
    expect(approvalsSearch(NO_FILTERS)).toBe("");
    const filters = { clientId: "c1", platform: "TIKTOK" as const, campaignId: null };
    expect(approvalsSearch(filters)).toBe("?clientId=c1&platform=TIKTOK");
    expect(filtersFromSearchParams(new URLSearchParams(approvalsSearch(filters)))).toEqual(filters);
  });
});

describe("selection", () => {
  const mine = request();
  const theirs = request({ id: "request-2", canDecide: false });
  const done = request({ id: "request-3", status: "APPROVED" });

  it("only offers rounds the viewer can decide now", () => {
    expect(isSelectable(mine)).toBe(true);
    expect(isSelectable(theirs)).toBe(false);
    expect(isSelectable(done)).toBe(false);
    expect(selectableIds([mine, theirs, done])).toEqual(["request-1"]);
  });

  it("drops what left the queue or stopped waiting on the viewer", () => {
    const selection = new Set(["request-1", "request-2", "gone"]);
    expect([...keepSelectable(selection, [mine, theirs])]).toEqual(["request-1"]);
  });

  it("keeps the same set when nothing changed", () => {
    const selection = new Set(["request-1"]);
    expect(keepSelectable(selection, [mine, theirs])).toBe(selection);
  });
});

describe("round lines", () => {
  it("names the step of a one-step chain", () => {
    expect(roundLine(request())).toBe("Round 1 · Manager review");
    expect(waitingOn(request())).toBe("Your call");
  });

  it("counts the steps of a longer chain", () => {
    const later = request({ round: 2, chain: TWO_STEPS, currentStep: 1, canDecide: false });
    expect(roundLine(later)).toBe("Round 2 · step 2 of 2: Brand lead");
    expect(waitingOn(later)).toBe("Waiting on Brand lead");
  });
});
