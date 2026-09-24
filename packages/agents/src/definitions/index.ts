import type {
  CopywriterInput,
  CopywriterOutput,
  ManagerIntakeInput,
  ManagerIntakeOutput,
  ManagerPlanInput,
  ManagerPlanOutput,
  ManagerQaInput,
  ManagerQaOutput,
} from "@enmo/shared";
import type { AgentDefinition } from "../definition";
import { copywriterWrite } from "./copywriter";
import { managerIntake, managerPlan, managerQa } from "./manager";

export { copywriterWrite } from "./copywriter";
export {
  DEFAULT_MAX_TOKENS,
  PLAN_MAX_TOKENS,
  managerIntake,
  managerPlan,
  managerQa,
} from "./manager";

/** Every agent action the orchestrator runs, by `${agent}.${action}`. Later phases add theirs. */
export interface AgentDefinitions {
  "MANAGER.intake": AgentDefinition<ManagerIntakeInput, ManagerIntakeOutput>;
  "MANAGER.plan": AgentDefinition<ManagerPlanInput, ManagerPlanOutput>;
  "MANAGER.qa": AgentDefinition<ManagerQaInput, ManagerQaOutput>;
  "COPYWRITER.write": AgentDefinition<CopywriterInput, CopywriterOutput>;
}

export type AgentKey = keyof AgentDefinitions;

export type AgentRegistry = { readonly [K in AgentKey]?: AgentDefinitions[K] };

export const AGENT_DEFINITIONS: AgentRegistry = {
  "MANAGER.intake": managerIntake,
  "MANAGER.plan": managerPlan,
  "MANAGER.qa": managerQa,
  "COPYWRITER.write": copywriterWrite,
};

/** The definition for `key`; throws if it hasn't been registered. */
export function getAgentDefinition<K extends AgentKey>(key: K): AgentDefinitions[K] {
  const definition = AGENT_DEFINITIONS[key];
  if (!definition) throw new Error(`No agent definition registered for ${key}`);
  return definition;
}
