"use client";

import type { ReactNode } from "react";
import { AlertsPanel } from "@/components/dashboard/AlertsPanel";
import { Button } from "@/components/ui/Button";
import { FormAlert } from "@/components/ui/Field";
import { LoadingRegion, Skeleton } from "@/components/ui/Skeleton";
import { usePosts } from "@/hooks/usePosts";
import { errorMessage } from "@/lib/api";
import { PipelineKanban } from "./PipelineKanban";

/*
 * One Command Center tab: alerts over the pipeline board for a client (or all clients). With no
 * posts yet there is nothing to board, so the caller's empty state (the idle Arsenal) shows, under
 * any alerts: a first campaign's intake or plan can fail or wait on the budget before any post.
 */
export function ClientPipeline({ clientId, empty }: { clientId?: string; empty: ReactNode }) {
  const posts = usePosts(clientId ? { clientId } : {});

  if (posts.isPending) {
    return (
      <LoadingRegion label="Loading the pipeline">
        <Skeleton className="mb-6 h-14 w-full rounded-xl" />
        <div className="grid grid-cols-7 gap-3">
          {Array.from({ length: 7 }, (_, index) => (
            <Skeleton key={index} className="h-64 rounded-xl" />
          ))}
        </div>
      </LoadingRegion>
    );
  }
  if (posts.isError) {
    return (
      <div className="flex flex-col items-start gap-4">
        <FormAlert>{errorMessage(posts.error)}</FormAlert>
        <Button onClick={() => void posts.refetch()}>Try again</Button>
      </div>
    );
  }
  if (posts.data.length === 0) {
    return (
      <div className="flex flex-col gap-10">
        <AlertsPanel posts={posts.data} clientId={clientId} hideWhenClear />
        {empty}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-10">
      <AlertsPanel posts={posts.data} clientId={clientId} />
      <PipelineKanban posts={posts.data} />
    </div>
  );
}
