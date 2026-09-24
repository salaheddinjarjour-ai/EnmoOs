import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import {
  CLOUDFLARE_IP_RANGES,
  clientIpGetter,
  clientIpPolicy,
  ipRateLimitKey,
  isCloudflareEdge,
  isTrustedProxyEntry,
  resolveClientIp,
  type TrustProxySetting,
} from "./trusted-proxies";

/** A bare app wired the way app.ts wires the real one, echoing request.clientIp. */
function echoApp(setting: TrustProxySetting) {
  const policy = clientIpPolicy(setting);
  const app = Fastify({ trustProxy: policy.trustProxy });
  app.decorateRequest("clientIp", { getter: clientIpGetter(policy) });
  app.get("/ip", (request) => ({ ip: request.clientIp }));
  return app;
}

// What production sets (render.yaml).
const production = echoApp(["loopback", "uniquelocal", "cloudflare"]);
const withoutCloudflare = echoApp(["loopback", "uniquelocal"]);

afterAll(async () => {
  await production.close();
  await withoutCloudflare.close();
});

const RENDER_PEER = "10.201.4.7";
const RENDER_HOP = "10.192.163.192";
const CF_EDGE = "172.71.150.145";
/** Where Cloudflare Workers' fetch() to another zone comes from (and its CF-Connecting-IP). */
const WORKER_EGRESS = "2a06:98c0:3600::103";
const VISITOR = "203.0.113.7";

/** request.clientIp for a request from `peer` with these forwarding headers. */
async function clientIp(
  app: ReturnType<typeof echoApp>,
  peer: string,
  forwardedFor: string,
  cfConnectingIp?: string,
): Promise<string> {
  const response = await app.inject({
    url: "/ip",
    remoteAddress: peer,
    headers: {
      "x-forwarded-for": forwardedFor,
      ...(cfConnectingIp === undefined ? {} : { "cf-connecting-ip": cfConnectingIp }),
    },
  });
  return response.json<{ ip: string }>().ip;
}

describe("isTrustedProxyEntry", () => {
  it.each([
    "loopback",
    "linklocal",
    "uniquelocal",
    "cloudflare",
    "10.0.0.1",
    "10.0.0.0/8",
    "::1",
    "2606:4700::/32",
  ])("accepts %s", (entry) => {
    expect(isTrustedProxyEntry(entry)).toBe(true);
  });

  it.each(["", "cloud", "10.0.0.0/33", "::/129", "10.0.0.0/8/1", "1.2.3", "10.0.0.0/x"])(
    "rejects %j",
    (entry) => {
      expect(isTrustedProxyEntry(entry)).toBe(false);
    },
  );
});

describe("clientIpPolicy", () => {
  it("never hands Cloudflare's ranges to proxy-addr as X-Forwarded-For proxies", () => {
    const policy = clientIpPolicy(["loopback", "cloudflare", "10.0.0.0/8", "loopback"]);
    expect(policy).toEqual({ trustProxy: ["loopback", "10.0.0.0/8"], cloudflare: true });
    expect(clientIpPolicy(["cloudflare"])).toEqual({ trustProxy: false, cloudflare: true });
  });

  it("keeps booleans and turns a hop count into a nearest-N-hops function", () => {
    expect(clientIpPolicy(false)).toEqual({ trustProxy: false, cloudflare: false });
    expect(clientIpPolicy(true)).toEqual({ trustProxy: true, cloudflare: false });
    const { trustProxy, cloudflare } = clientIpPolicy(2);
    expect(cloudflare).toBe(false);
    if (typeof trustProxy !== "function") throw new Error("expected a trust function");
    expect([0, 1, 2].map((hop) => trustProxy("198.51.100.1", hop))).toEqual([true, true, false]);
  });
});

describe("isCloudflareEdge", () => {
  it("matches the published ranges, IPv4-mapped addresses and the Workers egress", () => {
    expect(CLOUDFLARE_IP_RANGES).toHaveLength(22);
    for (const address of [CF_EDGE, `::ffff:${CF_EDGE}`, WORKER_EGRESS, "2a06:98c1:3120::1"]) {
      expect(isCloudflareEdge(address), address).toBe(true);
    }
    for (const address of [VISITOR, RENDER_HOP, "::1", "not-an-ip", ""]) {
      expect(isCloudflareEdge(address), address).toBe(false);
    }
  });
});

