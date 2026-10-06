# Task Browser Implementation Plan

> **For agentic workers:** Execute this plan task by task. Each task produces a separately testable contract.

**Goal:** Give each task one browser session that agents can drive and the operator can watch and take over from Paperclip.

**Architecture:** A task browser manager owns one isolated Chromium context per task. An authenticated issue route exposes bounded state, screenshot, navigation, click, typing, keys, scrolling, and a human control lease. Agents use the same route through Paperclip MCP tools. The task side panel polls the shared screenshot and renders the current URL and control owner; taking control pauses agent actions until released or the lease expires.

**Tech Stack:** Express, Playwright, React, Paperclip MCP, Vitest. Chromium is installed for the Paperclip service account at deployment.

**Spec:** User decision of 2026-10-06: Browser inside each task, shared by operator and agents; operator can observe and take control of the same session.

## Global constraints

- Enforce `getAccessibleResource` and issue-level authorization on every request; agents must present the active run for that task.
- Only `http:` and `https:` navigation is accepted. Browser contexts and cookies are isolated by task and deleted at session close.
- Cap active sessions, image size, text output, input length, and idle lifetime. Avoid storing screenshots or cookies in activity logs.
- Agent actions return `409` while the operator holds control. Every mutation logs actor and task ID.
- Use existing UI tokens and keep browser controls keyboard accessible.

## Task 1: Browser manager and route

**Files:** `server/src/services/task-browser-sessions.ts`, `server/src/routes/task-browser.ts`, `server/src/app.ts`, `server/package.json`, `pnpm-lock.yaml`.

**Interface:** `getState(taskId)`, `capture(taskId)`, `act(taskId, actor, action)`, `takeControl(taskId, userId)`, `releaseControl(taskId, userId)`, `closeAll()`.

- [ ] Test isolation, invalid URLs, state updates, human control lease, stale task/run denial, and idle cleanup.
- [ ] Implement Playwright context lifecycle with one page per task and a bounded session cap.
- [ ] Mount GET state/image and POST action/control routes, then run focused tests and typecheck.

## Task 2: Agent browser tools

**Files:** `packages/mcp-server/src/tools.ts`, `packages/mcp-server/src/tools.test.ts`, `server/src/services/heartbeat.ts`.

**Interface:** `paperclipBrowserState`, `paperclipBrowserNavigate`, `paperclipBrowserClick`, `paperclipBrowserType`, and `paperclipBrowserKey` use the current task ID and run token.

- [ ] Test that an agent can navigate and inspect the shared page but receives `409` during human control.
- [ ] Add the MCP tools and concise agent instruction to use them for task browsing.
- [ ] Run MCP tool tests and typecheck.

## Task 3: Shared browser panel

**Files:** `ui/src/components/task-side-panel/TaskBrowserPanel.tsx`, `ui/src/components/task-side-panel/TaskSidePanel.tsx`, `ui/src/lib/task-side-panel-state.ts`, `ui/src/api/task-tools.ts`.

**Interface:** The Browser tab shows URL, live screenshot, status, active controller, and controls for navigate, click, type, key, scroll, take/release control.

- [ ] Test that the tab displays the agent's latest navigation without creating a second browser.
- [ ] Test that clicking and typing target the displayed page only after taking control.
- [ ] Implement the tab and polling; run focused UI tests, typecheck, build, and token gates.

## Task 4: Live proof

- [ ] Install Chromium for the Paperclip service account and verify a browser starts without root privileges.
- [ ] Have an agent navigate a test page; confirm the operator sees the same URL and image.
- [ ] Take control, click/type, confirm the agent receives a control conflict, release, and confirm agent access resumes.
