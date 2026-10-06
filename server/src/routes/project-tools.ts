import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { projectToolContext } from "../services/project-tool-context.js";
import { BROWSER_TOOL_SCHEMAS, callProjectTool, isBrowserToolName, projectToolDefinitions } from "../services/project-tools.js";
import { taskBrowserSessions } from "../services/task-browser-sessions.js";
import { configureTaskBrowserOrigins } from "../services/task-browser-policy.js";
import { logActivity } from "../services/activity-log.js";
import { assertCompanyAccess } from "./authz.js";
import { forbidden } from "../errors.js";

/** Mounted after actor middleware; connection-scoped tokens cannot authenticate here. */
export function projectToolRoutes(db: Db) {
  const router = Router();
  router.post("/mcp/project-tools", async (req, res) => {
    const context = await projectToolContext(db, req.actor);
    assertCompanyAccess(req, context.run.companyId);
    const { id = null, method, params } = req.body;
    const send = (result: unknown) => res.json({ jsonrpc: "2.0", id, result });
    if (method === "initialize") return send({ protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "paperclip-project-tools", version: "1" } });
    if (method === "notifications/initialized") return res.status(202).end();
    const definitions = projectToolDefinitions(context.issue.workMode, true);
    if (method === "tools/list") return send({ tools: definitions });
    if (method !== "tools/call") return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    try {
      const toolName = typeof params?.name === "string" ? params.name : "";
      if (!definitions.some(tool => tool.name === toolName)) throw forbidden("Tool is unavailable in this mode");
      if (isBrowserToolName(toolName)) {
        await configureTaskBrowserOrigins(db, context.issue);
        const name = toolName;
        const args = BROWSER_TOOL_SCHEMAS[name].parse(params.arguments ?? {}) as Record<string, unknown>;
        const issueId = context.issue.id;
        if (name === "browser_screenshot") {
          const shot = await taskBrowserSessions.screenshot(issueId);
          return send({ content: [{ type: "image", data: shot.data, mimeType: "image/jpeg" }] });
        }
        let result: unknown;
        if (name === "browser_observe") result = await taskBrowserSessions.state(issueId);
        else {
          const action = name === "browser_navigate" ? { type: "navigate" as const, url: args.url as string }
            : name === "browser_click" ? { type: "clickSelector" as const, selector: args.selector as string }
            : name === "browser_type" ? { type: "type" as const, text: args.text as string, selector: args.selector as string | undefined }
            : name === "browser_key" ? { type: "key" as const, key: args.key as string }
            : { type: "scroll" as const, x: args.x as number, y: args.y as number };
          result = await taskBrowserSessions.act(issueId, { type: "agent" }, action);
          await logActivity(db, { companyId: context.issue.companyId, actorType: "agent", actorId: context.run.agentId,
            agentId: context.run.agentId, runId: context.run.id, action: `issue.${name}`,
            entityType: "issue", entityId: issueId });
        }
        return send({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
      }
      const apiUrl = process.env.PAPERCLIP_API_URL;
      if (!apiUrl) throw new Error("Paperclip API origin is unavailable");
      const result = await callProjectTool({
        name: params.name, arguments: params.arguments ?? {}, apiUrl,
        token: req.header("authorization")!.replace(/^Bearer\s+/i, ""),
        companyId: context.run.companyId, issueId: context.issue.id, agentId: context.run.agentId,
        conversation: Boolean(context.issue.conversationAgentId),
      });
      return send({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
    } catch (error) {
      return send({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Project tool failed" }] });
    }
  });
  return router;
}
