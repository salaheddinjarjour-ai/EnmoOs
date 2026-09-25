"use client";

import {
  aspectRatioFor,
  PLATFORM_LABEL,
  type AssetThumbDto,
  type CopywriterOutput,
  type PostDto,
} from "@enmo/shared";
import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { viewerTimeZone } from "@/components/calendar/zoned-time";
import { Badge } from "@/components/ui/Badge";
import { cx } from "@/components/ui/cx";
import { frameSizeOf, isVideoTake } from "@/components/vault/media";
import { TakeStatusPill } from "@/components/vault/TakeBadges";
import { TakeFrame } from "@/components/vault/TakeFrame";
import { vaultTakeHref } from "@/components/vault/vault-model";
import { useClient } from "@/hooks/useClients";
import { formatCalendarDay, formatSeconds } from "./format";
import { CopyEditor } from "./CopyEditor";
import { PlatformChips, PostTypeChip } from "./PlatformChips";
import { canEditPost, PostActions } from "./PostActions";
import { PostPreview } from "./PostPreview";
import { hasPublishing } from "./publishing";
import { PublishStatusList } from "./PublishStatus";
import { StatusPill } from "./StatusPill";

/*
 * Everything about one post in a side sheet: the preview, its shots (the current take of each,
 * linked to the Vault), the full copy (captions per platform, script scenes, slides, on-screen
 * text), QA notes, where its approval stands and, once scheduled, each platform's publish state
 * (live link, dry run, last error), with the same actions as the card. "Edit" swaps
 * the reading view for the CopyEditor in place. Built on the native <dialog> (focus trap, Escape,
 * inert page) like ui/Dialog, anchored to the right edge.
 */

export type DrawerMode = "view" | "edit";

export function PostDetailDrawer({
  post,
  open,
  onClose,
  initialMode = "view",
  showCampaignLink = false,
}: {
  post: PostDto;
  open: boolean;
  onClose: () => void;
  initialMode?: DrawerMode;
  /** Link to the campaign thread (from the kanban; the thread itself doesn't need it). */
  showCampaignLink?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

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
      {open ? (
        <DrawerBody
          post={post}
          titleId={titleId}
          onClose={onClose}
          initialMode={initialMode}
          showCampaignLink={showCampaignLink}
        />
      ) : null}
    </dialog>
  );
}

