"use client";

import type { AssetDto } from "@enmo/shared";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button, ButtonLink } from "@/components/ui/Button";
import { cx } from "@/components/ui/cx";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormAlert } from "@/components/ui/Field";
import { LoadingRegion, Skeleton } from "@/components/ui/Skeleton";
import { useAssetList } from "@/hooks/useAssets";
import { useCampaigns } from "@/hooks/useCampaigns";
import { useClients } from "@/hooks/useClients";
import { errorMessage } from "@/lib/api";
import { useCan } from "@/lib/auth";
import { AssetDrawer } from "./AssetDrawer";
import { AssetGrid, GRID_CLASS } from "./AssetGrid";
import { useDebouncedValue } from "./useDebouncedValue";
import { VaultFilters } from "./VaultFilters";
import {
  EMPTY_FILTERS,
  filtersFromSearchParams,
  hasActiveFilters,
  toAssetListFilters,
  vaultSearch,
  type VaultFilters as Filters,
} from "./vault-model";

/*
 * The Vault (MASTER_PLAN §03): every generated take, versioned, searchable by prompt, campaign,
 * scene (or slide) and shot. The grid shows the current take of each shot (or every version),
 * newest first, and pages in as it scrolls; a take opens in the drawer with its lineage and
 * Regenerate. The address carries the applied filters and the open take (`?asset=`), so a view can
 * be linked to.
 */

const SEARCH_DEBOUNCE_MS = 300;

export function VaultScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [filters, setFilters] = useState<Filters>(() => filtersFromSearchParams(params));
  const q = useDebouncedValue(filters.q, SEARCH_DEBOUNCE_MS);
  const applied = useMemo<Filters>(() => ({ ...filters, q }), [filters, q]);
  const openId = params.get("asset");

  const list = useAssetList(toAssetListFilters(applied));
  const clients = useClients();
  const campaigns = useCampaigns();
  const canBrief = useCan("campaigns.create");

  const search = vaultSearch(applied, openId);
  const currentSearch = params.size > 0 ? `?${params.toString()}` : "";
  useEffect(() => {
    if (search !== currentSearch) router.replace(`${pathname}${search}`, { scroll: false });
  }, [search, currentSearch, pathname, router]);

  const openTake = (assetId: string | null) =>
    router.replace(`${pathname}${vaultSearch(applied, assetId)}`, { scroll: false });

  const assets: AssetDto[] = list.data?.pages.flatMap((page) => page.items) ?? [];
  const filtered = hasActiveFilters(applied);
  const settling = filters.q !== q || (list.isPlaceholderData && list.isFetching);

  return (
    <>
      <PageHeader
        eyebrow="The Vault"
        title="Every take, versioned."
        description="Every render the Visual Director makes lands here with its whole lineage. Search by prompt, campaign, scene or shot; regenerate any take and the Visual Director gets its original context back."
      />

      <VaultFilters
        filters={filters}
        onChange={setFilters}
        clients={clients.data ?? []}
        campaigns={campaigns.data ?? []}
      />

      {list.isPending ? (
        <LoadingRegion label="Loading the Vault">
          <div className={GRID_CLASS}>
            {Array.from({ length: 10 }, (_, index) => (
              <Skeleton key={index} className="aspect-[4/5] w-full rounded-xl" />
            ))}
          </div>
        </LoadingRegion>
      ) : list.isError ? (
        <div className="flex flex-col items-start gap-4">
          <FormAlert>{errorMessage(list.error)}</FormAlert>
          <Button onClick={() => void list.refetch()}>Try again</Button>
        </div>
      ) : assets.length === 0 && !filtered ? (
        <EmptyState
          eyebrow="The Vault"
          title={
            <>
              The Vault is empty. <span className="text-steel">Every render lands here.</span>
            </>
          }
          description="Approve a plan and the Visual Director's takes arrive as they render: every version of every shot, with the prompt that made it."
          action={
            canBrief ? (
              <ButtonLink href="/brief" variant="primary" size="lg">
                Give the Arsenal a brief
              </ButtonLink>
            ) : null
          }
        />
      ) : assets.length === 0 ? (
        <div className="flex flex-col items-center gap-4 py-16 text-center">
          <p className="text-sm text-steel">
            {applied.q.trim() ? (
              <>
                No take matches <span className="text-paper">“{applied.q.trim()}”</span>
                {Object.keys(toAssetListFilters({ ...applied, q: "" })).length > 0
                  ? " with these filters."
                  : "."}
              </>
            ) : (
              "No takes match these filters."
            )}
          </p>
          <Button variant="secondary" size="sm" onClick={() => setFilters(EMPTY_FILTERS)}>
            Clear filters
          </Button>
        </div>
      ) : (
        <div
          aria-busy={settling || undefined}
          className={cx("transition-opacity duration-200 ease-enmo", settling && "opacity-60")}
        >
          <p className="mb-4 font-mono text-[11px] tracking-[0.16em] text-steel/80 uppercase">
            {assets.length}
            {list.hasNextPage ? "+" : ""} {assets.length === 1 ? "take" : "takes"}
            {applied.allVersions ? " · every version" : " · current takes"}
          </p>
          <AssetGrid
            assets={assets}
            onOpen={(asset) => openTake(asset.id)}
            hasNextPage={list.hasNextPage}
            fetchingNextPage={list.isFetchingNextPage}
            onLoadMore={() => void list.fetchNextPage()}
          />
        </div>
      )}

      <AssetDrawer assetId={openId} onClose={() => openTake(null)} />
    </>
  );
}
