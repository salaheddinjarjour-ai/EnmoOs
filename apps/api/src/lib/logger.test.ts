import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, redactUrl } from "./logger";

describe("redactUrl", () => {
  it.each([
    ["/v1/invites/SECRET-token", "/v1/invites/[redacted]"],
    ["/v1/invites/SECRET-token/accept", "/v1/invites/[redacted]/accept"],
    ["/v1/INVITES/SECRET-token", "/v1/INVITES/[redacted]"],
    ["/v1/invites", "/v1/invites"],
    ["/v1/invites/", "/v1/invites/"],
    ["/v1/clients/c1/social-accounts", "/v1/clients/c1/social-accounts"],
  ])("keeps the path but hides secret segments: %s", (url, expected) => {
    expect(redactUrl(url)).toBe(expected);
  });

  it("drops every query value and any fragment, keeping parameter names", () => {
    expect(redactUrl("/v1/oauth/meta/callback?code=AUTH-CODE&state=STATE#frag")).toBe(
      "/v1/oauth/meta/callback?code=[redacted]&state=[redacted]",
    );
    expect(redactUrl("/v1/posts?clientId=c1&allVersions")).toBe(
      "/v1/posts?clientId=[redacted]&allVersions",
    );
    expect(redactUrl("/v1/invites/SECRET?")).toBe("/v1/invites/[redacted]");
  });
});

describe("createLogger", () => {
  function capture() {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString("utf8"));
        done();
      },
    });
    return { lines, destination };
  }

  it("serializes `req` with a redacted URL and no headers", () => {
    const { lines, destination } = capture();
    const logger = createLogger({ level: "info", name: "test", destination });
    logger.info(
      {
        req: {
          method: "GET",
          url: "/v1/invites/SECRET-token?next=x",
          ip: "203.0.113.9",
          headers: { cookie: "enmo_session=abc" },
        },
      },
      "incoming request",
    );

    const output = lines.join("");
    expect(output).not.toContain("SECRET-token");
    expect(output).not.toContain("enmo_session");
    const entry = JSON.parse(output) as { req: Record<string, unknown> };
    expect(entry.req).toMatchObject({
      method: "GET",
      url: "/v1/invites/[redacted]?next=[redacted]",
      remoteAddress: "203.0.113.9",
    });
  });

  it("logs the client address, not the proxy hop in request.ip", () => {
    const { lines, destination } = capture();
    const logger = createLogger({ level: "info", name: "test", destination });
    logger.info(
      { req: { method: "GET", url: "/v1/auth/me", ip: "172.71.150.145", clientIp: "203.0.113.9" } },
      "incoming request",
    );

    const entry = JSON.parse(lines.join("")) as { req: Record<string, unknown> };
    expect(entry.req).toMatchObject({ remoteAddress: "203.0.113.9" });
  });
});
