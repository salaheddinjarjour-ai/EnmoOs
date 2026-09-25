"use client";

import type { ClientDto } from "@enmo/shared";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { PageHeader } from "@/components/shell/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonLink } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormAlert } from "@/components/ui/Field";
import { LoadingRegion, Skeleton } from "@/components/ui/Skeleton";
import { Tabs } from "@/components/ui/Tabs";
import { useToast } from "@/components/ui/Toast";
import { useArchiveClient, useClient } from "@/hooks/useClients";
import { useTeamDirectory } from "@/hooks/useTeam";
import { ApiError, errorMessage } from "@/lib/api";
import { useCan } from "@/lib/auth";
import { ApprovalChainEditor } from "./ApprovalChainEditor";
import { BannedWordsEditor } from "./BannedWordsEditor";
import { BrandVoiceForm } from "./BrandVoiceForm";
import { chainTeamIssues } from "./chain-health";
import { ConnectedAccounts } from "./ConnectedAccounts";
import { PlatformBadges } from "./platforms";
import { VisualStyleEditor } from "./VisualStyleEditor";

export function ClientDetailScreen({ clientId }: { clientId: string }) {
  const client = useClient(clientId);

  if (client.data) return <ClientDetail client={client.data} />;

  if (client.isError) {
    if (client.error instanceof ApiError && client.error.status === 404) {
      return (
        <EmptyState
          eyebrow="Clients"
          title="This client isn't on the roster."
          description="It may have been removed, or the link is wrong."
          action={
            <ButtonLink href="/clients" variant="secondary">
              Back to clients
            </ButtonLink>
          }
        />
      );
    }
    return (
      <div className="flex flex-col items-start gap-4">
        <FormAlert>{errorMessage(client.error)}</FormAlert>
        <Button onClick={() => void client.refetch()}>Try again</Button>
      </div>
    );
  }

  return (
    <LoadingRegion label="Loading client">
      <Skeleton className="mb-4 h-3 w-24" />
      <Skeleton className="mb-3 h-10 w-72" />
      <Skeleton className="mb-12 h-4 w-48" />
      <Skeleton className="h-96 w-full rounded-xl" />
    </LoadingRegion>
  );
}

/** Remount an editor (dropping its draft) only when its own slice of the client changes. */
const sliceKey = (value: unknown) => JSON.stringify(value);

function ClientDetail({ client }: { client: ClientDto }) {
  const router = useRouter();
  // `?tab=accounts`: where Meta's sign-in comes back to (OAuthResultNotice reads the rest).
  const initialTab = useSearchParams().get("tab") ?? undefined;
  const toast = useToast();
  const canWrite = useCan("clients.write");
  const canArchive = useCan("clients.archive");
  const canManageAccounts = useCan("socialAccounts.manage");
  const archive = useArchiveClient(client.id);
  const team = useTeamDirectory();
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const chainNeedsAttention =
    team.data !== undefined && chainTeamIssues(client.approvalChain, team.data).size > 0;

  const archived = client.archivedAt !== null;
  const readOnlyReason = archived
    ? "Archived · read-only"
    : canWrite
      ? null
      : "View only · Managers and Admins edit client settings";

  const count = (value: number) => (
    <span aria-hidden className="font-mono text-[10px] text-steel/80 tabular-nums">
      {value}
    </span>
  );

  return (
    <>
      <Link
        href="/clients"
        className="mb-6 inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-steel transition-colors duration-200 hover:text-paper"
      >
        <span aria-hidden>←</span> Clients
      </Link>
      <PageHeader
        title={client.name}
        meta={
          <>
            <span className="font-mono text-[11px] text-steel">
              /{client.slug} · {client.timezone}
            </span>
            <PlatformBadges platforms={client.enabledPlatforms} />
            {archived ? <Badge tone="muted">Archived</Badge> : null}
          </>
        }
        actions={
          canArchive && !archived ? (
            <Button variant="danger" size="sm" onClick={() => setConfirmingArchive(true)}>
              Archive client
            </Button>
          ) : null
        }
      />

      <Tabs
        label="Client settings"
        keepMounted
        defaultValue={initialTab}
        items={[
          {
            id: "brand-voice",
            label: "Brand voice",
            content: (
              <BrandVoiceForm
                key={sliceKey([
                  client.name,
                  client.slug,
                  client.timezone,
                  client.enabledPlatforms,
                  client.brandVoice,
                ])}
                client={client}
                readOnlyReason={readOnlyReason}
              />
            ),
          },
          {
            id: "visual-style",
            label: "Visual style",
            content: (
              <VisualStyleEditor
                key={sliceKey(client.visualStyle)}
                client={client}
                readOnlyReason={readOnlyReason}
              />
            ),
          },
          {
            id: "banned-words",
            label: "Banned words",
            badge: count(client.bannedWords.length),
            content: (
              <BannedWordsEditor
                key={sliceKey(client.bannedWords)}
                client={client}
                readOnlyReason={readOnlyReason}
              />
            ),
          },
          {
            id: "accounts",
            label: "Accounts",
            content: (
              <ConnectedAccounts
                client={client}
                canManage={canManageAccounts && !archived}
                readOnlyReason={archived ? readOnlyReason : null}
              />
            ),
          },
          {
            id: "approval-chain",
            label: "Approval chain",
            badge: (
              <>
                {count(client.approvalChain.steps.length)}
                {chainNeedsAttention ? (
                  <span
                    title="The current team can't complete this chain"
                    className="size-1.5 rounded-full bg-amber-300"
                  >
                    <span className="sr-only">needs attention</span>
                  </span>
                ) : null}
              </>
            ),
            content: (
              <ApprovalChainEditor
                key={sliceKey(client.approvalChain)}
                client={client}
                readOnlyReason={readOnlyReason}
              />
            ),
          },
        ]}
      />

      <ConfirmDialog
        open={confirmingArchive}
        onClose={() => setConfirmingArchive(false)}
        title={`Archive ${client.name}?`}
        description="The client leaves the roster and its settings become read-only. Its history (campaigns, posts, assets) is kept."
        confirmLabel="Archive client"
        pending={archive.isPending}
        error={archive.isError ? errorMessage(archive.error) : null}
        onConfirm={() =>
          archive.mutate(undefined, {
            onSuccess: () => {
              setConfirmingArchive(false);
              toast.success(`${client.name} archived`);
              router.push("/clients");
            },
          })
        }
      />
    </>
  );
}
