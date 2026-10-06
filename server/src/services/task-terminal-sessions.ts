import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { WebSocket } from "ws";

const TICKET_TTL_MS = 60_000;
const IDLE_TTL_MS = 15 * 60_000;
const MAX_INPUT_BYTES = 8_192;
const MAX_SCROLLBACK = 128_000;

// The helper owns the PTY so a resize changes the real shell dimensions. Its
// stdout is a line-delimited control channel; terminal bytes stay base64-encoded.
const PTY_HELPER = String.raw`
import base64, fcntl, json, os, pty, select, signal, struct, subprocess, sys, termios
cwd = sys.argv[1]
master, slave = pty.openpty()
def resize(cols, rows):
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
resize(120, 32)
child = subprocess.Popen(['/bin/bash', '--noprofile', '--norc', '-i'], stdin=slave, stdout=slave, stderr=slave, cwd=cwd, env=os.environ.copy(), preexec_fn=os.setsid)
os.close(slave)
try:
    while child.poll() is None:
        readable, _, _ = select.select([master, sys.stdin.buffer], [], [], 0.2)
        if master in readable:
            try:
                data = os.read(master, 8192)
            except OSError:
                break
            if not data:
                break
            sys.stdout.write(json.dumps({'type': 'output', 'data': base64.b64encode(data).decode('ascii')}) + '\n')
            sys.stdout.flush()
        if sys.stdin.buffer in readable:
            line = sys.stdin.buffer.readline()
            if not line:
                break
            try:
                frame = json.loads(line)
                if frame.get('type') == 'input':
                    os.write(master, base64.b64decode(frame['data'], validate=True))
                elif frame.get('type') == 'resize':
                    cols, rows = int(frame['cols']), int(frame['rows'])
                    if 20 <= cols <= 400 and 8 <= rows <= 200:
                        resize(cols, rows)
                        os.killpg(child.pid, signal.SIGWINCH)
            except (ValueError, KeyError, TypeError, OSError):
                pass
finally:
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    os.close(master)
`;

interface TerminalTicket {
  issueId: string;
  cwd: string;
  expiresAt: number;
}

interface TerminalSession {
  cwd: string;
  child: ChildProcessWithoutNullStreams;
  clients: Set<WebSocket>;
  scrollback: string;
  lastViewerAt: number;
}

function safeEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    USER: process.env.USER ?? "paperclip",
    SHELL: "/bin/bash",
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
  };
}

export class TaskTerminalSessionManager {
  private readonly tickets = new Map<string, TerminalTicket>();
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweepTimer.unref?.();
  }

  mint(issueId: string, cwd: string): string {
    const token = randomBytes(32).toString("base64url");
    this.tickets.set(token, { issueId, cwd, expiresAt: Date.now() + TICKET_TTL_MS });
    return token;
  }

  attach(issueId: string, token: string, socket: WebSocket): boolean {
    const ticket = this.tickets.get(token);
    this.tickets.delete(token);
    if (!ticket || ticket.issueId !== issueId || ticket.expiresAt < Date.now()) return false;
    let session = this.sessions.get(issueId);
    if (session && session.cwd !== ticket.cwd) {
      this.closeSession(issueId, "workspace_changed");
      session = undefined;
    }
    if (!session) session = this.openSession(issueId, ticket.cwd);
    session.clients.add(socket);
    session.lastViewerAt = Date.now();
    socket.send(JSON.stringify({ type: "ready", scrollback: session.scrollback }));
    socket.on("message", (raw) => this.onMessage(session!, raw));
    socket.on("close", () => {
      session!.clients.delete(socket);
      session!.lastViewerAt = Date.now();
    });
    return true;
  }

  private openSession(issueId: string, cwd: string): TerminalSession {
    const child = spawn("python3", ["-u", "-c", PTY_HELPER, cwd], {
      cwd,
      env: safeEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const session: TerminalSession = {
      cwd, child, clients: new Set(), scrollback: "", lastViewerAt: Date.now(),
    };
    this.sessions.set(issueId, session);
    const decoder = new StringDecoder("utf8");
    const terminalDecoder = new StringDecoder("utf8");
    let pending = "";
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      pending += decoder.write(chunk);
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          const frame = JSON.parse(line) as { type?: string; data?: string };
          if (frame.type === "output" && typeof frame.data === "string") {
            const text = terminalDecoder.write(Buffer.from(frame.data, "base64"));
            session.scrollback = (session.scrollback + text).slice(-MAX_SCROLLBACK);
            this.broadcast(session, { type: "output", data: text });
          }
        } catch { /* A malformed helper frame is discarded. */ }
        newline = pending.indexOf("\n");
      }
    });
    child.on("error", () => this.closeSession(issueId, "terminal_failed"));
    child.on("exit", () => this.closeSession(issueId, "terminal_closed"));
    return session;
  }

  private onMessage(session: TerminalSession, raw: unknown): void {
    let frame: { type?: string; data?: string; cols?: number; rows?: number };
    try { frame = JSON.parse(String(raw)) as typeof frame; } catch { return; }
    if (frame.type === "input" && typeof frame.data === "string") {
      const input = Buffer.from(frame.data, "utf8");
      if (input.length === 0 || input.length > MAX_INPUT_BYTES) return;
      session.child.stdin.write(JSON.stringify({ type: "input", data: input.toString("base64") }) + "\n");
    } else if (frame.type === "resize" && Number.isInteger(frame.cols) && Number.isInteger(frame.rows)) {
      session.child.stdin.write(JSON.stringify({ type: "resize", cols: frame.cols, rows: frame.rows }) + "\n");
    }
  }

  private broadcast(session: TerminalSession, frame: Record<string, unknown>): void {
    const payload = JSON.stringify(frame);
    for (const socket of session.clients) {
      if (socket.readyState === 1) socket.send(payload);
    }
  }

  private closeSession(issueId: string, reason: string): void {
    const session = this.sessions.get(issueId);
    if (!session) return;
    this.sessions.delete(issueId);
    this.broadcast(session, { type: "closed", reason });
    for (const socket of session.clients) socket.close(1000, reason);
    session.child.kill("SIGTERM");
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, ticket] of this.tickets) if (ticket.expiresAt < now) this.tickets.delete(token);
    for (const [issueId, session] of this.sessions) {
      if (session.clients.size === 0 && now - session.lastViewerAt > IDLE_TTL_MS) this.closeSession(issueId, "idle_timeout");
    }
  }

  closeAll(): void {
    clearInterval(this.sweepTimer);
    for (const issueId of this.sessions.keys()) this.closeSession(issueId, "server_shutdown");
    this.tickets.clear();
  }
}

export const taskTerminalSessions = new TaskTerminalSessionManager();
