"use client";

import { type AccountStatus, type ClientDto, type SocialAccountDto } from "@enmo/shared";
import { useState } from "react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cx } from "@/components/ui/cx";
import { FormAlert } from "@/components/ui/Field";
import { LoadingRegion, Skeleton } from "@/components/ui/Skeleton";
import { formatDate, RelativeTime } from "@/components/ui/time";
import { useToast } from "@/components/ui/Toast";
import {
  useCheckSocialAccount,
  useDisconnectSocialAccount,
  useSocialAccounts,
} from "@/hooks/useSocialAccounts";
import { errorMessage } from "@/lib/api";
import { accountNames, accountSource, scopeCheck, tokenExpiry } from "./accounts-model";
import { ConnectAccountForm } from "./ConnectAccountForm";
import { ConnectMetaButton } from "./ConnectMetaButton";
import { EditorSection } from "./EditorFrame";
import { OAuthResultNotice } from "./OAuthResultNotice";
import { PLATFORM_DOT } from "./platforms";

/*
 * Accounts tab: where the Publisher posts for this client. Everyone sees the list: each account's
 * platform, name, status, token expiry, last check and whether its token may publish. Only ADMINs
 * (socialAccounts.manage) connect (Meta sign-in, or a pasted token), check and disconnect. Tokens
 * are never displayed: the DTO has no token fields. Meta's sign-in comes back here with its result
 * in the address (OAuthResultNotice).
 */

const STATUS: Readonly<Record<AccountStatus, { tone: BadgeTone; label: string }>> = {
  ACTIVE: { tone: "positive", label: "Active" },
  EXPIRED: { tone: "warning", label: "Expired" },
  REVOKED: { tone: "muted", label: "Revoked" },
  ERROR: { tone: "negative", label: "Error" },
};

export function ConnectedAccounts({
  client,
  canManage,
  readOnlyReason,
}: {
  client: ClientDto;
  canManage: boolean;
  /** Why nobody can connect accounts here right now (archived client), if that's the case. */
  readOnlyReason?: string | null;
}) {
  const accounts = useSocialAccounts(client.id);
  // Bumped after each connect so the form remounts empty (and the token fields are cleared).
  const [formGeneration, setFormGeneration] = useState(0);

  return (
    <div className="flex flex-col gap-12">
      <OAuthResultNotice />
      <EditorSection
        title="Connected accounts"
        description="Pages and profiles the Publisher posts to. Tokens are encrypted at rest and never leave the API."
      >
        {accounts.isPending ? (
          <LoadingRegion label="Loading accounts">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-16 w-full rounded-lg" />
              <Skeleton className="h-16 w-full rounded-lg" />
            </div>
          </LoadingRegion>
        ) : accounts.isError ? (
          <div className="flex flex-col items-start gap-3">
            <FormAlert>{errorMessage(accounts.error)}</FormAlert>
            <Button size="sm" onClick={() => void accounts.refetch()}>
              Try again
            </Button>
          </div>
        ) : accounts.data.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line px-5 py-8 text-center text-sm text-steel">
            No accounts connected yet.{" "}
            {canManage ? "Connect Meta, or paste a token below." : "An admin connects them."}
          </p>
        ) : (
          <ul aria-label="Connected accounts" className="flex flex-col gap-2">
            {accounts.data.map((account) => (
              <AccountRow
                key={account.id}
                account={account}
                clientId={client.id}
                canManage={canManage}
              />
            ))}
          </ul>
        )}
      </EditorSection>

      {canManage ? (
        <>
          <EditorSection
            title="Connect with Meta"
            description="Sign in with Facebook and tick this client's Pages. Each Page, and the Instagram business account linked to it, is connected with a long-lived token."
          >
            <ConnectMetaButton clientId={client.id} />
          </EditorSection>
          <EditorSection
            title="Connect manually"
            description="Or paste a long-lived page or account token (a Meta system user's, say, or TikTok's until its sign-in arrives). It is stored encrypted and never shown again."
          >
            <ConnectAccountForm
              key={formGeneration}
              client={client}
              onConnected={() => setFormGeneration((value) => value + 1)}
            />
          </EditorSection>
        </>
      ) : (
        <p className="border-t border-line pt-5 font-mono text-[11px] uppercase tracking-[0.16em] text-steel">
          {readOnlyReason ?? "Only admins connect and disconnect accounts"}
        </p>
      )}
    </div>
  );
}

