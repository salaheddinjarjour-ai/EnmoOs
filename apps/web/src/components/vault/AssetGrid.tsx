"use client";

import type { AssetDto } from "@enmo/shared";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { AssetTile } from "./AssetTile";

/*
 * The Vault grid: uniform 4:5 cells, newest first. The next page loads as the sentinel under the
 * grid scrolls into view (well before the end, so scrolling rarely waits); "Load more" does the
 * same for keyboards and for browsers that never report the intersection.
 */

/** Start fetching the next page this far before the last row is reached. */
const PREFETCH_MARGIN = "800px 0px";
/** The first rows are above the fold: load their images right away. */
const EAGER_TILES = 10;

export const GRID_CLASS = "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5";

export function AssetGrid({
  assets,
  onOpen,
  hasNextPage,
  fetchingNextPage,
  onLoadMore,
}: {
  assets: readonly AssetDto[];
  onOpen: (asset: AssetDto) => void;
  hasNextPage: boolean;
  fetchingNextPage: boolean;
  onLoadMore: () => void;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const loadMore = useRef(onLoadMore);
  useEffect(() => {
    loadMore.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasNextPage || fetchingNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore.current();
      },
      { rootMargin: PREFETCH_MARGIN },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, fetchingNextPage]);

  return (
    <div className="flex flex-col gap-8">
      <ul aria-label="Takes" className={GRID_CLASS}>
        {assets.map((asset, index) => (
          <li key={asset.id}>
            <AssetTile asset={asset} onOpen={onOpen} eager={index < EAGER_TILES} />
          </li>
        ))}
        {fetchingNextPage
          ? Array.from({ length: 5 }, (_, index) => (
              <li key={`loading-${index}`} aria-hidden>
                <Skeleton className="aspect-[4/5] w-full rounded-xl" />
              </li>
            ))
          : null}
      </ul>
      <div ref={sentinel} className="flex min-h-10 items-center justify-center">
        {hasNextPage ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onLoadMore}
            loading={fetchingNextPage}
            className="font-mono text-[11px] tracking-[0.14em] uppercase"
          >
            Load more
          </Button>
        ) : assets.length > 0 ? (
          <p className="font-mono text-[11px] tracking-[0.16em] text-steel/70 uppercase">
            Every take is here
          </p>
        ) : null}
      </div>
    </div>
  );
}
