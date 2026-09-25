"use client";

import {
  ASSET_SEARCH_MAX_LENGTH,
  AssetKind,
  type CampaignDto,
  type ClientListItem,
} from "@enmo/shared";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { Select, type SelectOption } from "@/components/ui/Select";
import { PLACE_OPTIONS, placeOf, withPlace, type VaultFilters as Filters } from "./vault-model";

/*
 * Search and filters above the grid. The search box is controlled here and debounced by the screen,
 * so typing stays instant while the API sees one query per pause. Picking a client narrows the
 * campaign list to its campaigns (and clears a campaign of another client). "Scene or slide"
 * narrows to the takes of one script scene or carousel slide across the posts shown.
 */

const ALL = "";

const KIND_OPTIONS: ReadonlyArray<SelectOption> = [
  { value: ALL, label: "Images and video" },
  { value: "IMAGE", label: "Images" },
  { value: "VIDEO", label: "Video" },
];

export function VaultFilters({
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
    <div role="search" aria-label="Vault" className="mb-8 flex flex-col gap-4">
      <Input
        label="Search the Vault"
        labelHidden
        type="search"
        placeholder="Search prompts, campaigns and shots (s2)"
        value={filters.q}
        maxLength={ASSET_SEARCH_MAX_LENGTH}
        onChange={(event) => onChange({ ...filters, q: event.target.value })}
        inputClassName="h-11 text-[15px]"
      />
      <div className="flex flex-wrap items-end gap-3">
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
          label="Campaign"
          options={campaignOptions}
          value={filters.campaignId ?? ALL}
          onChange={(event) => onChange({ ...filters, campaignId: event.target.value || null })}
          className="w-56"
        />
        <Select
          label="Scene or slide"
          options={PLACE_OPTIONS}
          value={placeOf(filters)}
          onChange={(event) => onChange(withPlace(filters, event.target.value))}
          className="w-48"
        />
        <Select
          label="Kind"
          options={KIND_OPTIONS}
          value={filters.kind ?? ALL}
          onChange={(event) => {
            const kind = AssetKind.safeParse(event.target.value);
            onChange({ ...filters, kind: kind.success ? kind.data : null });
          }}
          className="w-44"
        />
        <Checkbox
          label="Show all versions"
          description="Earlier and rejected takes too"
          checked={filters.allVersions}
          onChange={(event) => onChange({ ...filters, allVersions: event.target.checked })}
          className="mb-1.5 ml-auto"
        />
      </div>
    </div>
  );
}
