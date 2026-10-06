import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";

const terminal = vi.hoisted(() => ({ attach: vi.fn(() => false), closeAll: vi.fn() }));
vi.mock("../services/task-terminal-sessions.js", () => ({ taskTerminalSessions: terminal }));
import { setupTaskTerminalWebSocketServer } from "./task-terminal-ws.js";

describe("terminal WebSocket tickets", () => {
  it("binds a direct terminal upgrade to its company and administrator key", async () => {
    const server = createServer();
    setupTaskTerminalWebSocketServer(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const companyId = "22222222-2222-4222-8222-222222222222";
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/companies/${companyId}/operator/admin-1/terminal/ws`);
    try {
      await once(socket, "open");
      socket.send(JSON.stringify({ type: "auth", token: "ticket" }));
      const [code] = await once(socket, "close") as [number];
      expect(code).toBe(1008);
      expect(terminal.attach).toHaveBeenCalledWith(`operator:${companyId}:admin-1`, "ticket", expect.anything());
    } finally {
      socket.terminate();
      server.close();
      await once(server, "close");
    }
  });
});
