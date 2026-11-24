import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  documentAnnotationComments,
  documentAnnotationThreads,
  documentRevisions,
  documents,
  issueComments,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  FORBIDDEN_TEST_TEXT,
  enableForbiddenTermsForTest,
  expectForbiddenTermRejection,
} from "./helpers/forbidden-terms.js";
import { documentAnnotationService } from "../services/document-annotations.js";
import { documentService } from "../services/documents.js";
import { insertIssueComment } from "../services/issue-comment-writes.js";
import { setIssueTitle } from "../services/issue-title.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres forbidden-terms write-path tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SELECTOR = {
  quote: { exact: "selected text", prefix: "Alpha ", suffix: " omega" },
  position: { normalizedStart: 6, normalizedEnd: 19, markdownStart: 6, markdownEnd: 19 },
};
const BOARD_ACTOR = { actorType: "user" as const, actorId: "board-user", userId: "board-user" };

describeEmbeddedPostgres("forbidden-terms filter on the single write points", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let restore: () => void = () => {};

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-forbidden-terms-paths-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    restore = enableForbiddenTermsForTest();
  });

  afterEach(async () => {
    restore();
    await db.delete(documentAnnotationComments);
    await db.delete(documentAnnotationThreads);
    await db.delete(issueComments);
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `PAP-${Math.floor(Math.random() * 100000)}`,
      title: "Supplier review",
      description: "Check supplier S1",
      status: "todo",
      priority: "medium",
    });
    return { companyId, issueId };
  }

  it("refuses a comment written through insertIssueComment (agent, chat and system writers)", async () => {
    const { companyId, issueId } = await seedIssue();
    await expectForbiddenTermRejection(
      insertIssueComment(db, { companyId, issueId, authorType: "system", body: FORBIDDEN_TEST_TEXT }),
    );
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).toHaveLength(0);

    const [clean] = await insertIssueComment(db, { companyId, issueId, authorType: "system", body: "Ask person P1" });
    expect(clean?.body).toBe("Ask person P1");
  });

  it("refuses issue creation whose initial plan carries a listed term and creates nothing", async () => {
    const { companyId } = await seedIssue();
    await expectForbiddenTermRejection(
      issueService(db).create(companyId, {
        title: "Supplier follow-up",
        description: null,
        status: "todo",
        priority: "medium",
        initialPlan: FORBIDDEN_TEST_TEXT,
      }),
    );
    expect(await db.select().from(issues).where(eq(issues.title, "Supplier follow-up"))).toHaveLength(0);
  });

  it("refuses an issue title set through setIssueTitle and keeps the previous title", async () => {
    const { companyId, issueId } = await seedIssue();
    await expectForbiddenTermRejection(
      db.transaction((tx) =>
        setIssueTitle(tx as unknown as typeof db, companyId, issueId, { title: FORBIDDEN_TEST_TEXT }, {
          actorType: "user",
          actorId: "board-user",
        }),
      ),
    );
    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(row?.title).toBe("Supplier review");
  });

  it("refuses imported issues, comments and documents carrying a listed term", async () => {
    const { companyId, issueId } = await seedIssue();
    const svc = issueService(db);
    await expectForbiddenTermRejection(
      svc.importIssues(companyId, [{
        id: randomUUID(),
        ref: "imported",
        projectId: null,
        projectWorkspaceId: null,
        title: "Imported task",
        description: FORBIDDEN_TEST_TEXT,
        assigneeAgentId: null,
        status: "todo",
        priority: "medium",
        billingCode: null,
        assigneeAdapterOverrides: null,
        executionWorkspaceSettings: null,
        labelIds: [],
        monitorNotes: null,
        monitorScheduledBy: null,
      }]),
    );
    await expectForbiddenTermRejection(
      svc.addImportedComments([{
        id: randomUUID(),
        companyId,
        issueId,
        body: FORBIDDEN_TEST_TEXT,
        authorType: "user",
        authorAgentId: null,
        authorUserId: "board-user",
        presentation: null,
        metadata: null,
        createdAt: null,
      }]),
    );
    await expectForbiddenTermRejection(
      documentService(db).createIssueDocumentsForImport([{
        companyId,
        issueId,
        key: "notes",
        title: "Notes",
        format: "markdown",
        body: FORBIDDEN_TEST_TEXT,
        createdByAgentId: null,
        createdByUserId: "board-user",
        createdByRunId: null,
        sourceTrust: null,
      }]),
    );
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(1);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).toHaveLength(0);
    expect(await db.select().from(issueDocuments).where(eq(issueDocuments.issueId, issueId))).toHaveLength(0);
  });

  it("refuses issue document annotation threads and replies carrying a listed term", async () => {
    const { issueId } = await seedIssue();
    const doc = await documentService(db).upsertIssueDocument({
      issueId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "Alpha selected text omega",
    });
    const annotations = documentAnnotationService(db);
    const base = {
      baseRevisionId: doc.document.latestRevisionId!,
      baseRevisionNumber: doc.document.latestRevisionNumber,
      selector: SELECTOR,
    };

    await expectForbiddenTermRejection(
      annotations.createThread(issueId, "plan", { ...base, body: FORBIDDEN_TEST_TEXT }, BOARD_ACTOR),
    );
    expect(await db.select().from(documentAnnotationThreads)).toHaveLength(0);

    const thread = await annotations.createThread(issueId, "plan", { ...base, body: "Check with person P1" }, BOARD_ACTOR);
    await expectForbiddenTermRejection(
      annotations.addComment(issueId, "plan", thread.id, { body: FORBIDDEN_TEST_TEXT }, BOARD_ACTOR),
    );
    expect(await db.select().from(documentAnnotationComments)).toHaveLength(1);
  });

  it("refuses routine document annotation threads and replies before any lookup", async () => {
    // The check runs before the routine is loaded, so an unknown routine still
    // answers 422 (refused) rather than 404 (not found).
    const annotations = documentAnnotationService(db);
    await expectForbiddenTermRejection(
      annotations.createRoutineThread(randomUUID(), "description", {
        baseRevisionId: randomUUID(),
        baseRevisionNumber: 1,
        selector: SELECTOR,
        body: FORBIDDEN_TEST_TEXT,
      }, BOARD_ACTOR),
    );
    await expectForbiddenTermRejection(
      annotations.addRoutineComment(randomUUID(), "description", randomUUID(), { body: FORBIDDEN_TEST_TEXT }, BOARD_ACTOR),
    );
  });
});
