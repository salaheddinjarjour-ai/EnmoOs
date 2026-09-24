"use client";

import type { ClientListItem } from "@enmo/shared";
import { useDeferredValue, useState } from "react";
import { PageHeader } from "@/components/shell/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormAlert } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { LoadingRegion, Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { useArchivedClientCount, useClients } from "@/hooks/useClients";
import { errorMessage } from "@/lib/api";
import { useCan } from "@/lib/auth";
import { ClientCard } from "./ClientCard";
import { CreateClientDialog } from "./CreateClientDialog";

function matches(client: ClientListItem, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return !needle || `${client.name} ${client.slug}`.toLocaleLowerCase().includes(needle);
}

export function ClientsScreen() {
  const toast = useToast();
  const canWrite = useCan("clients.write");
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [creating, setCreating] = useState(false);
  const clients = useClients({ includeArchived: showArchived });

  const visible = clients.data?.filter((client) => matches(client, deferredQuery)) ?? [];
  // With an empty roster the empty state carries the single green call to action instead.
  const rosterEmpty = clients.data?.length === 0;
  // No active clients isn't the same as no clients: archived ones are one checkbox away.
  const archivedCount = useArchivedClientCount(rosterEmpty && !showArchived);

  return (
    <>
      <PageHeader
        eyebrow="Clients"
        title="Every client, one brain."
        description="Brand voice, visual style, banned words, connected accounts and the approval chain, per client. The Arsenal switches context as fast as you switch tabs."
        actions={
          canWrite && !rosterEmpty ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              New client
            </Button>
          ) : null
        }
      />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <Input
          label="Search clients"
          labelHidden
          type="search"
          placeholder="Search by name or slug"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="w-full max-w-xs"
        />
        <Checkbox
          label="Show archived"
          checked={showArchived}
          onChange={(event) => setShowArchived(event.target.checked)}
        />
      </div>

      {clients.isPending || (rosterEmpty && !showArchived && archivedCount === undefined) ? (
        <LoadingRegion label="Loading clients">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} className="h-48 rounded-xl" />
            ))}
          </div>
        </LoadingRegion>
      ) : clients.isError ? (
        <div className="flex flex-col items-start gap-4">
          <FormAlert>{errorMessage(clients.error)}</FormAlert>
          <Button onClick={() => void clients.refetch()}>Try again</Button>
        </div>
      ) : clients.data.length === 0 && archivedCount ? (
        <EmptyState
          eyebrow="Clients"
          title="No active clients."
          description={`${archivedCount === 1 ? "1 archived client is" : `${archivedCount} archived clients are`} hidden. Archived clients stay readable but can't be changed.`}
          action={
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Button variant="secondary" size="lg" onClick={() => setShowArchived(true)}>
                Show archived
              </Button>
              {canWrite ? (
                <Button variant="primary" size="lg" onClick={() => setCreating(true)}>
                  New client
                </Button>
              ) : null}
            </div>
          }
        />
      ) : clients.data.length === 0 ? (
        <EmptyState
          eyebrow="Clients"
          title="No brands on the roster yet."
          description={
            canWrite
              ? "Add the first client: its voice, its look, the words it never uses and who signs off."
              : "An admin or manager adds clients. They'll appear here as soon as they do."
          }
          action={
            canWrite ? (
              <Button variant="primary" size="lg" onClick={() => setCreating(true)}>
                New client
              </Button>
            ) : null
          }
        />
      ) : visible.length === 0 ? (
        <p className="py-16 text-center text-sm text-steel">
          No client matches <span className="text-paper">“{deferredQuery.trim()}”</span>.
        </p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((client) => (
            <li key={client.id}>
              <ClientCard client={client} />
            </li>
          ))}
        </ul>
      )}

      {clients.data && clients.data.length > 0 ? (
        <p className="mt-8 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-steel/70">
          <Badge tone="muted">{clients.data.length}</Badge>
          {clients.data.length === 1 ? "client" : "clients"}
          {showArchived ? " including archived" : ""}
        </p>
      ) : null}

      {canWrite ? (
        <CreateClientDialog
          open={creating}
          onClose={() => setCreating(false)}
          onCreated={(client) => {
            setCreating(false);
            toast.success(
              `${client.name} is on the roster`,
              "Refine its voice, look and approval chain on the client page.",
            );
          }}
        />
      ) : null}
    </>
  );
}
