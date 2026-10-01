import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issueThreadInteractions, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { attentionRoutes } from "../routes/attention.js";
import { boardQuestionsService, boardQuestionText } from "../services/board-questions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres board questions tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const BOARD_USER = "board-user";

describe("boardQuestionText", () => {
  it("reads the question from each card kind", () => {
    expect(boardQuestionText("ask_user_questions", {
      questions: [{ prompt: "Which supplier?" }, { prompt: "Which day?" }],
    }, null)).toBe("Which supplier?\nWhich day?");
    expect(boardQuestionText("request_confirmation", { prompt: "Ship the price list?" }, null))
      .toBe("Ship the price list?");
    expect(boardQuestionText("suggest_tasks", { tasks: [{ title: "Call Metro" }] }, null))
      .toBe("1 suggested task: Call Metro");
    expect(boardQuestionText("connection_intent", { serviceName: "GitHub", requestingAgentName: "Dev" }, null))
      .toBe("Dev asks to connect GitHub.");
    expect(boardQuestionText("request_confirmation", {}, "Fallback summary")).toBe("Fallback summary");
    expect(boardQuestionText("request_confirmation", {}, null)).toBeNull();
  });
});

describeEmbeddedPostgres("board questions", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-board-questions-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(prefix = "BQ") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Co`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Reviewer",
      role: "qa",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId, prefix };
  }

  async function insertIssue(input: {
    companyId: string;
    identifier: string;
    title: string;
    status: string;
    executionState?: Record<string, unknown> | null;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.title,
      status: input.status,
      priority: "medium",
      originKind: "manual",
      originFingerprint: "default",
      executionState: input.executionState ?? null,
    });
    return id;
  }

  async function insertCard(input: {
    companyId: string;
    issueId: string;
    title: string;
    addresseeAgentId?: string | null;
    addresseeUserId?: string | null;
    status?: string;
  }) {
    const id = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id,
      companyId: input.companyId,
      issueId: input.issueId,
      kind: "ask_user_questions",
      status: input.status ?? "pending",
      continuationPolicy: "wake_assignee",
      title: input.title,
      addresseeAgentId: input.addresseeAgentId ?? null,
      addresseeUserId: input.addresseeUserId ?? null,
      payload: { version: 1, questions: [{ id: "q1", prompt: `${input.title}?`, selectionMode: "single", options: [] }] },
    });
    return id;
  }

  function approvalStage(participant: Record<string, unknown>, instructions: string | null = null) {
    return {
      status: "pending",
      currentStageId: randomUUID(),
      currentStageIndex: 0,
      currentStageType: "approval",
      currentParticipant: participant,
      returnAssignee: null,
      reviewRequest: instructions ? { instructions } : null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
      monitor: null,
    };
  }

  it("lists board cards on open issues and board approval stages, and nothing else", async () => {
    const { companyId, agentId, prefix } = await seedCompany();
    const openIssue = await insertIssue({ companyId, identifier: "BQ-1", title: "Open task", status: "in_progress" });
    const cancelledIssue = await insertIssue({ companyId, identifier: "BQ-2", title: "Dropped", status: "cancelled" });
    const doneIssue = await insertIssue({ companyId, identifier: "BQ-3", title: "Finished", status: "done" });
    const approvalIssue = await insertIssue({
      companyId,
      identifier: "BQ-4",
      title: "Needs sign-off",
      status: "in_review",
      executionState: approvalStage({ type: "user", userId: BOARD_USER }, "Check the totals"),
    });
    await insertIssue({
      companyId,
      identifier: "BQ-5",
      title: "Agent review stage",
      status: "in_review",
      executionState: approvalStage({ type: "agent", agentId }),
    });
    await insertIssue({
      companyId,
      identifier: "BQ-6",
      title: "Someone else's sign-off",
      status: "in_review",
      executionState: approvalStage({ type: "user", userId: "other-user" }),
    });

    const boardCardId = await insertCard({ companyId, issueId: openIssue, title: "Board question" });
    await insertCard({ companyId, issueId: openIssue, title: "Mine by name", addresseeUserId: BOARD_USER });
    await insertCard({ companyId, issueId: openIssue, title: "For another user", addresseeUserId: "other-user" });
    await insertCard({ companyId, issueId: openIssue, title: "For the agent", addresseeAgentId: agentId });
    await insertCard({ companyId, issueId: openIssue, title: "Already answered", status: "answered" });
    await insertCard({ companyId, issueId: cancelledIssue, title: "On cancelled issue" });
    await insertCard({ companyId, issueId: doneIssue, title: "On done issue" });

    const other = await seedCompany("OQ");
    const otherIssue = await insertIssue({ companyId: other.companyId, identifier: "OQ-1", title: "Other co", status: "todo" });
    await insertCard({ companyId: other.companyId, issueId: otherIssue, title: "Other company question" });

    const result = await boardQuestionsService(db).list(companyId, BOARD_USER);
    const titles = result.items.map((item) => item.title);

    expect(titles).toEqual(expect.arrayContaining(["Board question", "Mine by name", "Approval requested"]));
    expect(titles).not.toContain("For another user");
    expect(titles).not.toContain("For the agent");
    expect(titles).not.toContain("Already answered");
    expect(titles).not.toContain("On cancelled issue");
    expect(titles).not.toContain("On done issue");
    expect(titles).not.toContain("Other company question");
    expect(result.count).toBe(3);

    const boardCard = result.items.find((item) => item.interactionId === boardCardId);
    expect(boardCard).toMatchObject({
      kind: "interaction",
      issueIdentifier: "BQ-1",
      question: "Board question?",
      href: `/${prefix}/issues/BQ-1#interaction-${boardCardId}`,
    });
    const approval = result.items.find((item) => item.kind === "approval_stage");
    expect(approval).toMatchObject({
      issueId: approvalIssue,
      issueIdentifier: "BQ-4",
      question: "Check the totals",
      href: `/${prefix}/issues/BQ-4`,
    });
  });

  it("shows a card addressed to an agent once that agent can no longer act", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueId = await insertIssue({ companyId, identifier: "BQ-1", title: "Open task", status: "todo" });
    await insertCard({ companyId, issueId, title: "For the agent", addresseeAgentId: agentId });

    expect((await boardQuestionsService(db).list(companyId, BOARD_USER)).count).toBe(0);
    await db.update(agents).set({ status: "terminated" });
    const result = await boardQuestionsService(db).list(companyId, BOARD_USER);
    expect(result.items.map((item) => item.title)).toEqual(["For the agent"]);
  });

  it("does not double count an approval stage whose issue already shows a card", async () => {
    const { companyId } = await seedCompany();
    const issueId = await insertIssue({
      companyId,
      identifier: "BQ-1",
      title: "Needs sign-off",
      status: "in_review",
      executionState: approvalStage({ type: "user", userId: BOARD_USER }),
    });
    await insertCard({ companyId, issueId, title: "Approve the plan" });

    const result = await boardQuestionsService(db).list(companyId, BOARD_USER);
    expect(result.items.map((item) => item.kind)).toEqual(["interaction"]);
  });

  it("serves the route to board users of the company and refuses agents", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueId = await insertIssue({ companyId, identifier: "BQ-1", title: "Open task", status: "todo" });
    await insertCard({ companyId, issueId, title: "Board question" });

    function app(actor: Record<string, unknown>) {
      const testApp = express();
      testApp.use(express.json());
      testApp.use((req, _res, next) => {
        (req as any).actor = actor;
        next();
      });
      testApp.use("/api", attentionRoutes(db));
      testApp.use(errorHandler);
      return testApp;
    }

    const board = {
      type: "board",
      source: "session",
      userId: BOARD_USER,
      companyIds: [companyId],
      isInstanceAdmin: false,
    };
    const response = await request(app(board)).get(`/api/companies/${companyId}/board-questions`).expect(200);
    expect(response.body.count).toBe(1);

    await request(app({ ...board, companyIds: [] })).get(`/api/companies/${companyId}/board-questions`).expect(403);
    await request(app({ type: "agent", source: "agent_key", companyId, agentId, runId: null }))
      .get(`/api/companies/${companyId}/board-questions`)
      .expect(403);
  });
});
