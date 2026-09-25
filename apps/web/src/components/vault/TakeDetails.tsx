import type { AssetDto, AssetReview } from "@enmo/shared";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { cx } from "@/components/ui/cx";
import { formatDateTime } from "@/components/ui/time";
import { isRendering } from "./media";
import { fileLine, formatScore, ORIGIN_LABEL, providerLabel } from "./vault-model";

/*
 * Everything the drawer knows about one version: the prompt and negative prompt in mono (they are
 * what the provider read), the camera note, where it came from, the Visual Director's review, and
 * who made it with what.
 */

export function TakeDetails({ take }: { take: AssetDto }) {
  const { shot, origin, instruction } = take.params;
  const file = fileLine(take);
  return (
    <div className="flex flex-col gap-7">
      <Detail label="Prompt">
        <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap text-paper/90">
          {take.prompt}
        </pre>
      </Detail>
      {take.negativePrompt ? (
        <Detail label="Negative prompt">
          <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap text-steel">
            {take.negativePrompt}
          </pre>
        </Detail>
      ) : null}
      {shot?.cameraNote ? (
        <Detail label="Camera">
          <p className="text-sm text-paper/90">{shot.cameraNote}</p>
        </Detail>
      ) : null}

      <Detail label="Review">
        <ReviewBlock take={take} review={take.review} />
      </Detail>

      {origin ? (
        <Detail label="Origin">
          <p className="text-sm text-paper/90">{ORIGIN_LABEL[origin]}</p>
          {instruction !== null ? (
            <blockquote className="mt-1 border-l-2 border-paper/20 pl-3 text-sm whitespace-pre-wrap text-paper/85">
              {instruction}
            </blockquote>
          ) : null}
        </Detail>
      ) : null}

      <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        <Fact label="Provider">{providerLabel(take)}</Fact>
        <Fact label="File">{file ?? "Not rendered yet"}</Fact>
        <Fact label="Created by" mono={false}>
          {take.createdBy?.name ?? "Visual Director"}
        </Fact>
        <Fact label="Created">
          <time dateTime={take.createdAt}>{formatDateTime(take.createdAt)}</time>
        </Fact>
        {shot ? (
          <Fact label="Shot">
            {[
              shot.shotId,
              shot.sceneIndex === null ? null : `scene ${shot.sceneIndex + 1}`,
              shot.slideIndex === null ? null : `slide ${shot.slideIndex + 1}`,
              shot.aspectRatio,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Fact>
        ) : null}
        {shot?.seed !== undefined && shot.seed !== null ? (
          <Fact label="Seed">{shot.seed}</Fact>
        ) : null}
        <Fact label="Asset">{take.id}</Fact>
      </dl>
    </div>
  );
}

function ReviewBlock({ take, review }: { take: AssetDto; review: AssetReview | null }) {
  if (!review) {
    return (
      <p className="text-sm text-steel">
        {isRendering(take.status)
          ? "The Visual Director reviews every take once it renders."
          : take.status === "READY"
            ? "Awaiting the Visual Director's review."
            : "Not reviewed."}
      </p>
    );
  }
  const accepted = review.verdict === "accept";
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={accepted ? "positive" : "warning"}>
          {accepted ? "Accepted" : "Regenerate"}
        </Badge>
        <span className="font-mono text-xs text-paper tabular-nums">
          {formatScore(review.score)}/10
        </span>
        <span className="font-mono text-[11px] text-steel">
          take {review.attempt} · {formatDateTime(review.reviewedAt)}
        </span>
      </div>
      {review.issues.length > 0 ? (
        <ul aria-label="Review issues" className="flex list-disc flex-col gap-1 pl-5">
          {review.issues.map((issue, index) => (
            <li key={index} className="text-sm text-paper/85">
              {issue}
            </li>
          ))}
        </ul>
      ) : null}
      {review.revisedPrompt ? (
        <div className="flex flex-col gap-1">
          <p className="font-mono text-[10px] tracking-[0.14em] text-steel uppercase">
            Revised prompt
          </p>
          <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap text-steel">
            {review.revisedPrompt}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

export function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-mono text-[11px] tracking-[0.16em] text-steel uppercase">{label}</h3>
      {children}
    </section>
  );
}

/** Machine values (ids, sizes, timestamps) are set in mono; names aren't. */
function Fact({
  label,
  mono = true,
  children,
}: {
  label: string;
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="font-mono text-[10px] tracking-[0.16em] text-steel uppercase">{label}</dt>
      <dd className={cx("truncate text-paper/90", mono ? "font-mono text-xs" : "text-sm")}>
        {children}
      </dd>
    </div>
  );
}
