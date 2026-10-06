import { createProjectSchema, createIssueSchema } from "@paperclipai/shared";
import { z } from "zod";
import { CAPABILITY_SEMANTIC_TOOL_CATALOG } from "../vendor/paperclip-runner/index.js";
import { badRequest } from "../errors.js";

export const PROJECT_TOOL_NAMES = ["create_project", "list_project_repositories", "list_projects"];
export const BROWSER_TOOL_SCHEMAS = {
  browser_observe: z.object({}),
  browser_screenshot: z.object({}),
  browser_navigate: z.object({ url: z.url().max(2048) }),
  browser_click: z.object({ selector: z.string().min(1).max(500) }),
  browser_type: z.object({ text: z.string().max(5000), selector: z.string().min(1).max(500).optional() }),
  browser_key: z.object({ key: z.string().min(1).max(80) }),
  browser_scroll: z.object({ x: z.number().int().min(-2000).max(2000).default(0), y: z.number().int().min(-2000).max(2000) }),
};
export const BROWSER_TOOL_DESCRIPTIONS = {
  browser_observe: "Read the current URL, title, and visible text of this task's shared browser. The operator sees the same page live.",
  browser_screenshot: "See a JPEG screenshot of this task's shared browser. Use it to inspect visual layout and click targets.",
  browser_navigate: "Navigate this task's shared browser to an HTTP or HTTPS URL.",
  browser_click: "Click a CSS selector in this task's shared browser.",
  browser_type: "Fill a CSS-selected field or type into the focused field in this task's shared browser.",
  browser_key: "Press a key in this task's shared browser, such as Enter or Tab.",
  browser_scroll: "Scroll this task's shared browser by pixel offsets.",
};
export type BrowserToolName = keyof typeof BROWSER_TOOL_SCHEMAS;
export function isBrowserToolName(name: string): name is BrowserToolName {
  return Object.prototype.hasOwnProperty.call(BROWSER_TOOL_SCHEMAS, name);
}
export function projectToolDefinitions(workMode: string, includeTask = false) {
  const projectTools = CAPABILITY_SEMANTIC_TOOL_CATALOG.filter(tool =>
    (PROJECT_TOOL_NAMES.includes(tool.operationId) || includeTask && tool.operationId === "create_task")
    && tool.allowedModes.includes(workMode as "standard"),
  ).map(tool => ({ name: tool.operationId, description: tool.description,
    inputSchema: tool.operationId === "create_project"
      ? z.toJSONSchema(createProjectSchema.extend({ idempotencyKey: z.string().min(1).max(255) }))
      : tool.inputSchema,
  }));
  if (!includeTask) return projectTools;
  return [
    ...projectTools,
    ...Object.entries(BROWSER_TOOL_SCHEMAS).map(([name, schema]) => ({
      name,
      description: BROWSER_TOOL_DESCRIPTIONS[name as BrowserToolName],
      inputSchema: z.toJSONSchema(schema),
    })),
  ];
}

/** All transports use the normal authenticated API, including its validation and audit path. */
export async function callProjectTool(input: {
  name: string; arguments: Record<string, unknown>; apiUrl: string; token: string;
  companyId: string; issueId: string; agentId: string; conversation: boolean;
}) {
  const args = input.arguments;
  let path = `/companies/${input.companyId}/projects`;
  let body: unknown;
  if (input.name === "list_project_repositories") path = `/companies/${input.companyId}/project-repositories`;
  else if (input.name === "list_projects") { /* read projects */ }
  else if (input.name === "create_project") {
    body = createProjectSchema.extend({ idempotencyKey: z.string().min(1).max(255) }).parse(args);
  } else if (input.name === "create_task") {
    const key = z.string().min(1).max(150).parse(args.idempotencyKey);
    path = `/companies/${input.companyId}/issues`;
    body = createIssueSchema.parse({
      title: args.title, description: args.description, priority: args.priority,
      projectId: args.projectId, initialPlan: args.initialPlan,
      assigneeAgentId: args.assigneeActorId ?? input.agentId,
      parentId: input.conversation ? null : input.issueId,
      status: Array.isArray(args.blockedByTaskIds) && args.blockedByTaskIds.length ? "blocked" : "todo",
      blockedByIssueIds: args.blockedByTaskIds,
      idempotencyKey: `chat-handoff:${input.issueId}:${key}`,
    });
  } else throw badRequest("Unknown project tool");
  const response = await fetch(`${input.apiUrl.replace(/\/+$/, "").replace(/\/api$/, "")}/api${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : `Project tool failed (${response.status})`);
  return input.name === "list_projects" ? { projects: result } : result;
}
