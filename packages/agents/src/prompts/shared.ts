import { PLATFORM_LABEL, type BrandContext, type Platform } from "@enmo/shared";

/*
 * Prompt pieces every agent shares. System prompts are frozen strings (identical on every call,
 * so the prefix caches); everything that varies goes in the brand block or the user turn.
 */

export const ENMO_PREAMBLE = `You are part of ENMO OS, the autonomous marketing department of Enmo, a creative agency whose method is Discover, Strategize, Create, Optimize. Enmo's work is cinematic and intentional: every pixel has intent, every post has a memory. The Arsenal is seven agents (Manager, Strategist, Copywriter, Visual Director, Adapter, Analyst, Publisher) working for one client brand at a time, and nothing publishes until Enmo's team approves it. Work like a senior member of that team: specific, confident, never generic, never filler.`;

export const OUTPUT_RULES = `## Output rules
- Reply with exactly one JSON object that matches the response schema. No prose, no Markdown, no code fences, nothing before or after it.
- Every field is required. When a value is unknown or doesn't apply and the schema allows null, write null; never leave a field out.
- Your reply is validated in code, including business rules the schema can't express. If it is rejected you'll receive each failing path with the reason; reply with the complete corrected JSON object, not just the changed parts.`;

export const BANNED_WORDS_RULE = `## Banned words
The brand block lists the client's banned words under "Banned words: never use". Never use any of them anywhere in your output (captions, hashtags, scripts, overlays, slides, alt text, notes, summaries, questions), in any casing, spelling variant or hashtag form, even when the brief or feedback uses them. Rephrase around them.`;

export function platformNames(platforms: readonly Platform[]): string {
  return platforms.length > 0 ? platforms.map((p) => PLATFORM_LABEL[p]).join(", ") : "none";
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * The second system block: who the client is and how it speaks, banned words included. Rendered
 * deterministically from BrandContext so the same brand always produces the same cached block.
 */
export function renderBrandBlock(brand: BrandContext): string {
  const { visualStyle: style } = brand;
  const banned = brand.bannedWords.map((word) => word.trim()).filter(Boolean);
  const lines = [
    `# Client brand: ${brand.name}`,
    `Client id: ${brand.clientId}`,
    `Timezone: ${brand.timezone}`,
    `Enabled platforms: ${platformNames(brand.platforms)}`,
    "",
    "## Brand voice",
    brand.brandVoice.trim() ||
      "No voice guide on file yet. Default to Enmo's house voice: confident, warm, precise; short sentences; concrete sensory detail over adjectives.",
    "",
    "## Banned words: never use",
    ...(banned.length > 0
      ? banned.map((word) => `- ${word}`)
      : ["None on file. Still avoid clichés, hype and anything off-voice."]),
    "",
    "## Visual style",
    `- Palette: primary ${style.palette.primary}, secondary ${style.palette.secondary}, accent ${style.palette.accent}, background ${style.palette.background}, text ${style.palette.text}`,
    `- Typography: display ${style.typography.display}, body ${style.typography.body}`,
  ];
  if (style.keywords.length > 0) lines.push(`- Style keywords: ${style.keywords.join(", ")}`);
  if (style.lighting) lines.push(`- Lighting: ${style.lighting}`);
  if (style.imagery) lines.push(`- Imagery: ${style.imagery}`);
  if (style.avoid.length > 0) lines.push(`- Never show: ${style.avoid.join(", ")}`);
  return lines.join("\n");
}
