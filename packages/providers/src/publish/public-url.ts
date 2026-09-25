import { isIP } from "node:net";

/*
 * Meta and TikTok pull media by URL, so a live publish can only hand them URLs they can reach:
 * https on a public host (DESIGN §D "Meta and TikTok need public URLs", which is why production
 * serves assets from R2). Local storage's http://localhost/files/... URLs only work in dry runs.
 */

/** Names that never resolve on the public internet (RFC 2606, RFC 6761, RFC 8375, common LAN suffixes). */
const PRIVATE_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "test",
  "example",
  "invalid",
  "home.arpa",
  "lan",
] as const;

function ipv4Octets(address: string): number[] {
  return address.split(".").map(Number);
}

function isPrivateIpv4(address: string): boolean {
  const [a = 0, b = 0] = ipv4Octets(address);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) return isPrivateIpv4(mapped[1]);
  // fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast.
  return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith("ff");
}

/** A URL hostname (IPv6 in brackets, as URL#hostname gives it) without the brackets. */
function bareHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

/** Whether `hostname` can be reached from the public internet (not loopback, LAN or reserved). */
export function isPublicHostname(hostname: string): boolean {
  const host = bareHost(hostname).replace(/\.$/, "");
  const ip = isIP(host);
  if (ip === 4) return !isPrivateIpv4(host);
  if (ip === 6) return !isPrivateIpv6(host);
  if (!host.includes(".")) return false;
  return !PRIVATE_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** An absolute https URL on a public host. */
export function isPublicHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && isPublicHostname(url.hostname);
}

/** Whether the URL points at this machine (localhost, 127.0.0.0/8, ::1). */
export function isLoopbackUrl(value: string): boolean {
  let host: string;
  try {
    host = bareHost(new URL(value).hostname);
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  return isIP(host) === 4 && host.startsWith("127.");
}
