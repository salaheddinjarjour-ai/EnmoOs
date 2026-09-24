"use client";

import { ChangePasswordRequest, PASSWORD_MIN_LENGTH } from "@enmo/shared";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogActions } from "@/components/ui/Dialog";
import { FormAlert } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { errorMessage, fieldErrors } from "@/lib/api";
import { useChangePassword } from "@/lib/auth";

export function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Change password"
      description="Setting a new password needs the current one."
      size="sm"
    >
      <ChangePasswordForm onDone={onClose} />
    </Dialog>
  );
}

function ChangePasswordForm({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const change = useChangePassword();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = ChangePasswordRequest.safeParse({ currentPassword, newPassword });
    const nextErrors: Record<string, string> = parsed.success ? {} : fieldErrors(parsed.error);
    if (confirm !== newPassword) nextErrors.confirm = "The passwords don't match";
    setErrors(nextErrors);
    if (!parsed.success || nextErrors.confirm) return;

    change.mutate(parsed.data, {
      onSuccess: () => {
        toast.success("Password changed");
        onDone();
      },
      onError: (error) => setErrors(fieldErrors(error)),
    });
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <Input
        label="Current password"
        type="password"
        autoComplete="current-password"
        value={currentPassword}
        onChange={(event) => setCurrentPassword(event.target.value)}
        error={errors.currentPassword}
        required
      />
      <Input
        label="New password"
        type="password"
        autoComplete="new-password"
        value={newPassword}
        onChange={(event) => setNewPassword(event.target.value)}
        hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
        error={errors.newPassword}
        required
      />
      <Input
        label="Confirm new password"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
        error={errors.confirm}
        required
      />
      {change.isError ? <FormAlert>{errorMessage(change.error)}</FormAlert> : null}
      <DialogActions>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={change.isPending}>
          Change password
        </Button>
      </DialogActions>
    </form>
  );
}
