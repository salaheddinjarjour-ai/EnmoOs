import { BudgetExceeded } from "@enmo/agents";
import type { AlertPayload, ApproveAllResponse, PostDto } from "@enmo/shared";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { blockTaskOnBudget } from "../../src/orchestrator/escalation";
import { buildTestApp, type TestApp } from "../helpers/app";
import { testDb } from "../helpers/db";
import { createClient } from "../helpers/factories";
import {
  createTeam,
  obliterateQueues,
  seedCampaign,
  seedPipeline,
  seedPlan,
  sender,
  testBrief,
  testCopy,
  testPlan,
  type Team,
} from "../helpers/route-fixtures";

/*
 * Writers racing on one post, round, plan or budget: a copy edit against a decision, an
 * approve-all or an archive, two decisions on one round, two clicks on one plan, tasks hitting the
 * token cap together. Whatever the interleaving, each request either wins or gets a 409, never a
 * 5xx (a lock-order deadlock would surface as one), and the rows stay consistent: one decision
 * per step, one set of posts per plan, no edit stored where an agent will overwrite it, one
 * budget alert.
 */

let t: TestApp;
let team: Team;
const send = sender(() => t.app);

/** Each race is run this many times: a deadlock needs an unlucky interleaving to show. */
const RUNS = 6;

beforeAll(async () => {
  t = await buildTestApp();
});

afterAll(async () => {
  await obliterateQueues(t.deps);
  await t.close();
});

beforeEach(async () => {
  team = await createTeam();
});

function expectWinOrConflict(response: LightMyRequestResponse, label: string) {
  expect([200, 409], `${label}: ${response.statusCode} ${response.body}`).toContain(
    response.statusCode,
  );
}

async function onePendingPost() {
  const client = await createClient();
  const { posts, requests } = await seedPipeline({ createdBy: team.manager, client, postCount: 1 });
  const post = posts[0];
  const request = requests[0];
  if (!post || !request) throw new Error("seedPipeline: no post");
  return { post, request };
}

/** The post's rounds, oldest first, as [round, status]. */
async function rounds(postId: string) {
  const rows = await testDb().approvalRequest.findMany({
    where: { postId },
    orderBy: { round: "asc" },
  });
  return rows.map((row) => [row.round, row.status]);
}

