"use client";

import type { AgentTaskDto, CampaignDto, ChatMessageDto, PostDto } from "@enmo/shared";
import type { ReactNode } from "react";
import { AgentAvatar } from "@/components/agent/AgentAvatar";
import { AgentSignature } from "@/components/agent/AgentSignature";
import { formatDateTime } from "@/components/ui/time";
import { BriefCard } from "./BriefCard";
import { ClarifyCard, type ClarifyReply } from "./ClarifyCard";
import { EscalationCard } from "./EscalationCard";
import { PlanCard } from "./PlanCard";
import { PostCardsMessage } from "./PostCardsMessage";
import { isBusy, ProgressFeed } from "./ProgressFeed";
import { clarifyState, latestCardMessage } from "./thread-model";

/*
 * The thread, Claude-style: the team's turns as bubbles on the right, the Arsenal's messages on
 * the left, each signed with the agent's avatar and name (mono). Structured messages render as
 * their cards; everything else is plain text.
 */

const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

export interface MessageListProps {
  campaign: CampaignDto;
  messages: readonly ChatMessageDto[];
  posts: ReadonlyMap<string, PostDto> | undefined;
  tasks: ReadonlyMap<string, AgentTaskDto> | undefined;
  /** Answers the open clarifying question; null when the viewer can't post. */
  clarifyReply: ClarifyReply | null;
}

export function MessageList({ campaign, messages, posts, tasks, clarifyReply }: MessageListProps) {
  const owners = latestCardMessage(messages);
  return (
    <ol aria-label="Conversation" className="flex flex-col gap-8">
      {messages.map((message) => {
        if (message.role === "USER") return <UserMessage key={message.id} message={message} />;
        if (message.role === "SYSTEM") {
          return (
            <li
              key={message.id}
              className="text-center font-mono text-[11px] tracking-[0.14em] text-steel uppercase"
            >
              {message.content}
            </li>
          );
        }
        return (
          <AgentMessage
            key={message.id}
            message={message}
            active={message.kind === "PROGRESS" && message.payload.aggregate.some(isBusy)}
          >
            {renderBody(message)}
          </AgentMessage>
        );
      })}
    </ol>
  );

  function renderBody(message: ChatMessageDto): ReactNode {
    switch (message.kind) {
      case "TEXT":
        return <Text>{message.content}</Text>;
      case "CLARIFY": {
        const state = clarifyState(messages, message.id);
        const open = state.isLatest && !state.answered && campaign.status === "BRIEFING";
        return (
          <ClarifyCard
            payload={message.payload}
            reply={open ? clarifyReply : null}
            answered={state.answered}
          />
        );
      }
      case "BRIEF":
        return (
          <>
            <Text>{message.content}</Text>
            <BriefCard payload={message.payload} />
          </>
        );
      case "PLAN":
        // The message text is the plan summary, which the card shows with the plan.
        return <PlanCard graphId={message.payload.graphId} version={message.payload.version} />;
      case "PROGRESS":
        return <ProgressFeed payload={message.payload} />;
      case "POST_CARD":
        return (
          <>
            <Text>{message.content}</Text>
            <PostCardsMessage
              messageId={message.id}
              payload={message.payload}
              posts={posts}
              owners={owners}
            />
          </>
        );
      case "ESCALATION":
        return (
          <>
            {message.content ? <Text>{message.content}</Text> : null}
            <EscalationCard
              campaignId={campaign.id}
              payload={message.payload}
              task={tasks?.get(message.payload.taskId)}
            />
          </>
        );
    }
  }
}

function Text({ children }: { children: ReactNode }) {
  return (
    <p className="text-[15px] leading-relaxed whitespace-pre-wrap text-paper/90">{children}</p>
  );
}

function AgentMessage({
  message,
  active,
  children,
}: {
  message: ChatMessageDto;
  active: boolean;
  children: ReactNode;
}) {
  const agent = message.agent ?? "MANAGER";
  return (
    <li className="flex gap-3.5" data-kind={message.kind}>
      <AgentAvatar agent={agent} size="sm" active={active} className="mt-0.5" />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <AgentSignature agent={agent} at={message.createdAt} />
        {children}
      </div>
    </li>
  );
}

function UserMessage({ message }: { message: ChatMessageDto }) {
  return (
    <li className="flex justify-end" data-kind="USER">
      <div className="flex max-w-[min(38rem,85%)] flex-col gap-2 rounded-2xl rounded-br-md border border-line bg-paper/[0.05] px-4 py-3">
        <p className="text-[15px] leading-relaxed whitespace-pre-wrap text-paper">
          {message.content}
        </p>
        <p className="text-right font-mono text-[10px] tracking-[0.14em] text-steel uppercase">
          {message.author?.name ?? "You"} ·{" "}
          <time
            dateTime={message.createdAt}
            title={formatDateTime(message.createdAt)}
            suppressHydrationWarning
          >
            {TIME.format(new Date(message.createdAt))}
          </time>
        </p>
      </div>
    </li>
  );
}
