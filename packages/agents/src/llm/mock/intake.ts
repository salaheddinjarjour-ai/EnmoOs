import {
  PLATFORM_LABEL,
  Platform,
  POST_COUNT_MAX,
  type Brief,
  type BriefDraft,
  type BriefGap,
  type IntakeClient,
  type ManagerIntakeInput,
  type ManagerIntakeOutput,
  type PostMixItem,
  type PostType,
} from "@enmo/shared";
import { addDays, formatRange, parseWindow, type DateWindow } from "./dates";
import { capitalize, countNoun, joinList, platformList, sentence, titleCase } from "./text";

/*
 * manager.intake for MockLlm: regex heuristics over the team's messages (never the Manager's), the
 * newest mention of each fact winning. Client, platforms, post count and dates are required; when
 * one is missing and the question is still available, the reply is ONE clarify that names every
 * gap. Otherwise gaps are filled and written down as assumptions, as the real Manager must.
 */

interface Facts {
  clientId: string | null;
  platforms: Platform[] | null;
  postCount: number | null;
  postMix: PostMixItem[] | null;
  window: DateWindow | null;
  occasion: string | null;
  objective: string | null;
  productFocus: string | null;
  audience: string | null;
  cadenceNotes: string | null;
  constraints: string[];
  notes: string[];
}

const PLATFORM_PATTERNS: readonly [Platform, RegExp][] = [
  ["INSTAGRAM", /\b(?:instagram|insta|ig)\b/i],
  ["FACEBOOK", /\b(?:facebook|fb)\b/i],
  ["TIKTOK", /\btik\s?tok\b/i],
];
const ALL_PLATFORMS = /\b(?:all|every)\s+(?:the\s+)?(?:platforms|channels)\b|\beverywhere\b/i;

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  dozen: 12,
  "a dozen": 12,
};
const COUNT = String.raw`(\d{1,3}|a dozen|dozen|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty)`;
const COUNT_UNIT = new RegExp(
  String.raw`\b${COUNT}\s+(?:(?:new|social|feed|more|total|pieces\s+of)\s+)?(posts?|pieces(?:\s+of\s+content)?|reels?|tik\s?toks?|carousels?|static(?:\s+posts?|s)?|stories|story\s+posts?|images?)\b`,
  "gi",
);

