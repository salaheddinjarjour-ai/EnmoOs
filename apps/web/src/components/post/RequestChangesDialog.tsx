"use client";

import { VerbatimText, type FeedbackTarget, type PostDto } from "@enmo/shared";
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { cx } from "@/components/ui/cx";
import { Dialog, DialogActions } from "@/components/ui/Dialog";
import { FieldError, FormAlert, LABEL_CLASS } from "@/components/ui/Field";
import { Textarea } from "@/components/ui/Textarea";
import { useToast } from "@/components/ui/Toast";
import { useDecide } from "@/hooks/useApprovals";
import { errorMessage } from "@/lib/api";
import { useRuntimeCapabilities } from "@/lib/capabilities";

/*
 * Request Changes (DESIGN "Request Changes"): the note reaches the agent byte-for-byte, so the
 * textarea's value is sent exactly as typed (never trimmed), and the reviewer says what needs the
 * work. Visual and Both need the Visual Director in the pipeline (PIPELINE_ACTIONS has "direct",
 * from Phase 3), so until then they are shown but disabled.
 */

const FEEDBACK_MAX = 4000;

const TARGETS: ReadonlyArray<{ value: FeedbackTarget; label: string; description: string }> = [
  { value: "COPY", label: "Copy", description: "The Copywriter redrafts captions and script." },
  { value: "VISUAL", label: "Visual", description: "The Visual Director reshoots." },
  { value: "BOTH", label: "Both", description: "Copy first, then new visuals." },
];

export function RequestChangesDialog({
  post,
  open,
  onClose,
}: {
  post: PostDto;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Request changes to ${post.ref}`}
      description="Say what should change. Your note goes to the agent exactly as you write it, and the post comes back for a new approval round."
    >
      <RequestChangesForm post={post} onDone={onClose} />
    </Dialog>
  );
}

function RequestChangesForm({ post, onDone }: { post: PostDto; onDone: () => void }) {
  const toast = useToast();
  const decide = useDecide();
  const runtime = useRuntimeCapabilities();
  const visualsEnabled = runtime.data?.pipelineActions.includes("direct") ?? false;
  const [feedback, setFeedback] = useState("");
  const [target, setTarget] = useState<FeedbackTarget>("COPY");
  const [error, setError] = useState<string | null>(null);
  const groupId = useId();

  const requestId = post.currentApproval?.id;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!requestId) return;
    const parsed = VerbatimText.safeParse(feedback);
    if (!parsed.success) {
      setError("Say what should change");
      return;
    }
    setError(null);
    decide.mutate(
      { requestId, postId: post.id, decision: "REQUEST_CHANGES", feedback, target },
      {
        onSuccess: () => {
          toast.success(
            `Changes requested on ${post.ref}`,
            target === "COPY"
              ? "The Copywriter has your note, word for word."
              : "The Arsenal has your note, word for word.",
          );
          onDone();
        },
      },
    );
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <Textarea
        label="What should change?"
        value={feedback}
        onChange={(event) => setFeedback(event.target.value)}
        rows={5}
        maxLength={FEEDBACK_MAX}
        showCount
        autoFocus
        placeholder="Lead with the iced cardamom latte, and land the hook in under two seconds."
        hint="Sent verbatim: nothing is trimmed or rewritten on the way."
        error={error}
      />
      <fieldset
        className="flex flex-col gap-2.5"
        aria-describedby={visualsEnabled ? undefined : `${groupId}-hint`}
      >
        <legend className={cx(LABEL_CLASS, "mb-2.5")}>What needs the work</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {TARGETS.map((option) => {
            const disabled = option.value !== "COPY" && !visualsEnabled;
            const checked = target === option.value;
            return (
              <label
                key={option.value}
                className={cx(
                  "flex cursor-pointer flex-col gap-1 rounded-md border px-3 py-2.5 transition duration-200 ease-enmo",
                  checked ? "border-paper/40 bg-paper/[0.05]" : "border-line hover:border-paper/20",
                  disabled && "cursor-not-allowed opacity-45 hover:border-line",
                )}
              >
                <span className="flex items-center gap-2 text-sm text-paper">
                  <input
                    type="radio"
                    aria-label={option.label}
                    aria-describedby={`${groupId}-${option.value}`}
                    name={`${groupId}-target`}
                    value={option.value}
                    checked={checked}
                    disabled={disabled}
                    onChange={() => setTarget(option.value)}
                    className="size-3.5 accent-paper"
                  />
                  {option.label}
                </span>
                <span
                  id={`${groupId}-${option.value}`}
                  className="text-xs leading-relaxed text-steel"
                >
                  {option.description}
                </span>
              </label>
            );
          })}
        </div>
        {visualsEnabled ? null : (
          <p id={`${groupId}-hint`} className="text-xs leading-relaxed text-steel/80">
            Visual and Both open once the Visual Director joins the pipeline (Phase 3). Posts are
            text only for now, so the Copywriter takes the note.
          </p>
        )}
      </fieldset>
      {!requestId ? <FieldError>This post has no open approval round.</FieldError> : null}
      {decide.isError ? <FormAlert>{errorMessage(decide.error)}</FormAlert> : null}
      <DialogActions>
        <Button variant="ghost" onClick={onDone} disabled={decide.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={decide.isPending} disabled={!requestId}>
          Request changes
        </Button>
      </DialogActions>
    </form>
  );
}
