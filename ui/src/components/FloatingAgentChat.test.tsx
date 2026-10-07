// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Issue, IssueComment } from "@paperclipai/shared";
import { FloatingAgentChat } from "./FloatingAgentChat";

const state = vi.hoisted(() => ({
  enabled: true,
  companyId: "company-a",
  get: vi.fn(),
  ensure: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
  liveRuns: vi.fn(),
  recentIds: [] as string[],
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: state.companyId }) }));
vi.mock("@/hooks/useAgentChatEnabled", () => ({ useAgentChatEnabled: () => ({ enabled: state.enabled, loaded: true }) }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: async () => [agent, secondAgent] } }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: async () => ({ user: { id: "user-a" } }) } }));
vi.mock("@/api/agentChats", () => ({ agentChatsApi: { get: state.get, ensure: state.ensure } }));
vi.mock("@/api/issues", () => ({ issuesApi: { listComments: state.listComments, addComment: state.addComment } }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { liveRunsForIssue: state.liveRuns } }));
vi.mock("@/lib/recent-agent-chats", () => ({ useRecentAgentChats: () => state.recentIds, recordAgentChatVisit: vi.fn() }));
vi.mock("@/components/AgentIconPicker", () => ({ AgentIcon: () => <span aria-hidden>Agent</span> }));
vi.mock("@/lib/router", () => ({ Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a> }));

const agent = { id: "agent-a", companyId: "company-a", name: "Ariane", urlKey: "ariane", role: "engineer", title: "Engineer", icon: null, status: "idle" } as Agent;
const secondAgent = { id: "agent-b", companyId: "company-a", name: "Bruno", urlKey: "bruno", role: "designer", title: "Designer", icon: null, status: "idle" } as Agent;
const issue = { id: "chat-a", companyId: "company-a", conversationAgentId: "agent-a" } as Issue;
const comment = (id: string, body: string, authorType: "user" | "agent") => ({
  id, issueId: issue.id, companyId: issue.companyId, body, authorType,
  authorAgentId: authorType === "agent" ? agent.id : null,
  authorUserId: authorType === "user" ? "user-a" : null,
  createdAt: new Date(), updatedAt: new Date(), presentation: null, metadata: null,
} as IssueComment);

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let serverIssue: Issue | null;
let serverComments: IssueComment[];

async function render() {
  await act(async () => root.render(<QueryClientProvider client={client}><FloatingAgentChat /></QueryClientProvider>));
}
async function click(label: string) {
  await act(async () => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
}
async function waitForText(text: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (container.textContent?.includes(text)) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  throw new Error(`Timed out waiting for ${text}`);
}
async function waitForLogText(text: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (container.querySelector('[role="log"]')?.textContent?.includes(text)) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  throw new Error(`Timed out waiting for chat message ${text}`);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("scrollIntoView", vi.fn());
  Element.prototype.scrollIntoView = vi.fn();
  state.enabled = true;
  state.companyId = "company-a";
  state.recentIds = [];
  serverIssue = null;
  serverComments = [];
  state.get.mockReset().mockImplementation(async () => serverIssue);
  state.ensure.mockReset().mockImplementation(async () => { serverIssue = issue; return issue; });
  state.listComments.mockReset().mockImplementation(async () => [...serverComments].reverse());
  state.addComment.mockReset().mockImplementation(async (_issueId: string, body: string) => {
    const sent = comment("user-1", body, "user");
    serverComments.push(sent, comment("agent-1", "I can help with that.", "agent"));
    return sent;
  });
  state.liveRuns.mockReset().mockResolvedValue([]);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
});

