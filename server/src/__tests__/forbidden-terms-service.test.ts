import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
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
import { documentService } from "../services/documents.js";
import { issueService } from "../services/issues.ts";
import {
  FORBIDDEN_TERM_ERROR_CODE,
  FORBIDDEN_TERMS_FILE_ENV,
  resetForbiddenTermsCache,
} from "../services/forbidden-terms.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres forbidden-terms tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Invented names only.
const TERMS = ["# test list", "Zéphirine Duploux", "Bistrot Imaginaire"].join("\n");
const REFUSED = { status: 422, details: expect.objectContaining({ code: FORBIDDEN_TERM_ERROR_CODE }) };

describeEmbeddedPostgres("forbidden-terms filter on issue write paths", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let dir: string;
  const previous = process.env[FORBIDDEN_TERMS_FILE_ENV];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-forbidden-terms-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "paperclip-forbidden-terms-svc-"));
    const file = path.join(dir, "terms.txt");
    writeFileSync(file, TERMS, "utf8");
    process.env[FORBIDDEN_TERMS_FILE_ENV] = file;
    resetForbiddenTermsCache();
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env[FORBIDDEN_TERMS_FILE_ENV];
    else process.env[FORBIDDEN_TERMS_FILE_ENV] = previous;
    rmSync(dir, { recursive: true, force: true });
    resetForbiddenTermsCache();
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
      identifier: "PAP-4242",
      title: "Supplier review",
      description: "Check supplier S1",
      status: "todo",
      priority: "medium",
    });
    return { companyId, issueId };
  }

  it("refuses a comment containing a listed term and stores nothing", async () => {
    const { issueId } = await seedIssue();
    const svc = issueService(db);

    await expect(
      svc.addComment(issueId, "Spoke with ZEPHIRINE duploux about the order", { userId: "local-board" }),
    ).rejects.toMatchObject(REFUSED);

    const stored = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(stored).toEqual([]);
  });

  it("accepts a clean comment", async () => {
    const { issueId } = await seedIssue();
    const comment = await issueService(db).addComment(issueId, "Spoke with supplier S1 about the order", {
      userId: "local-board",
    });
    expect(comment.body).toBe("Spoke with supplier S1 about the order");
  });

  it("refuses an issue document revision containing a listed term and keeps the previous revision", async () => {
    const { issueId } = await seedIssue();
    const docs = documentService(db);
    const created = await docs.upsertIssueDocument({
      issueId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "# Plan\n\nVisit restaurant R1.",
    });

    await expect(
      docs.upsertIssueDocument({
        issueId,
        key: "plan",
        title: "Plan",
        format: "markdown",
        body: "# Plan\n\nVisit the Bistrot Imaginaire.",
        baseRevisionId: created.document.latestRevisionId,
      }),
    ).rejects.toMatchObject(REFUSED);

    const current = await docs.getIssueDocumentByKey(issueId, "plan");
    expect(current?.body).toBe("# Plan\n\nVisit restaurant R1.");
    expect(current?.latestRevisionNumber).toBe(1);

    const updated = await docs.upsertIssueDocument({
      issueId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "# Plan\n\nVisit restaurant R2.",
      baseRevisionId: created.document.latestRevisionId,
    });
    expect(updated.document.latestRevisionNumber).toBe(2);
  });

  it("refuses a new issue document whose title contains a listed term", async () => {
    const { issueId } = await seedIssue();
    await expect(
      documentService(db).upsertIssueDocument({
        issueId,
        key: "notes",
        title: "Notes on Bistrot Imaginaire",
        format: "markdown",
        body: "clean",
      }),
    ).rejects.toMatchObject(REFUSED);
  });

  it("refuses restoring an old revision that contains a listed term", async () => {
    const { issueId } = await seedIssue();
    const docs = documentService(db);
    delete process.env[FORBIDDEN_TERMS_FILE_ENV];
    const first = await docs.upsertIssueDocument({
      issueId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "Written before the filter: Zéphirine Duploux",
    });
    await docs.upsertIssueDocument({
      issueId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "Cleaned up: person P1",
      baseRevisionId: first.document.latestRevisionId,
    });
    process.env[FORBIDDEN_TERMS_FILE_ENV] = path.join(dir, "terms.txt");

    await expect(
      docs.restoreIssueDocumentRevision({
        issueId,
        key: "plan",
        revisionId: first.document.latestRevisionId!,
      }),
    ).rejects.toMatchObject(REFUSED);
  });

  it("refuses issue create and update carrying a listed term in title or description", async () => {
    const { companyId, issueId } = await seedIssue();
    const svc = issueService(db);

    await expect(
      svc.create(companyId, {
        title: "Follow up with Bistrot Imaginaire",
        description: null,
        status: "todo",
        priority: "medium",
      }),
    ).rejects.toMatchObject(REFUSED);

    await expect(
      svc.update(issueId, { description: "Owner: Zéphirine Duploux" }),
    ).rejects.toMatchObject(REFUSED);
    const [unchanged] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(unchanged?.description).toBe("Check supplier S1");

    const updated = await svc.update(issueId, { description: "Owner: manager M1" });
    expect(updated?.description).toBe("Owner: manager M1");
  });

  it("changes nothing when the variable is unset", async () => {
    delete process.env[FORBIDDEN_TERMS_FILE_ENV];
    const { issueId } = await seedIssue();
    const comment = await issueService(db).addComment(issueId, "Zéphirine Duploux", { userId: "local-board" });
    expect(comment.body).toBe("Zéphirine Duploux");
  });
});
