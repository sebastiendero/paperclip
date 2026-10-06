import { and, eq, or } from "drizzle-orm";
import { workspaceRuntimeServices, type Db } from "@paperclipai/db";
import { taskBrowserSessions } from "./task-browser-sessions.js";

/** Agent Chromium may reach only running services attached to its task workspace. */
export async function configureTaskBrowserOrigins(db: Db, issue: {
  id: string; companyId: string; executionWorkspaceId: string | null;
}) {
  const scopes = [eq(workspaceRuntimeServices.issueId, issue.id)];
  if (issue.executionWorkspaceId) scopes.push(eq(workspaceRuntimeServices.executionWorkspaceId, issue.executionWorkspaceId));
  const rows = await db.select({ url: workspaceRuntimeServices.url }).from(workspaceRuntimeServices).where(and(
    eq(workspaceRuntimeServices.companyId, issue.companyId),
    eq(workspaceRuntimeServices.status, "running"),
    or(...scopes),
  ));
  await taskBrowserSessions.allowAgentOrigins(issue.id, rows.flatMap((row) => row.url ? [row.url] : []));
}
