import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("playwright", () => ({ chromium: { launch } }));

import { TaskBrowserSessionManager } from "./task-browser-sessions.js";

function fakeBrowser() {
  const pages: Array<{ currentUrl: string; clicks: number }> = [];
  const routes: Array<{
    http?: (route: { request: () => { url: () => string }; continue: () => Promise<void>; abort: () => Promise<void> }) => Promise<void>;
    websocket?: (socket: { url: () => string; connectToServer: () => Promise<void>; close: () => Promise<void> }) => Promise<void>;
  }> = [];
  const close = vi.fn(async () => undefined);
  launch.mockImplementation(async () => ({
    newContext: async () => {
      const data = { currentUrl: "about:blank", clicks: 0 };
      const handlers: (typeof routes)[number] = {};
      pages.push(data);
      routes.push(handlers);
      return {
        close,
        route: async (_pattern: string, handler: typeof handlers.http) => { handlers.http = handler; },
        routeWebSocket: async (_pattern: string, handler: typeof handlers.websocket) => { handlers.websocket = handler; },
        newPage: async () => ({
          url: () => data.currentUrl,
          title: async () => data.currentUrl,
          locator: () => {
            const locator = { innerText: async () => "Visible text", click: async () => { data.clicks += 1; }, fill: async () => undefined,
              first: () => locator };
            return locator;
          },
          screenshot: async () => Buffer.from("image"),
          evaluate: async () => [],
          goto: async (url: string) => { data.currentUrl = url; },
          mouse: { click: async () => { data.clicks += 1; }, wheel: async () => undefined },
          keyboard: { insertText: async () => undefined, press: async () => undefined },
        }),
      };
    },
    close,
  }));
  return { pages, routes, close };
}

describe("task browser sessions", () => {
  let manager: TaskBrowserSessionManager;
  beforeEach(() => { launch.mockReset(); manager = new TaskBrowserSessionManager(); });
  afterEach(async () => { await manager.closeAll(); });

  it("shares one page for an agent and operator, pausing agent actions during takeover", async () => {
    const browser = fakeBrowser();
    await manager.allowAgentOrigins("issue-a", ["https://example.com/"]);
    await manager.act("issue-a", { type: "agent" }, { type: "navigate", url: "https://example.com/" });
    expect((await manager.state("issue-a")).url).toBe("https://example.com/");
    expect(browser.pages).toHaveLength(1);

    await manager.control("issue-a", "user-a", "take");
    await expect(manager.act("issue-a", { type: "agent" }, { type: "clickSelector", selector: "button" })).rejects.toMatchObject({ status: 409 });
    await manager.act("issue-a", { type: "board", userId: "user-a" }, { type: "click", x: 20, y: 20 });
    expect(browser.pages[0]?.clicks).toBe(1);
    await manager.control("issue-a", "user-a", "release");
    await manager.act("issue-a", { type: "agent" }, { type: "clickSelector", selector: "button" });
    expect(browser.pages[0]?.clicks).toBe(2);
  });

  it("isolates tasks and rejects unsafe navigation", async () => {
    const browser = fakeBrowser();
    await manager.allowAgentOrigins("issue-a", ["https://a.example/"]);
    await manager.allowAgentOrigins("issue-b", ["https://b.example/"]);
    await manager.act("issue-a", { type: "agent" }, { type: "navigate", url: "https://a.example/" });
    await manager.act("issue-b", { type: "agent" }, { type: "navigate", url: "https://b.example/" });
    expect(browser.pages).toHaveLength(2);
    expect((await manager.state("issue-a")).url).toBe("https://a.example/");
    expect((await manager.state("issue-b")).url).toBe("https://b.example/");
    await expect(manager.act("issue-a", { type: "agent" }, { type: "navigate", url: "file:///etc/passwd" })).rejects.toMatchObject({ status: 400 });
  });

  it("confines an agent to approved task service origins", async () => {
    const browser = fakeBrowser();
    await manager.allowAgentOrigins("issue-a", ["http://127.0.0.1:4173"]);
    await manager.act("issue-a", { type: "agent" }, { type: "navigate", url: "http://127.0.0.1:4173/" });
    await expect(manager.act("issue-a", { type: "agent" }, { type: "navigate", url: "http://127.0.0.1:3100/api/companies" })).rejects.toMatchObject({ status: 403 });
    await expect(manager.act("issue-a", { type: "agent" }, { type: "navigate", url: "http://169.254.169.254/latest/meta-data" })).rejects.toMatchObject({ status: 403 });
    const httpAbort = vi.fn(async () => undefined);
    await browser.routes[0]?.http?.({ request: () => ({ url: () => "http://127.0.0.1:3100/api" }), continue: vi.fn(), abort: httpAbort });
    expect(httpAbort).toHaveBeenCalled();
    const websocketClose = vi.fn(async () => undefined);
    await browser.routes[0]?.websocket?.({ url: () => "ws://127.0.0.1:3100/api", connectToServer: vi.fn(), close: websocketClose });
    expect(websocketClose).toHaveBeenCalled();
  });
});
