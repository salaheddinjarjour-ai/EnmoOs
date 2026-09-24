"use client";

import Link from "next/link";
import { chainsNeedingAttention } from "@/components/clients/chain-health";
import { useClients } from "@/hooks/useClients";
import { useTeamDirectory } from "@/hooks/useTeam";

/*
 * Deactivating someone or changing their role can leave a client's approval chain with a step
 * nobody can complete, and every post for that client would then wait there. The Team screen is
 * where that happens, so it names the affected clients right away.
 */
export function StalledChainsNotice() {
  const clients = useClients();
  const team = useTeamDirectory();
  if (clients.isError || team.isError) return null;
  // Until both lists arrive, "nothing is stalled" and "not checked yet" must not look the same.
  if (!clients.data || !team.data) {
    return (
      <p role="status" className="sr-only">
        Checking approval chains
      </p>
    );
  }

  const stalled = chainsNeedingAttention(clients.data, team.data);
  if (stalled.length === 0) return null;

  return (
    <section
      aria-labelledby="stalled-chains"
      className="flex flex-col gap-3 rounded-xl border border-amber-300/25 bg-amber-300/[0.04] p-5"
    >
      <h2 id="stalled-chains" className="font-display text-base font-medium text-paper">
        Approval chains the team can&apos;t complete
      </h2>
      <p className="text-sm text-steel">
        Posts for these clients would wait at these steps with nobody able to approve them. Open the
        client&apos;s approval chain to add approvers or lower the count.
      </p>
      <ul className="flex flex-col gap-2.5">
        {stalled.map(({ client, steps }) => (
          <li key={client.id} className="flex flex-col gap-0.5 text-sm">
            <Link
              href={`/clients/${encodeURIComponent(client.id)}`}
              className="text-paper underline decoration-paper/30 underline-offset-4 transition-colors duration-200 hover:decoration-paper"
            >
              {client.name}
            </Link>
            {steps.map((line) => (
              <span key={line} className="text-xs text-steel">
                {line}
              </span>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}
