/** Joins class names, skipping falsy entries (conditional Tailwind classes). */
export function cx(...parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