const PRODUCT_FOCUS =
  /\b(?:push|promote|launch|feature|highlight|spotlight|sell|showcase)\s+(?:(?:the|our|their|a|an|new)\s+)*([\p{L}\p{N}'’ -]{2,40}?)(?=\s*(?:[,.;!?—–]|$)|\s+(?:for|on|in|across|during|over|with|and|to|this|next)\b)/iu;
const OCCASION = /(?<![\p{L}\p{N}'’])((?:[\p{L}\p{N}'’]+\s+){0,2}[\p{L}\p{N}'’]+)\s+campaign\b/iu;
const OBJECTIVE = /\b(?:goal|objective|aim)\s*(?:is|:)\s*(?:to\s+)?([^.;\n]+)/i;
const AUDIENCE = /\b(?:targeting|aimed at|audience(?:\s+is|:)?)\s+([^,.;\n]+)/i;
const CADENCE =
  /\b(\d{1,2}|one|two|three|four|five|six|seven)\s*(?:posts?\s*)?(?:a|per)\s+(day|week)\b/i;
const CONSTRAINT =
  /\b(?:avoid|don'?t (?:mention|use|say)|do not (?:mention|use|say)|never (?:mention|use|say))\s+([^,.;\n]+)/gi;
const LEADING_FILLER = /^(?:(?:a|an|the|our|their|new|this|next|big|upcoming)\s+)+/i;
const GENERIC_NAME_WORDS = new Set([
  "co",
  "inc",
  "llc",
  "ltd",
  "company",
  "group",
  "the",
  "and",
  "studio",
  "brand",
  "agency",
  "cafe",
  "shop",
]);

function toCount(raw: string): number {
  const lower = raw.toLowerCase();
  return /^\d+$/.test(lower) ? Number(lower) : (NUMBER_WORDS[lower] ?? 0);
}

function unitType(unit: string): PostType | null {
  const lower = unit.toLowerCase();
  if (lower.startsWith("reel")) return "REEL";
  if (lower.startsWith("tik")) return "TIKTOK";
  if (lower.startsWith("carousel")) return "CAROUSEL";
  if (lower.startsWith("stor")) return "STORY";
  if (lower.startsWith("static") || lower.startsWith("image")) return "STATIC";
  return null;
}

function mentionedPlatforms(text: string): Platform[] | null {
  if (ALL_PLATFORMS.test(text)) return [...Platform.options];
  const found = PLATFORM_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([p]) => p);
  return found.length > 0 ? found : null;
}

function mentionedCounts(text: string): { total: number | null; mix: PostMixItem[] } {
  let total: number | null = null;
  const typed = new Map<PostType, number>();
  for (const match of text.matchAll(COUNT_UNIT)) {
    const count = toCount(match[1]!);
    if (count < 1) continue;
    const type = unitType(match[2]!);
    if (type) typed.set(type, (typed.get(type) ?? 0) + count);
    else total = count;
  }
  return { total, mix: [...typed].map(([type, count]) => ({ type, count })) };
}

function mentionedClient(text: string, clients: readonly IntakeClient[]): string | null {
  const lower = text.toLowerCase();
  const byFullName = clients.filter((client) => lower.includes(client.name.toLowerCase()));
  if (byFullName.length === 1) return byFullName[0]!.id;
  const byWord = clients.filter((client) =>
    client.name
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 3 && !GENERIC_NAME_WORDS.has(word))
      .some((word) => new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, "u").test(lower)),
  );
  return byWord.length === 1 ? byWord[0]!.id : null;
}

function readFacts(input: ManagerIntakeInput): Facts {
  const facts: Facts = {
    clientId: null,
    platforms: null,
    postCount: null,
    postMix: null,
    window: null,
    occasion: null,
    objective: null,
    productFocus: null,
    audience: null,
    cadenceNotes: null,
    constraints: [],
    notes: [],
  };
  const teamMessages = input.thread.filter((message) => message.role === "USER");

  for (const { content } of teamMessages) {
    facts.clientId = mentionedClient(content, input.clients) ?? facts.clientId;
    facts.platforms = mentionedPlatforms(content) ?? facts.platforms;
    facts.window = parseWindow(content, input.today) ?? facts.window;

    const counts = mentionedCounts(content);
    if (counts.mix.length > 0) {
      facts.postMix = counts.mix;
      facts.postCount = counts.total ?? counts.mix.reduce((sum, item) => sum + item.count, 0);
    } else if (counts.total !== null) {
      facts.postCount = counts.total;
    }

    const focus = PRODUCT_FOCUS.exec(content)?.[1]?.trim();
    if (focus) facts.productFocus = focus.replace(LEADING_FILLER, "");
    const occasion = OCCASION.exec(content)?.[1]?.trim().replace(LEADING_FILLER, "");
    if (occasion) facts.occasion = titleCase(occasion);
    const objective = OBJECTIVE.exec(content)?.[1]?.trim();
    if (objective) facts.objective = sentence(capitalize(objective));
    const audience = AUDIENCE.exec(content)?.[1]?.trim();
    if (audience) facts.audience = audience;
    const cadence = CADENCE.exec(content);
    if (cadence) facts.cadenceNotes = `${cadence[1]} posts per ${cadence[2]!.toLowerCase()}`;
    for (const constraint of content.matchAll(CONSTRAINT)) {
      facts.constraints.push(sentence(capitalize(constraint[0].trim())));
    }
  }

  const selected = input.clients.find((client) => client.id === input.selectedClientId);
  if (selected) facts.clientId = selected.id;
  else if (!facts.clientId && input.clients.length === 1) facts.clientId = input.clients[0]!.id;

  const client = input.clients.find((c) => c.id === facts.clientId);
  if (client && facts.platforms) {
    const enabled = facts.platforms.filter((p) => client.enabledPlatforms.includes(p));
    const dropped = facts.platforms.filter((p) => !client.enabledPlatforms.includes(p));
    if (dropped.length > 0) {
      facts.notes.push(
        `${platformList(dropped)} ${dropped.length === 1 ? "isn't" : "aren't"} enabled for ${client.name}, so the plan leaves ${dropped.length === 1 ? "it" : "them"} out.`,
      );
    }
    facts.platforms = enabled.length > 0 ? enabled : null;
  }
  if (facts.postCount !== null) facts.postCount = Math.min(facts.postCount, POST_COUNT_MAX);
  return facts;
}

function missingGaps(facts: Facts): BriefGap[] {
  const missing: BriefGap[] = [];
  if (!facts.clientId) missing.push("client");
  if (!facts.platforms) missing.push("platforms");
  if (facts.postCount === null) missing.push("postCount");
  if (!facts.window) missing.push("window");
  return missing;
}

/** One question, one question mark, every gap. */
function clarifyQuestion(
  facts: Facts,
  missing: readonly BriefGap[],
  input: ManagerIntakeInput,
): string {
  const client = input.clients.find((c) => c.id === facts.clientId);
  const options = client?.enabledPlatforms.length ? client.enabledPlatforms : Platform.options;
  const subject = facts.occasion
    ? `the ${facts.occasion} campaign`
    : client
      ? `${client.name}'s campaign`
      : "this campaign";
  const clauses = missing.map((gap) => {
    switch (gap) {
      case "client":
        return "which client it's for";
      case "platforms":
        return `which platforms it should run on (${joinList(
          options.map((p) => PLATFORM_LABEL[p]),
          "or",
        )})`;
      case "postCount":
        return "how many posts you'd like";
      case "window":
        return facts.postCount === null
          ? "the dates it should cover"
          : `the dates the ${facts.postCount} posts should cover`;
      case "postMix":
        return "the mix of formats";
      case "objective":
        return "what it needs to achieve";
      case "productFocus":
        return "which product to put front and centre";
    }
  });
  return `Before I plan ${subject}, could you confirm ${joinList(clauses)}?`;
}

/** Reels, carousels and statics for Meta, TikToks for TikTok, dealt round-robin. */
export function defaultPostMix(postCount: number, platforms: readonly Platform[]): PostMixItem[] {
  const rotation: PostType[] = [];
  if (platforms.some((p) => p !== "TIKTOK")) rotation.push("REEL", "CAROUSEL", "STATIC");
  if (platforms.includes("TIKTOK")) rotation.push("TIKTOK");
  const counts = new Map<PostType, number>();
  for (let i = 0; i < postCount; i++) {
    const type = rotation[i % rotation.length]!;
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return rotation
    .filter((type) => counts.has(type))
    .map((type) => ({ type, count: counts.get(type)! }));
}

function mixText(mix: readonly PostMixItem[]): string {
  return joinList(mix.map((item) => countNoun(item.count, item.type)));
}

function buildBrief(
  facts: Facts,
  input: ManagerIntakeInput,
): { brief: Brief; confirmation: string } {
  const assumptions = [...facts.notes];

  let client = input.clients.find((c) => c.id === facts.clientId);
  if (!client) {
    client = [...input.clients].sort((a, b) => a.name.localeCompare(b.name))[0];
    if (client) assumptions.push(`Client assumed: ${client.name}.`);
  }
  const clientName = client?.name ?? input.brand?.name ?? "the client";

  let platforms = facts.platforms;
  if (!platforms) {
    platforms = client?.enabledPlatforms.length ? [...client.enabledPlatforms] : ["INSTAGRAM"];
    assumptions.push(`Platforms assumed: ${platformList(platforms)}.`);
  }

  let postCount = facts.postCount;
  if (postCount === null) {
    postCount = 8;
    assumptions.push("Post count assumed: 8 posts.");
  }

  let postMix = facts.postMix;
  const typedTotal = postMix?.reduce((sum, item) => sum + item.count, 0) ?? 0;
  if (!postMix || typedTotal !== postCount) {
    postMix = defaultPostMix(postCount, platforms);
    assumptions.push(`Post mix assumed: ${mixText(postMix)}.`);
  }

  let window = facts.window;
  if (!window) {
    const start = addDays(input.today, 1);
    window = { start, end: addDays(start, 27) };
    assumptions.push(
      `Dates assumed: the next four weeks (${formatRange(window.start, window.end)}).`,
    );
  } else if (window.start < input.today) {
    const end = window.end < input.today ? addDays(input.today, 27) : window.end;
    assumptions.push(
      `The window starts today (${formatRange(input.today, end)}): ${window.start} has already passed.`,
    );
    window = { start: input.today, end };
  }

  const focus = facts.productFocus;
  const occasion = facts.occasion;
  let objective = facts.objective;
  if (!objective) {
    objective = focus
      ? `Drive awareness and trial of the ${focus}${occasion ? ` during ${occasion}` : ""}.`
      : `Grow awareness and engagement for ${clientName}${occasion ? ` during ${occasion}` : ""}.`;
    assumptions.push(`Objective inferred: ${objective}`);
  }

  const keyMessages = focus
    ? [
        `The ${focus} is made for ${occasion ?? "this season"}.`,
        `Crafted with ${clientName}'s signature care.`,
      ]
    : [`${clientName}, at its most intentional.`];

  const title = occasion
    ? `${occasion}${focus ? ` — ${titleCase(focus)}` : ""}`
    : focus
      ? `${titleCase(focus)} Push`
      : `${clientName} Campaign`;

  const brief: Brief = {
    clientId: client?.id ?? input.selectedClientId ?? "",
    title,
    objective,
    productFocus: focus,
    audience: facts.audience,
    keyMessages,
    platforms,
    postCount,
    postMix,
    window,
    cadenceNotes: facts.cadenceNotes,
    constraints: facts.constraints,
    assumptions,
  };

  const confirmation = [
    `Brief locked for ${clientName}: ${postCount} posts (${mixText(postMix)}) on ${platformList(platforms)}, ${formatRange(window.start, window.end)}.`,
    focus ? `The ${focus} leads${occasion ? ` the ${occasion} story` : ""}.` : null,
    assumptions.length > 0 ? `Assumptions — ${assumptions.join(" ")}` : null,
    "Next, I'll draft the plan for your approval before anything is generated.",
  ]
    .filter(Boolean)
    .join(" ");

  return { brief, confirmation };
}

function draftOf(facts: Facts): BriefDraft {
  return {
    clientId: facts.clientId,
    title: facts.occasion,
    objective: facts.objective,
    productFocus: facts.productFocus,
    audience: facts.audience,
    keyMessages: null,
    platforms: facts.platforms,
    postCount: facts.postCount,
    postMix: facts.postMix,
    window: facts.window,
    cadenceNotes: facts.cadenceNotes,
    constraints: facts.constraints.length > 0 ? facts.constraints : null,
    assumptions: facts.notes.length > 0 ? facts.notes : null,
  };
}

export function mockIntake(input: ManagerIntakeInput): ManagerIntakeOutput {
  const facts = readFacts(input);
  const missing = missingGaps(facts);
  if (missing.length > 0 && input.allowClarify) {
    return {
      result: {
        kind: "clarify",
        question: clarifyQuestion(facts, missing, input),
        missing,
        draft: draftOf(facts),
      },
    };
  }
  return { result: { kind: "brief", ...buildBrief(facts, input) } };
}
