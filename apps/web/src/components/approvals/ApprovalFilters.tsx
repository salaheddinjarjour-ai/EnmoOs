"use client";

import { Platform, PLATFORM_LABEL, type CampaignDto, type ClientListItem } from "@enmo/shared";
import { Select, type SelectOption } from "@/components/ui/Select";
import type { ApprovalFilters as Filters } from "./approvals-model";

/*
 * Client, platform and campaign filters over the queue. Picking a client narrows the campaigns to
 * its own (and drops a campaign of another client), as in the Vault.
 */

const ALL = "";

const PLATFORM_OPTIONS: readonly SelectOption[] = [
  { value: ALL, label: "All platforms" },
  ...Platform.options.map((platform) => ({ value: platform, label: PLATFORM_LABEL[platform] })),
];

export function ApprovalFilters({
  filters,
  onChange,
  clients,
  campaigns,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  clients: readonly ClientListItem[];
  campaigns: readonly CampaignDto[];
}) {
  const clientOptions: SelectOption[] = [
    { value: ALL, label: "All clients" },
    ...clients.map((client) => ({ value: client.id, label: client.name })),
  ];
  const campaignOptions: SelectOption[] = [
    { value: ALL, label: "All campaigns" },
    ...campaigns
      .filter((campaign) => !filters.clientId || campaign.client?.id === filters.clientId)
      .map((campaign) => ({ value: campaign.id, label: campaign.name })),
  ];

  return (
    <div role="search" aria-label="Filter approvals" className="flex flex-wrap items-end gap-3">
      <Select
        label="Client"
        options={clientOptions}
        value={filters.clientId ?? ALL}
        onChange={(event) => {
          const clientId = event.target.value || null;
          const campaign = campaigns.find((c) => c.id === filters.campaignId);
          onChange({
            ...filters,
            clientId,
            campaignId: clientId && campaign?.client?.id !== clientId ? null : filters.campaignId,
          });
        }}
        className="w-48"
      />
      <Select
        label="Platform"
        options={PLATFORM_OPTIONS}
        value={filters.platform ?? ALL}
        onChange={(event) => {
          const platform = Platform.safeParse(event.target.value);
          onChange({ ...filters, platform: platform.success ? platform.data : null });
        }}
        className="w-44"
      />
      <Select
        label="Campaign"
        options={campaignOptions}
        value={filters.campaignId ?? ALL}
        onChange={(event) => onChange({ ...filters, campaignId: event.target.value || null })}
        className="w-56"
      />
    </div>
  );
}
