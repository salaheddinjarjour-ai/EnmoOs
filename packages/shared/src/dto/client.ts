import { z } from "zod";
import { ApprovalChain, defaultApprovalChain } from "../approval-chain";
import { Platform } from "../enums";
import { hasUniqueItems } from "../internal";
import { VisualStyleTokens, defaultVisualStyle } from "../visual-style";
import { Id, IsoDateTime, listResponse } from "./common";

export const CLIENT_SLUG_MAX_LENGTH = 48;
export const BANNED_WORDS_MAX = 500;

export const Slug = z
  .string()
  .min(1)
  .max(CLIENT_SLUG_MAX_LENGTH)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, digits and single hyphens");

/** URL-safe slug from a client name; non-Latin names fall back to "client" (the API de-dupes). */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, CLIENT_SLUG_MAX_LENGTH)
    .replace(/^-+|-+$/g, "");
  return slug || "client";
}

/** IANA zone names only (no raw offsets), and the runtime must know the zone. */
export function isValidTimeZone(timeZone: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9]*(?:[/_+-][A-Za-z0-9]+)*$/.test(timeZone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The runtime's spelling of a zone typed in another case ("asia/riyadh" → "Asia/Riyadh"), so equal
 * zones compare equal. Aliases keep the name as sent: ICU's pick between them differs by runtime
 * (Node 22 resolves Asia/Kolkata to the older Asia/Calcutta), so it isn't a stable canonical form.
 */
export function canonicalTimeZoneCase(timeZone: string): string {
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
    return resolved.toLowerCase() === timeZone.toLowerCase() ? resolved : timeZone;
  } catch {
    return timeZone;
  }
}

export const TimeZone = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, "Unknown IANA time zone")
  .overwrite(canonicalTimeZoneCase);

/** Trimmed, non-empty and de-duplicated case-insensitively (first spelling wins). */
export const BannedWords = z
  .array(z.string().trim().min(1).max(100))
  .max(BANNED_WORDS_MAX)
  .overwrite((words) => {
    const seen = new Set<string>();
    return words.filter((word) => {
      const key = word.normalize("NFKC").toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

export const EnabledPlatforms = z
  .array(Platform)
  .min(1)
  .max(Platform.options.length)
  .refine(hasUniqueItems, "Platforms must be unique");

export const ClientName = z.string().trim().min(1).max(120);
export const BrandVoice = z.string().trim().max(10_000);

export const ClientDto = z.object({
  id: Id,
  name: z.string(),
  slug: z.string(),
  timezone: z.string(),
  brandVoice: z.string(),
  visualStyle: VisualStyleTokens,
  bannedWords: z.array(z.string()),
  approvalChain: ApprovalChain,
  enabledPlatforms: z.array(Platform),
  archivedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ClientDto = z.infer<typeof ClientDto>;

/** GET /v1/clients */
export const ClientListQuery = z.object({
  includeArchived: z.stringbool().default(false),
});
export type ClientListQuery = z.infer<typeof ClientListQuery>;

/** Related-row counts shown on the roster. */
export const ClientCounts = z.object({
  socialAccounts: z.number().int().nonnegative(),
  campaigns: z.number().int().nonnegative(),
  posts: z.number().int().nonnegative(),
});
export type ClientCounts = z.infer<typeof ClientCounts>;

/** A GET /v1/clients item: the ClientDto plus its related-row counts. */
export const ClientListItem = ClientDto.extend({ counts: ClientCounts });
export type ClientListItem = z.infer<typeof ClientListItem>;

export const ClientListResponse = listResponse(ClientListItem);
export type ClientListResponse = z.infer<typeof ClientListResponse>;

/** POST /v1/clients → ClientDto. Omitted slug is derived from the name. */
export const CreateClientRequest = z.object({
  name: ClientName,
  slug: Slug.optional(),
  timezone: TimeZone.default("UTC"),
  brandVoice: BrandVoice.default(""),
  visualStyle: VisualStyleTokens.default(defaultVisualStyle),
  bannedWords: BannedWords.default(() => []),
  approvalChain: ApprovalChain.default(defaultApprovalChain),
  enabledPlatforms: EnabledPlatforms.default(() => [...Platform.options]),
});
export type CreateClientRequest = z.infer<typeof CreateClientRequest>;
export type CreateClientInput = z.input<typeof CreateClientRequest>;

/**
 * PATCH /v1/clients/:id → ClientDto. `visualStyle` replaces the stored tokens (missing leaves take
 * defaults); the approval chain has its own endpoint.
 */
export const UpdateClientRequest = z
  .object({
    name: ClientName,
    slug: Slug,
    timezone: TimeZone,
    brandVoice: BrandVoice,
    visualStyle: VisualStyleTokens,
    bannedWords: BannedWords,
    enabledPlatforms: EnabledPlatforms,
  })
  .partial()
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "Nothing to update",
  });
export type UpdateClientRequest = z.infer<typeof UpdateClientRequest>;
export type UpdateClientInput = z.input<typeof UpdateClientRequest>;

/** PUT /v1/clients/:id/approval-chain → ClientDto */
export const UpdateApprovalChainRequest = ApprovalChain;
export type UpdateApprovalChainRequest = z.infer<typeof UpdateApprovalChainRequest>;
