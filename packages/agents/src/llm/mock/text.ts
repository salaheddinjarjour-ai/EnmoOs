import { PLATFORM_LABEL, type BannedWordMatcher, type Platform, type PostType } from "@enmo/shared";

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function titleCase(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => capitalize(word))
    .join(" ");
}

/** "a", "a and b", "a, b and c" (conjunction configurable). */
export function joinList(items: readonly string[], conjunction = "and"): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items[items.length - 1]}`;
}

/** Cuts at a word boundary and adds an ellipsis when `text` is longer than `max`. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(0, max - 1));
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Ends with sentence punctuation. */
export function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** "#IcedLine" from "iced line"; null when nothing tag-worthy is left. */
export function hashtag(text: string): string | null {
  const body = text
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word) => capitalize(word))
    .join("");
  return body ? `#${body}` : null;
}

export function platformList(platforms: readonly Platform[]): string {
  return joinList(platforms.map((platform) => PLATFORM_LABEL[platform]));
}

export const POST_TYPE_NOUN: Readonly<Record<PostType, [singular: string, plural: string]>> = {
  REEL: ["Reel", "Reels"],
  TIKTOK: ["TikTok", "TikToks"],
  CAROUSEL: ["carousel", "carousels"],
  STATIC: ["static post", "static posts"],
  STORY: ["story", "stories"],
};

export function countNoun(count: number, type: PostType): string {
  const [singular, plural] = POST_TYPE_NOUN[type];
  return `${count} ${count === 1 ? singular : plural}`;
}

const FALLBACK_LINES = ["Made with intent.", "See you there.", "Now serving."];

/**
 * Removes every banned-word match from the strings of a JSON-like value (hashtags that contain
 * one are dropped), so mock output can never trip the validator the real model faces. Keys in
 * `ignoreKeys` are left alone, mirroring the validator's scan.
 */
export function scrubBannedWords<T>(
  value: T,
  matcher: BannedWordMatcher,
  ignoreKeys: readonly string[],
): T {
  if (matcher.terms.length === 0) return value;
  const ignore = new Set(ignoreKeys);

  const scrubString = (text: string): string => {
    let current = text;
    for (let pass = 0; pass < 5; pass++) {
      const hits = matcher.find(current);
      if (hits.length === 0) return current;
      for (const hit of [...hits].reverse()) {
        current = current.slice(0, hit.index) + current.slice(hit.index + hit.length);
      }
      current = current
        .replace(/[ \t]{2,}/g, " ")
        .replace(/ ([,.!?;:])/g, "$1")
        .trim();
    }
    return current;
  };

  const visit = (node: unknown, key: string | null): unknown => {
    if (typeof node === "string") {
      const cleaned = scrubString(node);
      if (cleaned || !node) return cleaned;
      return FALLBACK_LINES.find((line) => matcher.find(line).length === 0) ?? "";
    }
    if (Array.isArray(node)) {
      const items = node.map((item) => visit(item, key));
      return key === "hashtags"
        ? items.filter((item, i) => typeof item !== "string" || item === node[i])
        : items;
    }
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [childKey, child] of Object.entries(node)) {
        out[childKey] = ignore.has(childKey) ? child : visit(child, childKey);
      }
      return out;
    }
    return node;
  };

  return visit(value, null) as T;
}
