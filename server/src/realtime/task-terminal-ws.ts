import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { taskTerminalSessions } from "../services/task-terminal-sessions.js";

type UpgradeRequest = IncomingMessage & { paperclipWebSocketHandled?: boolean };

function reject(socket: Duplex) {
  if (!socket.destroyed) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
}

export function setupTaskTerminalWebSocketServer(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const req = request as UpgradeRequest;
    if (req.paperclipWebSocketHandled || !req.url) return;
    const match = new URL(req.url, "http://localhost").pathname.match(/^\/api\/issues\/([0-9a-f-]{36})\/terminal\/ws$/i);
    if (!match) return;
    req.paperclipWebSocketHandled = true;
    const issueId = match[1];
    if (!issueId) return reject(socket);
    wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      const authTimer = setTimeout(() => ws.close(1008, "authentication_timeout"), 10_000);
      const authenticate = (raw: unknown) => {
        clearTimeout(authTimer);
        ws.off("message", authenticate);
        let token: string | null = null;
        try {
          const frame = JSON.parse(String(raw)) as { type?: string; token?: string };
          if (frame.type === "auth" && typeof frame.token === "string") token = frame.token;
        } catch { /* Invalid authentication frame. */ }
        if (!token || !taskTerminalSessions.attach(issueId, token, ws)) ws.close(1008, "invalid_terminal_token");
      };
      ws.on("message", authenticate);
      ws.on("close", () => clearTimeout(authTimer));
    });
  });
  server.on("close", () => {
    taskTerminalSessions.closeAll();
    wss.close();
  });
}
