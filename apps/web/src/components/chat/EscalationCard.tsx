"use client";

import { AGENT_LABEL, type AgentTaskDto, type ChatMessagePayload } from "@enmo/shared";
import { Button } from "@/components/ui/Button";
import { FormAlert } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import { useResolveTask } from "@/hooks/useCampaigns";
import { errorMessage } from "@/lib/api";
import { useCan } from "@/lib/auth";

/*
 * A task the Arsenal gave up on (DESIGN §C/§D: contract retries used up, a refusal, a render the
 * provider refused or failed, weak takes after every regeneration). The issues are listed as the
 * agent saw them; a Manager or Admin can send the task round again with fresh attempts or, for the
 * Visual Director's shots, keep the best-scored take of each shot and let the post move on.
 */

const REASON: Readonly<Record<string, string>> = {
  INVALID_OUTPUT: "Output kept failing its contract",
  REFUSED: "The model refused",
  TRUNCATED: "The answer kept running out of room",
  WEAK_TAKES: "Takes stayed weak after every regeneration",
  RENDER_REJECTED: "The visual provider refused the render",
  RENDER_FAILED: "The render failed",
};

const OPEN = new Set<AgentTaskDto["status"]>(["ESCALATED", "FAILED"]);

export function EscalationCard({
  campaignId,
  payload,
  task,
}: {
  campaignId: string;
  payload: ChatMessagePayload<"ESCALATION">;
  /** The escalated task as it stands now; undefined while loading. */
  task: AgentTaskDto | undefined;
}) {
  const toast = useToast();
  const canResolve = useCan("tasks.resolveEscalation");
  const resolve = useResolveTask(campaignId);
  const stillOpen = task ? OPEN.has(task.status) : true;
  const subject = payload.postRef ? `${payload.postRef}` : "the campaign";
  // Only the Visual Director's shots have takes to choose between (POST /agent-tasks/:id/resolve).
  const hasTakes = payload.agent === "VISUAL_DIRECTOR" && payload.action === "direct";

  function retry() {
    resolve.mutate(
      { taskId: payload.taskId, action: "retry" },
      {
        onSuccess: () =>
          toast.success(
            `${AGENT_LABEL[payload.agent]} is retrying ${subject}`,
            "Fresh attempts, same brief.",
          ),
      },
    );
  }

  function acceptBest() {
    resolve.mutate(
      { taskId: payload.taskId, action: "accept_best" },
      {
        onSuccess: () =>
          toast.success(`Kept the best takes for ${subject}`, "The post moves on to QA."),
      },
    );
  }

  return (
    <section
      aria-label={`Escalation: ${AGENT_LABEL[payload.agent]} on ${subject}`}
      className="flex flex-col gap-3 rounded-xl border border-amber-300/30 bg-amber-300/[0.04] px-5 py-4"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-display text-base font-medium tracking-tight text-paper">
          {AGENT_LABEL[payload.agent]} escalated {subject}
        </h3>
        <span className="font-mono text-[11px] tracking-[0.12em] text-amber-200 uppercase">
          {payload.agent.toLowerCase()}.{payload.action} · {payload.reason}
        </span>
      </header>
      <p className="text-sm text-paper/80">{REASON[payload.reason] ?? payload.reason}.</p>
      {payload.issues.length > 0 ? (
        <ul className="flex flex-col gap-1 rounded-md border border-line bg-void/50 px-3 py-2.5">
          {payload.issues.map((issue, index) => (
            <li key={index} className="text-xs leading-relaxed text-steel">
              <span className="font-mono text-paper/80">{issue.path || "(root)"}</span> —{" "}
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      {stillOpen ? (
        canResolve ? (
          <div className="flex flex-wrap items-center gap-3">
            {hasTakes ? (
              <Button
                variant="primary"
                size="sm"
                onClick={acceptBest}
                disabled={resolve.isPending}
                loading={resolve.isPending && resolve.variables?.action === "accept_best"}
              >
                Accept best take
              </Button>
            ) : null}
            <Button
              variant={hasTakes ? "secondary" : "primary"}
              size="sm"
              onClick={retry}
              disabled={resolve.isPending}
              loading={resolve.isPending && resolve.variables?.action === "retry"}
            >
              Retry
            </Button>
            <span className="text-xs text-steel">
              {hasTakes
                ? "Keep each shot's best-scored take, or run the shots again."
                : "Runs the task again with fresh attempts."}
            </span>
          </div>
        ) : (
          <p className="text-xs text-steel">
            A Manager or Admin can {hasTakes ? "accept the best take or retry it" : "retry it"}.
          </p>
        )
      ) : (
        <p className="font-mono text-[11px] tracking-[0.12em] text-steel uppercase">
          Back in the pipeline · {task?.status.toLowerCase()}
        </p>
      )}
      {resolve.isError ? <FormAlert>{errorMessage(resolve.error)}</FormAlert> : null}
    </section>
  );
}