function DrawerBody({
  post,
  titleId,
  onClose,
  initialMode,
  showCampaignLink,
}: {
  post: PostDto;
  titleId: string;
  onClose: () => void;
  initialMode: DrawerMode;
  showCampaignLink: boolean;
}) {
  const client = useClient(post.clientId);
  const [mode, setMode] = useState<DrawerMode>(
    initialMode === "edit" && canEditPost(post) ? "edit" : "view",
  );
  const copy = post.copy;
  const approval = post.currentApproval;

  return (
    <div className="flex h-full flex-col border-l border-line bg-panel shadow-[0_40px_120px_-40px_rgb(0_0_0/0.9)]">
      <header className="flex items-start justify-between gap-6 border-b border-line px-6 pt-5 pb-4">
        <div className="flex min-w-0 flex-col gap-2">
          <p className="font-mono text-[11px] tracking-[0.2em] text-steel uppercase">
            {client.data?.name ?? "Post"}
            {post.targetDate ? ` · ${formatCalendarDay(post.targetDate)}` : ""}
          </p>
          <h2
            id={titleId}
            className="flex items-center gap-2.5 font-display text-xl font-medium tracking-tight"
          >
            <span className="font-mono text-base text-steel">{post.ref}</span>
            <span className="truncate">{post.angle ?? "Untitled post"}</span>
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <PostTypeChip type={post.type} />
            <StatusPill pill={post.pill} approved={post.approved} failed={post.failed} />
            <PlatformChips platforms={post.platforms} />
            {post.needsAttention ? (
              <Badge tone="warning" title={post.attentionReason ?? undefined}>
                Needs attention
              </Badge>
            ) : null}
          </div>
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

      <div className="flex-1 overflow-y-auto px-6 py-6">
        {mode === "edit" && copy ? (
          <CopyEditor
            post={post}
            copy={copy}
            onSaved={() => setMode("view")}
            onCancel={() => setMode("view")}
          />
        ) : (
          <div className="flex flex-col gap-8">
            <div className="flex flex-col gap-6 sm:flex-row">
              <PostPreview post={post} palette={client.data?.visualStyle.palette} />
              <div className="flex min-w-0 flex-1 flex-col gap-4">
                <ApprovalLine post={post} />
                {post.needsAttention && post.attentionReason ? (
                  <p className="rounded-md border border-amber-300/25 bg-amber-300/[0.05] px-3 py-2 text-sm text-amber-100">
                    {post.attentionReason}
                  </p>
                ) : null}
                {post.qaNotes ? (
                  <Detail label="Manager QA">
                    <p className="text-sm leading-relaxed text-paper/90">{post.qaNotes}</p>
                  </Detail>
                ) : null}
                {hasPublishing(post.publishing) ? (
                  <Detail label="Publishing">
                    <PublishStatusList
                      publishing={post.publishing}
                      timeZone={client.data?.timezone ?? viewerTimeZone()}
                      detailed
                    />
                  </Detail>
                ) : null}
                <PostActions post={post} onEdit={() => setMode("edit")} />
                {showCampaignLink ? (
                  <Link
                    href={`/brief/${encodeURIComponent(post.campaignId)}`}
                    className="text-sm text-steel underline decoration-steel/40 underline-offset-4 transition-colors duration-200 hover:text-paper"
                  >
                    Open the campaign thread
                  </Link>
                ) : null}
              </div>
            </div>
            {post.currentAssets.length > 0 ? <ShotsStrip post={post} /> : null}
            {copy ? (
              <CopyDetails copy={copy} />
            ) : (
              <p className="text-sm text-steel">
                The Copywriter hasn&apos;t drafted this post yet.
              </p>
            )}
            {approval ? null : (
              <p className="font-mono text-[11px] tracking-[0.12em] text-steel uppercase">
                No approval round yet
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Where a shot sits in the post: "Slide 2", "Scene 3", else its shot id. */
function shotPlace(take: AssetThumbDto): string {
  if (take.slideIndex !== null) return `Slide ${take.slideIndex + 1}`;
  if (take.sceneIndex !== null) return `Scene ${take.sceneIndex + 1}`;
  return take.shotId ?? "Shot";
}

/** The current take of each shot, in the order the post reads; each opens in the Vault. */
function ShotsStrip({ post }: { post: PostDto }) {
  const ratio = aspectRatioFor(post.type);
  const shots = post.currentAssets;
  return (
    <Detail label={`Shots · ${shots.length}`}>
      <ul aria-label="Shots" className="flex gap-2.5 overflow-x-auto pb-1">
        {shots.map((take) => {
          const name = [take.shotId, `v${take.version}`].filter(Boolean).join(" · ");
          return (
            <li key={take.id} className="shrink-0">
              <Link
                href={vaultTakeHref(take.id)}
                aria-label={`Open ${name} in the Vault`}
                className="flex w-24 flex-col gap-1.5 rounded-lg border border-line p-1.5 transition duration-200 ease-enmo hover:-translate-y-px hover:border-paper/25"
              >
                <TakeFrame
                  take={take}
                  size={frameSizeOf(take, ratio)}
                  alt={`${post.ref} ${shotPlace(take).toLowerCase()}`}
                  className="h-28 w-full"
                  frameClassName="rounded-sm"
                >
                  {take.status === "READY" ? null : (
                    <TakeStatusPill
                      status={take.status}
                      onMedia
                      className="pointer-events-none absolute top-1 left-1"
                    />
                  )}
                </TakeFrame>
                <span className="flex items-center justify-between gap-1 font-mono text-[10px] leading-none">
                  <span className="truncate text-paper">
                    {take.shotId ?? "shot"}
                    {isVideoTake(take) ? <span className="text-steel"> · clip</span> : null}
                  </span>
                  <span className="text-steel">v{take.version}</span>
                </span>
                <span className="truncate text-[11px] leading-none text-steel">
                  {shotPlace(take)}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </Detail>
  );
}

function ApprovalLine({ post }: { post: PostDto }) {
  const approval = post.currentApproval;
  if (!approval) return null;
  const step =
    approval.stepCount > 1
      ? ` · step ${approval.currentStep + 1} of ${approval.stepCount}${approval.stepName ? `: ${approval.stepName}` : ""}`
      : approval.stepName
        ? ` · ${approval.stepName}`
        : "";
  return (
    <p className="font-mono text-[11px] tracking-[0.12em] text-steel uppercase">
      Round {approval.round} · {approval.status.replace("_", " ").toLowerCase()}
      {approval.status === "PENDING" ? step : ""}
      {post.humanEditCount > 0
        ? ` · ${post.humanEditCount} human edit${post.humanEditCount === 1 ? "" : "s"}`
        : ""}
    </p>
  );
}

function CopyDetails({ copy }: { copy: CopywriterOutput }) {
  return (
    <div className="flex flex-col gap-6">
      <Detail label="Caption">
        <p className="text-sm leading-relaxed whitespace-pre-wrap text-paper/90">{copy.caption}</p>
      </Detail>
      {copy.platformCaptions.length > 0 ? (
        <Detail label="Per platform">
          <ul className="flex flex-col gap-3">
            {copy.platformCaptions.map((entry) => (
              <li key={entry.platform} className="rounded-md border border-line px-3 py-2.5">
                <p className="mb-1 font-mono text-[10px] tracking-[0.14em] text-steel uppercase">
                  {PLATFORM_LABEL[entry.platform]}
                </p>
                <p className="text-sm leading-relaxed whitespace-pre-wrap text-paper/85">
                  {entry.caption}
                </p>
              </li>
            ))}
          </ul>
        </Detail>
      ) : null}
      {copy.script ? (
        <Detail
          label={`Script · ${formatSeconds(copy.script.totalDurationSec)} · hook at ${formatSeconds(copy.script.hookTimestampSec)}`}
        >
          <ol className="flex flex-col divide-y divide-line rounded-md border border-line">
            {copy.script.scenes.map((scene) => (
              <li key={scene.index} className="grid gap-1 px-3 py-2.5 sm:grid-cols-[5.5rem_1fr]">
                <span className="font-mono text-[11px] text-steel tabular-nums">
                  {formatSeconds(scene.startSec)}–
                  {formatSeconds(scene.startSec + scene.durationSec)}
                </span>
                <div className="flex flex-col gap-1">
                  <p className="text-sm text-paper/90">{scene.voiceover}</p>
                  <p className="text-xs text-steel">
                    On screen: <span className="text-paper/80">{scene.overlayText}</span>
                  </p>
                  <p className="text-xs text-steel/80 italic">{scene.visualNote}</p>
                </div>
              </li>
            ))}
          </ol>
        </Detail>
      ) : null}
      {copy.slides ? (
        <Detail label={`Slides · ${copy.slides.length}`}>
          <ol className="flex flex-col gap-2">
            {copy.slides.map((slide, index) => (
              <li key={slide.index} className="rounded-md border border-line px-3 py-2.5">
                <p className="text-sm font-medium text-paper">
                  <span className="mr-2 font-mono text-[11px] text-steel">{index + 1}</span>
                  {slide.headline}
                </p>
                <p className="mt-1 text-sm text-steel">{slide.body}</p>
              </li>
            ))}
          </ol>
        </Detail>
      ) : null}
      {copy.onScreenText ? (
        <Detail label="On-screen text">
          <p className="text-sm text-paper/90">{copy.onScreenText}</p>
        </Detail>
      ) : null}
      <div className="grid gap-6 sm:grid-cols-2">
        <Detail label="Call to action">
          <p className="text-sm text-paper/90">{copy.cta}</p>
        </Detail>
        <Detail label="Alt text">
          <p className="text-sm text-paper/90">{copy.altText}</p>
        </Detail>
      </div>
      {copy.hashtags.length > 0 ? (
        <Detail label="Hashtags">
          <p className="font-mono text-xs leading-relaxed text-steel">
            {copy.hashtags.map((tag) => (tag.startsWith("#") ? tag : `#${tag}`)).join(" ")}
          </p>
        </Detail>
      ) : null}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-mono text-[11px] tracking-[0.16em] text-steel uppercase">{label}</h3>
      {children}
    </section>
  );
}
