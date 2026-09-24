"use client";

import {
  AcceptInviteRequest,
  PASSWORD_MIN_LENGTH,
  ROLE_LABEL,
  type InvitePreviewResponse,
} from "@enmo/shared";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonLink } from "@/components/ui/Button";
import { FormAlert } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { SkeletonText } from "@/components/ui/Skeleton";
import { formatDate } from "@/components/ui/time";
import { useAcceptInvite, useInvitePreview } from "@/hooks/useInvite";
import { ApiError, errorMessage, fieldErrors } from "@/lib/api";
import { AuthLayout, AuthPanel } from "./AuthLayout";

/** /invite/[token]: check the one-time link, then set a name and password to join. */
export function InviteAcceptScreen({ token }: { token: string }) {
  const preview = useInvitePreview(token);

  return (
    <AuthLayout>
      {preview.data ? (
        <AcceptInviteForm token={token} invite={preview.data} />
      ) : preview.isError ? (
        <InviteUnavailable error={preview.error} onRetry={() => void preview.refetch()} />
      ) : (
        <AuthPanel title="Checking your invitation">
          <div role="status" aria-live="polite">
            <span className="sr-only">Checking the invite link…</span>
            <SkeletonText lines={3} />
          </div>
        </AuthPanel>
      )}
    </AuthLayout>
  );
}

function InviteUnavailable({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (error instanceof ApiError && (error.status === 404 || error.status === 409)) {
    return (
      <AuthPanel
        title="This invite has closed."
        description="Invite links work once and expire after seven days. Ask an admin for a fresh one."
      >
        <ButtonLink href="/login" variant="secondary" className="w-full">
          Go to sign in
        </ButtonLink>
      </AuthPanel>
    );
  }
  return (
    <AuthPanel title="Can't check this invite right now." description={errorMessage(error)}>
      <Button variant="secondary" onClick={onRetry} className="w-full">
        Try again
      </Button>
    </AuthPanel>
  );
}

function AcceptInviteForm({ token, invite }: { token: string; invite: InvitePreviewResponse }) {
  const router = useRouter();
  const accept = useAcceptInvite(token);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = AcceptInviteRequest.safeParse({ name, password });
    const nextErrors: Record<string, string> = parsed.success ? {} : fieldErrors(parsed.error);
    if (!parsed.success && nextErrors.name) nextErrors.name = "Tell the team what to call you";
    if (confirm !== password) nextErrors.confirm = "The passwords don't match";
    setErrors(nextErrors);
    if (!parsed.success || nextErrors.confirm) return;

    accept.mutate(parsed.data, {
      onSuccess: () => router.replace("/command"),
      onError: (error) => setErrors(fieldErrors(error)),
    });
  }

  return (
    <AuthPanel
      title="Join ENMO OS"
      description={
        <span className="flex flex-wrap items-center gap-2">
          You&apos;re invited as <Badge tone="neutral">{ROLE_LABEL[invite.role]}</Badge>
        </span>
      }
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-5">
        <div className="flex flex-col gap-1 rounded-md border border-line bg-void/50 px-3.5 py-3">
          <span className="text-xs text-steel">Signing in as</span>
          <span className="truncate font-mono text-sm text-paper">{invite.email}</span>
          <span className="font-mono text-[11px] text-steel/80">
            Link expires {formatDate(invite.expiresAt)}
          </span>
        </div>
        <Input
          label="Your name"
          name="name"
          autoComplete="name"
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={errors.name}
          required
        />
        <Input
          label="Password"
          type="password"
          name="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
          error={errors.password}
          required
        />
        <Input
          label="Confirm password"
          type="password"
          name="confirm"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          error={errors.confirm}
          required
        />
        {accept.isError ? <FormAlert>{errorMessage(accept.error)}</FormAlert> : null}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={accept.isPending || accept.isSuccess}
          className="mt-1 w-full"
        >
          Join ENMO OS
        </Button>
      </form>
    </AuthPanel>
  );
}
