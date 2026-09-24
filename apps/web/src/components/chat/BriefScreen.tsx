"use client";

import { AGENT_LABEL, AgentName, type CampaignDto } from "@enmo/shared";
import Link from "next/link";
import { AgentAvatar } from "@/components/agent/AgentAvatar";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormAlert } from "@/components/ui/Field";
import { LoadingRegion, Skeleton } from "@/components/ui/Skeleton";
import { RelativeTime } from "@/components/ui/time";
import { useCampaigns } from "@/hooks/useCampaigns";
import { useClients } from "@/hooks/useClients";
import { errorMessage } from "@/lib/api";
import { useCan } from "@/lib/auth";
import { CampaignStatusBadge } from "./CampaignStatusBadge";
import { NewBriefForm } from "./NewBriefForm";

/*
 * The Brief (MASTER_PLAN §03): one thread per campaign. A composer to start a new one, and every
 * campaign grouped by client with where it stands. With no campaigns yet, the idle Arsenal holds
 * the composer: one line, one green action.
 */

const UNASSIGNED = "unassigned";

interface ClientGroup {
  id: string;
  name: string;
  campaigns: CampaignDto[];
}

/** Campaigns by client, clients A–Z, the not-yet-resolved ones last; newest first inside. */
export function groupByClient(campaigns: readonly CampaignDto[]): ClientGroup[] {
  const groups = new Map<string, ClientGroup>();
  for (const campaign of campaigns) {
    const id = campaign.client?.id ?? UNASSIGNED;
    let group = groups.get(id);
    if (!group) {
      group = { id, name: campaign.client?.name ?? "Client to be confirmed", campaigns: [] };
      groups.set(id, group);
    }
    group.campaigns.push(campaign);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.id === UNASSIGNED) return 1;
    if (b.id === UNASSIGNED) return -1;
    return a.name.localeCompare(b.name);
  });
}

export function BriefScreen({ clientId }: { clientId?: string }) {
  const campaigns = useCampaigns();
  const clients = useClients();
  const canBrief = useCan("campaigns.create");

  const loading = campaigns.isPending || clients.isPending;
  const error = campaigns.error ?? clients.error;
  const empty = campaigns.data?.length === 0;

  return (
    <>
      <PageHeader
        eyebrow="The Brief"
        title="Where you run the agency."
        description="One thread per campaign. Brief the Manager in plain words: it asks one question at most, plans for your approval, and nothing is generated until you say so."
      />
      {loading ? (
        <LoadingRegion label="Loading campaigns">
          <Skeleton className="mb-10 h-32 w-full rounded-2xl" />
          <div className="flex flex-col gap-3">
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
          </div>
        </LoadingRegion>
      ) : error ? (
        <div className="flex flex-col items-start gap-4">
          <FormAlert>{errorMessage(error)}</FormAlert>
          <Button
            onClick={() => {
              void campaigns.refetch();
              void clients.refetch();
            }}
          >
            Try again
          </Button>
        </div>
      ) : empty ? (
        <EmptyState
          eyebrow="The Arsenal"
          title={
            <>
              The Arsenal is idle. <span className="text-steel">Give it a brief.</span>
            </>
          }
          description="Say what the client needs, as you would to a colleague. The Manager handles the rest."
          visual={
            <ul
              aria-label="The Arsenal, standing by"
              className="flex flex-wrap justify-center gap-3"
            >
              {AgentName.options.map((agent) => (
                <li key={agent}>
                  <AgentAvatar agent={agent} />
                  <span className="sr-only">{AGENT_LABEL[agent]}</span>
                </li>
              ))}
            </ul>
          }
          action={
            canBrief ? (
              <NewBriefForm
                clients={clients.data ?? []}
                defaultClientId={clientId}
                autoFocus
                className="w-[min(40rem,calc(100vw-6rem))]"
              />
            ) : null
          }
        >
          {canBrief ? null : "Your role can read campaigns but not start them."}
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-12">
          {canBrief ? (
            <NewBriefForm clients={clients.data ?? []} defaultClientId={clientId} />
          ) : null}
          <CampaignGroups campaigns={campaigns.data ?? []} />
        </div>
      )}
    </>
  );
}

function CampaignGroups({ campaigns }: { campaigns: readonly CampaignDto[] }) {
  return (
    <div className="flex flex-col gap-10">
      {groupByClient(campaigns).map((group) => (
        <section
          key={group.id}
          aria-labelledby={`client-${group.id}`}
          className="flex flex-col gap-3"
        >
          <h2
            id={`client-${group.id}`}
            className="flex items-baseline gap-3 font-display text-lg font-medium tracking-tight text-paper"
          >
            {group.name}
            <span className="font-mono text-[11px] tracking-[0.12em] text-steel">
              {group.campaigns.length}
            </span>
          </h2>
          <ul className="flex flex-col gap-2">
            {group.campaigns.map((campaign) => (
              <li key={campaign.id}>
                <CampaignRow campaign={campaign} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function CampaignRow({ campaign }: { campaign: CampaignDto }) {
  const plan = campaign.latestGraph;
  return (
    <Link
      href={`/brief/${encodeURIComponent(campaign.id)}`}
      className="group flex flex-wrap items-center justify-between gap-4 rounded-xl border border-line bg-panel/60 px-5 py-4 transition duration-200 ease-enmo hover:-translate-y-px hover:border-paper/20 hover:bg-panel"
    >
      <span className="flex min-w-0 flex-col gap-1">
        <span className="truncate text-[15px] text-paper">{campaign.name}</span>
        <span className="font-mono text-[11px] tracking-[0.1em] text-steel uppercase">
          {campaign.brief ? `${campaign.brief.postCount} posts` : "Briefing"}
          {plan ? ` · plan v${plan.version} ${plan.status.toLowerCase()}` : ""}
          {" · "}
          <RelativeTime iso={campaign.createdAt} />
        </span>
      </span>
      <CampaignStatusBadge status={campaign.status} />
    </Link>
  );
}
