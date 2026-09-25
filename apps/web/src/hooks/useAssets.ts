import {
  AssetDetailDto,
  AssetDto,
  AssetListResponse,
  type NamedRef,
  type RegenerateAssetBody,
} from "@enmo/shared";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  pendingTake,
  withoutPendingTakes,
  withTake,
  type AssetListFilters,
} from "@/components/vault/vault-model";
import { api, apiPath } from "@/lib/api";
import { queryKeys } from "./query-keys";

/*
 * The Vault (DESIGN §E "vault"): every take, newest first and keyset-paginated, one take with its
 * lineage, and Regenerate. Realtime `asset.updated` invalidates every asset query (and the posts,
 * whose cards read currentAssets), so a take moves from shimmer to image without polling.
 */

export function useAssetList(filters: AssetListFilters) {
  return useInfiniteQuery({
    queryKey: queryKeys.assets.list(filters),
    queryFn: ({ pageParam, signal }) =>
      api("/assets", {
        query: { ...filters, cursor: pageParam },
        schema: AssetListResponse,
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    // A new search keeps the last results on screen (dimmed) instead of flashing skeletons.
    placeholderData: keepPreviousData,
  });
}

/** GET /assets/:id: the take plus its whole lineage (oldest version first). */
export function useAsset(assetId: string | null) {
  return useQuery({
    queryKey: queryKeys.assets.detail(assetId ?? ""),
    queryFn: ({ signal }) =>
      api(apiPath("assets", assetId ?? ""), { schema: AssetDetailDto, signal }),
    enabled: assetId !== null,
  });
}

export interface RegenerateVariables {
  /** The version to regenerate from (its shot, the post's copy and brand go back to the Director). */
  source: AssetDto;
  /** Sent verbatim; null when the teammate left none. */
  instruction: RegenerateAssetBody["instruction"];
  /** Who asked, for the optimistic take. */
  createdBy: NamedRef | null;
}

type DetailSnapshot = Array<[readonly unknown[], AssetDetailDto | undefined]>;

/** The prefix of every queryKeys.assets.detail(id): a lineage may be open under any version's id. */
const ASSET_DETAILS = ["assets", "detail"] as const;

function patchDetails(
  queryClient: QueryClient,
  rootAssetId: string,
  patch: (detail: AssetDetailDto) => AssetDetailDto,
): void {
  queryClient.setQueriesData<AssetDetailDto>({ queryKey: ASSET_DETAILS }, (detail) =>
    detail && detail.lineage.rootAssetId === rootAssetId ? patch(detail) : detail,
  );
}

/**
 * POST /assets/:id/regenerate → the new version, QUEUED. The lineage shows the next version
 * shimmering at once; the API's answer replaces it, and asset.updated events carry it from there
 * (rendering, ready, reviewed, current). A refusal (409: still rendering, agents at work, a
 * published post) takes the placeholder back out.
 */
export function useRegenerateAsset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ source, instruction }: RegenerateVariables) =>
      api(apiPath("assets", source.id, "regenerate"), {
        method: "POST",
        body: { instruction } satisfies RegenerateAssetBody,
        schema: AssetDto,
      }),
    onMutate: async ({ source, instruction, createdBy }) => {
      await queryClient.cancelQueries({ queryKey: ASSET_DETAILS });
      const snapshot: DetailSnapshot = queryClient.getQueriesData<AssetDetailDto>({
        queryKey: ASSET_DETAILS,
      });
      const now = new Date().toISOString();
      patchDetails(queryClient, source.rootAssetId, (detail) =>
        withTake(detail, pendingTake(source, detail, { instruction, createdBy, now })),
      );
      return { snapshot };
    },
    onError: (_error, _variables, context) => {
      for (const [queryKey, data] of context?.snapshot ?? []) {
        queryClient.setQueryData(queryKey, data);
      }
    },
    onSuccess: (take) => {
      patchDetails(queryClient, take.rootAssetId, (detail) =>
        withTake(withoutPendingTakes(detail), take),
      );
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.assets.all }),
        // A regenerate on a planned post reopens it (CHANGES_REQUESTED, a new round later).
        queryClient.invalidateQueries({ queryKey: queryKeys.posts.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.approvals.all }),
      ]),
  });
}
