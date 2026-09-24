"use client";

import { useEffect, useState } from "react";
import { Button, type ButtonVariant } from "./Button";
import { cx } from "./cx";
import { CONTROL_CLASS, FieldShell, useFieldIds } from "./Field";

/** A read-only value (e.g. an invite link) with a copy button. Selecting the field also works. */
export function CopyField({
  label,
  value,
  hint,
  buttonVariant = "secondary",
  className,
}: {
  label: string;
  value: string;
  hint?: string;
  buttonVariant?: ButtonVariant;
  className?: string;
}) {
  const { controlId, describedBy } = useFieldIds(undefined, { hint });
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2400);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      // Clipboard access can be denied (permissions, insecure context); the text stays selectable.
      setState("failed");
    }
  }

  return (
    <FieldShell controlId={controlId} label={label} hint={hint} className={className}>
      <div className="flex gap-2">
        <input
          id={controlId}
          readOnly
          value={value}
          aria-describedby={describedBy}
          onFocus={(event) => event.currentTarget.select()}
          className={cx(CONTROL_CLASS, "h-10 min-w-0 flex-1 px-3 font-mono text-xs")}
        />
        <Button variant={buttonVariant} onClick={() => void copy()} className="w-28">
          {state === "copied" ? "Copied" : state === "failed" ? "Select it" : "Copy link"}
        </Button>
      </div>
      <span aria-live="polite" className="sr-only">
        {state === "copied" ? "Link copied to the clipboard" : ""}
      </span>
    </FieldShell>
  );
}