describe("resolveClientIp", () => {
  it("believes CF-Connecting-IP only from a Cloudflare edge, and only when it is one address", () => {
    expect(resolveClientIp(CF_EDGE, VISITOR, true)).toBe(VISITOR);
    expect(resolveClientIp(CF_EDGE, ` ${VISITOR} `, true)).toBe(VISITOR);
    expect(resolveClientIp(CF_EDGE, VISITOR, false)).toBe(CF_EDGE);
    expect(resolveClientIp("198.51.100.20", VISITOR, true)).toBe("198.51.100.20");
    for (const header of [undefined, "", "unknown", `${VISITOR}, 6.6.6.6`, [VISITOR, VISITOR]]) {
      expect(resolveClientIp(CF_EDGE, header, true), JSON.stringify(header)).toBe(CF_EDGE);
    }
  });
});

describe("request.clientIp with the production TRUST_PROXY", () => {
  it("is the visitor Cloudflare saw, behind Render's Cloudflare edge and internal hop", async () => {
    expect(
      await clientIp(production, RENDER_PEER, `${VISITOR}, ${CF_EDGE}, ${RENDER_HOP}`, VISITOR),
    ).toBe(VISITOR);
  });

  it("is still the visitor when our own Cloudflare zone proxies the record as well", async () => {
    expect(
      await clientIp(
        production,
        RENDER_PEER,
        `${VISITOR}, 162.158.90.12, ${CF_EDGE}, ${RENDER_HOP}`,
        VISITOR,
      ),
    ).toBe(VISITOR);
  });

  it("can't be picked from a Cloudflare Worker: X-Forwarded-For left of the edge is ignored", async () => {
    // A Worker on someone else's account sets X-Forwarded-For and fetches the API; Cloudflare
    // appends the Worker's egress address and overwrites CF-Connecting-IP with it.
    for (const forwardedFor of [
      `6.6.6.6, ${WORKER_EGRESS}, ${CF_EDGE}, ${RENDER_HOP}`,
      `6.6.6.6, ${WORKER_EGRESS}, ${RENDER_HOP}`,
      `6.6.6.6, ${WORKER_EGRESS}`,
    ]) {
      expect(await clientIp(production, RENDER_PEER, forwardedFor, WORKER_EGRESS)).toBe(
        WORKER_EGRESS,
      );
      // Even without CF-Connecting-IP the left-most entry never wins: the edge is the client.
      const edge = forwardedFor.split(", ").findLast((hop) => hop !== RENDER_HOP);
      expect(await clientIp(production, RENDER_PEER, forwardedFor)).toBe(edge);
    }
  });

  it("ignores CF-Connecting-IP from a client that didn't come through Cloudflare", async () => {
    expect(
      await clientIp(production, RENDER_PEER, `6.6.6.6, 198.51.100.20, ${RENDER_HOP}`, "6.6.6.6"),
    ).toBe("198.51.100.20");
    expect(await clientIp(production, "198.51.100.20", VISITOR, "6.6.6.6")).toBe("198.51.100.20");
  });

  it("ignores whatever the client wrote left of the address Cloudflare saw", async () => {
    expect(
      await clientIp(
        production,
        RENDER_PEER,
        `6.6.6.6, 104.16.0.1, ${VISITOR}, ${CF_EDGE}, ${RENDER_HOP}`,
        VISITOR,
      ),
    ).toBe(VISITOR);
  });

  it("without `cloudflare`, never reads CF-Connecting-IP", async () => {
    expect(
      await clientIp(
        withoutCloudflare,
        RENDER_PEER,
        `${VISITOR}, ${CF_EDGE}, ${RENDER_HOP}`,
        VISITOR,
      ),
    ).toBe(CF_EDGE);
  });
});

describe("ipRateLimitKey", () => {
  it("keeps IPv4, folds IPv4-mapped IPv6 into IPv4 and groups IPv6 by /64", () => {
    expect(ipRateLimitKey(VISITOR)).toBe(VISITOR);
    expect(ipRateLimitKey("::ffff:203.0.113.7")).toBe(VISITOR);
    expect(ipRateLimitKey("::ffff:cb00:7107")).toBe(VISITOR);
    expect(ipRateLimitKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(ipRateLimitKey("2001:DB8:1:2:bbbb:cccc:dddd:eeee")).toBe("2001:db8:1:2::/64");
    expect(ipRateLimitKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipRateLimitKey(WORKER_EGRESS)).toBe("2a06:98c0:3600:0::/64");
    expect(ipRateLimitKey("::1")).toBe("0:0:0:0::/64");
    expect(ipRateLimitKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(ipRateLimitKey("64:ff9b::192.0.2.33")).toBe("64:ff9b:0:0::/64");
  });
});
