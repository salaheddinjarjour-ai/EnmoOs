"use client";

import {
  CreateInviteRequest,
  INVITE_TTL_DAYS,
  Role,
  ROLE_LABEL,
  type CreateInviteResponse,
} from "@enmo/shared";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { CopyField } from "@/components/ui/CopyField";
import { Dialog, DialogActions } from "@/components/ui/Dialog";
import { FormAlert } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { formatDate } from "@/components/ui/time";
import { useCreateInvite } from "@/hooks/useTeam";
import { errorMessage, fieldErrors } from "@/lib/api";

/*
 * Invite a teammate (POST /invites). ENMO sends no email: the one-time link is shown once, here,
 * for the admin to copy and share. The raw token is never retrievable again.
 */

const ROLE_OPTIONS = Role.options.map((role) => ({ value: role, label: ROLE_LABEL[role] }));

const ROLE_HINT: Readonly<Record<Role, string>> = {
  ADMIN: "Everything, including the team, audit log and connected accounts.",
  MANAGER: "Edits clients, approves plans and spend, reschedules publishing.",
  EDITOR: "Briefs campaigns, edits copy and decides approvals where the chain allows.",
};

export function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Invite a teammate"
      description={`They get a one-time link that expires in ${INVITE_TTL_DAYS} days.`}
      size="md"
    >
      <InviteFlow onClose={onClose} />
    </Dialog>
  );
}

interface CreatedInvite {
  response: CreateInviteResponse;
  link: string;
}

function InviteFlow({ onClose }: { onClose: () => void }) {
  const create = useCreateInvite();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("EDITOR");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<CreatedInvite | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = CreateInviteRequest.safeParse({ email, role });
    if (!parsed.success) {
      const issues = fieldErrors(parsed.error);
      setErrors(issues.email ? { ...issues, email: "Enter a valid email address" } : issues);
      return;
    }
    setErrors({});
    create.mutate(parsed.data, {
      onSuccess: (response) =>
        setCreated({
          response,
          link: new URL(response.acceptPath, window.location.origin).toString(),
        }),
      onError: (error) => setErrors(fieldErrors(error)),
    });
  }

  if (created) {
    const { invite } = created.response;
    return (
      <div className="flex flex-col gap-5">
        <div className="flex items-start gap-3 rounded-md border border-enmo/25 bg-enmo/[0.05] px-4 py-3">
          <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-enmo" />
          <p className="text-sm leading-relaxed text-paper">
            Invite ready for <span className="font-mono text-[13px]">{invite.email}</span> as{" "}
            {ROLE_LABEL[invite.role]}. Share the link directly; it works once and expires{" "}
            {formatDate(invite.expiresAt)}.
          </p>
        </div>
        <CopyField
          label="Invite link"
          value={created.link}
          buttonVariant="primary"
          hint="This is the only time the link is shown."
        />
        <DialogActions>
          <Button
            variant="ghost"
            onClick={() => {
              setCreated(null);
              setEmail("");
              create.reset();
            }}
          >
            Invite another
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Done
          </Button>
        </DialogActions>
      </div>
    );
  }

  const formError =
    create.isError && Object.keys(errors).length === 0 ? errorMessage(create.error) : null;

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <Input
        label="Email"
        type="email"
        inputMode="email"
        autoComplete="off"
        autoFocus
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="name@enmo.marketing"
        error={errors.email}
        required
      />
      <Select
        label="Role"
        value={role}
        onChange={(event) => setRole(Role.parse(event.target.value))}
        options={ROLE_OPTIONS}
        hint={ROLE_HINT[role]}
        error={errors.role}
      />
      {formError ? <FormAlert>{formError}</FormAlert> : null}
      <DialogActions>
        <Button variant="ghost" onClick={onClose} disabled={create.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={create.isPending}>
          Create invite
        </Button>
      </DialogActions>
    </form>
  );
}
