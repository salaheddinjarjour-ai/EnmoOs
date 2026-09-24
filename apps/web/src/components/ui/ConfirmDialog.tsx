"use client";

import type { ReactNode } from "react";
import { Button } from "./Button";
import { Dialog, DialogActions } from "./Dialog";
import { FormAlert } from "./Field";

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  /** Destructive actions use the danger button; everything else the primary one. */
  tone?: "danger" | "primary";
  pending?: boolean;
  error?: string | null;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  tone = "danger",
  pending = false,
  error,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title={title} size="sm" dismissible={!pending}>
      {description ? (
        <div className="mb-4 text-sm leading-relaxed text-steel">{description}</div>
      ) : null}
      {error ? <FormAlert className="mb-4">{error}</FormAlert> : null}
      <DialogActions>
        <Button variant="ghost" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button variant={tone} onClick={onConfirm} loading={pending}>
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
