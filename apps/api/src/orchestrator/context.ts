import type { Client, Post } from "@enmo/db";
import {
  Brief,
  ManagerPlanOutput,
  VisualStyleTokens,
  type BrandContext,
  type PostContext,
} from "@enmo/shared";
import { parseStored } from "../lib/stored";

/* Agent inputs are built from stored rows; these helpers read the JSON columns they depend on. */

/** `@db.Date` columns come back as UTC midnight. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function dateFromIsoDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export function brandContextOf(client: Client): BrandContext {
  return {
    clientId: client.id,
    name: client.name,
    timezone: client.timezone,
    brandVoice: client.brandVoice,
    bannedWords: client.bannedWords,
    visualStyle: parseStored(
      VisualStyleTokens,
      client.visualStyle,
      `Client ${client.id}.visualStyle`,
    ),
    platforms: client.enabledPlatforms,
  };
}

export class MissingBriefError extends Error {
  override readonly name = "MissingBriefError";
  constructor(campaignId: string) {
    super(`Campaign ${campaignId} has no locked brief`);
  }
}

export function storedBrief(campaign: { id: string; brief: unknown }): Brief {
  if (campaign.brief === null || campaign.brief === undefined) {
    throw new MissingBriefError(campaign.id);
  }
  return parseStored(Brief, campaign.brief, `Campaign ${campaign.id}.brief`);
}

export function storedPlan(graph: { id: string; graph: unknown }): ManagerPlanOutput {
  return parseStored(ManagerPlanOutput, graph.graph, `TaskGraph ${graph.id}.graph`);
}

/** The planned node a task was created from ("n7.r1" → "n7"). */
export function baseNodeId(nodeKey: string): string {
  return nodeKey.split(".")[0] ?? nodeKey;
}

/** The post as an agent sees it; `instructions` come from the task's plan node. */
export function postContextOf(post: Post, instructions: string | null): PostContext {
  return {
    ref: post.ref,
    type: post.type,
    platforms: post.platforms,
    // Plans always date their posts; a missing date would be a post created outside a plan.
    targetDate: post.targetDate ? isoDate(post.targetDate) : isoDate(post.createdAt),
    angle: post.angle ?? "",
    hook: post.hook,
    pillar: post.pillar,
    targetHookSec: null,
    instructions,
  };
}
