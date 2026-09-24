"use client";

import type { PostDto } from "@enmo/shared";
import { useState } from "react";
import { Button, type ButtonSize } from "@/components/ui/Button";
import { cx } from "@/components/ui/cx";
import { useToast } from "@/components/ui/Toast";
import { useDecide } from "@/hooks/useApprovals";
import { errorMessage } from "@/lib/api";
import { useCan } from "@/lib/auth";
import { RequestChangesDialog } from "./RequestChangesDialog";

/*
 * Approve / Request Changes / Edit for one post, shared by the card and the detail drawer. The
 * decision buttons show only when the viewer may decide the round's current step (the API's
 * `canDecide`); Approve is optimistic, so the green border lands with the click.
 */

/**
 * The API's own answer (PostDto.editable): the copy waits on a human or is approved and unpublished,
 * no agent still owes the post work, and its campaign isn't archived.
 */
export function canEditPost(post: PostDto): boolean {
  return post.editable && post.copy !== null;
}

export function isDecidable(post: PostDto): boolean {
  return post.currentApproval?.status === "PENDING" && post.currentApproval.canDecide;
}

export function PostActions({
  post,
  onEdit,
  size = "sm",
  className,
}: {
  post: PostDto;
  /** Shown when set and the viewer may edit this post's copy now. */
  onEdit?: () => void;
  size?: ButtonSize;
  className?: string;
}) {
  const toast = useToast();
  const decide = useDecide();
  const mayEdit = useCan("posts.editCopy");
  const [requesting, setRequesting] = useState(false);
  const approval = post.currentApproval;
  const decidable = isDecidable(post);
  const editable = Boolean(onEdit) && mayEdit && canEditPost(post);

  function approve() {
    if (!approval) return;
    const lastStep = approval.currentStep >= approval.stepCount - 1;
    decide.mutate(
      { requestId: approval.id, postId: post.id, decision: "APPROVE" },
      {
        onSuccess: (request) =>
          toast.success(
            request.status === "APPROVED" ? `${post.ref} approved` : `${post.ref}: step approved`,
            lastStep ? undefined : "The next step of the chain has it now.",
          ),
        onError: (error) => toast.error(`Couldn't approve ${post.ref}`, errorMessage(error)),
      },
    );
  }

  // The dialog outlives the buttons: once changes are requested the round closes and the buttons go,
  // but the dialog still has to hear back from its request.
  if (!decidable && !editable && !requesting) return null;

  return (
    <div className={cx("flex flex-wrap items-center gap-2 empty:hidden", className)}>
      {decidable ? (
        <>
          <Button variant="primary" size={size} onClick={approve} loading={decide.isPending}>
            Approve
          </Button>
          <Button size={size} onClick={() => setRequesting(true)} disabled={decide.isPending}>
            Request changes
          </Button>
        </>
      ) : null}
      {editable ? (
        <Button variant="ghost" size={size} onClick={onEdit}>
          Edit
        </Button>
      ) : null}
      {requesting ? (
        <RequestChangesDialog post={post} open onClose={() => setRequesting(false)} />
      ) : null}
    </div>
  );
}
