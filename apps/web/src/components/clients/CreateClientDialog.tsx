"use client";

import {
  BANNED_WORDS_MAX,
  CreateClientRequest,
  Platform,
  slugify,
  type ClientDto,
  type CreateClientInput,
} from "@enmo/shared";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { ChipInput } from "@/components/ui/ChipInput";
import { Dialog, DialogActions } from "@/components/ui/Dialog";
import { FormAlert } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { useCreateClient } from "@/hooks/useClients";
import { errorMessage, fieldErrors } from "@/lib/api";
import { PlatformPicker } from "./platforms";
import { TimeZoneSelect } from "./TimeZoneSelect";

/*
 * "New client": the essentials to start briefing. Visual style and the approval chain start from
 * the shared defaults (CreateClientRequest) and are refined on the client page.
 */

export function CreateClientDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (client: ClientDto) => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New client"
      description="A brand for the Arsenal to speak for. Visual style and the approval chain start from sensible defaults."
      size="lg"
    >
      <CreateClientForm onCancel={onClose} onCreated={onCreated} />
    </Dialog>
  );
}

const FRIENDLY_ERRORS: Readonly<Record<string, string>> = {
  name: "Give the client a name",
  enabledPlatforms: "Pick at least one platform",
};

function CreateClientForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (client: ClientDto) => void;
}) {
  const create = useCreateClient();
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [enabledPlatforms, setEnabledPlatforms] = useState<Platform[]>(() => [...Platform.options]);
  const [brandVoice, setBrandVoice] = useState("");
  const [bannedWords, setBannedWords] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input: CreateClientInput = { name, timezone, enabledPlatforms, brandVoice, bannedWords };
    const parsed = CreateClientRequest.safeParse(input);
    if (!parsed.success) {
      const issues = fieldErrors(parsed.error);
      setErrors(
        Object.fromEntries(
          Object.entries(issues).map(([path, message]) => [path, FRIENDLY_ERRORS[path] ?? message]),
        ),
      );
      return;
    }
    setErrors({});
    // The API applies the defaults (style, chain); send what the user chose.
    create.mutate(input, {
      onSuccess: onCreated,
      onError: (error) => setErrors(fieldErrors(error)),
    });
  }

  const slug = name.trim() ? slugify(name) : null;

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-6">
      <div className="grid gap-6 sm:grid-cols-2">
        <Input
          label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoFocus
          maxLength={120}
          placeholder="Qahwa Co"
          hint={
            slug ? (
              <span className="font-mono">/{slug}</span>
            ) : (
              "Shown across the app and in every brief."
            )
          }
          error={errors.name}
          required
        />
        <TimeZoneSelect value={timezone} onChange={setTimezone} error={errors.timezone} />
      </div>
      <PlatformPicker
        value={enabledPlatforms}
        onChange={setEnabledPlatforms}
        error={errors.enabledPlatforms}
      />
      <Textarea
        label="Brand voice"
        value={brandVoice}
        onChange={(event) => setBrandVoice(event.target.value)}
        rows={4}
        maxLength={10_000}
        placeholder="Warm, confident and rooted in Gulf coffee culture. Short sentences. Never salesy."
        hint="Optional now. Every agent reads it before writing."
        error={errors.brandVoice}
      />
      <ChipInput
        label="Banned words"
        value={bannedWords}
        onChange={setBannedWords}
        max={BANNED_WORDS_MAX}
        maxLength={100}
        placeholder="Type a word or phrase, then Enter"
        hint="Captions containing any of these are blocked. Matching ignores case."
        error={errors.bannedWords}
      />
      {create.isError && Object.keys(fieldErrors(create.error)).length === 0 ? (
        <FormAlert>{errorMessage(create.error)}</FormAlert>
      ) : null}
      <DialogActions>
        <Button variant="ghost" onClick={onCancel} disabled={create.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={create.isPending}>
          Create client
        </Button>
      </DialogActions>
    </form>
  );
}
