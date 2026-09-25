import { Platform, type ApprovalListQuery, type ApprovalRequestDto } from "@enmo/shared";

/*
 * The Approvals Queue's view model (MASTER_PLAN §03 "Approvals Queue", DESIGN §E "approvals"):
 * its filters as GET /approvals reads them and as the address carries them, which rounds the
 * viewer may put in a batch (only the ones whose current step they can decide), and how a round
 * reads on its tile. Pure, so it is unit-tested.
 */

export interface ApprovalFilters {
  clientId: string | null;
  platform: Platform | null;
  campaignId: string | null;
}

export const NO_FILTERS: ApprovalFilters = { clientId: null, platform: null, campaignId: null };

/** Filters from `/approvals?clientId=…&platform=…&campaignId=…`; anything unknown is dropped. */
export function filtersFromSearchParams(params: {
  get(name: string): string | null;
}): ApprovalFilters {
  const platform = Platform.safeParse(params.get("platform"));
  return {
    clientId: params.get("clientId") || null,
    platform: platform.success ? platform.data : null,
    campaignId: params.get("campaignId") || null,
  };
}

export function toApprovalListQuery(filters: ApprovalFilters): ApprovalListQuery {
  return {
    ...(filters.clientId && { clientId: filters.clientId }),
    ...(filters.platform && { platform: filters.platform }),
    ...(filters.campaignId && { campaignId: filters.campaignId }),
  };
}

export function hasFilters(filters: ApprovalFilters): boolean {
  return Object.keys(toApprovalListQuery(filters)).length > 0;
}

/** The address for a set of filters ("" when there are none). */
export function approvalsSearch(filters: ApprovalFilters): string {
  const search = new URLSearchParams(toApprovalListQuery(filters)).toString();
  return search ? `?${search}` : "";
}

/** Whether the viewer may approve this round's current step now (so it may join a batch). */
export function isSelectable(request: ApprovalRequestDto): boolean {
  return request.status === "PENDING" && request.canDecide;
}

export function selectableIds(requests: readonly ApprovalRequestDto[]): string[] {
  return requests.filter(isSelectable).map((request) => request.id);
}

/**
 * The selection, less anything that left the queue or stopped waiting on the viewer (decided by
 * someone else, filtered out, moved to a step they can't decide). Returns the same set when
 * nothing changed, so it can feed a state setter without a render loop.
 */
export function keepSelectable(
  selection: ReadonlySet<string>,
  requests: readonly ApprovalRequestDto[],
): ReadonlySet<string> {
  const allowed = new Set(selectableIds(requests));
  const kept = [...selection].filter((id) => allowed.has(id));
  return kept.length === selection.size ? selection : new Set(kept);
}

function stepName(request: ApprovalRequestDto): string | null {
  return request.chain.steps[request.currentStep]?.name ?? null;
}

/** "Round 2 · step 1 of 2: Manager review" (the step count only for longer chains). */
export function roundLine(request: ApprovalRequestDto): string {
  const name = stepName(request);
  const steps = request.chain.steps.length;
  const step =
    steps > 1
      ? ` · step ${request.currentStep + 1} of ${steps}${name ? `: ${name}` : ""}`
      : name
        ? ` · ${name}`
        : "";
  return `Round ${request.round}${step}`;
}

/** Whose move it is: the viewer's, or the step that holds the round. */
export function waitingOn(request: ApprovalRequestDto): string {
  if (isSelectable(request)) return "Your call";
  return `Waiting on ${stepName(request) ?? "the chain"}`;
}
