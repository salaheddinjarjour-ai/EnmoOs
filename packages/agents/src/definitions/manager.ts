import {
  ManagerIntakeInput,
  ManagerIntakeNoClarifyOutput,
  ManagerIntakeOutput,
  ManagerPlanInput,
  ManagerPlanOutput,
  ManagerQaInput,
  ManagerQaOutput,
} from "@enmo/shared";
import { defaultEffort, type AgentDefinition } from "../definition";
import {
  MANAGER_INTAKE_PROMPT_VERSION,
  MANAGER_INTAKE_SYSTEM_PROMPT,
  MANAGER_PLAN_PROMPT_VERSION,
  MANAGER_PLAN_SYSTEM_PROMPT,
  MANAGER_QA_PROMPT_VERSION,
  MANAGER_QA_SYSTEM_PROMPT,
  renderBrandBlock,
  renderIntakeUserMessage,
  renderPlanUserMessage,
  renderQaUserMessage,
} from "../prompts/index";
import { validateIntake, validatePlan, validateQa } from "../validators/index";

/** Default starting max_tokens (the runner grows it ×1.5 after a truncation, up to 32k). */
export const DEFAULT_MAX_TOKENS = 16_000;
/** manager.plan writes a node per action per post (up to 241 nodes for 60 posts). */
export const PLAN_MAX_TOKENS = 32_000;

export const managerIntake: AgentDefinition<ManagerIntakeInput, ManagerIntakeOutput> = {
  agent: "MANAGER",
  action: "intake",
  promptVersion: MANAGER_INTAKE_PROMPT_VERSION,
  effort: defaultEffort("MANAGER", "intake"),
  maxTokens: DEFAULT_MAX_TOKENS,
  input: ManagerIntakeInput,
  output: ManagerIntakeOutput,
  // Once the one question has been asked, the clarify branch isn't even in the schema.
  outputFor: (input) => (input.allowClarify ? ManagerIntakeOutput : ManagerIntakeNoClarifyOutput),
  systemPrompt: MANAGER_INTAKE_SYSTEM_PROMPT,
  brandBlock: (input) => (input.brand ? renderBrandBlock(input.brand) : null),
  userMessage: renderIntakeUserMessage,
  validate: validateIntake,
};

export const managerPlan: AgentDefinition<ManagerPlanInput, ManagerPlanOutput> = {
  agent: "MANAGER",
  action: "plan",
  promptVersion: MANAGER_PLAN_PROMPT_VERSION,
  effort: defaultEffort("MANAGER", "plan"),
  maxTokens: PLAN_MAX_TOKENS,
  input: ManagerPlanInput,
  output: ManagerPlanOutput,
  systemPrompt: MANAGER_PLAN_SYSTEM_PROMPT,
  brandBlock: (input) => renderBrandBlock(input.brand),
  userMessage: renderPlanUserMessage,
  validate: validatePlan,
};

export const managerQa: AgentDefinition<ManagerQaInput, ManagerQaOutput> = {
  agent: "MANAGER",
  action: "qa",
  promptVersion: MANAGER_QA_PROMPT_VERSION,
  effort: defaultEffort("MANAGER", "qa"),
  maxTokens: DEFAULT_MAX_TOKENS,
  input: ManagerQaInput,
  output: ManagerQaOutput,
  systemPrompt: MANAGER_QA_SYSTEM_PROMPT,
  brandBlock: (input) => renderBrandBlock(input.brand),
  userMessage: renderQaUserMessage,
  validate: validateQa,
};
