import { Router, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { issueService, logActivity } from "../services/index.js";
import { taskBrowserSessions, type BrowserAction } from "../services/task-browser-sessions.js";
import { assertBoard, getAccessibleResource } from "./authz.js";

const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: z.string().trim().min(1).max(2048) }),
  z.object({ type: z.literal("click"), x: z.number().int().min(0).max(1280), y: z.number().int().min(0).max(800) }),
  z.object({ type: z.literal("clickSelector"), selector: z.string().trim().min(1).max(500) }),
  z.object({ type: z.literal("type"), text: z.string().max(5000), selector: z.string().trim().min(1).max(500).optional() }),
  z.object({ type: z.literal("key"), key: z.string().trim().min(1).max(80) }),
  z.object({ type: z.literal("scroll"), x: z.number().int().min(-2000).max(2000), y: z.number().int().min(-2000).max(2000) }),
]);

export function taskBrowserRoutes(db: Db) {
  const router = Router();
  const issues = issueService(db);

  async function authorizedIssue(req: Request, res: Response) {
    const issue = await getAccessibleResource(req, res, issues.getById(req.params.issueId as string), "Task not found");
    if (!issue) return null;
    if (req.actor.type === "agent") {
      const runId = req.actor.runId?.trim();
      if (!runId || !req.actor.agentId) throw forbidden("An active task run is required for the browser.");
      const [run] = await db.select({
        status: heartbeatRuns.status,
        nativeIssueId: heartbeatRuns.nativeIssueId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, runId),
        eq(heartbeatRuns.companyId, issue.companyId),
        eq(heartbeatRuns.agentId, req.actor.agentId),
      )).limit(1);
      const contextId = run?.contextSnapshot?.issueId ?? run?.contextSnapshot?.taskId;
      if (!run || run.status !== "running" || (run.nativeIssueId !== issue.id && contextId !== issue.id)) {
        throw forbidden("This agent run is not active on this task.");
      }
    }
    return issue;
  }

  router.get("/issues/:issueId/browser/state", async (req, res) => {
    const issue = await authorizedIssue(req, res);
    if (!issue) return;
    res.setHeader("Cache-Control", "no-store");
    res.json(await taskBrowserSessions.state(issue.id));
  });

  router.get("/issues/:issueId/browser/screenshot", async (req, res) => {
    const issue = await authorizedIssue(req, res);
    if (!issue) return;
    res.setHeader("Cache-Control", "no-store");
    res.json(await taskBrowserSessions.screenshot(issue.id));
  });

  router.post("/issues/:issueId/browser/control", async (req, res) => {
    const issue = await authorizedIssue(req, res);
    if (!issue) return;
    assertBoard(req);
    const input = z.object({ operation: z.enum(["take", "release"]) }).parse(req.body);
    const userId = req.actor.userId ?? "local-board";
    const control = await taskBrowserSessions.control(issue.id, userId, input.operation);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "user",
      actorId: userId,
      action: `issue.browser_control_${input.operation}`,
      entityType: "issue",
      entityId: issue.id,
    });
    res.json(control);
  });

  router.post("/issues/:issueId/browser/action", async (req, res) => {
    const issue = await authorizedIssue(req, res);
    if (!issue) return;
    const action = actionSchema.parse(req.body) as BrowserAction;
    const actor = req.actor.type === "board"
      ? { type: "board" as const, userId: req.actor.userId ?? "local-board" }
      : { type: "agent" as const };
    const result = await taskBrowserSessions.act(issue.id, actor, action);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: req.actor.type === "board" ? "user" : "agent",
      actorId: req.actor.type === "board" ? (req.actor.userId ?? "local-board") : (req.actor.agentId ?? "unknown"),
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      runId: req.actor.type === "agent" ? req.actor.runId : null,
      action: `issue.browser_${action.type}`,
      entityType: "issue",
      entityId: issue.id,
    });
    res.json(result);
  });

  router.delete("/issues/:issueId/browser", async (req, res) => {
    const issue = await authorizedIssue(req, res);
    if (!issue) return;
    assertBoard(req);
    await taskBrowserSessions.close(issue.id);
    res.status(204).end();
  });

  return router;
}
