"use client";

import type { CampaignDto, ChatMessageDto } from "@enmo/shared";
import { usePostMessage } from "@/hooks/useThread";
import { useRequestPlanChanges } from "@/hooks/useTaskGraph";
import { errorMessage } from "@/lib/api";
import { useCan } from "@/lib/auth";
import { MessageField } from "./MessageField";
import { composerMode } from "./thread-model";

/*
 * The thread's composer. It is disabled while the Manager is thinking (or once the brief is
 * locked), sends brief turns while briefing, and while a plan waits for approval it asks for a
 * new version: the Manager only re-plans on a change request, so a plain message would go
 * unanswered.
 */
export function Composer({
  campaign,
  messages,
}: {
  campaign: CampaignDto;
  messages: readonly ChatMessageDto[];
}) {
  const canPost = useCan("chat.post");
  const canRequestChanges = useCan("plan.requestChanges");
  const postMessage = usePostMessage(campaign.threadId);
  const requestChanges = useRequestPlanChanges();
  const mode = composerMode(campaign, messages);

  const allowed = mode.kind === "plan-changes" ? canRequestChanges : canPost;
  const pending = postMessage.isPending || requestChanges.isPending;
  const error = mode.kind === "plan-changes" ? requestChanges.error : postMessage.error;

  async function send(text: string): Promise<boolean> {
    try {
      if (mode.kind === "plan-changes") {
        await requestChanges.mutateAsync({ graphId: mode.graphId, feedback: text });
      } else {
        await postMessage.mutateAsync(text);
      }
      return true;
    } catch {
      return false;
    }
  }

  return (
    <MessageField
      label="Message the Manager"
      labelHidden
      placeholder={
        mode.kind === "closed"
          ? mode.reason
          : !allowed
            ? "Your role can read this thread but not post to it."
            : mode.placeholder
      }
      submitLabel={mode.kind === "plan-changes" ? "Request changes" : "Send"}
      disabled={mode.kind === "closed" || !allowed}
      pending={pending}
      error={error ? errorMessage(error) : null}
      onSubmit={send}
      rows={1}
      className="shadow-[0_24px_60px_-30px_rgb(0_0_0/0.9)]"
    />
  );
}
