"use client";

import {
  CreateSocialAccountRequest,
  Platform,
  PLATFORM_LABEL,
  type ClientDto,
  type CreateSocialAccountInput,
  type SocialAccountMeta,
} from "@enmo/shared";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { FormAlert } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { useConnectSocialAccount } from "@/hooks/useSocialAccounts";
import { errorMessage, fieldErrors } from "@/lib/api";

/** Manual token connect (POST /clients/:id/social-accounts). ADMIN only; the parent gates it. */

const EXTERNAL_ID_LABEL: Readonly<Record<Platform, string>> = {
  INSTAGRAM: "Instagram user ID",
  FACEBOOK: "Facebook page ID",
  TIKTOK: "TikTok open_id",
};

/** The non-secret identifiers the publishers look up in SocialAccount.meta. */
function metaFor(platform: Platform, externalId: string, handle: string): SocialAccountMeta {
  switch (platform) {
    case "INSTAGRAM":
      return { igUserId: externalId, username: handle };
    case "FACEBOOK":
      return { pageId: externalId };
    case "TIKTOK":
      return { username: handle };
  }
}

const optional = (value: string) => (value.trim() ? value.trim() : undefined);

export function ConnectAccountForm({
  client,
  onConnected,
}: {
  client: ClientDto;
  onConnected: () => void;
}) {
  const toast = useToast();
  const connect = useConnectSocialAccount(client.id);
  const platformOptions = client.enabledPlatforms.map((platform) => ({
    value: platform,
    label: PLATFORM_LABEL[platform],
  }));

  const [platform, setPlatform] = useState<Platform>(client.enabledPlatforms[0] ?? "INSTAGRAM");
  const [handle, setHandle] = useState("");
  const [externalId, setExternalId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [tokenExpiresAt, setTokenExpiresAt] = useState("");
  const [scopes, setScopes] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanHandle = handle.trim().replace(/^@+/, "");
    const input: CreateSocialAccountInput = {
      platform,
      handle: cleanHandle,
      externalId: externalId.trim(),
      displayName: optional(displayName),
      accessToken,
      refreshToken: optional(refreshToken),
      // datetime-local is wall-clock time in the viewer's zone; the API wants an instant.
      tokenExpiresAt: tokenExpiresAt ? new Date(tokenExpiresAt).toISOString() : undefined,
      scopes: scopes
        .split(/[\s,]+/)
        .map((scope) => scope.trim())
        .filter(Boolean),
      meta: metaFor(platform, externalId.trim(), cleanHandle),
    };

    const parsed = CreateSocialAccountRequest.safeParse(input);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    connect.mutate(input, {
      onSuccess: (account) => {
        toast.success(
          `Connected @${account.handle}`,
          `${PLATFORM_LABEL[account.platform]} is ready for ${client.name}.`,
        );
        onConnected();
      },
      onError: (error) => setErrors(fieldErrors(error)),
    });
  }

  const formError =
    connect.isError && Object.keys(errors).length === 0 ? errorMessage(connect.error) : null;

  return (
    <form
      onSubmit={submit}
      noValidate
      autoComplete="off"
      className="flex flex-col gap-5 rounded-xl border border-line bg-panel p-5"
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <Select
          label="Platform"
          value={platform}
          onChange={(event) => setPlatform(Platform.parse(event.target.value))}
          options={platformOptions}
        />
        <Input
          label="Handle"
          value={handle}
          onChange={(event) => setHandle(event.target.value)}
          placeholder="@qahwaco"
          error={errors.handle}
          required
        />
        <Input
          label={EXTERNAL_ID_LABEL[platform]}
          value={externalId}
          onChange={(event) => setExternalId(event.target.value)}
          inputClassName="font-mono text-[13px]"
          error={errors.externalId}
          required
        />
        <Input
          label="Display name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="Optional"
          error={errors.displayName}
        />
        <Input
          label="Access token"
          type="password"
          value={accessToken}
          onChange={(event) => setAccessToken(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          inputClassName="font-mono text-[13px]"
          error={errors.accessToken}
          required
        />
        <Input
          label="Refresh token"
          type="password"
          value={refreshToken}
          onChange={(event) => setRefreshToken(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder="Optional"
          inputClassName="font-mono text-[13px]"
          error={errors.refreshToken}
        />
        <Input
          label="Token expires"
          type="datetime-local"
          value={tokenExpiresAt}
          onChange={(event) => setTokenExpiresAt(event.target.value)}
          hint="Leave empty for long-lived tokens."
          error={errors.tokenExpiresAt}
        />
        <Input
          label="Scopes"
          value={scopes}
          onChange={(event) => setScopes(event.target.value)}
          placeholder="pages_manage_posts, instagram_content_publish"
          inputClassName="font-mono text-[13px]"
          hint="Comma or space separated. Optional."
          error={errors.scopes}
        />
      </div>
      {formError ? <FormAlert>{formError}</FormAlert> : null}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={connect.isPending}>
          Connect account
        </Button>
      </div>
    </form>
  );
}
