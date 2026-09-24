"use client";

import {
  COPY_LIMITS,
  EDITED_COPY_BOUNDS,
  PLATFORM_LABEL,
  type CopywriterOutput,
  type PostDto,
  type Scene,
  type Slide,
} from "@enmo/shared";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { ChipInput } from "@/components/ui/ChipInput";
import { FormAlert } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { useToast } from "@/components/ui/Toast";
import { useClient } from "@/hooks/useClients";
import { useUpdatePostCopy } from "@/hooks/usePosts";
import { errorMessage } from "@/lib/api";
import {
  bannedHitsOf,
  copyMatcher,
  describeHits,
  hashtagPath,
  hitsByPath,
  ruleIssuesOf,
  scanCopy,
} from "./copy-editing";
import { formatSeconds } from "./format";

/*
 * Human edits to a post's copy (PATCH /posts/:id/copy). Every text field the audience sees is
 * editable; scene timings stay as the Copywriter set them, because the script's timing rules are
 * checked as a whole. Banned words are flagged under the field as you type, with the matcher the
 * API uses; if the API still refuses (the list changed meanwhile), its 422 hits land in the same
 * places, as do the Copywriter rules it holds every edit to (no blank caption, "#" hashtags).
 * Saving a post that is in (or past) approval opens a new approval round.
 */