describe("a copy edit racing an approval", () => {
  it("against a decision: one wins, the other sees it; never a 5xx", async () => {
    for (let run = 0; run < RUNS; run++) {
      const { post, request } = await onePendingPost();
      const [edit, decision] = await Promise.all([
        send("PATCH", `/v1/posts/${post.id}/copy`, team.cookies.editor, {
          copy: testCopy(`Edited in run ${run}`),
        }),
        send("POST", `/v1/approvals/${request.id}/decision`, team.cookies.manager, {
          decision: "APPROVE",
        }),
      ]);
      expect(edit.statusCode, `edit: ${edit.body}`).toBe(200);
      expectWinOrConflict(decision, "decision");

      // The edit always lands: it either replaced the pending round or reopened the approval.
      const stored = await testDb().post.findUniqueOrThrow({ where: { id: post.id } });
      expect(stored).toMatchObject({ status: "PENDING_APPROVAL", humanEditCount: 1 });
      expect(await rounds(post.id)).toEqual([
        [1, "CANCELLED"],
        [2, "PENDING"],
      ]);
      expect(edit.json<PostDto>().currentApproval).toMatchObject({ round: 2, status: "PENDING" });
    }
  });

  it("against a change request: exactly one wins, and a lost edit is never stored", async () => {
    for (let run = 0; run < RUNS; run++) {
      const { post, request } = await onePendingPost();
      const edited = testCopy(`Edited in run ${run}`);
      const [edit, decision] = await Promise.all([
        send("PATCH", `/v1/posts/${post.id}/copy`, team.cookies.editor, { copy: edited }),
        send("POST", `/v1/approvals/${request.id}/decision`, team.cookies.manager, {
          decision: "REQUEST_CHANGES",
          feedback: "Warmer, please.",
          target: "COPY",
        }),
      ]);
      expectWinOrConflict(edit, "edit");
      expectWinOrConflict(decision, "decision");
      expect(
        [edit.statusCode, decision.statusCode].sort(),
        `edit ${edit.body} / decision ${decision.body}`,
      ).toEqual([200, 409]);

      const round1 = await testDb().approvalRequest.findUniqueOrThrow({
        where: { id: request.id },
      });
      const stored = await testDb().post.findUniqueOrThrow({ where: { id: post.id } });
      if (decision.statusCode === 200) {
        // The change request won: the Copywriter owns the post now, and the edit wasn't stored.
        expect(round1.status).toBe("CHANGES_REQUESTED");
        expect(stored).toMatchObject({ status: "CHANGES_REQUESTED", humanEditCount: 0 });
        expect(stored.copy).toEqual(post.copy);
        expect(await rounds(post.id)).toEqual([[1, "CHANGES_REQUESTED"]]);
        expect(await testDb().approvalDecision.count({ where: { requestId: request.id } })).toBe(1);
      } else {
        // The edit won: it replaced the round the reviewer was deciding.
        expect(stored).toMatchObject({ status: "PENDING_APPROVAL", humanEditCount: 1 });
        expect(stored.copy).toEqual(edited);
        expect(await rounds(post.id)).toEqual([
          [1, "CANCELLED"],
          [2, "PENDING"],
        ]);
        expect(await testDb().approvalDecision.count({ where: { requestId: request.id } })).toBe(0);
      }
    }
  });

  it("against an archive: the edit lands before it (and its round is cancelled) or is refused", async () => {
    for (let run = 0; run < RUNS; run++) {
      const { post } = await onePendingPost();
      const [edit, archive] = await Promise.all([
        send("PATCH", `/v1/posts/${post.id}/copy`, team.cookies.editor, {
          copy: testCopy(`Edited in run ${run}`),
        }),
        send("POST", `/v1/campaigns/${post.campaignId}/archive`, team.cookies.manager),
      ]);
      expectWinOrConflict(edit, "edit");
      expect(archive.statusCode, `archive: ${archive.body}`).toBe(200);
      // Whoever went first, nothing of the archived campaign is left waiting on a human.
      expect(
        await testDb().approvalRequest.count({ where: { postId: post.id, status: "PENDING" } }),
      ).toBe(0);
      const stored = await testDb().post.findUniqueOrThrow({ where: { id: post.id } });
      expect(stored.humanEditCount).toBe(edit.statusCode === 200 ? 1 : 0);
    }
  });

  it("against approve-all: never a 5xx, and the edit reopens what was approved", async () => {
    for (let run = 0; run < RUNS; run++) {
      const client = await createClient();
      const { posts, requests } = await seedPipeline({
        createdBy: team.manager,
        client,
        postCount: 3,
      });
      const edited = posts[1];
      if (!edited) throw new Error("seedPipeline: no post");
      const [edit, all] = await Promise.all([
        send("PATCH", `/v1/posts/${edited.id}/copy`, team.cookies.editor, {
          copy: testCopy(`Edited in run ${run}`),
        }),
        send("POST", "/v1/approvals/approve-all", team.cookies.manager, {
          requestIds: requests.map((request) => request.id),
        }),
      ]);
      expect(edit.statusCode, `edit: ${edit.body}`).toBe(200);
      expect(all.statusCode, `approve-all: ${all.body}`).toBe(200);
      expect(all.json<ApproveAllResponse>().approvedCount).toBeGreaterThanOrEqual(2);
      expect(await rounds(edited.id)).toEqual([
        [1, "CANCELLED"],
        [2, "PENDING"],
      ]);
      const statuses = await testDb().post.findMany({
        where: { id: { in: posts.map((post) => post.id) } },
        select: { id: true, status: true },
      });
      for (const row of statuses) {
        expect(row.status).toBe(row.id === edited.id ? "PENDING_APPROVAL" : "APPROVED");
      }
    }
  });
});

