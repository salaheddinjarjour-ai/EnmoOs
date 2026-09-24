import { z } from "zod";
import { CampaignStatus, TaskGraphStatus } from "../enums";
import { Brief } from "../contracts/common";
import { Id, IsoDateTime, NamedRef, listResponse } from "./common";
import { CHAT_MESSAGE_MAX_LENGTH } from "./thread";

/** The campaign's newest plan, for pages that need to know where it stands without loading it. */
export const GraphRef = z.object({
  id: Id,
  version: z.int().positive(),
  status: TaskGraphStatus,
});
export type GraphRef = z.infer<typeof GraphRef>;

export const CampaignDto = z.object({
  id: Id,
  /** Null until the brief resolves a client. */
  client: NamedRef.nullable(),
  name: z.string(),
  status: CampaignStatus,
  brief: Brief.nullable(),
  /** How many clarifying questions were asked (at most one). */
  clarifyCount: z.int().nonnegative(),
  threadId: Id,
  briefAt: IsoDateTime,
  briefLockedAt: IsoDateTime.nullable(),
  createdById: Id,
  latestGraph: GraphRef.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CampaignDto = z.infer<typeof CampaignDto>;

/** GET /v1/campaigns — newest first. */
export const CampaignListQuery = z.object({
  clientId: Id.optional(),
  status: CampaignStatus.optional(),
});
export type CampaignListQuery = z.infer<typeof CampaignListQuery>;

export const CampaignListResponse = listResponse(CampaignDto);
export type CampaignListResponse = z.infer<typeof CampaignListResponse>;

/**
 * POST /v1/campaigns → CampaignDto. Opens the campaign and its thread with `message` as the first
 * brief turn; the Manager's intake runs in the background.
 */
export const CreateCampaignRequest = z.object({
  clientId: Id.optional(),
  message: z.string().trim().min(1).max(CHAT_MESSAGE_MAX_LENGTH),
});
export type CreateCampaignRequest = z.infer<typeof CreateCampaignRequest>;
