import { Router } from "express";
import { eq } from "drizzle-orm";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { issueService, logActivity } from "../services/index.js";
import { taskTerminalSessions } from "../services/task-terminal-sessions.js";
import { assertInstanceAdmin, getAccessibleResource } from "./authz.js";

export function taskTerminalRoutes(db: Db) {
  const router = Router();
  const issues = issueService(db);

  router.post("/issues/:issueId/terminal/session", async (req, res) => {
    const issueId = req.params.issueId as string;
    const issue = await getAccessibleResource(req, res, issues.getById(issueId), "Task not found");
    if (!issue) return;
    assertInstanceAdmin(req);
    if (!issue.executionWorkspaceId) {
      throw conflict("This task has no execution workspace. Assign a local workspace before opening a terminal.");
    }
    const [workspace] = await db.select({
      companyId: executionWorkspaces.companyId,
      providerType: executionWorkspaces.providerType,
      status: executionWorkspaces.status,
      cwd: executionWorkspaces.cwd,
    }).from(executionWorkspaces).where(eq(executionWorkspaces.id, issue.executionWorkspaceId)).limit(1);
    if (!workspace || workspace.companyId !== issue.companyId || workspace.providerType !== "local_fs"
      || workspace.status !== "active" || !workspace.cwd || !isAbsolute(workspace.cwd)) {
      throw conflict("An active local execution workspace is required for the task terminal.");
    }
    let cwd: string;
    try {
      cwd = await realpath(workspace.cwd);
      if (!(await stat(cwd)).isDirectory()) throw new Error("not_directory");
    } catch {
      throw conflict("The task workspace directory is unavailable.");
    }
    const token = taskTerminalSessions.mint(issue.id, cwd);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "local-board",
      action: "issue.terminal_session_opened",
      entityType: "issue",
      entityId: issue.id,
      details: { executionWorkspaceId: issue.executionWorkspaceId },
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({ token, websocketPath: `/api/issues/${encodeURIComponent(issue.id)}/terminal/ws` });
  });

  return router;
}
