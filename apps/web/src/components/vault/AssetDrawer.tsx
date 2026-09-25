"use client";

import { MASTER_ASPECT_RATIO, aspectRatioFor, type AssetDetailDto } from "@enmo/shared";
import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { PostTypeChip } from "@/components/post/PlatformChips";
import { Button } from "@/components/ui/Button";
import { cx } from "@/components/ui/cx";
import { FormAlert } from "@/components/ui/Field";
import { LoadingRegion, Skeleton, SkeletonText } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { useAsset, useRegenerateAsset } from "@/hooks/useAssets";
import { errorMessage } from "@/lib/api";
import { useCan, useSession } from "@/lib/auth";
import { LineageTimeline } from "./LineageTimeline";
import { frameSizeOf, isVideoTake } from "./media";
import { RegenerateForm } from "./RegenerateForm";
import { MockChip, ProviderChip, TakeStatusPill, VersionBadge, VideoBadge } from "./TakeBadges";
import { Detail, TakeDetails } from "./TakeDetails";
import { TakeFrame } from "./TakeFrame";
import {
  canRegenerate,
  instructionOf,
  lineageInFlight,
  lineageSteps,
  pendingTakeId,
  providerLabel,
  selectedTake,
  shotLabel,
} from "./vault-model";

/*
 * One take in a side sheet (DESIGN §G vault/AssetDrawer): the large preview, the lineage of its
 * shot, the prompt and review, and Regenerate. Built on the native <dialog> like PostDetailDrawer.
 * After a Regenerate the stage follows the new version: it shimmers while it renders and swaps to
 * the image when asset.updated (over SSE) refreshes the lineage.
 */

export function AssetDrawer({ assetId, onClose }: { assetId: string | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const open = assetId !== null;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className={cx(
        "fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-dvh w-full max-w-2xl overflow-visible bg-transparent p-0 text-paper",
        "backdrop:bg-void/70 backdrop:backdrop-blur-sm",
        "translate-x-0 opacity-100 transition-[opacity,translate] duration-300 ease-enmo starting:translate-x-6 starting:opacity-0",
      )}
    >
      {assetId ? (
        <DrawerBody key={assetId} assetId={assetId} titleId={titleId} onClose={onClose} />
      ) : null}
    </dialog>
  );
}

function DrawerBody({
  assetId,
  titleId,
  onClose,
}: {
  assetId: string;
  titleId: string;
  onClose: () => void;
}) {
  const asset = useAsset(assetId);

  if (asset.isPending) {
    return (
      <Panel titleId={titleId} title="Loading take…" onClose={onClose}>
        <LoadingRegion label="Loading take">
          <Skeleton className="h-[min(58vh,600px)] w-full rounded-xl" />
          <SkeletonText className="mt-8" lines={4} />
        </LoadingRegion>
      </Panel>
    );
  }
  if (asset.isError) {
    return (
      <Panel titleId={titleId} title="Take unavailable" onClose={onClose}>
        <div className="flex flex-col items-start gap-4">
          <FormAlert>{errorMessage(asset.error)}</FormAlert>
          <Button onClick={() => void asset.refetch()}>Try again</Button>
        </div>
      </Panel>
    );
  }
  return <TakeView detail={asset.data} titleId={titleId} onClose={onClose} />;
}

