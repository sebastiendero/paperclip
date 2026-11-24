import { notifyStatusCardIssueChange } from "./status-card-notifications.js";
import { notifyIssueRecovery } from "./issue-recovery-notifications.js";
import type { PgInsertValue } from "drizzle-orm/pg-core";
import { issueComments, type Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { assertNoForbiddenTerms } from "./forbidden-terms.js";

type WriteDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function insertIssueComment(db: WriteDb, input: PgInsertValue<typeof issueComments> & { companyId: string }) {
  // Every comment creation goes through this insert, so checking here covers
  // routes, agents, chat channels and system flows alike.
  assertNoForbiddenTerms([{ field: "body", text: typeof input.body === "string" ? input.body : null }], {
    surface: "issue_comment",
    issueId: typeof input.issueId === "string" ? input.issueId : null,
    companyId: input.companyId,
    authorAgentId: typeof input.authorAgentId === "string" ? input.authorAgentId : null,
    authorUserId: typeof input.authorUserId === "string" ? input.authorUserId : null,
  });
  return db.transaction(async tx => {
    await notifyStatusCardIssueChange(tx, input.companyId);
    await notifyIssueRecovery(tx, { companyId: input.companyId,
      issueId: typeof input.issueId === "string" ? input.issueId : undefined });
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.dotEvents, `company:${input.companyId}`);
    return tx.insert(issueComments).values(input).returning();
  });
}
