"use client";

import { CHAT_MESSAGE_MAX_LENGTH } from "@enmo/shared";
import { useId, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { cx } from "@/components/ui/cx";
import { FieldError } from "@/components/ui/Field";

/*
 * The Claude-style input shared by the thread composer, the clarify reply and the new-brief form:
 * Enter sends, Shift+Enter breaks the line, and the text is sent exactly as typed (the API trims
 * brief turns itself; plan feedback must stay verbatim).
 */

export interface MessageFieldProps {
  label: string;
  /** Keep the label for assistive tech only. */
  labelHidden?: boolean;
  placeholder?: string;
  submitLabel: string;
  disabled?: boolean;
  pending?: boolean;
  error?: string | null;
  /** Extra controls on the left of the send row (e.g. a client picker). */
  toolbar?: ReactNode;
  /** Resolves true when the text was accepted, which clears the field. */
  onSubmit: (text: string) => Promise<boolean>;
  rows?: number;
  autoFocus?: boolean;
  className?: string;
}

export function MessageField({
  label,
  labelHidden = false,
  placeholder,
  submitLabel,
  disabled = false,
  pending = false,
  error,
  toolbar,
  onSubmit,
  rows = 2,
  autoFocus,
  className,
}: MessageFieldProps) {
  const id = useId();
  const [text, setText] = useState("");
  const blank = text.trim().length === 0;

  async function send() {
    if (blank || disabled || pending) return;
    if (await onSubmit(text)) setText("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  }

  function onFormSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send();
  }

  return (
    <form
      onSubmit={onFormSubmit}
      className={cx(
        // Opaque even when disabled: the thread scrolls under the pinned composer.
        "flex flex-col gap-2 rounded-2xl border border-line bg-panel p-3 transition duration-200 ease-enmo focus-within:border-paper/30",
        className,
      )}
    >
      <label
        htmlFor={id}
        className={labelHidden ? "sr-only" : "px-1 text-xs font-medium text-steel"}
      >
        {label}
      </label>
      <textarea
        id={id}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        rows={rows}
        maxLength={CHAT_MESSAGE_MAX_LENGTH}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : `${id}-hint`}
        className="field-sizing-content max-h-72 min-h-12 w-full resize-none bg-transparent px-1 text-[15px] leading-relaxed text-paper placeholder:text-steel/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:text-steel disabled:placeholder:text-steel/60"
      />
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
          {toolbar}
          <span
            id={`${id}-hint`}
            className="font-mono text-[10px] tracking-[0.12em] text-steel/70 uppercase"
          >
            Enter to send · Shift+Enter for a new line
          </span>
        </div>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          loading={pending}
          disabled={disabled || blank}
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
