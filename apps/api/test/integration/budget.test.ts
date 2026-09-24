import type { BudgetDto, Role } from "@enmo/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app";
import { sessionCookieFor, type CookieHeader } from "../helpers/auth";
import { testDb } from "../helpers/db";
import { createClient, createUser } from "../helpers/factories";
import { seedPipeline, sender } from "../helpers/route-fixtures";

/* GET /v1/budget (DESIGN §C "Runner" step 1, §E "system"): today's UTC spend against the cap. */

const CAP = 50_000;
const NOW = new Date("2027-02-10T15:30:00Z");

let t: TestApp;
const send = sender(() => t.app);

beforeAll(async () => {
  t = await buildTestApp({ env: { DAILY_TOKEN_CAP: String(CAP) } });
});

afterAll(async () => {
  await t.close();
});

beforeEach(() => {
  t.clock.set(NOW);
});

async function cookieFor(role: Role): Promise<CookieHeader> {
  return sessionCookieFor(await createUser({ role }), { now: t.clock.now() });
}

function usage(day: string, input: number, output: number) {
  return testDb().tokenUsage.create({
    data: {
      day: new Date(`${day}T00:00:00Z`),
      inputTokens: BigInt(input),
      outputTokens: BigInt(output),
      // Cache traffic never counts against the cap.
      cacheReadTokens: 999_999n,
      cacheWriteTokens: 999_999n,
      calls: 3,
    },
  });
}

describe("GET /v1/budget", () => {
  it("shows every role today's spend, the cap and when it resets", async () => {
    await usage("2027-02-10", 12_000, 3_000);
    await usage("2027-02-09", 40_000, 9_000);

    for (const role of ["ADMIN", "MANAGER", "EDITOR"] as const) {
      const response = await send("GET", "/v1/budget", await cookieFor(role));
      expect(response.statusCode, `${role}: ${response.body}`).toBe(200);
      expect(response.json<BudgetDto>()).toEqual({
        day: "2027-02-10",
        used: 15_000,
        cap: CAP,
        remaining: CAP - 15_000,
        blockedTasks: 0,
        resetsAt: "2027-02-11T00:00:00.000Z",
      });
    }
  });

  it("counts the tasks waiting for tomorrow and never goes below zero", async () => {
    await usage("2027-02-10", 45_000, 9_000);
    const manager = await createUser({ role: "MANAGER" });
    const { tasks } = await seedPipeline({ createdBy: manager, client: await createClient() });
    await testDb().agentTask.updateMany({
      where: { id: { in: tasks.slice(0, 2).map((task) => task.id) } },
      data: { status: "BLOCKED_BUDGET" },
    });

    const response = await send("GET", "/v1/budget", await cookieFor("EDITOR"));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<BudgetDto>()).toMatchObject({
      used: 54_000,
      remaining: 0,
      blockedTasks: 2,
    });
  });

  it("starts the new UTC day from zero", async () => {
    await usage("2027-02-10", 45_000, 9_000);
    t.clock.set("2027-02-11T00:00:01Z");
    const response = await send("GET", "/v1/budget", await cookieFor("EDITOR"));
    expect(response.json<BudgetDto>()).toMatchObject({
      day: "2027-02-11",
      used: 0,
      remaining: CAP,
      resetsAt: "2027-02-12T00:00:00.000Z",
    });
  });

  it("needs a session", async () => {
    const response = await send("GET", "/v1/budget");
    expect(response.statusCode).toBe(401);
  });
});
