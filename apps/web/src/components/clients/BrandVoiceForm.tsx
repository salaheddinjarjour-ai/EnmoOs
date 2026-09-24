"use client";

import {
  UpdateClientRequest,
  type ClientDto,
  type Platform,
  type UpdateClientInput,
} from "@enmo/shared";
import { useState } from "react";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { useToast } from "@/components/ui/Toast";
import { useUpdateClient } from "@/hooks/useClients";
import { errorMessage, fieldErrors } from "@/lib/api";
import { EditorForm, EditorSection, SaveBar } from "./EditorFrame";
import { PlatformPicker } from "./platforms";
import { TimeZoneSelect } from "./TimeZoneSelect";

/** Brand voice tab: the client's profile (name, slug, zone, platforms) and its written voice. */

interface Profile {
  name: string;
  slug: string;
  timezone: string;
  enabledPlatforms: Platform[];
  brandVoice: string;
}

const profileOf = (client: ClientDto): Profile => ({
  name: client.name,
  slug: client.slug,
  timezone: client.timezone,
  enabledPlatforms: [...client.enabledPlatforms],
  brandVoice: client.brandVoice,
});

/** Only the fields that differ, so PATCH never rewrites what the user didn't touch. */
function changedFields(before: Profile, after: Profile): UpdateClientInput {
  const changes: UpdateClientInput = {};
  if (after.name !== before.name) changes.name = after.name;
  if (after.slug !== before.slug) changes.slug = after.slug;
  if (after.timezone !== before.timezone) changes.timezone = after.timezone;
  if (after.brandVoice !== before.brandVoice) changes.brandVoice = after.brandVoice;
  if (after.enabledPlatforms.join() !== before.enabledPlatforms.join()) {
    changes.enabledPlatforms = after.enabledPlatforms;
  }
  return changes;
}

const FRIENDLY_ERRORS: Readonly<Record<string, string>> = {
  name: "Give the client a name",
  enabledPlatforms: "Pick at least one platform",
};

export function BrandVoiceForm({
  client,
  readOnlyReason,
}: {
  client: ClientDto;
  readOnlyReason: string | null;
}) {
  const toast = useToast();
  const update = useUpdateClient(client.id);
  const [saved, setSaved] = useState(() => profileOf(client));
  const [draft, setDraft] = useState(saved);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const readOnly = readOnlyReason !== null;

  const changes = changedFields(saved, draft);
  const dirty = Object.keys(changes).length > 0;

  function set<K extends keyof Profile>(key: K, value: Profile[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function save() {
    const parsed = UpdateClientRequest.safeParse(changes);
    if (!parsed.success) {
      const issues = fieldErrors(parsed.error);
      setErrors(
        Object.fromEntries(Object.entries(issues).map(([k, v]) => [k, FRIENDLY_ERRORS[k] ?? v])),
      );
      return;
    }
    setErrors({});
    update.mutate(changes, {
      onSuccess: (next) => {
        const profile = profileOf(next);
        setSaved(profile);
        setDraft(profile);
        toast.success("Brand voice saved");
      },
      onError: (error) => setErrors(fieldErrors(error)),
    });
  }

  const formError =
    update.isError && Object.keys(errors).length === 0 ? errorMessage(update.error) : null;

  return (
    <EditorForm onSubmit={save}>
      <EditorSection
        title="Voice"
        description="How the brand sounds: personality, vocabulary, the dos and the don'ts. Every agent reads this before it writes a word."
      >
        <Textarea
          label="Brand voice"
          value={draft.brandVoice}
          onChange={(event) => set("brandVoice", event.target.value)}
          rows={12}
          maxLength={10_000}
          showCount
          readOnly={readOnly}
          placeholder={
            "Warm, confident, rooted in Gulf coffee culture.\nShort sentences. Arabic phrases welcome, never forced.\nNever salesy; never 'cheap'."
          }
          error={errors.brandVoice}
        />
      </EditorSection>

      <EditorSection
        title="Profile"
        description="How the client appears across ENMO OS, and when its posts go out."
      >
        <div className="grid gap-6 sm:grid-cols-2">
          <Input
            label="Name"
            value={draft.name}
            onChange={(event) => set("name", event.target.value)}
            maxLength={120}
            readOnly={readOnly}
            error={errors.name}
          />
          <Input
            label="Slug"
            value={draft.slug}
            onChange={(event) => set("slug", event.target.value.toLowerCase())}
            maxLength={48}
            readOnly={readOnly}
            inputClassName="font-mono text-[13px]"
            hint="Lowercase letters, digits and hyphens; used in asset paths."
            error={errors.slug}
          />
        </div>
        <TimeZoneSelect
          value={draft.timezone}
          onChange={(zone) => set("timezone", zone)}
          disabled={readOnly}
          error={errors.timezone}
        />
        <PlatformPicker
          value={draft.enabledPlatforms}
          onChange={(platforms) => set("enabledPlatforms", platforms)}
          disabled={readOnly}
          error={errors.enabledPlatforms}
        />
      </EditorSection>

      <SaveBar
        dirty={dirty}
        saving={update.isPending}
        error={formError}
        saveLabel="Save brand voice"
        onDiscard={() => {
          setDraft(saved);
          setErrors({});
        }}
        readOnlyReason={readOnlyReason}
      />
    </EditorForm>
  );
}
