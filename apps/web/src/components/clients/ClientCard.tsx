import type { ClientListItem } from "@enmo/shared";
import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { PlatformBadges } from "./platforms";

/** One client on the roster; the whole card links to its settings. */
export function ClientCard({ client }: { client: ClientListItem }) {
  const stats: Array<[string, number]> = [
    ["Accounts", client.counts.socialAccounts],
    ["Banned", client.bannedWords.length],
    ["Steps", client.approvalChain.steps.length],
  ];

  return (
    <Link
      href={`/clients/${encodeURIComponent(client.id)}`}
      className="group flex h-full flex-col gap-5 rounded-xl border border-line bg-panel p-5 transition duration-250 ease-enmo hover:-translate-y-0.5 hover:border-paper/15 hover:shadow-[0_24px_48px_-32px_rgb(0_0_0/0.9)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h2 className="truncate font-display text-lg font-medium tracking-tight text-paper">
            {client.name}
          </h2>
          <p className="truncate font-mono text-[11px] text-steel">
            /{client.slug} · {client.timezone}
          </p>
        </div>
        {client.archivedAt ? <Badge tone="muted">Archived</Badge> : null}
      </div>

      <PlatformBadges platforms={client.enabledPlatforms} />

      <dl className="mt-auto grid grid-cols-3 gap-3 border-t border-line pt-4">
        {stats.map(([label, value]) => (
          <div key={label} className="flex flex-col gap-1">
            <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-steel/80">
              {label}
            </dt>
            <dd className="font-mono text-sm text-paper tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </Link>
  );
}
