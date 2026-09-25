import { z } from "zod";
import { AccountStatus, Platform } from "../enums";
import { Id, IsoDateTime, listResponse } from "./common";

/** How an account was connected: the OAuth flow, or a token pasted by an admin. */
export const SocialAccountSource = z.enum(["oauth", "manual"]);
export type SocialAccountSource = z.infer<typeof SocialAccountSource>;

/**
 * Non-secret platform identifiers kept in SocialAccount.meta. Meta OAuth stores one account per
 * Facebook Page (externalId = pageId) and one per Instagram account linked to a Page (externalId =
 * igUserId, pageId = the Page it publishes through, whose token it holds).
 */
export const SocialAccountMeta = z.looseObject({
  pageId: z.string().optional(),
  pageName: z.string().optional(),
  igUserId: z.string().optional(),
  username: z.string().optional(),
  /** TikTok's per-app user id (Phase 5). */
  openId: z.string().optional(),
  source: SocialAccountSource.optional(),
});
export type SocialAccountMeta = z.infer<typeof SocialAccountMeta>;

/**
 * Never carries tokens, encrypted or not. `status`, `tokenExpiresAt` and `scopes` say whether the
 * account can publish (see missingPublishScopes); `meta` names the Page or Instagram account.
 */
export const SocialAccountDto = z.object({
  id: Id,
  clientId: Id,
  platform: Platform,
  externalId: z.string(),
  handle: z.string(),
  displayName: z.string().nullable(),
  status: AccountStatus,
  scopes: z.array(z.string()),
  meta: SocialAccountMeta,
  tokenExpiresAt: IsoDateTime.nullable(),
  refreshExpiresAt: IsoDateTime.nullable(),
  lastCheckedAt: IsoDateTime.nullable(),
  connectedById: Id.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SocialAccountDto = z.infer<typeof SocialAccountDto>;

/** GET /v1/clients/:id/social-accounts */
export const SocialAccountListResponse = listResponse(SocialAccountDto);
export type SocialAccountListResponse = z.infer<typeof SocialAccountListResponse>;

const Token = z.string().trim().min(1).max(8192);

/** POST /v1/clients/:id/social-accounts (manual token) → SocialAccountDto */
export const CreateSocialAccountRequest = z.object({
  platform: Platform,
  externalId: z.string().trim().min(1).max(128),
  handle: z.string().trim().min(1).max(128),
  displayName: z.string().trim().min(1).max(200).nullish(),
  accessToken: Token,
  refreshToken: Token.nullish(),
  tokenExpiresAt: IsoDateTime.nullish(),
  refreshExpiresAt: IsoDateTime.nullish(),
  scopes: z
    .array(z.string().trim().min(1).max(128))
    .max(50)
    .default(() => []),
  meta: SocialAccountMeta.default(() => ({})),
});
export type CreateSocialAccountRequest = z.infer<typeof CreateSocialAccountRequest>;
export type CreateSocialAccountInput = z.input<typeof CreateSocialAccountRequest>;

/** POST /v1/social-accounts/:id/check → SocialAccountDto with refreshed status/lastCheckedAt. */
export const CheckSocialAccountResponse = SocialAccountDto;
export type CheckSocialAccountResponse = SocialAccountDto;
