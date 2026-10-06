import { Router, type Request } from "express";
import { realpath, stat } from "node:fs/promises";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { logActivity } from "../services/index.js";
import { taskBrowserSessions, type BrowserAction } from "../services/task-browser-sessions.js";
import { taskTerminalSessions } from "../services/task-terminal-sessions.js";
import { assertCompanyAccess, assertInstanceAdmin } from "./authz.js";

const browserActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: z.string().trim().min(1).max(2048) }),
  z.object({ type: z.literal("click"), x: z.number().int().min(0).max(1280), y: z.number().int().min(0).max(800) }),
  z.object({ type: z.literal("type"), text: z.string().max(5000) }),
  z.object({ type: z.literal("key"), key: z.string().trim().min(1).max(80) }),
  z.object({ type: z.literal("scroll"), x: z.number().int().min(-2000).max(2000), y: z.number().int().min(-2000).max(2000) }),
]);

function operatorIdentity(req: Request) {
  assertInstanceAdmin(req);
  const companyId = z.uuid().parse(req.params.companyId);
  assertCompanyAccess(req, companyId);
  const userId = req.actor.userId ?? "local-board";
  return { companyId, userId, key: `operator:${companyId}:${userId}` };
}

export function operatorToolsRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/operator/browser/state", async (req, res) => {
    const { key } = operatorIdentity(req);
    res.setHeader("Cache-Control", "no-store");
    res.json(await taskBrowserSessions.state(key));
  });

  router.get("/companies/:companyId/operator/browser/screenshot", async (req, res) => {
    const { key } = operatorIdentity(req);
    res.setHeader("Cache-Control", "no-store");
    res.json(await taskBrowserSessions.screenshot(key));
  });

  router.post("/companies/:companyId/operator/browser/control", async (req, res) => {
    const { companyId, userId, key } = operatorIdentity(req);
    const { operation } = z.object({ operation: z.enum(["take", "release"]) }).parse(req.body);
    const result = await taskBrowserSessions.control(key, userId, operation);
    await logActivity(db, { companyId, actorType: "user", actorId: userId,
      action: `operator.browser_control_${operation}`, entityType: "company", entityId: companyId });
    res.json(result);
  });

  router.post("/companies/:companyId/operator/browser/action", async (req, res) => {
    const { companyId, userId, key } = operatorIdentity(req);
    const action = browserActionSchema.parse(req.body) as BrowserAction;
    const result = await taskBrowserSessions.act(key, { type: "board", userId }, action);
    await logActivity(db, { companyId, actorType: "user", actorId: userId,
      action: `operator.browser_${action.type}`, entityType: "company", entityId: companyId });
    res.json(result);
  });

  router.post("/companies/:companyId/operator/terminal/session", async (req, res) => {
    const { companyId, userId, key } = operatorIdentity(req);
    const cwd = await realpath(process.cwd());
    if (!(await stat(cwd)).isDirectory()) throw new Error("Paperclip server directory is unavailable.");
    const token = taskTerminalSessions.mint(key, cwd);
    await logActivity(db, { companyId, actorType: "user", actorId: userId,
      action: "operator.terminal_session_opened", entityType: "company", entityId: companyId });
    res.setHeader("Cache-Control", "no-store");
    res.json({ token, websocketPath: `/api/companies/${encodeURIComponent(companyId)}/operator/${encodeURIComponent(userId)}/terminal/ws` });
  });

  return router;
}
