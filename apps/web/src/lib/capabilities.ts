import { CapabilitiesResponse } from "@enmo/shared";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

/*
 * Runtime modes from GET /v1/capabilities (which LLM, visual provider and publish mode the API runs
 * with). The Topbar turns the non-production ones into chips so nobody mistakes a dry run for a
 * live post. Not to be confused with RBAC capabilities (useCan in lib/auth).
 */

export const RUNTIME_QUERY_KEY = ["runtime-capabilities"] as const;

export function useRuntimeCapabilities() {
  return useQuery({
    queryKey: RUNTIME_QUERY_KEY,
    queryFn: ({ signal }) => api("/capabilities", { schema: CapabilitiesResponse, signal }),
    staleTime: 5 * 60_000,
  });
}

export interface ModeChip {
  id: "llm" | "visual" | "publish";
  label: string;
  description: string;
}

/** Chips for every mode that is not the real thing; an empty list means fully live. */
export function modeChips(capabilities: CapabilitiesResponse): ModeChip[] {
  const chips: ModeChip[] = [];
  if (capabilities.llm.provider === "mock") {
    chips.push({
      id: "llm",
      label: "Mock LLM",
      description: "Agents answer from deterministic fixtures; no Anthropic calls are made.",
    });
  }
  if (capabilities.visual.provider === "mock") {
    chips.push({
      id: "visual",
      label: "Mock visuals",
      description: "Renders are branded placeholders, not Higgsfield output.",
    });
  }
  if (capabilities.publish.mode === "dry-run") {
    chips.push({
      id: "publish",
      label: "Dry-run",
      description:
        "Publishing validates payloads and returns dryrun.enmo.marketing links; nothing is posted.",
    });
  }
  return chips;
}
