import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

const issue = { id: "11111111-1111-4111-8111-111111111111", companyId: "22222222-2222-4222-8222-222222222222", executionWorkspaceId: null };
vi.mock("../services/index.js", () => ({
  issueService: () => ({ getById: async () => issue }),
  logActivity: vi.fn(),
}));

import { taskTerminalRoutes } from "../routes/task-terminal.js";

describe("task terminal access", () => {
  it("denies a company editor who is not an instance admin before opening a shell", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board", source: "session", userId: "editor-1",
        companyIds: [issue.companyId], memberships: [{ companyId: issue.companyId, membershipRole: "member", status: "active" }],
      } as Express.Request["actor"];
      next();
    });
    app.use("/api", taskTerminalRoutes({} as never));
    app.use((error: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.status ?? 500).json({ error: error.message });
    });
    const response = await request(app).post(`/api/issues/${issue.id}/terminal/session`).send({});
    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/Instance admin/);
  });
});
