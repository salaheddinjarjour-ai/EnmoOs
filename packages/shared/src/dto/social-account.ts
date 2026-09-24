import { z } from "zod";
import { AccountStatus, Platform } from "../enums";
import { Id, IsoDateTime, listResponse } from "./common";

/** Non-secret platform identifiers kept in SocialAccount.meta. */
export const SocialAccountMeta = z.looseObject({
  pageId: z.string().optional(),
  igUserId: z.string().optional(),
  username: z.string().optional(),
});
export type SocialAccountMeta = z.infer<typeof SocialAccountMeta>;

/** Never carries tokens, encrypted or not. */
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
