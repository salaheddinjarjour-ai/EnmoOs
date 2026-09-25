import { timingSafeEqual } from "node:crypto";
import { BlockList, isIP } from "node:net";
import type { FastifyRequest } from "fastify";

/*
 * Who the client is (TRUST_PROXY). Two different kinds of hop sit in front of the API on Render,
 * and they get two different kinds of trust:
 *
 * - Our own infrastructure (Render's private 10.x hops, loopback, explicit addresses) is trusted by
 *   address for X-Forwarded-For: proxy-addr walks the header from the right, skips every trusted
 *   address and stops at the first one left. That is `request.ip`: the hop that handed the request
 *   to our infrastructure. A hop count would break as soon as the path changes length.
 *
 * - Cloudflare (`cloudflare` in TRUST_PROXY) is never trusted for X-Forwarded-For. Every
 *   Cloudflare customer can send requests from Cloudflare's addresses: a Worker's `fetch` leaves
 *   from 2a06:98c0::/29 carrying whatever X-Forwarded-For the script set, and Cloudflare only
 *   appends to it. Skipping Cloudflare ranges would therefore let anyone pick the left-most entry,
 *   i.e. their own IP. What Cloudflare does guarantee is CF-Connecting-IP: its edge overwrites the
 *   header with the address it saw (for a Worker on another zone, the Worker's egress address), so
 *   a client can't choose it. It is believed only when the hop in `request.ip` is a Cloudflare
 *   edge, since a client that reaches the API any other way could have written it.
 *
 * On Render a visitor arrives as `X-Forwarded-For: <visitor>, <Cloudflare edge>, <Render 10.x>`
 * with `CF-Connecting-IP: <visitor>`; `request.clientIp` is the visitor, and all traffic from other
 * Cloudflare customers' Workers shares the Workers egress address.
 */

/**
 * Cloudflare's published edge ranges (https://www.cloudflare.com/ips/, 15 IPv4 + 7 IPv6, current
 * as of 2026-09). Cloudflare announces changes well ahead; update this list when it does.
 */
export const CLOUDFLARE_IP_RANGES = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
] as const;

/** A Cloudflare edge in front: believe its CF-Connecting-IP, never its X-Forwarded-For. */
export const CLOUDFLARE = "cloudflare";

/** Names proxy-addr understands itself (uniquelocal covers 10/8, 172.16/12, 192.168/16, fc00::/7). */
const PROXY_ADDR_NAMES: ReadonlySet<string> = new Set(["loopback", "linklocal", "uniquelocal"]);

export const TRUSTED_PROXY_NAMES = [...PROXY_ADDR_NAMES, CLOUDFLARE];

