"use client";

import type { ClientListItem } from "@enmo/shared";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { cx } from "@/components/ui/cx";
import { CONTROL_CLASS } from "@/components/ui/Field";
import { useCreateCampaign } from "@/hooks/useCampaigns";
import { errorMessage } from "@/lib/api";
import { MessageField } from "./MessageField";

/*
 * "New brief": the first turn of a campaign, in plain words. Picking a client is optional (the
 * Manager can tell from the brief, or asks in its one question); the thread opens as soon as the
 * campaign exists and the Manager answers there.
 */

const ANY_CLIENT = "";

export function NewBriefForm({
  clients,
  defaultClientId,
  autoFocus,
  className,
}: {
  clients: readonly ClientListItem[];
  defaultClientId?: string;
  autoFocus?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const create = useCreateCampaign();
  const [clientId, setClientId] = useState(() =>
    clients.some((client) => client.id === defaultClientId)
      ? (defaultClientId ?? ANY_CLIENT)
      : ANY_CLIENT,
  );

  async function submit(message: string): Promise<boolean> {
    try {
      const campaign = await create.mutateAsync({
        message,
        ...(clientId !== ANY_CLIENT && { clientId }),
      });
      router.push(`/brief/${encodeURIComponent(campaign.id)}`);
      return true;
    } catch {
      return false;
    }
  }

  return (
    <MessageField
      label="Brief the Manager"
      placeholder="Ramadan campaign for the coffee client — 12 posts, push the iced line."
      submitLabel="Send brief"
      pending={create.isPending}
      error={create.isError ? errorMessage(create.error) : null}
      onSubmit={submit}
      rows={3}
      autoFocus={autoFocus}
      className={cx("w-full text-left", className)}
      toolbar={
        <label className="flex items-center gap-2 text-xs text-steel">
          Client
          <select
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
            className={cx(CONTROL_CLASS, "h-8 w-auto max-w-56 appearance-auto px-2 text-xs")}
          >
            <option value={ANY_CLIENT}>Let the Manager work it out</option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </label>
      }
    />
  );
}
