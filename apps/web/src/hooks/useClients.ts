import {
  ClientDto,
  ClientListResponse,
  type CreateClientInput,
  type UpdateApprovalChainRequest,
  type UpdateClientInput,
} from "@enmo/shared";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, apiPath } from "@/lib/api";
import { queryKeys } from "./query-keys";

/* Clients (DESIGN §E): list (with related-row counts), detail, create, update, approval chain, archive. */

export function useClients({
  includeArchived = false,
  enabled = true,
}: { includeArchived?: boolean; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.clients.list(includeArchived),
    queryFn: ({ signal }) =>
      api("/clients", { query: { includeArchived }, schema: ClientListResponse, signal }),
    select: (data) => data.items,
    enabled,
  });
}

/**
 * How many archived clients exist, fetched only while `needed` (an empty active roster), so an
 * empty screen can say "no active clients" instead of "no clients". Undefined until known.
 */
export function useArchivedClientCount(needed: boolean): number | undefined {
  const all = useClients({ includeArchived: true, enabled: needed });
  if (!needed) return undefined;
  if (all.isError) return 0;
  return all.data?.filter((client) => client.archivedAt !== null).length;
}

export function useClient(clientId: string) {
  return useQuery({
    queryKey: queryKeys.clients.detail(clientId),
    queryFn: ({ signal }) => api(apiPath("clients", clientId), { schema: ClientDto, signal }),
  });
}

/** Store the fresh client and refresh every list it appears in. */
function storeClient(queryClient: QueryClient, client: ClientDto): Promise<void> {
  queryClient.setQueryData(queryKeys.clients.detail(client.id), client);
  return queryClient.invalidateQueries({ queryKey: queryKeys.clients.lists() });
}

export function useCreateClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateClientInput) =>
      api("/clients", { method: "POST", body, schema: ClientDto }),
    onSuccess: (client) => storeClient(queryClient, client),
  });
}

export function useUpdateClient(clientId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateClientInput) =>
      api(apiPath("clients", clientId), { method: "PATCH", body, schema: ClientDto }),
    onSuccess: (client) => storeClient(queryClient, client),
  });
}

export function useReplaceApprovalChain(clientId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateApprovalChainRequest) =>
      api(apiPath("clients", clientId, "approval-chain"), {
        method: "PUT",
        body,
        schema: ClientDto,
      }),
    onSuccess: (client) => storeClient(queryClient, client),
  });
}

export function useArchiveClient(clientId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api(apiPath("clients", clientId, "archive"), { method: "POST", schema: ClientDto }),
    onSuccess: (client) => storeClient(queryClient, client),
  });
}
