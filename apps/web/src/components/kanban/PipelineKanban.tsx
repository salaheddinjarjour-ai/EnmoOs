"use client";

import { KANBAN_COLUMN_LABEL, KanbanColumn, type PostDto } from "@enmo/shared";
import { useState } from "react";
import { PostCard } from "@/components/post/PostCard";
import { PostDetailDrawer, type DrawerMode } from "@/components/post/PostDetailDrawer";
import { cx } from "@/components/ui/cx";

/*
 * The pipeline board (MASTER_PLAN §03): Idea → Draft → Visual → Approval → Scheduled → Live →
 * Scored, placed by the shared status map (a FAILED post stays in the column it failed in). Cards
 * move between columns as events arrive, so the board owns the one detail drawer: a card that
 * moves while its drawer is open must not take the drawer down with it.
 */

export function groupByColumn(posts: readonly PostDto[]): Record<KanbanColumn, PostDto[]> {
  const columns = Object.fromEntries(
    KanbanColumn.options.map((column) => [column, []]),
  ) as unknown as Record<KanbanColumn, PostDto[]>;
  for (const post of posts) columns[post.column].push(post);
  return columns;
}

export function PipelineKanban({ posts }: { posts: readonly PostDto[] }) {
  const [opened, setOpened] = useState<{ postId: string; mode: DrawerMode } | null>(null);
  const columns = groupByColumn(posts);
  const openPost = opened ? posts.find((post) => post.id === opened.postId) : undefined;

  return (
    <section aria-label="Pipeline" className="flex flex-col gap-3">
      <h2 className="font-display text-base font-medium tracking-tight text-paper">Pipeline</h2>
      <div className="-mx-2 overflow-x-auto px-2 pb-2">
        <ol className="grid min-w-[70rem] grid-cols-7 gap-3">
          {KanbanColumn.options.map((column) => {
            const items = columns[column];
            return (
              <li key={column} className="min-w-0">
                <section
                  aria-label={`${KANBAN_COLUMN_LABEL[column]} column`}
                  className={cx(
                    "flex h-full min-h-40 flex-col gap-2 rounded-xl border border-line bg-panel/40 p-2",
                  )}
                >
                  <header className="flex items-center justify-between px-1.5 pt-1">
                    <h3 className="font-mono text-[11px] tracking-[0.16em] text-steel uppercase">
                      {KANBAN_COLUMN_LABEL[column]}
                    </h3>
                    <span className="font-mono text-[11px] text-steel tabular-nums">
                      {items.length}
                    </span>
                  </header>
                  <ul className="flex flex-col gap-2">
                    {items.map((post) => (
                      <li key={post.id}>
                        <PostCard
                          post={post}
                          variant="compact"
                          onOpen={(target, mode) => setOpened({ postId: target.id, mode })}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              </li>
            );
          })}
        </ol>
      </div>
      {openPost ? (
        <PostDetailDrawer
          post={openPost}
          open
          initialMode={opened?.mode}
          onClose={() => setOpened(null)}
          showCampaignLink
        />
      ) : null}
    </section>
  );
}
