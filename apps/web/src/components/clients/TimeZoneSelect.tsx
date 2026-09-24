"use client";

import { useMemo } from "react";
import { Select, type SelectOption } from "@/components/ui/Select";

let cachedZones: readonly string[] | undefined;

/** IANA zones the runtime knows (the API validates with the same Intl data), UTC first. */
function timeZones(): readonly string[] {
  cachedZones ??= ["UTC", ...Intl.supportedValuesOf("timeZone").filter((zone) => zone !== "UTC")];
  return cachedZones;
}

export function TimeZoneSelect({
  value,
  onChange,
  disabled,
  error,
  hint = "Publishing slots and the calendar use this zone.",
}: {
  value: string;
  onChange: (zone: string) => void;
  disabled?: boolean;
  error?: string | null;
  hint?: string;
}) {
  const options = useMemo<SelectOption[]>(() => {
    const zones = timeZones();
    // Keep a stored zone selectable even if this browser's Intl data doesn't list it.
    const all = zones.includes(value) ? zones : [value, ...zones];
    return all.map((zone) => ({ value: zone, label: zone.replaceAll("_", " ") }));
  }, [value]);

  return (
    <Select
      label="Time zone"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      options={options}
      disabled={disabled}
      error={error}
      hint={hint}
    />
  );
}
