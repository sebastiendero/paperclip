import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@/components/ui/button";
import { operatorToolsApi, taskToolsApi } from "@/api/task-tools";
import { buildSameOriginWebSocketUrl } from "@/lib/websocket-url";
import { Link } from "@/lib/router";

export function TaskTerminalPanel({ issueId, companyId }: { issueId?: string; companyId?: string }) {
  const targetId = companyId ?? issueId!;
  const toolsApi = companyId ? operatorToolsApi : taskToolsApi;
  const elementRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const connectionVersionRef = useRef(0);
  const [status, setStatus] = useState<"connecting" | "connected" | "closed" | "error">("connecting");
  const [message, setMessage] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const connect = useCallback(async (version: number) => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    setStatus("connecting");
    setMessage(null);
    try {
      const ticket = await toolsApi.createTerminalSession(targetId);
      if (version !== connectionVersionRef.current) return;
      const socket = new WebSocket(buildSameOriginWebSocketUrl(ticket.websocketPath));
      socketRef.current = socket;
      socket.onopen = () => {
        socket.send(JSON.stringify({ type: "auth", token: ticket.token }));
        fitRef.current?.fit();
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      };
      socket.onmessage = (event) => {
        let frame: { type?: string; data?: string; scrollback?: string; reason?: string };
        try { frame = JSON.parse(String(event.data)) as typeof frame; } catch { return; }
        if (frame.type === "ready") {
          terminal.reset();
          terminal.write(frame.scrollback ?? "");
          setStatus("connected");
          terminal.focus();
        } else if (frame.type === "output") terminal.write(frame.data ?? "");
        else if (frame.type === "closed") { setStatus("closed"); setMessage(frame.reason ?? "Terminal closed"); }
      };
      socket.onerror = () => { setStatus("error"); setMessage("Terminal connection failed."); };
      socket.onclose = () => { if (socketRef.current === socket) { socketRef.current = null; setStatus((current) => current === "error" ? current : "closed"); } };
    } catch (error) {
      if (version !== connectionVersionRef.current) return;
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Terminal unavailable.");
    }
  }, [targetId, toolsApi]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const terminal = new Terminal({ cursorBlink: true, fontFamily: "monospace", scrollback: 3000 });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    terminalRef.current = terminal;
    fitRef.current = fit;
    const input = terminal.onData((data) => {
      if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: "input", data }));
    });
    const observer = new ResizeObserver(() => {
      try { fit.fit(); } catch { return; }
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      }
    });
    observer.observe(element);
    fit.fit();
    const version = ++connectionVersionRef.current;
    void connect(version);
    return () => {
      connectionVersionRef.current += 1;
      socketRef.current?.close(1000, "panel_closed");
      socketRef.current = null;
      observer.disconnect();
      input.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [connect, attempt]);

  return <div className="flex h-full min-h-0 flex-col bg-card">
    <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs text-muted-foreground">
      <span>{companyId ? "Paperclip server terminal" : "Task workspace terminal"} · {status}</span>
      {status !== "connected" && <Button size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>Reconnect</Button>}
    </div>
    {message && <p role="alert" className="px-3 py-2 text-xs text-destructive">{message}</p>}
    {message?.includes("execution workspace") && !companyId && <p className="px-3 pb-2 text-xs text-muted-foreground">For a terminal without a task workspace, open <Link to="/operator-tools" className="underline">Browser &amp; Terminal</Link> from the sidebar.</p>}
    <div ref={elementRef} className="min-h-0 flex-1 overflow-hidden p-2" aria-label={companyId ? "Paperclip server terminal" : "Task terminal"} />
  </div>;
}
