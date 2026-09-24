"use client";

import { Role, ROLE_LABEL, type UserDto } from "@enmo/shared";
import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FormAlert } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { RelativeTime } from "@/components/ui/time";
import { useToast } from "@/components/ui/Toast";
import { useUpdateUser, useUsers } from "@/hooks/useTeam";
import { errorMessage } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { ROW_CLASS, TableSection, Td, Th } from "./Table";

const ROLE_OPTIONS = Role.options.map((role) => ({ value: role, label: ROLE_LABEL[role] }));

export function UsersTable() {
  const { user: me } = useSession();
  const users = useUsers();

  return (
    <TableSection
      title="Members"
      description="Deactivating someone ends their sessions at once. The last active admin can't be demoted or deactivated."
    >
      {users.isError ? (
        <div className="flex flex-col items-start gap-3 p-5">
          <FormAlert>{errorMessage(users.error)}</FormAlert>
          <Button size="sm" onClick={() => void users.refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <table className="w-full min-w-[46rem] text-sm">
          <caption className="sr-only">Team members</caption>
          <thead>
            <tr>
              <Th>Member</Th>
              <Th className="w-44">Role</Th>
              <Th>Status</Th>
              <Th>Last sign-in</Th>
              <Th className="text-right">
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {users.data
              ? users.data.map((user) => (
                  <UserRow key={user.id} user={user} isSelf={user.id === me.id} />
                ))
              : Array.from({ length: 3 }, (_, index) => (
                  <tr key={index} className={ROW_CLASS}>
                    <Td colSpan={5}>
                      <Skeleton className="h-8 w-full" />
                    </Td>
                  </tr>
                ))}
          </tbody>
        </table>
      )}
    </TableSection>
  );
}

function UserRow({ user, isSelf }: { user: UserDto; isSelf: boolean }) {
  const toast = useToast();
  const update = useUpdateUser();
  const [confirmingDeactivate, setConfirmingDeactivate] = useState(false);

  // Show the chosen role while the PATCH is in flight instead of snapping back.
  const pendingRole = update.isPending ? update.variables.changes.role : undefined;

  function changeRole(role: Role) {
    update.mutate(
      { userId: user.id, changes: { role } },
      {
        onSuccess: (updated) => toast.success(`${updated.name} is now ${ROLE_LABEL[updated.role]}`),
        onError: (error) => toast.error("Role not changed", errorMessage(error)),
      },
    );
  }

  function setActive(isActive: boolean) {
    update.mutate(
      { userId: user.id, changes: { isActive } },
      {
        onSuccess: (updated) => {
          setConfirmingDeactivate(false);
          toast.success(
            updated.isActive ? `${updated.name} can sign in again` : `${updated.name} deactivated`,
          );
        },
        onError: (error) => {
          if (!isActive) return; // the confirm dialog shows it
          toast.error("Couldn't reactivate", errorMessage(error));
        },
      },
    );
  }

  return (
    <tr className={ROW_CLASS}>
      <Td>
        <div className="flex flex-col">
          <span className="flex items-center gap-2 text-paper">
            {user.name}
            {isSelf ? <Badge tone="muted">You</Badge> : null}
          </span>
          <span className="font-mono text-[11px] text-steel">{user.email}</span>
        </div>
      </Td>
      <Td>
        <Select
          label={`Role for ${user.name}`}
          labelHidden
          value={pendingRole ?? user.role}
          options={ROLE_OPTIONS}
          disabled={isSelf || !user.isActive || update.isPending}
          onChange={(event) => changeRole(Role.parse(event.target.value))}
          selectClassName="h-9"
          title={isSelf ? "You can't change your own role" : undefined}
        />
      </Td>
      <Td>
        {user.isActive ? (
          <Badge tone="neutral" dot>
            Active
          </Badge>
        ) : (
          <Badge tone="muted">Deactivated</Badge>
        )}
      </Td>
      <Td className="font-mono text-[11px] text-steel">
        {user.lastLoginAt ? <RelativeTime iso={user.lastLoginAt} /> : "Never"}
      </Td>
      <Td className="text-right">
        {isSelf ? null : user.isActive ? (
          <Button
            size="sm"
            variant="danger"
            aria-label={`Deactivate ${user.name}`}
            onClick={() => setConfirmingDeactivate(true)}
          >
            Deactivate
          </Button>
        ) : (
          <Button
            size="sm"
            aria-label={`Reactivate ${user.name}`}
            loading={update.isPending}
            onClick={() => setActive(true)}
          >
            Reactivate
          </Button>
        )}
        <ConfirmDialog
          open={confirmingDeactivate}
          onClose={() => setConfirmingDeactivate(false)}
          title={`Deactivate ${user.name}?`}
          description="They are signed out everywhere immediately and can't sign in until reactivated. Their work stays."
          confirmLabel="Deactivate"
          pending={update.isPending}
          error={
            update.isError && update.variables.changes.isActive === false
              ? errorMessage(update.error)
              : null
          }
          onConfirm={() => setActive(false)}
        />
      </Td>
    </tr>
  );
}
