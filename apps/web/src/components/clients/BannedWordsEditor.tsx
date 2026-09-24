"use client";

import { BANNED_WORDS_MAX, type ClientDto } from "@enmo/shared";
import { useState } from "react";
import { ChipInput } from "@/components/ui/ChipInput";
import { useToast } from "@/components/ui/Toast";
import { useUpdateClient } from "@/hooks/useClients";
import { errorMessage } from "@/lib/api";
import { EditorForm, EditorSection, SaveBar } from "./EditorFrame";

/** Banned words tab: a chip editor over Client.bannedWords, saved with PATCH. */
export function BannedWordsEditor({
  client,
  readOnlyReason,
}: {
  client: ClientDto;
  readOnlyReason: string | null;
}) {
  const toast = useToast();
  const update = useUpdateClient(client.id);
  const [saved, setSaved] = useState<string[]>(() => [...client.bannedWords]);
  const [words, setWords] = useState<string[]>(saved);

  const dirty = words.join("\u0000") !== saved.join("\u0000");

  function save() {
    update.mutate(
      { bannedWords: words },
      {
        onSuccess: (next) => {
          setSaved(next.bannedWords);
          setWords(next.bannedWords);
          toast.success(
            "Banned words saved",
            `${next.bannedWords.length} on the list for ${next.name}.`,
          );
        },
      },
    );
  }

  return (
    <EditorForm onSubmit={save}>
      <EditorSection
        title="Never say"
        description={
          <>
            The Copywriter steers clear of these, QA flags any draft that slips, and publishing
            refuses a caption that contains one. Matching ignores case; phrases work too.
          </>
        }
      >
        <ChipInput
          label="Banned words"
          value={words}
          onChange={setWords}
          disabled={readOnlyReason !== null}
          max={BANNED_WORDS_MAX}
          maxLength={100}
          placeholder="Type a word or phrase, then Enter (paste a comma-separated list to add many)"
        />
      </EditorSection>
      <SaveBar
        dirty={dirty}
        saving={update.isPending}
        error={update.isError ? errorMessage(update.error) : null}
        saveLabel="Save banned words"
        onDiscard={() => setWords(saved)}
        readOnlyReason={readOnlyReason}
      />
    </EditorForm>
  );
}
