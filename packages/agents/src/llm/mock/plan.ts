import {
  canonicalGraph,
  orderPipelineActions,
  type ManagerPlanInput,
  type ManagerPlanOutput,
  type PipelineAction,
  type Platform,
  type PlannedPost,
  type PostType,
} from "@enmo/shared";
import { addDays, daysBetween, formatRange } from "./dates";
import { createRng, hashOf } from "./seed";
import { countNoun, joinList, platformList } from "./text";

/*
 * manager.plan for MockLlm: the brief's mix dealt round-robin into p1…pN, dates spread evenly
 * over the window (never before today, dodging busy dates), angles and pillars drawn from the
 * brief with a seed, and the canonical task graph for the enabled actions.
 */

const ANGLES: readonly ((c: AngleContext) => string)[] = [
  (c) => `Hero close-up: the ${c.focus} in slow motion, built around "${c.message}"`,
  (c) => `Ritual moment: where the ${c.focus} fits into ${c.occasion} evenings`,
  (c) => `Behind the craft: how ${c.brand} makes the ${c.focus}, step by step`,
  (c) => `First sip: real reactions to the ${c.focus}`,
  (c) => `Pairing guide: the ${c.focus} with ${c.occasion} favourites`,
  (c) => `Three ways to enjoy the ${c.focus} this ${c.occasion}`,
  (c) => `Countdown: why the ${c.focus} is the move this week`,
  (c) => `Myth vs fact: what makes the ${c.focus} different`,
  (c) => `Golden hour: the ${c.focus} as the day winds down`,
  (c) => `Community: the ${c.brand} regulars and their ${c.focus} order`,
];
const PILLARS = ["Product hero", "Ritual & moments", "Behind the craft", "Community voices"];

interface AngleContext {
  focus: string;
  occasion: string;
  brand: string;
  message: string;
}

const ACTION_STEP: Readonly<Record<PipelineAction, string>> = {
  strategy: "the Strategist sets the pillars and hooks",
  write: "the Copywriter drafts the copy",
  direct: "the Visual Director creates the visuals",
  adapt: "the Adapter formats it for each platform",
  qa: "I quality-check it",
};

/** Round-robin over the mix so formats alternate through the calendar. */
function dealTypes(mix: ManagerPlanInput["brief"]["postMix"]): PostType[] {
  const remaining = mix.map((item) => ({ ...item }));
  const types: PostType[] = [];
  while (remaining.some((item) => item.count > 0)) {
    for (const item of remaining) {
      if (item.count > 0) {
        types.push(item.type);
        item.count -= 1;
      }
    }
  }
  return types;
}

function platformsFor(type: PostType, briefPlatforms: readonly Platform[]): Platform[] {
  const tiktok = briefPlatforms.filter((p) => p === "TIKTOK");
  const meta = briefPlatforms.filter((p) => p !== "TIKTOK");
  if (type === "TIKTOK") return tiktok.length > 0 ? tiktok : [...briefPlatforms];
  return meta.length > 0 ? meta : [...briefPlatforms];
}

function spreadDates(count: number, input: ManagerPlanInput): string[] {
  const { window } = input.brief;
  const start =
    window.start < input.today && input.today <= window.end ? input.today : window.start;
  const span = daysBetween(start, window.end) + 1;
  const busy = new Set(input.busyDates);
  const dates: string[] = [];
  for (let i = 0; i < count; i++) {
    const ideal = Math.floor((i * span) / count);
    let chosen = addDays(start, ideal);
    for (let shift = 1; busy.has(chosen) && shift < span; shift++) {
      const later = ideal + shift;
      const earlier = ideal - shift;
      if (later < span && !busy.has(addDays(start, later))) chosen = addDays(start, later);
      else if (earlier >= 0 && !busy.has(addDays(start, earlier))) chosen = addDays(start, earlier);
    }
    dates.push(chosen);
  }
  return dates;
}

export function mockPlan(input: ManagerPlanInput): ManagerPlanOutput {
  const { brief, brand } = input;
  const rng = createRng(hashOf({ brief, changeRequest: input.changeRequest }));
  const types = dealTypes(brief.postMix);
  const dates = spreadDates(types.length, input);
  const angleOffset = rng.int(0, ANGLES.length - 1);
  const pillarOffset = rng.int(0, PILLARS.length - 1);
  const context = {
    focus: brief.productFocus ?? "signature range",
    // Intake titles read "<Occasion> — <Focus>"; anything else has no occasion to lean on.
    occasion: brief.title.includes(" — ") ? brief.title.split(" — ")[0]! : "the season",
    brand: brand.name,
  };

  const posts: PlannedPost[] = types.map((type, i) => ({
    ref: `p${i + 1}`,
    type,
    platforms: platformsFor(type, brief.platforms),
    targetDate: dates[i]!,
    angle: ANGLES[(angleOffset + i) % ANGLES.length]!({
      ...context,
      message: brief.keyMessages[i % Math.max(1, brief.keyMessages.length)] ?? brief.objective,
    }),
    pillarHint: PILLARS[(pillarOffset + i) % PILLARS.length]!,
  }));

  const actions = orderPipelineActions(input.enabledActions);
  const mix = joinList(brief.postMix.map((item) => countNoun(item.count, item.type)));
  const summary = [
    input.changeRequest === null ? null : `Updated for your note: "${input.changeRequest}"`,
    `${posts.length} posts for ${brand.name} on ${platformList(brief.platforms)}, ${formatRange(brief.window.start, brief.window.end)}: ${mix}.`,
    `For each post, ${joinList(actions.map((action) => ACTION_STEP[action]))} before it lands in your approval queue.`,
    "Nothing is generated until you approve this plan.",
  ]
    .filter(Boolean)
    .join(" ");

  return { summary, posts, nodes: canonicalGraph(posts, actions) };
}
