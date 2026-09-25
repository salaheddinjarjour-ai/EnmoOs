"use client";

import { PLATFORM_LABEL, type OAuthSelectionAccount } from "@enmo/shared";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { cx } from "@/components/ui/cx";
import { Dialog } from "@/components/ui/Dialog";
import { FormAlert } from "@/components/ui/Field";
import { LoadingRegion, Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { useConnectOAuthSelection, useOAuthSelection } from "@/hooks/useOAuth";
import { errorMessage } from "@/lib/api";
import {
  initialPicks,
  oauthResultFrom,
  pendingSelection,
  selectionBlock,
  selectionDetail,
  selectionName,
  withoutOAuthResult,
} from "./accounts-model";
import { PLATFORM_DOT } from "./platforms";

/*
 * Meta's sign-in comes back with every Page the admin ever granted the app, other clients' brands
 * included, so nothing is connected until the admin says which belong to this client. The API's
 * callback lands here with `outcome=choose&pick=<id>`: this lists what Meta returned, each Page
 * with its linked Instagram account, ticks the accounts already this client's (and a lone free
 * Page), greys out the ones another client has, and connects exactly what is ticked. Closing it,
 * or connecting, takes the result out of the address.
 */
export function MetaAccountPicker({ clientId }: { clientId: string }) {
  // It reads the address, which only the browser knows.
  return (
    <Suspense fallback={null}>
      <Picker clientId={clientId} />
    </Suspense>
  );
}

function Picker({ clientId }: { clientId: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const selectionId = pendingSelection(oauthResultFrom(params));
  const close = () =>
    router.replace(`${pathname}${withoutOAuthResult(params.toString())}`, { scroll: false });

  return (
    <Dialog
      open={selectionId !== null}
      onClose={close}
      title="Choose what to connect"
      description="Meta returned every Page this Facebook sign-in can manage. Tick the ones that belong to this client, and the Instagram accounts linked to them."
      size="lg"
    >
      {selectionId ? (
        <PickList key={selectionId} clientId={clientId} selectionId={selectionId} onDone={close} />
      ) : null}
    </Dialog>
  );
}

function PickList({
  clientId,
  selectionId,
  onDone,
}: {
  clientId: string;
  selectionId: string;
  onDone: () => void;
}) {
  const toast = useToast();
  const selection = useOAuthSelection(selectionId);
  const connect = useConnectOAuthSelection(clientId);
  const [picked, setPicked] = useState<Set<string> | null>(null);

  if (selection.isPending) {
    return (
      <LoadingRegion label="Loading the accounts Meta returned">
        <div className="flex flex-col gap-2 p-6">
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-14 w-full rounded-lg" />
        </div>
      </LoadingRegion>
    );
  }
  if (selection.isError) {
    return (
      <div className="flex flex-col items-start gap-4 p-6">
        <FormAlert>{errorMessage(selection.error)}</FormAlert>
        <Button size="sm" onClick={onDone}>
          Close
        </Button>
      </div>
    );
  }

  const { accounts } = selection.data;
  const chosen = picked ?? new Set(initialPicks(accounts));
  const toggle = (key: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(key);
    else next.delete(key);
    setPicked(next);
  };
  const count = chosen.size;

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        connect.mutate(
          { selectionId, keys: [...chosen] },
          {
            onSuccess: (result) => {
              const noun = result.connected === 1 ? "account" : "accounts";
              toast.success(
                `${result.connected} Meta ${noun} connected`,
                "Where several share a platform, choose the one the Publisher posts through.",
              );
              onDone();
            },
          },
        );
      }}
    >
      <ul aria-label="Accounts Meta returned" className="flex flex-col gap-2 overflow-y-auto p-6">
        {accounts.map((account) => (
          <PickRow
            key={account.key}
            account={account}
            checked={chosen.has(account.key)}
            onChange={(on) => toggle(account.key, on)}
          />
        ))}
      </ul>
      {connect.isError ? (
        <div className="px-6 pb-4">
          <FormAlert>{errorMessage(connect.error)}</FormAlert>
        </div>
      ) : null}
      <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-6 py-4">
        <Button type="button" variant="ghost" onClick={onDone} disabled={connect.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={count === 0} loading={connect.isPending}>
          {count === 0 ? "Connect" : `Connect ${count} account${count === 1 ? "" : "s"}`}
        </Button>
      </footer>
    </form>
  );
}

function PickRow({
  account,
  checked,
  onChange,
}: {
  account: OAuthSelectionAccount;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const blocked = selectionBlock(account);
  const name = selectionName(account);
  return (
    <li
      className={cx(
        "flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-panel px-4 py-3",
        account.platform === "INSTAGRAM" && "ml-6",
      )}
    >
      <span
        aria-hidden
        className={cx("size-2 shrink-0 rounded-full", PLATFORM_DOT[account.platform])}
      />
      <Checkbox
        label={name}
        aria-label={`${PLATFORM_LABEL[account.platform]}: ${name}`}
        description={blocked ?? selectionDetail(account)}
        checked={checked && blocked === null}
        disabled={blocked !== null}
        onChange={(event) => onChange(event.target.checked)}
        className="min-w-0 flex-1"
      />
      {account.status === "connected" ? <Badge tone="muted">Connected here</Badge> : null}
    </li>
  );
}
