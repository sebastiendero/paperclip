import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

const issue = { id: "11111111-1111-4111-8111-111111111111", companyId: "22222222-2222-4222-8222-222222222222" };
const state = vi.hoisted(() => vi.fn(async () => ({ url: "about:blank" })));
vi.mock("../services/index.js", () => ({ issueService: () => ({ getById: async () => issue }), logActivity: vi.fn() }));
vi.mock("../services/task-browser-sessions.js", () => ({ taskBrowserSessions: { state } }));
import { taskBrowserRoutes } from "../routes/task-browser.js";

describe("task browser access", () => {
  it("does not expose a server-side browser to a company editor", async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId: "editor-1", companyIds: [issue.companyId] } as Express.Request["actor"];
      next();
    });
    app.use("/api", taskBrowserRoutes({} as never));
    app.use((error: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.status ?? 500).json({ error: error.message });
    });
    const response = await request(app).get(`/api/issues/${issue.id}/browser/state`);
    expect(response.status).toBe(403);
    expect(state).not.toHaveBeenCalled();
  });
});