export function CopyEditor({
  post,
  copy,
  onSaved,
  onCancel,
}: {
  post: PostDto;
  copy: CopywriterOutput;
  onSaved: (post: PostDto) => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const client = useClient(post.clientId);
  const update = useUpdatePostCopy(post.id);
  const [draft, setDraft] = useState<CopywriterOutput>(copy);
  const [submitted, setSubmitted] = useState<CopywriterOutput | null>(null);

  const bannedWords = client.data?.bannedWords;
  const matcher = useMemo(() => copyMatcher(bannedWords ?? []), [bannedWords]);
  const localHits = useMemo(() => scanCopy(draft, matcher), [draft, matcher]);
  // The API's answer describes what was sent: it stands until the draft changes.
  const answered = submitted === draft;
  const serverHits = answered ? bannedHitsOf(update.error) : [];
  const ruleIssues = answered ? ruleIssuesOf(update.error) : new Map<string, string>();
  const byPath = hitsByPath([...localHits, ...serverHits]);
  const warn = (path: string) => describeHits(byPath.get(path)) ?? ruleIssues.get(path) ?? null;
  const hashtagWarning =
    describeHits(draft.hashtags.flatMap((_, index) => byPath.get(hashtagPath(index)) ?? [])) ??
    ruleIssues.get("hashtags") ??
    draft.hashtags.map((_, index) => ruleIssues.get(hashtagPath(index))).find(Boolean) ??
    null;

  const dirty = draft !== copy;
  const reopensApproval =
    post.currentApproval?.status === "PENDING" || post.currentApproval?.status === "APPROVED";

  function patch(changes: Partial<CopywriterOutput>) {
    setDraft((current) => ({ ...current, ...changes }));
  }

  function patchScene(index: number, changes: Partial<Scene>) {
    setDraft((current) =>
      current.script
        ? {
            ...current,
            script: {
              ...current.script,
              scenes: current.script.scenes.map((scene, i) =>
                i === index ? { ...scene, ...changes } : scene,
              ),
            },
          }
        : current,
    );
  }

  function patchSlide(index: number, changes: Partial<Slide>) {
    setDraft((current) =>
      current.slides
        ? {
            ...current,
            slides: current.slides.map((slide, i) =>
              i === index ? { ...slide, ...changes } : slide,
            ),
          }
        : current,
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(draft);
    update.mutate(
      { copy: draft },
      {
        onSuccess: (saved) => {
          const newRound =
            saved.currentApproval && saved.currentApproval.round !== post.currentApproval?.round;
          toast.success(
            `${post.ref} copy saved`,
            newRound
              ? `Approval round ${saved.currentApproval?.round} is open for it.`
              : "The edit is on the post.",
          );
          onSaved(saved);
        },
      },
    );
  }

  const bannedError = serverHits.length > 0;
  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={`Edit ${post.ref} copy`}
      className="flex flex-col gap-7"
    >
      <Section title="Captions">
        <Textarea
          label="Caption"
          value={draft.caption}
          onChange={(event) => patch({ caption: event.target.value })}
          rows={6}
          maxLength={COPY_LIMITS.captionMaxChars}
          showCount
          error={warn("caption")}
        />
        {draft.platformCaptions.map((entry, index) => (
          <Textarea
            key={entry.platform}
            label={`${PLATFORM_LABEL[entry.platform]} caption`}
            value={entry.caption}
            onChange={(event) =>
              patch({
                platformCaptions: draft.platformCaptions.map((item, i) =>
                  i === index ? { ...item, caption: event.target.value } : item,
                ),
              })
            }
            rows={3}
            maxLength={COPY_LIMITS.captionMaxChars}
            showCount
            error={warn(`platformCaptions[${index}].caption`)}
          />
        ))}
      </Section>

      {draft.script ? (
        <Section
          title="Script"
          aside={`${formatSeconds(draft.script.totalDurationSec)} · hook at ${formatSeconds(draft.script.hookTimestampSec)}`}
        >
          <Input
            label="Hook"
            value={draft.script.hookText}
            onChange={(event) =>
              setDraft((current) =>
                current.script
                  ? { ...current, script: { ...current.script, hookText: event.target.value } }
                  : current,
              )
            }
            error={warn("script.hookText")}
          />
          <ol className="flex flex-col gap-4">
            {draft.script.scenes.map((scene, index) => (
              <li key={scene.index} className="rounded-lg border border-line p-4">
                <p className="mb-3 font-mono text-[11px] tracking-[0.12em] text-steel uppercase">
                  Scene {index + 1} · {formatSeconds(scene.startSec)}–
                  {formatSeconds(scene.startSec + scene.durationSec)}
                </p>
                <div className="flex flex-col gap-3">
                  <Textarea
                    label={`Scene ${index + 1} voiceover`}
                    value={scene.voiceover}
                    onChange={(event) => patchScene(index, { voiceover: event.target.value })}
                    rows={2}
                    error={warn(`script.scenes[${index}].voiceover`)}
                  />
                  <Input
                    label={`Scene ${index + 1} on-screen text`}
                    value={scene.overlayText}
                    onChange={(event) => patchScene(index, { overlayText: event.target.value })}
                    error={warn(`script.scenes[${index}].overlayText`)}
                  />
                  <Input
                    label={`Scene ${index + 1} visual note`}
                    hint="For the Visual Director; never shown to the audience."
                    value={scene.visualNote}
                    onChange={(event) => patchScene(index, { visualNote: event.target.value })}
                    error={warn(`script.scenes[${index}].visualNote`)}
                  />
                </div>
              </li>
            ))}
          </ol>
        </Section>
      ) : null}

      {draft.slides ? (
        <Section title="Slides" aside={`${draft.slides.length} slides`}>
          <ol className="flex flex-col gap-4">
            {draft.slides.map((slide, index) => (
              <li
                key={slide.index}
                className="flex flex-col gap-3 rounded-lg border border-line p-4"
              >
                <Input
                  label={`Slide ${index + 1} headline`}
                  value={slide.headline}
                  onChange={(event) => patchSlide(index, { headline: event.target.value })}
                  error={warn(`slides[${index}].headline`)}
                />
                <Textarea
                  label={`Slide ${index + 1} body`}
                  value={slide.body}
                  onChange={(event) => patchSlide(index, { body: event.target.value })}
                  rows={2}
                  error={warn(`slides[${index}].body`)}
                />
              </li>
            ))}
          </ol>
        </Section>
      ) : null}

      {draft.onScreenText !== null ? (
        <Section title="On-screen text">
          <Textarea
            label="On-screen text"
            value={draft.onScreenText}
            onChange={(event) => patch({ onScreenText: event.target.value })}
            rows={2}
            error={warn("onScreenText")}
          />
        </Section>
      ) : null}

      <Section title="Details">
        <ChipInput
          label="Hashtags"
          value={draft.hashtags}
          onChange={(hashtags) => patch({ hashtags })}
          max={COPY_LIMITS.hashtagsMax}
          maxLength={EDITED_COPY_BOUNDS.hashtagMaxChars}
          placeholder="Type a hashtag, then Enter"
          hint={`Up to ${COPY_LIMITS.hashtagsMax}, each a "#" and one word.`}
          error={hashtagWarning}
        />
        <Input
          label="Call to action"
          value={draft.cta}
          onChange={(event) => patch({ cta: event.target.value })}
          error={warn("cta")}
        />
        <Textarea
          label="Alt text"
          value={draft.altText}
          onChange={(event) => patch({ altText: event.target.value })}
          rows={2}
          error={warn("altText")}
        />
      </Section>

      {bannedError ? (
        <FormAlert>
          The API refused the copy: it still uses banned words. They are flagged above.
        </FormAlert>
      ) : update.isError && answered ? (
        <FormAlert>{errorMessage(update.error)}</FormAlert>
      ) : null}

      <div className="sticky -bottom-6 -mx-6 -mb-6 flex flex-wrap items-center justify-between gap-3 border-t border-line bg-panel px-6 py-4">
        <p className="text-xs text-steel">
          {localHits.length > 0
            ? "Remove the flagged words: the API refuses banned words."
            : reopensApproval
              ? "Saving opens a new approval round for this post."
              : "Edits are counted on the post."}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={update.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={update.isPending} disabled={!dirty}>
            Save copy
          </Button>
        </div>
      </div>
    </form>
  );
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-baseline justify-between gap-3">
        <h3 className="font-display text-sm font-medium tracking-tight text-paper">{title}</h3>
        {aside ? (
          <span className="font-mono text-[11px] tracking-[0.12em] text-steel uppercase">
            {aside}
          </span>
        ) : null}
      </header>
      {children}
    </section>
  );
}