function TakeView({
  detail,
  titleId,
  onClose,
}: {
  detail: AssetDetailDto;
  titleId: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const session = useSession();
  const mayRegenerate = useCan("assets.regenerate");
  const regenerate = useRegenerateAsset();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const take = selectedTake(detail, selectedId);
  const steps = lineageSteps(detail);
  const ratio = take.post ? aspectRatioFor(take.post.type) : MASTER_ASPECT_RATIO;
  const current = take.id === detail.lineage.currentAssetId;

  function startRegenerate() {
    const source = take;
    const instruction = instructionOf(note);
    // The stage follows the new version at once: its placeholder, then the API's take.
    setSelectedId(pendingTakeId(source.id));
    regenerate.mutate(
      {
        source,
        instruction,
        createdBy: { id: session.user.id, name: session.user.name },
      },
      {
        onSuccess: (created) => {
          setSelectedId(created.id);
          setNote("");
          toast.success(
            `v${created.version} is rendering`,
            instruction === null
              ? "The Visual Director has the shot back."
              : "The Visual Director has the shot back, with your note word for word.",
          );
        },
        onError: () => setSelectedId(source.id),
      },
    );
  }

  return (
    <Panel
      titleId={titleId}
      title={
        <>
          <span className="font-mono text-base">{shotLabel(take)}</span>{" "}
          <VersionBadge version={take.version} size="md" />
        </>
      }
      eyebrow={[take.client.name, take.campaign?.name].filter(Boolean).join(" · ")}
      chips={
        <>
          <TakeStatusPill status={take.status} size="md" />
          {take.post ? <PostTypeChip type={take.post.type} /> : null}
          {isVideoTake(take) ? <VideoBadge durationSec={take.durationSec} size="md" /> : null}
          <ProviderChip label={providerLabel(take)} size="md" />
          {take.provider === "mock" ? <MockChip size="md" /> : null}
        </>
      }
      onClose={onClose}
    >
      <div className="flex flex-col gap-8">
        <TakeFrame
          take={take}
          size={frameSizeOf(take, ratio)}
          alt={take.prompt}
          dimmed={take.status === "REJECTED"}
          playable
          labelled
          eager
          className="h-[min(58vh,600px)] w-full rounded-xl border border-line bg-void/60"
          frameClassName="rounded-md"
        >
          {current || take.status === "REJECTED" ? (
            <span
              className={cx(
                "pointer-events-none absolute top-3 left-3 inline-flex h-6 items-center rounded-full px-2.5 font-mono text-[10px] tracking-[0.14em] uppercase",
                current ? "bg-paper/90 text-void" : "border border-line bg-void/75 text-steel",
              )}
            >
              {current ? "Current take" : "Rejected take"}
            </span>
          ) : null}
        </TakeFrame>

        <Detail label={`Lineage · ${steps.length} ${steps.length === 1 ? "version" : "versions"}`}>
          <LineageTimeline
            steps={steps}
            selectedId={take.id}
            fallbackRatio={ratio}
            onSelect={setSelectedId}
          />
        </Detail>

        {mayRegenerate && canRegenerate(take) ? (
          <Detail label="Regenerate">
            <RegenerateForm
              note={note}
              onNoteChange={setNote}
              blockedReason={
                lineageInFlight(detail)
                  ? "A take of this shot is still rendering. Regenerate once it lands."
                  : null
              }
              pending={regenerate.isPending}
              error={regenerate.isError ? regenerate.error : null}
              onSubmit={startRegenerate}
            />
          </Detail>
        ) : null}

        <TakeDetails take={take} />

        {take.campaign ? (
          <Link
            href={`/brief/${encodeURIComponent(take.campaign.id)}`}
            className="self-start text-sm text-steel underline decoration-steel/40 underline-offset-4 transition-colors duration-200 hover:text-paper"
          >
            Open the campaign thread
          </Link>
        ) : null}
      </div>
    </Panel>
  );
}

function Panel({
  titleId,
  title,
  eyebrow,
  chips,
  onClose,
  children,
}: {
  titleId: string;
  title: ReactNode;
  eyebrow?: string;
  chips?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col border-l border-line bg-panel shadow-[0_40px_120px_-40px_rgb(0_0_0/0.9)]">
      <header className="flex items-start justify-between gap-6 border-b border-line px-6 pt-5 pb-4">
        <div className="flex min-w-0 flex-col gap-2">
          <p className="truncate font-mono text-[11px] tracking-[0.2em] text-steel uppercase">
            {eyebrow || "The Vault"}
          </p>
          <h2
            id={titleId}
            className="flex items-center gap-2.5 font-display text-xl font-medium tracking-tight"
          >
            {title}
          </h2>
          {chips ? <div className="flex flex-wrap items-center gap-2">{chips}</div> : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="-mr-2 rounded-md p-1.5 text-steel transition duration-200 hover:bg-paper/[0.06] hover:text-paper"
        >
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            className="size-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
          >
            <path d="m4 4 8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>
      <div className="flex-1 overflow-y-auto px-6 py-6">{children}</div>
    </div>
  );
}
