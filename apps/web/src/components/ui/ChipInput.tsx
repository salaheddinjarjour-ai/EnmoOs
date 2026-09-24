"use client";

import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { cx } from "./cx";
import { FieldShell, useFieldIds, type FieldProps } from "./Field";

/*
 * Tag-style list editor (banned words, mood keywords, "never show" items). Enter or a comma adds
 * the typed entry, pasting a comma/newline separated list adds them all, Backspace on an empty
 * input removes the last chip. Entries are trimmed and de-duplicated case-insensitively, matching
 * how the shared BannedWords schema normalises them.
 */

export interface ChipInputProps extends FieldProps {
  value: readonly string[];
  onChange: (next: string[]) => void;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Most entries allowed. */
  max?: number;
  /** Longest entry allowed, in characters. */
  maxLength?: number;
}

const entryKey = (entry: string) => entry.normalize("NFKC").toLocaleLowerCase();

/** Adds the entries in `raw` to `current`; returns the new list and a note about skipped ones. */
export function addEntries(
  current: readonly string[],
  raw: string,
  limits: { max?: number; maxLength?: number },
): { next: string[]; note: string | null } {
  const seen = new Set(current.map(entryKey));
  const next = [...current];
  let duplicates = 0;
  let tooLong = 0;
  let overflow = 0;

  for (const candidate of raw.split(/[,\n]/)) {
    const entry = candidate.trim();
    if (!entry) continue;
    if (limits.maxLength !== undefined && entry.length > limits.maxLength) {
      tooLong += 1;
      continue;
    }
    const key = entryKey(entry);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    if (limits.max !== undefined && next.length >= limits.max) {
      overflow += 1;
      continue;
    }
    seen.add(key);
    next.push(entry);
  }

  const notes = [
    duplicates ? `${duplicates === 1 ? "Already listed" : `${duplicates} already listed`}` : null,
    tooLong ? `${tooLong} longer than ${limits.maxLength} characters` : null,
    overflow ? `Limit of ${limits.max} reached` : null,
  ].filter(Boolean);
  return { next, note: notes.length ? notes.join(" · ") : null };
}

export function ChipInput({
  label,
  labelHidden,
  hint,
  error,
  className,
  value,
  onChange,
  id,
  placeholder,
  disabled = false,
  max,
  maxLength,
}: ChipInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const { controlId, describedBy, invalid } = useFieldIds(id, { hint, error: error ?? note });

  function commit(raw: string) {
    const result = addEntries(value, raw, { max, maxLength });
    setNote(result.note);
    if (result.next.length !== value.length) onChange(result.next);
    setDraft("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      if (draft.trim()) commit(draft);
    } else if (event.key === "Backspace" && draft === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  function onPaste(event: ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData("text");
    if (!/[,\n]/.test(text)) return;
    event.preventDefault();
    commit(`${draft}${text}`);
  }

  const counter =
    max !== undefined ? (
      <span className="font-mono text-[11px] text-steel/70 tabular-nums">
        {value.length} / {max}
      </span>
    ) : null;

  return (
    <FieldShell
      controlId={controlId}
      label={label}
      labelHidden={labelHidden}
      hint={hint}
      error={error ?? note}
      aside={counter}
      className={className}
    >
      <div
        onClick={() => inputRef.current?.focus()}
        className={cx(
          "flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-md border bg-void/60 px-2 py-1.5 transition duration-200 ease-enmo focus-within:border-paper/40 focus-within:bg-void",
          invalid ? "border-red-400/50" : "border-line",
          disabled ? "cursor-not-allowed opacity-60" : "cursor-text hover:border-paper/15",
        )}
      >
        {value.map((entry) => (
          <span
            key={entry}
            className="inline-flex h-7 max-w-full items-center gap-1 rounded-full border border-line bg-paper/[0.05] pr-1 pl-2.5 text-xs text-paper transition-colors duration-200"
          >
            <span className="truncate">{entry}</span>
            {disabled ? null : (
              <button
                type="button"
                aria-label={`Remove ${entry}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onChange(value.filter((item) => item !== entry));
                }}
                className="rounded-full p-1 text-steel transition-colors duration-200 hover:bg-paper/10 hover:text-paper"
              >
                <svg
                  aria-hidden
                  viewBox="0 0 16 16"
                  className="size-2.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                >
                  <path d="m4 4 8 8M12 4l-8 8" />
                </svg>
              </button>
            )}
          </span>
        ))}
        <input
          ref={inputRef}
          id={controlId}
          value={draft}
          disabled={disabled}
          onChange={(event) => {
            setDraft(event.target.value);
            if (note) setNote(null);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => {
            if (draft.trim()) commit(draft);
          }}
          placeholder={value.length === 0 ? (disabled ? "None" : placeholder) : undefined}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          enterKeyHint="enter"
          autoComplete="off"
          className={cx(
            "h-7 flex-1 bg-transparent px-1.5 text-sm text-paper placeholder:text-steel/50 focus:outline-none disabled:cursor-not-allowed",
            disabled && value.length > 0 ? "sr-only" : "min-w-36",
          )}
        />
      </div>
    </FieldShell>
  );
}
