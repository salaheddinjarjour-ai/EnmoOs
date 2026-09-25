import { PublisherInput, PublisherOutput } from "@enmo/shared";
import { defaultEffort, type AgentDefinition } from "../definition";
import {
  PUBLISHER_PROMPT_VERSION,
  PUBLISHER_SYSTEM_PROMPT,
  renderPublisherUserMessage,
} from "../prompts/index";
import { validatePublisher } from "../validators/index";
import { DEFAULT_MAX_TOKENS } from "./manager";

/**
 * Picks a publish slot for each variant of freshly approved posts among the optimizer's scored
 * candidates. It never escalates: once retries run out the orchestrator takes each variant's top
 * candidate (topSlotCandidate, slotSource "optimizer").
 */
export const publisherSchedule: AgentDefinition<PublisherInput, PublisherOutput> = {
  agent: "PUBLISHER",
  action: "schedule",
  promptVersion: PUBLISHER_PROMPT_VERSION,
  effort: defaultEffort("PUBLISHER", "schedule"),
  maxTokens: DEFAULT_MAX_TOKENS,
  input: PublisherInput,
  output: PublisherOutput,
  systemPrompt: PUBLISHER_SYSTEM_PROMPT,
  // Scheduling needs no brand voice: the input carries everything the choice depends on.
  brandBlock: () => null,
  userMessage: renderPublisherUserMessage,
  validate: validatePublisher,
};
