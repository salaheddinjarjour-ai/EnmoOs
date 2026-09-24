"use client";

import type { PostDto } from "@enmo/shared";
import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { cx } from "@/components/ui/cx";
import { useClient } from "@/hooks/useClients";
import { formatCalendarDay, qaNoteOf } from "./format";
import { PlatformChips, PostTypeChip } from "./PlatformChips";
import { PostActions } from "./PostActions";
import { PostDetailDrawer, type DrawerMode } from "./PostDetailDrawer";
import { PostPreview } from "./PostPreview";
import { StatusPill } from "./StatusPill";

/*
 * The atomic unit (MASTER_PLAN §04): 9:16 preview, caption excerpt, platform chips, status pill,
 * Approve / Edit / Request Changes, reused in chat, the approvals queue and the kanban.
 *   full     chat and queue: everything, with the actions
 *   compact  kanban: small preview, ref, the caption's first lines and the format; opens the drawer
 *   thumb    batch views: just the frame and the ref
 * Approved posts wear the green border. Pass `onOpen` when a parent owns the detail drawer (a
 * board where the card moves between columns); otherwise the card keeps its own.
 */

export type PostCardVariant = "full" | "compact" | "thumb";

export interface PostCardProps {
  post: PostDto;
  variant?: PostCardVariant;
  onOpen?: (post: PostDto, mode: DrawerMode) => void;
  className?: string;
}

function roundLine(post: PostDto): string | null {
  const approval = post.currentApproval;
  if (post.status === "CHANGES_REQUESTED" || (post.status === "DRAFTING" && post.revision > 0)) {
    return "Changes requested · revising";
  }
  if (!approval || approval.status !== "PENDING") return null;
  const waiting = approval.canDecide
    ? "Your call"
    : `Waiting on ${approval.stepName ?? "the chain"}`;
  return `Round ${approval.round} · ${waiting}`;
}

export function PostCard({ post, variant = "full", onOpen, className }: PostCardProps) {
  const client = useClient(post.clientId);
  const palette = client.data?.visualStyle.palette;
  const [drawer, setDrawer] = useState<DrawerMode | null>(null);

  const open = (mode: DrawerMode) => (onOpen ? onOpen(post, mode) : setDrawer(mode));
  const drawerElement =
    drawer && !onOpen ? (
      <PostDetailDrawer post={post} open initialMode={drawer} onClose={() => setDrawer(null)} />
    ) : null;

  const frame = cx(
    "group relative rounded-xl border bg-panel transition duration-250 ease-enmo",
    post.approved ? "border-enmo/60" : post.failed ? "border-red-400/35" : "border-line",
    className,
  );

  if (variant === "thumb" || variant === "compact") {
    const compact = variant === "compact";
    return (
      <article
        aria-label={compact ? `Post ${post.ref}` : `Thumbnail of ${post.ref}`}
        className={cx(
          frame,
          "flex items-start gap-2.5 p-2 hover:-translate-y-px hover:border-paper/20",
        )}
      >
        <PostPreview post={post} palette={palette} size={compact ? "compact" : "thumb"} />
        {compact ? (
          // Narrow kanban columns: the column already names the stage, so the pill gives way to
          // the ref, the caption's first lines and the format; attention shows as a dot.
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-center justify-between gap-1.5">
              <span className="font-mono text-[11px] text-paper">{post.ref}</span>
              <PlatformChips platforms={post.platforms} compact />
            </div>
            <p className="line-clamp-2 text-[11px] leading-snug break-words text-steel">
              {post.copy?.caption ?? post.angle ?? "Drafting…"}
            </p>
            <div className="flex items-center gap-1.5">
              <PostTypeChip type={post.type} />
              {post.needsAttention || post.failed ? (
                <span
                  title={post.attentionReason ?? (post.failed ? "Failed" : "Needs attention")}
                  className={cx(
                    "size-1.5 shrink-0 rounded-full",
                    post.failed ? "bg-red-400" : "bg-amber-300",
                  )}
                >
                  <span className="sr-only">{post.failed ? "Failed" : "Needs attention"}</span>
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
        {/* Stretched over the card, so the whole card opens the drawer without nesting controls. */}
        <button
          type="button"
          onClick={() => open("view")}
          aria-label={`Open ${post.ref} details`}
          className="absolute inset-0 rounded-xl"
        />
        {drawerElement}
      </article>
    );
  }

  const round = roundLine(post);
  const qaNote = qaNoteOf(post.qaNotes);
  return (
    <article aria-label={`Post ${post.ref}`} className={cx(frame, "flex gap-4 p-4")}>
      <div className="relative shrink-0">
        <PostPreview post={post} palette={palette} />
        <button
          type="button"
          onClick={() => open("view")}
          aria-label={`Open ${post.ref} details`}
          className="absolute inset-0 rounded-lg transition-colors duration-200 ease-enmo hover:bg-paper/[0.03]"
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <header className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm text-paper">{post.ref}</span>
          <PostTypeChip type={post.type} />
          <StatusPill pill={post.pill} approved={post.approved} failed={post.failed} />
          {post.needsAttention ? (
            <Badge tone="warning" title={post.attentionReason ?? undefined}>
              Needs attention
            </Badge>
          ) : null}
        </header>
        <div className="flex flex-wrap items-center gap-2">
          <PlatformChips platforms={post.platforms} />
          {post.targetDate ? (
            <span className="font-mono text-[11px] tracking-[0.08em] text-steel">
              {formatCalendarDay(post.targetDate)}
            </span>
          ) : null}
        </div>
        {post.copy ? (
          <p className="line-clamp-4 text-sm leading-relaxed whitespace-pre-line text-paper/85">
            {post.copy.caption}
          </p>
        ) : (
          <p className="text-sm text-steel">{post.angle ?? "The Copywriter is on it."}</p>
        )}
        {qaNote ? (
          <p
            className={cx(
              "line-clamp-3 rounded-md border px-3 py-2 text-xs leading-relaxed whitespace-pre-line",
              qaNote.open
                ? "border-amber-300/25 bg-amber-300/[0.05] text-amber-100"
                : "border-line text-steel",
            )}
          >
            <span className="mr-1.5 font-mono text-[10px] tracking-[0.12em] uppercase">
              Manager QA
            </span>
            {qaNote.text}
          </p>
        ) : null}
        {round ? (
          <p className="font-mono text-[11px] tracking-[0.08em] text-steel uppercase">{round}</p>
        ) : null}
        <PostActions post={post} onEdit={() => open("edit")} className="mt-auto" />
      </div>
      {drawerElement}
    </article>
  );
}
