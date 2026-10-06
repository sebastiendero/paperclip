import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { conflict, badRequest } from "../errors.js";

const IDLE_MS = 15 * 60_000;
const CONTROL_MS = 5 * 60_000;
const MAX_SESSIONS = 8;
const VIEWPORT = { width: 1280, height: 800 };

export type BrowserAction =
  | { type: "navigate"; url: string }
  | { type: "click"; x: number; y: number }
  | { type: "clickSelector"; selector: string }
  | { type: "type"; text: string; selector?: string }
  | { type: "key"; key: string }
  | { type: "scroll"; x: number; y: number };

interface TaskBrowserSession {
  context: BrowserContext;
  page: Page;
  lastUsedAt: number;
  revision: number;
  controller: { userId: string; until: number } | null;
  queue: Promise<unknown>;
}

export class TaskBrowserSessionManager {
  private browserPromise: Promise<Browser> | null = null;
  private stopping = false;
  private readonly sessions = new Map<string, Promise<TaskBrowserSession>>();
  private readonly sweepTimer = setInterval(() => { void this.sweep(); }, 60_000);

  constructor() { this.sweepTimer.unref?.(); }

  private async browser(): Promise<Browser> {
    if (!this.browserPromise) {
      this.browserPromise = chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] })
        .catch((error: unknown) => {
          this.browserPromise = null;
          throw error;
        });
    }
    return this.browserPromise;
  }

  private async session(issueId: string): Promise<TaskBrowserSession> {
    if (this.stopping) throw conflict("The task browser is restarting. Retry in a moment.");
    let promise = this.sessions.get(issueId);
    if (!promise) {
      if (this.sessions.size >= MAX_SESSIONS) {
        const candidates = await Promise.all([...this.sessions.entries()].map(async ([id, pending]) => ({ id, session: await pending.catch(() => null) })));
        const oldest = candidates.filter((candidate) => candidate.session && (!candidate.session.controller || candidate.session.controller.until <= Date.now()))
          .sort((left, right) => left.session!.lastUsedAt - right.session!.lastUsedAt)[0];
        if (!oldest) throw conflict("Too many active task browsers. Release an operator session and retry.");
        await this.close(oldest.id);
      }
      promise = (async () => {
        const context = await (await this.browser()).newContext({ viewport: VIEWPORT, acceptDownloads: false });
        const page = await context.newPage();
        return { context, page, lastUsedAt: Date.now(), revision: 0, controller: null, queue: Promise.resolve() };
      })().catch((error: unknown) => {
        this.sessions.delete(issueId);
        throw error;
      });
      this.sessions.set(issueId, promise);
    }
    const session = await promise;
    session.lastUsedAt = Date.now();
    if (session.controller && session.controller.until <= Date.now()) session.controller = null;
    return session;
  }

  private async exclusive<T>(session: TaskBrowserSession, action: () => Promise<T>): Promise<T> {
    const result = session.queue.then(action, action);
    session.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async state(issueId: string) {
    const session = await this.session(issueId);
    return this.exclusive(session, async () => ({
      url: session.page.url(),
      title: await session.page.title().catch(() => ""),
      text: await session.page.locator("body").innerText({ timeout: 2_000 }).then((value) => value.slice(0, 12_000)).catch(() => ""),
      elements: await session.page.evaluate(() => Array.from(document.querySelectorAll("a,button,input,textarea,select,[role=button]"))
        .slice(0, 100).map((element) => ({
          tag: element.tagName.toLowerCase(),
          text: (element.textContent ?? "").trim().slice(0, 120),
          id: element.id || null,
          name: element.getAttribute("name"),
          placeholder: element.getAttribute("placeholder"),
          href: element.getAttribute("href"),
        }))).catch(() => []),
      revision: session.revision,
      control: session.controller ? { by: "human" as const, until: session.controller.until } : { by: "agent" as const, until: null },
      viewport: VIEWPORT,
    }));
  }

  async screenshot(issueId: string) {
    const session = await this.session(issueId);
    return this.exclusive(session, async () => ({
      revision: session.revision,
      data: (await session.page.screenshot({ type: "jpeg", quality: 65, timeout: 10_000 })).toString("base64"),
    }));
  }

  async control(issueId: string, userId: string, operation: "take" | "release") {
    const session = await this.session(issueId);
    return this.exclusive(session, async () => {
      if (operation === "take") {
        if (session.controller && session.controller.userId !== userId) throw conflict("Another operator is controlling this task browser.");
        session.controller = { userId, until: Date.now() + CONTROL_MS };
      } else if (session.controller?.userId === userId) {
        session.controller = null;
      }
      return { by: session.controller ? "human" as const : "agent" as const, until: session.controller?.until ?? null };
    });
  }

  async act(issueId: string, actor: { type: "board" | "agent"; userId?: string }, action: BrowserAction) {
    const session = await this.session(issueId);
    return this.exclusive(session, async () => {
      if (session.controller && (actor.type !== "board" || actor.userId !== session.controller.userId)) {
        throw conflict("The operator has taken control of this task browser.");
      }
      if (actor.type === "board" && !session.controller) throw conflict("Take control of this browser before interacting with it.");
      if (actor.type === "board" && session.controller) session.controller.until = Date.now() + CONTROL_MS;
      const page = session.page;
      switch (action.type) {
        case "navigate": {
          let url: URL;
          try { url = new URL(action.url); } catch { throw badRequest("Enter a complete http or https URL."); }
          if (!(["http:", "https:"].includes(url.protocol))) throw badRequest("Only http and https URLs are supported.");
          await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 20_000 });
          break;
        }
        case "click": await page.mouse.click(action.x, action.y); break;
        case "clickSelector": await page.locator(action.selector).first().click({ timeout: 5_000 }); break;
        case "type":
          if (action.selector) await page.locator(action.selector).first().fill(action.text, { timeout: 5_000 });
          else await page.keyboard.insertText(action.text);
          break;
        case "key": await page.keyboard.press(action.key); break;
        case "scroll": await page.mouse.wheel(action.x, action.y); break;
      }
      session.revision += 1;
      return { url: page.url(), revision: session.revision };
    });
  }

  async close(issueId: string) {
    const pending = this.sessions.get(issueId);
    this.sessions.delete(issueId);
    if (!pending) return;
    const session = await pending.catch(() => null);
    if (session) await session.queue.then(() => session.context.close()).catch(() => undefined);
  }

  private async sweep() {
    for (const [issueId, pending] of this.sessions) {
      const session = await pending.catch(() => null);
      if (session && Date.now() - session.lastUsedAt > IDLE_MS) await this.close(issueId);
    }
  }

  async closeAll() {
    this.stopping = true;
    clearInterval(this.sweepTimer);
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
    if (this.browserPromise) await this.browserPromise.then((browser) => browser.close()).catch(() => undefined);
    this.browserPromise = null;
  }
}

export const taskBrowserSessions = new TaskBrowserSessionManager();