/** An IP address, a CIDR range (address/prefix) or one of TRUSTED_PROXY_NAMES. */
export function isTrustedProxyEntry(entry: string): boolean {
  if (TRUSTED_PROXY_NAMES.includes(entry)) return true;
  const [address = "", prefix, ...rest] = entry.split("/");
  const version = isIP(address);
  if (version === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (version === 4 ? 32 : 128);
}

/** Parsed TRUST_PROXY: a hop count, true/false, or a list of addresses, ranges and names. */
export type TrustProxySetting = number | boolean | readonly string[];

export interface ClientIpPolicy {
  /** Fastify's `trustProxy`: the hops whose X-Forwarded-For entries decide `request.ip`. */
  readonly trustProxy: boolean | string[] | ((address: string, hop: number) => boolean);
  /** Whether CF-Connecting-IP is believed when `request.ip` is a Cloudflare edge. */
  readonly cloudflare: boolean;
}

/**
 * Splits TRUST_PROXY into the X-Forwarded-For trust Fastify applies and the Cloudflare rule
 * applied on top of it. Fastify 5.12 fails closed on a bare hop count (it cannot verify the
 * immediate peer), so a count becomes proxy-addr's classic "trust the nearest N hops" function,
 * which is only right while exactly N proxies sit in front.
 */
export function clientIpPolicy(setting: TrustProxySetting): ClientIpPolicy {
  if (typeof setting === "number") {
    return { trustProxy: (_address, hop) => hop < setting, cloudflare: false };
  }
  if (typeof setting === "boolean") return { trustProxy: setting, cloudflare: false };
  const proxies = [...new Set(setting.filter((entry) => entry !== CLOUDFLARE))];
  return {
    trustProxy: proxies.length > 0 ? proxies : false,
    cloudflare: setting.includes(CLOUDFLARE),
  };
}

const cloudflareEdges = new BlockList();
for (const range of CLOUDFLARE_IP_RANGES) {
  const [network = "", prefix = ""] = range.split("/");
  cloudflareEdges.addSubnet(network, Number(prefix), isIP(network) === 6 ? "ipv6" : "ipv4");
}

/** Whether the address is in Cloudflare's published ranges (IPv4-mapped IPv6 included). */
export function isCloudflareEdge(address: string): boolean {
  const version = isIP(address);
  if (version === 0) return false;
  return cloudflareEdges.check(address, version === 6 ? "ipv6" : "ipv4");
}

/**
 * The client's address. `peer` is `request.ip`, the nearest hop our own proxies vouch for. Only
 * when that hop is a Cloudflare edge (and TRUST_PROXY names `cloudflare`) is the header Cloudflare
 * wrote believed; a missing, repeated or malformed one leaves the edge itself as the client, which
 * fails closed (one shared rate-limit bucket) rather than open.
 */
export function resolveClientIp(
  peer: string,
  cfConnectingIp: string | string[] | undefined,
  cloudflare: boolean,
): string {
  if (!cloudflare || !isCloudflareEdge(peer)) return peer;
  const connecting = typeof cfConnectingIp === "string" ? cfConnectingIp.trim() : "";
  return isIP(connecting) === 0 ? peer : connecting;
}

/** Headers the web Worker's same-origin proxy (apps/web/src/edge/api-proxy.ts) sends. */
export const EDGE_CLIENT_IP_HEADER = "x-enmo-client-ip";
export const EDGE_AUTH_HEADER = "x-enmo-edge-auth";

function sameSecret(sent: string, expected: string): boolean {
  const a = Buffer.from(sent);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The visitor our own web Worker vouches for, or null. Every proxied request reaches the API from
 * Cloudflare's shared Workers egress address, so without this every visitor would share one
 * address (one login rate-limit bucket). The header counts only with the shared secret, so a
 * client that writes it itself is ignored; a malformed address is ignored too.
 */
export function edgeClientIp(
  headers: FastifyRequest["headers"],
  secret: string | undefined,
): string | null {
  if (!secret) return null;
  const auth = headers[EDGE_AUTH_HEADER];
  const address = headers[EDGE_CLIENT_IP_HEADER];
  if (typeof auth !== "string" || typeof address !== "string") return null;
  if (!sameSecret(auth, secret)) return null;
  const trimmed = address.trim();
  return isIP(trimmed) === 0 ? null : trimmed;
}

/** The `request.clientIp` getter app.ts decorates requests with. */
export function clientIpGetter({ cloudflare }: ClientIpPolicy, edgeSecret?: string) {
  return function clientIp(this: FastifyRequest): string {
    return (
      edgeClientIp(this.headers, edgeSecret) ??
      resolveClientIp(this.ip, this.headers["cf-connecting-ip"], cloudflare)
    );
  };
}

/** The eight hextets of a valid IPv6 address (zone dropped, dotted-quad tail folded in). */
function ipv6Hextets(address: string): number[] {
  let text = address.split("%", 1)[0] ?? "";
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  return groups.map((group) => Number.parseInt(group, 16));
}

/**
 * Rate-limit key for a client address. One IPv6 subscriber usually holds a whole /64, so IPv6 is
 * grouped by /64 (as @fastify/rate-limit's default does); IPv4-mapped IPv6 counts as its IPv4.
 */
export function ipRateLimitKey(address: string): string {
  if (isIP(address.split("%", 1)[0] ?? "") !== 6) return address.toLowerCase();
  const hextets = ipv6Hextets(address);
  const isMapped4 = hextets.slice(0, 5).every((group) => group === 0) && hextets[5] === 0xffff;
  if (isMapped4) {
    const [high = 0, low = 0] = hextets.slice(6);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  }
  return `${hextets
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}
