"use client";

import { useState } from "react";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button, ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { useCan } from "@/lib/auth";
import { InviteDialog } from "./InviteDialog";
import { InvitesTable } from "./InvitesTable";
import { StalledChainsNotice } from "./StalledChainsNotice";
import { UsersTable } from "./UsersTable";

/** /admin/users: the team, roles, deactivation and one-time invite links (ADMIN only). */
export function TeamScreen() {
  const canManageUsers = useCan("users.manage");
  const canInvite = useCan("invites.manage");
  const [inviting, setInviting] = useState(false);

  if (!canManageUsers) {
    return (
      <EmptyState
        eyebrow="Admin"
        title="Admins only."
        description="Roles, deactivation and invites are managed by an admin. Ask one if you need a teammate added."
        action={
          <ButtonLink href="/command" variant="secondary">
            Back to the Command Center
          </ButtonLink>
        }
      />
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="The team."
        description="Admin, Manager and Editor; nothing more until pain proves it. ENMO sends no email: invite links are copied and shared by hand."
        actions={
          canInvite ? (
            <Button variant="primary" onClick={() => setInviting(true)}>
              Invite teammate
            </Button>
          ) : null
        }
      />
      <div className="flex flex-col gap-14">
        <StalledChainsNotice />
        <UsersTable />
        {canInvite ? <InvitesTable /> : null}
      </div>
      {canInvite ? <InviteDialog open={inviting} onClose={() => setInviting(false)} /> : null}
    </>
  );
}
