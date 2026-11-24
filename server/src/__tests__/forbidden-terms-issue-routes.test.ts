import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companyMemberships, createDb, issueComments, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  FORBIDDEN_TEST_TEXT,
  enableForbiddenTermsForTest,
  expectForbiddenTermResponse,
} from "./helpers/forbidden-terms.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres forbidden-terms issue route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SELECTOR = {
  quote: { exact: "selected text", prefix: "Alpha ", suffix: " omega" },
  position: { normalizedStart: 6, normalizedEnd: 19, markdownStart: 6, markdownEnd: 19 },
};

// End-to-end through the real issue routes and services: each entry point
// answers 422 without echoing the term, and nothing is stored.
describeEmbeddedPostgres("forbidden-terms filter on issue HTTP routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  let companyId!: string;
  let restore: (() => void) | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-forbidden-terms-routes-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    app = createApp();
    await db.insert(companies).values({
      id: companyId,
      name: "Forbidden terms tenant",
      issuePrefix: "FTR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
  }, 20_000);

  afterEach(() => {
    restore?.();
    restore = null;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createStorage(): StorageService {
    return {
      provider: "local_disk",
      putFile: vi.fn(async () => {
        throw new Error("Unexpected storage.putFile call");
      }),
      getObject: vi.fn(async () => {
        throw new Error("Unexpected storage.getObject call");
      }),
      headObject: vi.fn(async () => ({ exists: false })),
      deleteObject: vi.fn(async () => undefined),
    };
  }

  function createApp() {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    testApp.use("/api", issueRoutes(db, createStorage()));
    testApp.use(errorHandler);
    return testApp;
  }

  function enable() {
    restore = enableForbiddenTermsForTest();
  }

  async function createCleanIssue(title: string) {
    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title, description: "Check supplier S1", status: "todo", priority: "medium" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; identifier: string };
  }

  it("refuses issue creation (title, description, initial plan) and creates nothing", async () => {
    enable();
    for (const body of [
      { title: FORBIDDEN_TEST_TEXT },
      { title: "Supplier follow-up", description: FORBIDDEN_TEST_TEXT },
      { title: "Supplier follow-up", initialPlan: FORBIDDEN_TEST_TEXT },
    ]) {
      const res = await request(app)
        .post(`/api/companies/${companyId}/issues`)
        .send({ status: "todo", priority: "medium", ...body });
      expectForbiddenTermResponse(res);
    }
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(0);
  });

  it("refuses an issue PATCH of title or description and keeps the stored text", async () => {
    const issue = await createCleanIssue("Patch target");
    enable();
    expectForbiddenTermResponse(await request(app).patch(`/api/issues/${issue.id}`).send({ title: FORBIDDEN_TEST_TEXT }));
    expectForbiddenTermResponse(
      await request(app).patch(`/api/issues/${issue.id}`).send({ description: FORBIDDEN_TEST_TEXT }),
    );
    const [row] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(row).toMatchObject({ title: "Patch target", description: "Check supplier S1" });
  });

  it("refuses a comment creation and stores nothing", async () => {
    const issue = await createCleanIssue("Comment target");
    enable();
    expectForbiddenTermResponse(
      await request(app).post(`/api/issues/${issue.id}/comments`).send({ body: FORBIDDEN_TEST_TEXT }),
    );
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id))).toHaveLength(0);
  });

  it("refuses an issue document write and a restore of an older revision carrying the term", async () => {
    const issue = await createCleanIssue("Document target");
    // Written before the filter is enabled, as a pre-existing revision would be.
    const first = await request(app)
      .put(`/api/issues/${issue.id}/documents/plan`)
      .send({ title: "Plan", format: "markdown", body: `Written earlier: ${FORBIDDEN_TEST_TEXT}` });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await request(app)
      .put(`/api/issues/${issue.id}/documents/plan`)
      .send({ title: "Plan", format: "markdown", body: "Cleaned up: person P1", baseRevisionId: first.body.latestRevisionId });
    expect(second.status, JSON.stringify(second.body)).toBe(200);

    enable();
    expectForbiddenTermResponse(
      await request(app)
        .put(`/api/issues/${issue.id}/documents/plan`)
        .send({ title: "Plan", format: "markdown", body: FORBIDDEN_TEST_TEXT, baseRevisionId: second.body.latestRevisionId }),
    );
    expectForbiddenTermResponse(
      await request(app)
        .post(`/api/issues/${issue.id}/documents/plan/revisions/${first.body.latestRevisionId}/restore`)
        .send({}),
    );
    const current = await request(app).get(`/api/issues/${issue.id}/documents/plan`);
    expect(current.body.body).toBe("Cleaned up: person P1");
  });

  it("refuses an issue document annotation thread and reply", async () => {
    const issue = await createCleanIssue("Annotation target");
    const doc = await request(app)
      .put(`/api/issues/${issue.id}/documents/plan`)
      .send({ title: "Plan", format: "markdown", body: "Alpha selected text omega" });
    expect(doc.status, JSON.stringify(doc.body)).toBe(201);
    const base = {
      baseRevisionId: doc.body.latestRevisionId,
      baseRevisionNumber: doc.body.latestRevisionNumber,
      selector: SELECTOR,
    };
    const thread = await request(app)
      .post(`/api/issues/${issue.id}/documents/plan/annotations`)
      .send({ ...base, body: "Check with person P1" });
    expect(thread.status, JSON.stringify(thread.body)).toBe(201);

    enable();
    expectForbiddenTermResponse(
      await request(app)
        .post(`/api/issues/${issue.id}/documents/plan/annotations`)
        .send({ ...base, body: FORBIDDEN_TEST_TEXT }),
    );
    expectForbiddenTermResponse(
      await request(app)
        .post(`/api/issues/${issue.id}/documents/plan/annotations/${thread.body.id}/comments`)
        .send({ body: FORBIDDEN_TEST_TEXT }),
    );
  });
});
