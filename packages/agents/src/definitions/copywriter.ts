import { CopywriterInput, CopywriterOutput } from "@enmo/shared";
import { defaultEffort, type AgentDefinition } from "../definition";
import {
  COPYWRITER_PROMPT_VERSION,
  COPYWRITER_SYSTEM_PROMPT,
  renderBrandBlock,
  renderCopywriterUserMessage,
} from "../prompts/index";
import { validateCopy } from "../validators/index";
import { DEFAULT_MAX_TOKENS } from "./manager";

export const copywriterWrite: AgentDefinition<CopywriterInput, CopywriterOutput> = {
  agent: "COPYWRITER",
  action: "write",
  promptVersion: COPYWRITER_PROMPT_VERSION,
  effort: defaultEffort("COPYWRITER", "write"),
  maxTokens: DEFAULT_MAX_TOKENS,
  input: CopywriterInput,
  output: CopywriterOutput,
  systemPrompt: COPYWRITER_SYSTEM_PROMPT,
  brandBlock: (input) => renderBrandBlock(input.brand),
  userMessage: renderCopywriterUserMessage,
  validate: validateCopy,
};
