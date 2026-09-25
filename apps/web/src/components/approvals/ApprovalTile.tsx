"use client";

import type { ApprovalRequestDto } from "@enmo/shared";
import { PlatformChips, PostTypeChip } from "@/components/post/PlatformChips";
import { PostActions } from "@/components/post/PostActions";
import { PostCard } from "@/components/post/PostCard";
import { Checkbox } from "@/components/ui/Checkbox";
import { cx } from "@/components/ui/cx";
import { RelativeTime } from "@/components/ui/time";
import { roundLine, waitingOn } from "./approvals-model";

/*
 * One round in the queue: the post's thumbnail (PostCard "thumb", which opens the detail drawer),
 * who and what it is for, where the chain stands, and Approve / Request changes when the viewer
 * decides the current step. A round the viewer can decide may also join the batch.
 */

export function ApprovalTile({
  request,
  selectable,
  selected,
  onSelectedChange,
}: {
  request: ApprovalRequestDto;
  /** Offer the batch checkbox (the viewer may approve-all, and decides this step). */
  selectable: boolean;
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
}) {
  const { post, client, campaign } = request;
  const name = `${post.ref} · ${client.name}`;

  return (
    <li className="min-w-0">
      <article
        aria-label={name}
        className={cx(
          "flex h-full gap-3 rounded-xl border p-2.5 transition-colors duration-200 ease-enmo",
          selected ? "border-paper/40 bg-paper/[0.035]" : "border-line bg-panel/50",
        )}
      >
        <PostCard post={post} variant="thumb" className="shrink-0 self-start" />
        <div className="flex min-w-0 flex-1 flex-col gap-2 py-1 pr-1">
          <header className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 flex-col gap-1">
              <p className="flex items-center gap-2">
                <span className="font-mono text-sm text-paper">{post.ref}</span>
                <PostTypeChip type={post.type} />
              </p>
              <p
                className="truncate text-xs text-steel"
                title={`${client.name} · ${campaign.name}`}
              >
                <span className="text-paper/85">{client.name}</span> · {campaign.name}
              </p>
            </div>
            {selectable ? (
              <Checkbox
                label={<span className="sr-only">Select {name}</span>}
                checked={selected}
                onChange={(event) => onSelectedChange(event.target.checked)}
                className="mt-0.5"
              />
            ) : null}
          </header>
          <PlatformChips platforms={post.platforms} compact />
          <p className="line-clamp-3 text-xs leading-relaxed break-words text-paper/80">
            {post.copy?.caption ?? post.angle ?? "No caption yet."}
          </p>
          <p className="font-mono text-[10px] leading-relaxed tracking-[0.08em] text-steel uppercase">
            {roundLine(request)} · {waitingOn(request)} ·{" "}
            <RelativeTime iso={request.createdAt} className="normal-case" />
          </p>
          <PostActions post={post} className="mt-auto pt-1" />
        </div>
      </article>
    </li>
  );
}
