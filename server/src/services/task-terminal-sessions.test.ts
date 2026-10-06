import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { TaskTerminalSessionManager } from "./task-terminal-sessions.js";

class FakeSocket extends EventEmitter {
  readyState = 1;
  frames: Array<Record<string, unknown>> = [];
  send(data: string) { this.frames.push(JSON.parse(data) as Record<string, unknown>); }
  close() { this.readyState = 3; this.emit("close"); }
}

describe("task terminal tickets", () => {
  const manager = new TaskTerminalSessionManager();
  afterEach(() => manager.closeAll());

  it("uses a token once and binds it to its task", async () => {
    const token = manager.mint("task-a", "/tmp");
    const wrong = new FakeSocket();
    expect(manager.attach("task-b", token, wrong as unknown as WebSocket)).toBe(false);
    expect(manager.attach("task-a", token, wrong as unknown as WebSocket)).toBe(false);

    const ticket = manager.mint("task-a", "/tmp");
    const socket = new FakeSocket();
    expect(manager.attach("task-a", ticket, socket as unknown as WebSocket)).toBe(true);
    expect(socket.frames[0]?.type).toBe("ready");
    expect(manager.attach("task-a", ticket, new FakeSocket() as unknown as WebSocket)).toBe(false);
    socket.close();
  });
});
