"use client";

import { VERBATIM_TEXT_MAX_LENGTH } from "@enmo/shared";
import type { FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { FormAlert } from "@/components/ui/Field";
import { Textarea } from "@/components/ui/Textarea";
import { errorMessage } from "@/lib/api";

/*
 * Regenerate (MASTER_PLAN §03 The Vault): the Visual Director gets the take's original context back
 * (its shot, the post's copy and the brand) plus the note, which is sent exactly as typed, never
 * trimmed. A blank note sends none, and the Director re-rolls the shot. The note lives with the
 * drawer, so it survives the stage switching to the new version (and comes back on a refusal).
 */

export function RegenerateForm({
  note,
  onNoteChange,
  blockedReason,
  pending,
  error,
  onSubmit,
}: {
  note: string;
  onNoteChange: (note: string) => void;
  /** Why a Regenerate can't start right now (a take of the shot is still rendering). */
  blockedReason: string | null;
  pending: boolean;
  error: unknown;
  onSubmit: () => void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pending && blockedReason === null) onSubmit();
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <p className="text-sm leading-relaxed text-steel">
        The Visual Director gets this take&apos;s shot, the post&apos;s copy and the brand back, and
        renders the next version. Posts keep the current take until the new one passes review.
      </p>
      <Textarea
        label="Instruction (optional)"
        value={note}
        onChange={(event) => onNoteChange(event.target.value)}
        rows={3}
        maxLength={VERBATIM_TEXT_MAX_LENGTH}
        showCount
        placeholder="Warmer light, and bring the glass closer to camera."
        hint="Sent verbatim. Leave it empty to let the Visual Director re-roll the shot."
        disabled={pending}
      />
      {error ? <FormAlert>{errorMessage(error)}</FormAlert> : null}
      <div className="flex flex-wrap items-center justify-end gap-3">
        {blockedReason && !pending ? (
          <p className="mr-auto text-xs text-steel">{blockedReason}</p>
        ) : null}
        <Button type="submit" variant="primary" loading={pending} disabled={blockedReason !== null}>
          Regenerate
        </Button>
      </div>
    </form>
  );
}
