import {
  BannedWordsErrorDetails,
  compileBannedWords,
  CopyRuleErrorDetails,
  scanForBannedWords,
  type BannedWordHitDto,
  type BannedWordMatcher,
  type CopywriterOutput,
} from "@enmo/shared";
import { ApiError } from "../../lib/api";

/*
 * Banned-word plumbing for the CopyEditor. The editor scans the draft with the same matcher and
 * options as PATCH /posts/:id/copy, so a warning under a field is exactly what the API would
 * refuse; the API's 422 hits use the same paths ("caption", "script.scenes[1].voiceover"), and
 * so do the Copywriter rules it reports for the post (a blank caption, a malformed hashtag).
 */

/** `platform` holds enum values, never copy (same option the API passes). */
export const COPY_SCAN_OPTIONS = { ignoreKeys: ["platform"] } as const;

export function copyMatcher(bannedWords: readonly string[]): BannedWordMatcher {
  return compileBannedWords(bannedWords);
}

export function scanCopy(copy: CopywriterOutput, matcher: BannedWordMatcher): BannedWordHitDto[] {
  return scanForBannedWords(copy, matcher, COPY_SCAN_OPTIONS);
}

/** The hits an API 422 carried, or [] for any other error. */
export function bannedHitsOf(error: unknown): BannedWordHitDto[] {
  if (!(error instanceof ApiError) || error.code !== "UNPROCESSABLE") return [];
  const parsed = BannedWordsErrorDetails.safeParse(error.details);
  return parsed.success ? parsed.data.bannedWords : [];
}

/**
 * The Copywriter rules an API 422 said the copy breaks, first message per path ("caption",
 * "hashtags[1]", "platformCaptions"), or an empty map for any other error.
 */
export function ruleIssuesOf(error: unknown): Map<string, string> {
  const byPath = new Map<string, string>();
  if (!(error instanceof ApiError) || error.code !== "UNPROCESSABLE") return byPath;
  const parsed = CopyRuleErrorDetails.safeParse(error.details);
  if (!parsed.success) return byPath;
  for (const issue of parsed.data.issues) {
    if (!byPath.has(issue.path)) byPath.set(issue.path, issue.message);
  }
  return byPath;
}

export function hitsByPath(hits: readonly BannedWordHitDto[]): Map<string, BannedWordHitDto[]> {
  const byPath = new Map<string, BannedWordHitDto[]>();
  for (const hit of hits) {
    const list = byPath.get(hit.path);
    if (list) {
      if (!list.some((existing) => existing.index === hit.index && existing.term === hit.term))
        list.push(hit);
    } else {
      byPath.set(hit.path, [hit]);
    }
  }
  return byPath;
}

/** "Banned word: “cheap”" / "Banned words: “cheap”, “instant coffee”" */
export function describeHits(hits: readonly BannedWordHitDto[] | undefined): string | null {
  if (!hits || hits.length === 0) return null;
  const terms = [...new Set(hits.map((hit) => hit.match))];
  return `Banned ${terms.length === 1 ? "word" : "words"}: ${terms.map((term) => `“${term}”`).join(", ")}`;
}

/** Hashtags are stored with or without "#"; the editor keeps what the writer typed. */
export function hashtagPath(index: number): string {
  return `hashtags[${index}]`;
}
