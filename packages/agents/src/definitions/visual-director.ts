import {
  VisualDirectInput,
  VisualDirectOutput,
  VisualReviewInput,
  VisualReviewOutput,
} from "@enmo/shared";
import { defaultEffort, type AgentDefinition } from "../definition";
import {
  VISUAL_DIRECTOR_DIRECT_PROMPT_VERSION,
  VISUAL_DIRECTOR_DIRECT_SYSTEM_PROMPT,
  VISUAL_DIRECTOR_REVIEW_PROMPT_VERSION,
  VISUAL_DIRECTOR_REVIEW_SYSTEM_PROMPT,
  renderBrandBlock,
  renderVisualDirectUserMessage,
  renderVisualReviewUserMessage,
} from "../prompts/index";
import { validateVisualDirect, validateVisualReview } from "../validators/index";
import { DEFAULT_MAX_TOKENS } from "./manager";

/** Turns one post's copy into a shot list with provider prompts. */
export const visualDirectorDirect: AgentDefinition<VisualDirectInput, VisualDirectOutput> = {
  agent: "VISUAL_DIRECTOR",
  action: "direct",
  promptVersion: VISUAL_DIRECTOR_DIRECT_PROMPT_VERSION,
  effort: defaultEffort("VISUAL_DIRECTOR", "direct"),
  maxTokens: DEFAULT_MAX_TOKENS,
  input: VisualDirectInput,
  output: VisualDirectOutput,
  systemPrompt: VISUAL_DIRECTOR_DIRECT_SYSTEM_PROMPT,
  brandBlock: (input) => renderBrandBlock(input.brand),
  userMessage: renderVisualDirectUserMessage,
  validate: validateVisualDirect,
};

/**
 * Looks at one render and accepts it or asks for another take. Run it with
 * `runAgent(visualDirectorReview, input, { ...hooks, images: [render] })`: the render travels as
 * an image block beside the input.
 */
export const visualDirectorReview: AgentDefinition<VisualReviewInput, VisualReviewOutput> = {
  agent: "VISUAL_DIRECTOR",
  action: "review",
  promptVersion: VISUAL_DIRECTOR_REVIEW_PROMPT_VERSION,
  effort: defaultEffort("VISUAL_DIRECTOR", "review"),
  maxTokens: DEFAULT_MAX_TOKENS,
  input: VisualReviewInput,
  output: VisualReviewOutput,
  systemPrompt: VISUAL_DIRECTOR_REVIEW_SYSTEM_PROMPT,
  brandBlock: (input) => renderBrandBlock(input.brand),
  userMessage: renderVisualReviewUserMessage,
  validate: validateVisualReview,
};