describe("two decisions on one round", () => {
  it("a decision and an approve-all: one decision is recorded, the other is told", async () => {
    for (let run = 0; run < RUNS; run++) {
      const { post, request } = await onePendingPost();
      const [decision, all] = await Promise.all([
        send("POST", `/v1/approvals/${request.id}/decision`, team.cookies.manager, {
          decision: "APPROVE",
        }),
        send("POST", "/v1/approvals/approve-all", team.cookies.admin, {
          requestIds: [request.id],
        }),
      ]);
      expectWinOrConflict(decision, "decision");
      expect(all.statusCode, `approve-all: ${all.body}`).toBe(200);
      const viaAll = all.json<ApproveAllResponse>().approvedCount;
      expect(viaAll + (decision.statusCode === 200 ? 1 : 0)).toBe(1);
      expect(await testDb().approvalDecision.count({ where: { requestId: request.id } })).toBe(1);
      expect(await testDb().post.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({
        status: "APPROVED",
      });
    }
  });

  it("two reviewers approving at once: one decision, the other gets a conflict", async () => {
    for (let run = 0; run < RUNS; run++) {
      const { request } = await onePendingPost();
      const url = `/v1/approvals/${request.id}/decision`;
      const responses = await Promise.all([
        send("POST", url, team.cookies.manager, { decision: "APPROVE" }),
        send("POST", url, team.cookies.admin, { decision: "APPROVE" }),
      ]);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      expect(await testDb().approvalDecision.count({ where: { requestId: request.id } })).toBe(1);
    }
  });
});

describe("two clicks on one plan", () => {
  it("approves it once: one set of posts, the other click is a conflict", async () => {
    for (let run = 0; run < RUNS; run++) {
      const client = await createClient();
      const seeded = await seedCampaign({
        createdBy: team.editor,
        client,
        brief: testBrief(client),
      });
      const graph = await seedPlan({ campaign: seeded.campaign, plan: testPlan(3) });
      const url = `/v1/task-graphs/${graph.id}/approve`;
      const responses = await Promise.all([
        send("POST", url, team.cookies.admin),
        send("POST", url, team.cookies.manager),
      ]);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      expect(await testDb().post.count({ where: { campaignId: seeded.campaign.id } })).toBe(3);
      expect(await testDb().agentTask.count({ where: { graphId: graph.id } })).toBe(6);
    }
  });
});

describe("tasks hitting the token cap together", () => {
  async function budgetAlerts(): Promise<number> {
    const rows = await testDb().realtimeEvent.findMany({ where: { type: "alert" } });
    return rows.filter((row) => (row.payload as AlertPayload).kind === "budget").length;
  }

  it("send exactly one budget alert between them", async () => {
    const exceeded = new BudgetExceeded({ day: "2027-02-10", used: 2, cap: 1 });
    for (let run = 0; run < RUNS; run++) {
      const client = await createClient();
      const { tasks } = await seedPipeline({ createdBy: team.manager, client, postCount: 3 });
      const ids = tasks.map((task) => task.id);
      await testDb().agentTask.updateMany({
        where: { id: { in: ids } },
        data: { status: "RUNNING" },
      });
      const before = await budgetAlerts();

      const blocked = await Promise.all(ids.map((id) => blockTaskOnBudget(t.deps, id, exceeded)));
      expect(blocked).toEqual(ids.map(() => true));
      expect(await testDb().agentTask.count({ where: { status: "BLOCKED_BUDGET" } })).toBe(
        ids.length,
      );
      expect((await budgetAlerts()) - before, `run ${run}`).toBe(1);

      // What the sweeper does once the day rolls over, so the next run starts unblocked.
      await testDb().agentTask.updateMany({
        where: { status: "BLOCKED_BUDGET" },
        data: { status: "QUEUED" },
      });
    }
  });
});