describe("FloatingAgentChat", () => {
  it("opens an agent without creating a conversation and sends through the existing chat", async () => {
    await render();
    await click("Open agent chat");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Ariane"))!.click();
    });
    expect(state.get).toHaveBeenCalledWith("company-a", "agent-a");
    expect(state.ensure).not.toHaveBeenCalled();

    const input = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Ariane"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Hello Ariane");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Send message");

    expect(state.ensure).toHaveBeenCalledOnce();
    expect(state.addComment).toHaveBeenCalledWith("chat-a", "Hello Ariane", undefined, undefined, undefined, expect.any(String));
    expect(container.querySelector('[role="log"]')?.textContent).toContain("Hello Ariane");
    expect(container.querySelector('[role="log"]')?.textContent).toContain("I can help with that.");
  });

  it("hides the bubble when agent chat is disabled", async () => {
    state.enabled = false;
    await render();
    expect(container.querySelector('button[aria-label="Open agent chat"]')).toBeNull();
  });

  it("reopens the most recent agent and shows recent conversations with a last-message preview", async () => {
    state.recentIds = [agent.id];
    serverIssue = issue;
    serverComments = [comment("older", "Can you review the launch?", "user"), comment("latest", "Yes, I can review it.", "agent")];
    await render();
    await click("Open agent chat");
    await waitForLogText("Yes, I can review it.");
    expect(container.querySelector('[role="log"]')?.textContent).toContain("Yes, I can review it.");
    expect(container.querySelector('aside[aria-label="Chat navigation"]')?.textContent).toContain("Recent conversations");
    expect(container.querySelector('aside[aria-label="Chat navigation"]')?.textContent).toContain("Yes, I can review it.");

    await click("Choose another agent");
    await waitForText("Recent conversations");
    await waitForText("Yes, I can review it.");
    expect(container.textContent).toContain("Recent conversations");
    expect(container.textContent).toContain("Yes, I can review it.");
  });

  it("keeps the agent list beside the conversation and switches chats inside the wider panel", async () => {
    serverIssue = issue;
    serverComments = [comment("first", "Ariane's answer", "agent")];
    state.get.mockImplementation(async (_companyId: string, id: string) => id === agent.id ? issue : null);
    await render();
    await click("Open agent chat");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await click("Chat with Ariane");
    await waitForText("Ariane's answer");

    const panel = container.querySelector<HTMLElement>('section[aria-label="Chat with Ariane"]')!;
    expect(panel.className).toContain("sm:w-(--sz-720px)");
    expect(panel.querySelector('aside[aria-label="Chat navigation"]')).not.toBeNull();
    expect(panel.querySelector('[role="log"]')).not.toBeNull();

    await click("Chat with Bruno");
    await waitForText("Say hello to Bruno");
    expect(container.querySelector('section[aria-label="Chat with Bruno"]')).not.toBeNull();
    expect(state.get).toHaveBeenCalledWith("company-a", "agent-b");
  });

  it("keeps each agent's unsent draft when switching conversations", async () => {
    await render();
    await click("Open agent chat");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await click("Chat with Ariane");
    const input = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Ariane"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Draft for Ariane");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Chat with Bruno");
    await click("Chat with Ariane");
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Ariane"]')?.value).toBe("Draft for Ariane");
  });

  it("shows the sent message immediately while the server confirms it", async () => {
    let confirmSend!: (value: IssueComment) => void;
    state.addComment.mockImplementation(() => new Promise<IssueComment>((resolve) => { confirmSend = resolve; }));
    await render();
    await click("Open agent chat");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Ariane"))!.click();
    });
    const input = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Ariane"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "A quick question");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.click(); });
    expect(container.querySelector('[role="log"]')?.textContent).toContain("A quick question");
    expect(input.value).toBe("");
    await act(async () => {
      serverComments.push(comment("user-2", "A quick question", "user"));
      confirmSend(serverComments[0]!);
    });
  });

  it("shows that the selected agent is running while its reply is pending", async () => {
    state.recentIds = [agent.id];
    serverIssue = issue;
    serverComments = [comment("waiting", "Please check this", "user")];
    state.liveRuns.mockResolvedValue([{ id: "run-1", agentId: agent.id, status: "running", currentStatusMessage: "Reviewing the request" }]);
    await render();
    await click("Open agent chat");
    await waitForText("Reviewing the request");
    expect(container.textContent).toContain("Reviewing the request");
  });
});
