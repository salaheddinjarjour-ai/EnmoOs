/** Where signing in lands when there is no usable `next`. */
export const DEFAULT_LANDING = "/command";

/*
 * The URL parser silently drops ASCII tab, CR and LF, so "/\t/evil.com" parses as the
 * protocol-relative "//evil.com"; browsers read "\" as "/". Neither belongs in an app path, so any
 * control character, whitespace or backslash rejects the value outright.
 */
function hasUnsafeCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return /[\s\\]/.test(value);
}

/**
 * The same-origin path (with its query and hash) that `next` names, or the dashboard. The value is
 * resolved the way the router will resolve it and its origin compared, rather than trusting any
 * prefix check, so nothing it accepts can navigate off `origin`.
 */
export function safeNextPath(next: string | null | undefined, origin: string): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || hasUnsafeCharacter(next)) {
    return DEFAULT_LANDING;
  }
  try {
    const base = new URL(origin);
    const url = new URL(next, base);
    if (url.origin !== base.origin) return DEFAULT_LANDING;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return DEFAULT_LANDING;
  }
}
