import { MASTER_ASPECT_RATIO, aspectRatioFor, type AssetDto } from "@enmo/shared";
import { cx } from "@/components/ui/cx";
import { RelativeTime } from "@/components/ui/time";
import { frameSizeOf, isVideoTake } from "./media";
import { MockChip, ProviderChip, TakeStatusPill, VersionBadge, VideoBadge } from "./TakeBadges";
import { TakeFrame } from "./TakeFrame";
import { providerLabel, shotLabel, takeLabel } from "./vault-model";

/*
 * One take in the Vault grid. Every cell is the same 4:5 stage, and the take sits in it at its own
 * aspect ratio (a 9:16 master reads tall; later adapted frames may be 4:5 or 1:1), so the grid
 * stays even while the shapes stay true. The whole tile opens the drawer.
 */

export function AssetTile({
  asset,
  onOpen,
  eager = false,
}: {
  asset: AssetDto;
  onOpen: (asset: AssetDto) => void;
  eager?: boolean;
}) {
  const label = takeLabel(asset);
  const size = frameSizeOf(
    asset,
    asset.post ? aspectRatioFor(asset.post.type) : MASTER_ASPECT_RATIO,
  );
  const dimmed = asset.status === "REJECTED" || asset.status === "FAILED";

  return (
    <article
      aria-label={label}
      className="group relative flex flex-col gap-2.5 rounded-xl border border-line bg-panel p-2 transition duration-250 ease-enmo hover:-translate-y-px hover:border-paper/20"
    >
      <TakeFrame
        take={asset}
        size={size}
        alt={asset.prompt}
        dimmed={dimmed}
        eager={eager}
        className="aspect-[4/5] w-full overflow-hidden rounded-lg bg-[radial-gradient(closest-side,rgb(245_245_244/0.05),transparent)]"
        frameClassName="rounded-md"
      >
        <div className="pointer-events-none absolute inset-x-2 top-2 flex items-start justify-between gap-1.5">
          <TakeStatusPill status={asset.status} onMedia />
          <VersionBadge version={asset.version} onMedia />
        </div>
        <div className="pointer-events-none absolute inset-x-2 bottom-2 flex items-end justify-between gap-1.5">
          {isVideoTake(asset) ? <VideoBadge durationSec={asset.durationSec} onMedia /> : <span />}
          {asset.provider === "mock" ? <MockChip onMedia /> : null}
        </div>
      </TakeFrame>

      <div className="flex min-w-0 flex-col gap-1 px-1 pb-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-mono text-[11px] text-paper">{shotLabel(asset)}</span>
          <ProviderChip label={providerLabel(asset)} />
        </div>
        <p
          className="truncate text-xs text-steel"
          title={asset.campaign?.name ?? asset.client.name}
        >
          {asset.campaign?.name ?? asset.client.name}
        </p>
        <p
          className={cx(
            "line-clamp-2 text-[11px] leading-snug text-steel/80",
            asset.status === "REJECTED" && "text-steel/60",
          )}
        >
          {asset.prompt}
        </p>
        <RelativeTime
          iso={asset.createdAt}
          className="font-mono text-[10px] tracking-[0.08em] text-steel/70"
        />
      </div>

      {/* Stretched over the tile, so the whole tile opens the drawer without nesting controls. */}
      <button
        type="button"
        onClick={() => onOpen(asset)}
        aria-label={`Open ${label}`}
        className="absolute inset-0 rounded-xl focus-visible:outline-offset-2"
      />
    </article>
  );
}
