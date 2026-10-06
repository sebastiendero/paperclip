import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

const companyId = "22222222-2222-4222-8222-222222222222";
const mocks = vi.hoisted(() => ({
  state: vi.fn(async () => ({ url: "about:blank" })),
  mint: vi.fn(() => "single-use-ticket"),
  logActivity: vi.fn(async () => undefined),
}));
vi.mock("../services/task-browser-sessions.js", () => ({ taskBrowserSessions: { state: mocks.state } }));
vi.mock("../services/task-terminal-sessions.js", () => ({ taskTerminalSessions: { mint: mocks.mint } }));
vi.mock("../services/index.js", () => ({ logActivity: mocks.logActivity }));

import { operatorToolsRoutes } from "../routes/operator-tools.js";

function appFor(actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.actor = actor; next(); });
  app.use("/api", operatorToolsRoutes({} as never));
  app.use((error: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ error: error.message });
  });
  return app;
}

describe("direct operator tools", () => {
  it("does not expose the browser or shell to a company member", async () => {
    const actor = { type: "board", source: "session", userId: "editor-1", companyIds: [companyId] } as Express.Request["actor"];
    const app = appFor(actor);
    expect((await request(app).get(`/api/companies/${companyId}/operator/browser/state`)).status).toBe(403);
    expect((await request(app).post(`/api/companies/${companyId}/operator/terminal/session`).send({})).status).toBe(403);
    expect(mocks.state).not.toHaveBeenCalled();
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it("keeps an instance administrator inside their company access", async () => {
    const actor = { type: "board", source: "session", userId: "admin-1", isInstanceAdmin: true, companyIds: [] } as Express.Request["actor"];
    expect((await request(appFor(actor)).get(`/api/companies/${companyId}/operator/browser/state`)).status).toBe(403);
  });

  it("issues a personal terminal ticket to an authorized administrator", async () => {
    const actor = { type: "board", source: "session", userId: "admin-1", isInstanceAdmin: true, companyIds: [companyId] } as Express.Request["actor"];
    const response = await request(appFor(actor)).post(`/api/companies/${companyId}/operator/terminal/session`).send({});
    expect(response.status).toBe(200);
    expect(response.body.token).toBe("single-use-ticket");
    expect(response.body.websocketPath).toContain(`/operator/admin-1/terminal/ws`);
    expect(mocks.mint).toHaveBeenCalledWith(`operator:${companyId}:admin-1`, expect.any(String));
  });
});