function TokenLine({ account }: { account: SocialAccountDto }) {
  const expiry = tokenExpiry(account);
  switch (expiry.kind) {
    case "never":
      return <dd>no expiry</dd>;
    case "valid":
      return <dd>expires {formatDate(expiry.at)}</dd>;
    case "soon":
      return <dd className="text-amber-200">expires {formatDate(expiry.at)}</dd>;
    case "expired":
      return <dd className="text-red-300">expired {formatDate(expiry.at)}</dd>;
  }
}

function ScopeNote({ account }: { account: SocialAccountDto }) {
  const check = scopeCheck(account);
  if (check.kind === "ok") return null;
  if (check.kind === "unknown") {
    return (
      <p className="w-full font-mono text-[11px] text-steel">
        Permissions unknown: none were recorded with this token.
      </p>
    );
  }
  return (
    <p className="w-full text-xs text-amber-200">
      Can&apos;t publish yet: missing{" "}
      <span className="font-mono text-[11px]">{check.scopes.join(", ")}</span>. Connect it again and
      grant them.
    </p>
  );
}

function AccountRow({
  account,
  clientId,
  canManage,
}: {
  account: SocialAccountDto;
  clientId: string;
  canManage: boolean;
}) {
  const toast = useToast();
  const check = useCheckSocialAccount(clientId);
  const disconnect = useDisconnectSocialAccount(clientId);
  const [confirming, setConfirming] = useState(false);
  const status = STATUS[account.status];
  const names = accountNames(account);
  const source = accountSource(account);
  const name = names.primary;

  return (
    <li className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-lg border border-line bg-panel px-4 py-3.5">
      <span
        aria-hidden
        className={cx("size-2 shrink-0 rounded-full", PLATFORM_DOT[account.platform])}
      />
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm text-paper">{name}</span>
        <span className="truncate font-mono text-[11px] text-steel">
          {names.secondary}
          {source ? ` · ${source}` : ""}
        </span>
      </div>
      <Badge tone={status.tone} dot>
        {status.label}
      </Badge>
      <dl className="flex flex-col font-mono text-[11px] text-steel sm:ml-auto sm:items-end">
        <div className="flex gap-1.5">
          <dt>Token</dt>
          <TokenLine account={account} />
        </div>
        <div className="flex gap-1.5">
          <dt>Checked</dt>
          <dd>{account.lastCheckedAt ? <RelativeTime iso={account.lastCheckedAt} /> : "never"}</dd>
        </div>
      </dl>
      {canManage ? (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            aria-label={`Check ${name}`}
            loading={check.isPending}
            onClick={() =>
              check.mutate(account.id, {
                onSuccess: (checked) =>
                  toast.show({
                    title: `${name} is ${STATUS[checked.status].label.toLowerCase()}`,
                    tone: checked.status === "ACTIVE" ? "success" : "error",
                  }),
                onError: (error) => toast.error(`Couldn't check ${name}`, errorMessage(error)),
              })
            }
          >
            Check
          </Button>
          <Button
            size="sm"
            variant="danger"
            aria-label={`Disconnect ${name}`}
            onClick={() => setConfirming(true)}
          >
            Disconnect
          </Button>
        </div>
      ) : null}
      <ScopeNote account={account} />
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Disconnect ${name}?`}
        description="Its token is deleted and scheduled posts for this account stop until it is connected again."
        confirmLabel="Disconnect"
        pending={disconnect.isPending}
        error={disconnect.isError ? errorMessage(disconnect.error) : null}
        onConfirm={() =>
          disconnect.mutate(account.id, {
            onSuccess: () => {
              setConfirming(false);
              toast.success(`${name} disconnected`);
            },
          })
        }
      />
    </li>
  );
}
