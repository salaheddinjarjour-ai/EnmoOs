"use client";

import type { ChatMessagePayload, PostDto } from "@enmo/shared";
import { PostCard } from "@/components/post/PostCard";
import { Skeleton } from "@/components/ui/Skeleton";

/*
 * Posts that passed QA and landed in approval (a POST_CARD message). A post that comes back for
 * another round is announced again further down, so an older message shows it as a thumbnail and
 * leaves the live card (and its buttons) to the newest announcement.
 */

export function PostCardsMessage({
  messageId,
  payload,
  posts,
  owners,
}: {
  messageId: string;
  payload: ChatMessagePayload<"POST_CARD">;
  /** The campaign's posts by id; undefined while loading. */
  posts: ReadonlyMap<string, PostDto> | undefined;
  /** postId → id of the newest POST_CARD message listing it. */
  owners: ReadonlyMap<string, string>;
}) {
  const current = payload.postIds.filter((id) => owners.get(id) === messageId);
  const moved = payload.postIds.filter((id) => owners.get(id) !== messageId);

  return (
    <div className="flex flex-col gap-3">
      {current.length > 0 ? (
        <ul aria-label="Posts for approval" className="grid gap-3 xl:grid-cols-2">
          {current.map((postId) => {
            const post = posts?.get(postId);
            return (
              <li key={postId}>
                {post ? <PostCard post={post} /> : <Skeleton className="h-72 w-full rounded-xl" />}
              </li>
            );
          })}
        </ul>
      ) : null}
      {moved.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="font-mono text-[11px] tracking-[0.12em] text-steel uppercase">
            Revised further down
          </p>
          <ul aria-label="Revised posts" className="flex flex-wrap gap-2">
            {moved.map((postId) => {
              const post = posts?.get(postId);
              return (
                <li key={postId} className="w-28">
                  {post ? (
                    <PostCard post={post} variant="thumb" />
                  ) : (
                    <Skeleton className="aspect-[9/16] w-full rounded-md" />
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
