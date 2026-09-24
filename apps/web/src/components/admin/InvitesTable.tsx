"use client";

import { ROLE_LABEL, type InviteDto, type InviteStatus } from "@enmo/shared";
import { useState } from "react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FormAlert } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatDate } from "@/components/ui/time";
import { useToast } from "@/components/ui/Toast";
import { useInvites, useRevokeInvite } from "@/hooks/useTeam";
import { errorMessage } from "@/lib/api";
import { ROW_CLASS, TableSection, Td, Th } from "./Table";

const STATUS: Readonly<Record<InviteStatus, { tone: BadgeTone; label: string }>> = {
  PENDING: { tone: "neutral", label: "Pending" },
  ACCEPTED: { tone: "positive", label: "Accepted" },
  REVOKED: { tone: "muted", label: "Revoked" },
  EXPIRED: { tone: "warning", label: "Expired" },
};

export function InvitesTable() {
  const toast = useToast();
  const invites = useInvites();
  const revoke = useRevokeInvite();
  const [revoking, setRevoking] = useState<InviteDto | null>(null);

  return (
    <TableSection
      title="Invites"
      description="Links work once and expire after seven days. The link itself is only shown when it's created."
    >
      {invites.isError ? (
        <div className="flex flex-col items-start gap-3 p-5">
          <FormAlert>{errorMessage(invites.error)}</FormAlert>
          <Button size="sm" onClick={() => void invites.refetch()}>
            Try again
          </Button>
        </div>
      ) : invites.data?.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-steel">No invites yet.</p>
      ) : (
        <table className="w-full min-w-[46rem] text-sm">
          <caption className="sr-only">Invites</caption>
          <thead>
            <tr>
              <Th>Email</Th>
              <Th>Role</Th>
              <Th>Status</Th>
              <Th>Invited by</Th>
              <Th>Expires</Th>
              <Th className="text-right">
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {invites.data
              ? invites.data.map((invite) => (
                  <tr key={invite.id} className={ROW_CLASS}>
                    <Td className="font-mono text-[12px] text-paper">{invite.email}</Td>
                    <Td className="text-paper/90">{ROLE_LABEL[invite.role]}</Td>
                    <Td>
                      <Badge tone={STATUS[invite.status].tone}>{STATUS[invite.status].label}</Badge>
                    </Td>
                    <Td className="text-steel">{invite.invitedBy.name}</Td>
                    <Td className="font-mono text-[11px] text-steel">
                      {invite.acceptedAt
                        ? `joined ${formatDate(invite.acceptedAt)}`
                        : formatDate(invite.expiresAt)}
                    </Td>
                    <Td className="text-right">
                      {invite.status === "PENDING" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Revoke invite for ${invite.email}`}
                          onClick={() => setRevoking(invite)}
                        >
                          Revoke
                        </Button>
                      ) : null}
                    </Td>
                  </tr>
                ))
              : Array.from({ length: 2 }, (_, index) => (
                  <tr key={index} className={ROW_CLASS}>
                    <Td colSpan={6}>
                      <Skeleton className="h-8 w-full" />
                    </Td>
                  </tr>
                ))}
          </tbody>
        </table>
      )}

      <ConfirmDialog
        open={revoking !== null}
        onClose={() => {
          setRevoking(null);
          revoke.reset();
        }}
        title="Revoke this invite?"
        description={
          revoking ? `The link for ${revoking.email} stops working immediately.` : undefined
        }
        confirmLabel="Revoke invite"
        pending={revoke.isPending}
        error={revoke.isError ? errorMessage(revoke.error) : null}
        onConfirm={() => {
          if (!revoking) return;
          revoke.mutate(revoking.id, {
            onSuccess: () => {
              toast.success(`Invite for ${revoking.email} revoked`);
              setRevoking(null);
            },
          });
        }}
      />
    </TableSection>
  );
}
