"use client";

import { PageHeader } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/Button";
import { FormAlert } from "@/components/ui/Field";
import { LoadingRegion, Skeleton } from "@/components/ui/Skeleton";
import { Tabs, type TabItem } from "@/components/ui/Tabs";
import { ClientPipeline } from "@/components/kanban/ClientPipeline";
import { useArchivedClientCount, useClients } from "@/hooks/useClients";
import { errorMessage } from "@/lib/api";
import { useCan } from "@/lib/auth";
import { ArsenalIdle } from "./ArsenalIdle";

/*
 * Command Center: one tab per active client. Each tab shows its alerts over the pipeline kanban
 * (Phase 2), or the idle-Arsenal empty state while the client has no posts. Growth tiles and the
 * learnings feed join these panels in Phase 6.
 */
export function CommandCenter() {
  const clients = useClients();
  const canAddClients = useCan("clients.write");
  const archivedCount = useArchivedClientCount(canAddClients && clients.data?.length === 0);

  return (
    <>
      <PageHeader
        eyebrow="Command Center"
        title="Every client, one view."
        description="Pipeline, alerts, growth and weekly learnings per client. It fills up as the Arsenal works."
      />
      {clients.isPending ? (
        <LoadingRegion label="Loading clients">
          <div className="flex gap-3 border-b border-line pb-3">
            <Skeleton className="h-6 w-24" />
            <Skeleton className="h-6 w-28" />
            <Skeleton className="h-6 w-20" />
          </div>
          <Skeleton className="mt-8 h-96 w-full rounded-2xl" />
        </LoadingRegion>
      ) : clients.isError ? (
        <div className="flex flex-col items-start gap-4">
          <FormAlert>{errorMessage(clients.error)}</FormAlert>
          <Button onClick={() => void clients.refetch()}>Try again</Button>
        </div>
      ) : (
        <Tabs
          label="Clients"
          items={[
            {
              id: "all",
              label: "All clients",
              content: (
                <ClientPipeline
                  empty={
                    <ArsenalIdle
                      noActiveClients={
                        clients.data.length === 0 && archivedCount !== undefined
                          ? { archived: archivedCount }
                          : undefined
                      }
                    />
                  }
                />
              ),
            },
            ...clients.data.map((client): TabItem => ({
              id: client.id,
              label: client.name,
              content: (
                <ClientPipeline clientId={client.id} empty={<ArsenalIdle client={client} />} />
              ),
            })),
          ]}
        />
      )}
    </>
  );
}
