import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("playwright", () => ({ chromium: { launch } }));

import { TaskBrowserSessionManager } from "./task-browser-sessions.js";

function fakeBrowser() {
  const pages: Array<{ currentUrl: string; clicks: number }> = [];
  const close = vi.fn(async () => undefined);
  launch.mockImplementation(async () => ({
    newContext: async () => {
      const data = { currentUrl: "about:blank", clicks: 0 };
      pages.push(data);
      return {
        close,
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
  return { pages, close };
}

describe("task browser sessions", () => {
  let manager: TaskBrowserSessionManager;
  beforeEach(() => { launch.mockReset(); manager = new TaskBrowserSessionManager(); });
  afterEach(async () => { await manager.closeAll(); });

  it("shares one page for an agent and operator, pausing agent actions during takeover", async () => {
    const browser = fakeBrowser();
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
    await manager.act("issue-a", { type: "agent" }, { type: "navigate", url: "https://a.example/" });
    await manager.act("issue-b", { type: "agent" }, { type: "navigate", url: "https://b.example/" });
    expect(browser.pages).toHaveLength(2);
    expect((await manager.state("issue-a")).url).toBe("https://a.example/");
    expect((await manager.state("issue-b")).url).toBe("https://b.example/");
    await expect(manager.act("issue-a", { type: "agent" }, { type: "navigate", url: "file:///etc/passwd" })).rejects.toMatchObject({ status: 400 });
  });
});
