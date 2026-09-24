"use client";

import type { AgentTaskDto, CampaignDto, ChatMessageDto, PostDto } from "@enmo/shared";
import Link from "next/link";
import { useEffect, useMemo, useRef } from "react";
import { Button } from "@/components/ui/Button";
import { FormAlert } from "@/components/ui/Field";
import { LoadingRegion, Skeleton, SkeletonText } from "@/components/ui/Skeleton";
import { RelativeTime } from "@/components/ui/time";
import { useApprovals } from "@/hooks/useApprovals";
import { useCampaign, useCampaignTasks } from "@/hooks/useCampaigns";
import { usePosts } from "@/hooks/usePosts";
import { usePostMessage, useThreadMessages } from "@/hooks/useThread";
import { ApiError, errorMessage } from "@/lib/api";
import { useCan } from "@/lib/auth";
import { useRealtimeThread } from "@/lib/realtime";
import { ApproveAllBar } from "./ApproveAllBar";
import { CampaignStatusBadge } from "./CampaignStatusBadge";
import type { ClarifyReply } from "./ClarifyCard";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { agentsAtWork, hasPosts, managerThinking, requestsWithCards } from "./thread-model";

/*
 * One campaign's thread (MASTER_PLAN §03 "The Brief"): the brief conversation, the plan card, live
 * progress, and the post cards landing in approval, with approve-all and the composer pinned to
 * the bottom. The page streams the thread's events while it is open (lib/realtime).
 */

export function CampaignThread({ campaignId }: { campaignId: string }) {
  const campaign = useCampaign(campaignId);

  if (campaign.isPending) {
    return (
      <LoadingRegion label="Loading the campaign">
        <Skeleton className="mb-4 h-4 w-40" />
        <Skeleton className="mb-10 h-10 w-2/3" />
        <SkeletonText lines={4} className="max-w-2xl" />
      </LoadingRegion>
    );
  }
  if (campaign.isError) {
    const missing = campaign.error instanceof ApiError && campaign.error.status === 404;
    return (
      <div className="flex flex-col items-start gap-4">
        <FormAlert>
          {missing ? "This campaign doesn't exist." : errorMessage(campaign.error)}
        </FormAlert>
        <div className="flex gap-2">
          <Link
            href="/brief"
            className="text-sm text-steel underline underline-offset-4 hover:text-paper"
          >
            Back to all briefs
          </Link>
          {missing ? null : (
            <Button size="sm" onClick={() => void campaign.refetch()}>
              Try again
            </Button>
          )}
        </div>
      </div>
    );
  }
  return <Thread campaign={campaign.data} />;
}

function Thread({ campaign }: { campaign: CampaignDto }) {
  useRealtimeThread(campaign.threadId);
  const messages = useThreadMessages(campaign.threadId);
  const producing = hasPosts(campaign);
  const posts = usePosts({ campaignId: campaign.id }, { enabled: producing });
  const approvals = useApprovals({ campaignId: campaign.id }, { enabled: producing });
  const hasEscalations = messages.data?.some((message) => message.kind === "ESCALATION") ?? false;
  const tasks = useCampaignTasks(campaign.id, { enabled: hasEscalations });
  const canPost = useCan("chat.post");
  const reply = usePostMessage(campaign.threadId);

  const postsById = useMemo(
    () =>
      posts.data ? new Map<string, PostDto>(posts.data.map((post) => [post.id, post])) : undefined,
    [posts.data],
  );
  const reviewable = useMemo(
    () =>
      approvals.data && messages.data
        ? requestsWithCards(approvals.data, messages.data)
        : undefined,
    [approvals.data, messages.data],
  );
  const tasksById = useMemo(
    () =>
      tasks.data
        ? new Map<string, AgentTaskDto>(tasks.data.map((task) => [task.id, task]))
        : undefined,
    [tasks.data],
  );

  const clarifyReply: ClarifyReply | null = canPost
    ? {
        send: async (text) => {
          try {
            await reply.mutateAsync(text);
            return true;
          } catch {
            return false;
          }
        },
        pending: reply.isPending,
        error: reply.error,
      }
    : null;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col">
      <ThreadHeader
        campaign={campaign}
        working={campaign.status === "PRODUCING" && agentsAtWork(messages.data ?? [])}
      />
      {messages.isPending ? (
        <LoadingRegion label="Loading the thread">
          <div className="flex flex-col gap-8">
            <Skeleton className="ml-auto h-20 w-2/3 rounded-2xl" />
            <SkeletonText lines={3} className="max-w-xl" />
          </div>
        </LoadingRegion>
      ) : messages.isError ? (
        <div className="flex flex-col items-start gap-4">
          <FormAlert>{errorMessage(messages.error)}</FormAlert>
          <Button size="sm" onClick={() => void messages.refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <ThreadBody
          campaign={campaign}
          messages={messages.data}
          posts={postsById}
          tasks={tasksById}
          clarifyReply={clarifyReply}
        />
      )}

      <div className="sticky bottom-0 z-10 mt-10 flex flex-col gap-3 bg-linear-to-t from-void via-void/95 to-void/0 pt-6 pb-6">
        {reviewable ? <ApproveAllBar requests={reviewable} /> : null}
        {messages.data ? <Composer campaign={campaign} messages={messages.data} /> : null}
      </div>
    </div>
  );
}

function ThreadBody({
  campaign,
  messages,
  posts,
  tasks,
  clarifyReply,
}: {
  campaign: CampaignDto;
  messages: ChatMessageDto[];
  posts: ReadonlyMap<string, PostDto> | undefined;
  tasks: ReadonlyMap<string, AgentTaskDto> | undefined;
  clarifyReply: ClarifyReply | null;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const thinking = managerThinking(campaign, messages);
  const count = messages.length;

  // Follow new messages when the reader is already at the bottom (or on first load).
  const followRef = useRef(true);
  useEffect(() => {
    const onScroll = () => {
      followRef.current =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 240;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    if (followRef.current) endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [count, thinking]);

  return (
    <>
      <MessageList
        campaign={campaign}
        messages={messages}
        posts={posts}
        tasks={tasks}
        clarifyReply={clarifyReply}
      />
      {thinking ? (
        <div className="mt-8">
          <ThinkingIndicator
            label={
              messages.at(-1)?.kind === "BRIEF" || campaign.status === "PLANNING"
                ? "Manager is drafting the plan…"
                : "Manager is thinking…"
            }
          />
        </div>
      ) : null}
      <div ref={endRef} />
    </>
  );
}

function ThreadHeader({ campaign, working }: { campaign: CampaignDto; working: boolean }) {
  return (
    <header className="mb-10 flex flex-col gap-3">
      <Link
        href="/brief"
        className="w-fit font-mono text-[11px] tracking-[0.24em] text-steel uppercase transition-colors duration-200 hover:text-paper"
      >
        ← The Brief
      </Link>
      <h1 className="font-display text-3xl font-medium tracking-tight text-balance text-paper sm:text-4xl">
        {campaign.name}
      </h1>
      <div className="flex flex-wrap items-center gap-2.5 text-sm text-steel">
        <CampaignStatusBadge status={campaign.status} working={working} />
        <span>{campaign.client?.name ?? "Client to be confirmed"}</span>
        <span aria-hidden>·</span>
        <span>
          Briefed <RelativeTime iso={campaign.briefAt} />
        </span>
      </div>
    </header>
  );
}
