import { AgentName } from "@enmo/shared";

/*
 * MockLlm fault injection (DESIGN §C), e.g. MOCK_LLM_FAULTS="COPYWRITER.write:invalid*2,MANAGER.qa:weak".
 *
 * Each entry is `AGENT.action:kind[*N]` (N defaults to 1). Faults are counted per *subject*, the
 * piece of work a call is about (one post's copy, one intake conversation, one plan request),
 * not globally: with concurrent posts a global counter would spread `invalid*3` across three
 * posts and nothing would escalate. Within a subject the entries for a key fire in order, so
 * "COPYWRITER.write:invalid*2" makes every post fail attempts 1 and 2 and pass attempt 3, and a
 * later retry of the same post runs clean.
 *
 * Kinds: invalid (a field missing), banned (a banned word in the copy), refusal, truncated (half
 * the JSON with stop_reason max_tokens) and weak (a valid negative verdict: QA revises). `weak`
 * only affects agents that give verdicts and is a no-op elsewhere; `banned` falls back to
 * `invalid` where the output isn't checked for banned words or the brand has none.
 */

export const MOCK_FAULT_KINDS = ["invalid", "banned", "refusal", "truncated", "weak"] as const;
export type MockFaultKind = (typeof MOCK_FAULT_KINDS)[number];

export interface MockFault {
  /** `AGENT.action`, e.g. "COPYWRITER.write". */
  key: string;
  kind: MockFaultKind;
  /** How many calls per subject it affects (≥ 1). */
  count: number;
}

const ENTRY = /^([A-Z_]+)\.([a-z][a-zA-Z]*)\s*:\s*([a-z]+)\s*(?:\*\s*(\d+))?$/;

/** Parses the MOCK_LLM_FAULTS syntax; throws on the first malformed entry. */
export function parseMockFaults(spec: string): MockFault[] {
  const faults: MockFault[] = [];
  for (const raw of spec.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const match = ENTRY.exec(entry);
    if (!match) {
      throw new Error(`Invalid MOCK_LLM_FAULTS entry "${entry}": expected AGENT.action:kind[*N]`);
    }
    const [, agent, action, kind, count] = match;
    if (!AgentName.safeParse(agent).success) {
      throw new Error(`Invalid MOCK_LLM_FAULTS entry "${entry}": unknown agent ${agent}`);
    }
    if (!(MOCK_FAULT_KINDS as readonly string[]).includes(kind!)) {
      throw new Error(
        `Invalid MOCK_LLM_FAULTS entry "${entry}": kind must be one of ${MOCK_FAULT_KINDS.join(", ")}`,
      );
    }
    const times = count === undefined ? 1 : Number(count);
    if (!Number.isSafeInteger(times) || times < 1) {
      throw new Error(`Invalid MOCK_LLM_FAULTS entry "${entry}": the count must be at least 1`);
    }
    faults.push({ key: `${agent}.${action}`, kind: kind as MockFaultKind, count: times });
  }
  return faults;
}

/** The fault for the `callIndex`-th (0-based) call of one subject, or null for a clean call. */
export function faultAt(
  faults: readonly MockFault[],
  key: string,
  callIndex: number,
): MockFaultKind | null {
  let remaining = callIndex;
  for (const fault of faults) {
    if (fault.key !== key) continue;
    if (remaining < fault.count) return fault.kind;
    remaining -= fault.count;
  }
  return null;
}
