# Task Terminal Implementation Plan

> **For agentic workers:** Execute this plan task by task. The workspace and authentication checks are part of every step.

**Goal:** Give the board an interactive terminal inside each task with a local execution workspace, while the agent's existing run transcript remains visible in the task.

**Architecture:** A task-scoped terminal manager owns one PTY process per task and streams it over an authenticated WebSocket. A short-lived token minted by a company-scoped issue route authorizes a board connection. The task side panel reuses xterm and opens a Terminal tab. The manager never executes a shell for a task with no active local filesystem workspace.

**Tech Stack:** Express, `ws`, Node child processes, `script` PTY, React, xterm, Vitest.

**Spec:** This plan records the user decision of 2026-10-06: Terminal inside each task, for the operator and agent work on that task.

## Global constraints

- Resolve the task through `getAccessibleResource` and enforce board authorization before minting a terminal token.
- Resolve workspace path from the task's current `executionWorkspaceId`; require `providerType === "local_fs"`, `status === "active"`, and an existing absolute `cwd`.
- Tokens expire after 60 seconds, are single use, and never appear in URLs or logs.
- Close PTYs on server shutdown and after 15 minutes without a viewer.
- Follow `DESIGN.md` tokens and run `pnpm check:token-gates`.

## Task 1: Server terminal session

**Files:** `server/src/services/task-terminal-sessions.ts`, `server/src/routes/task-terminal.ts`, `server/src/realtime/task-terminal-ws.ts`, `server/src/app.ts`, `server/src/index.ts`.

**Interface:** `mint(issueId, actorId): { token, websocketPath }`; `attach(issueId, token, socket): void`; `closeAll(): void`.

- [ ] Test that a foreign company, viewer, agent, and task without an active local workspace cannot mint a token.
- [ ] Test that a token is single use and that disconnected viewers cannot leave a shell alive indefinitely.
- [ ] Implement the manager and route, then mount the WebSocket handler on the HTTP server.
- [ ] Run focused server tests and typecheck.

## Task 2: Task panel terminal

**Files:** `ui/src/components/task-side-panel/TaskTerminalPanel.tsx`, `ui/src/components/task-side-panel/TaskSidePanel.tsx`, `ui/src/lib/task-side-panel-state.ts`, `ui/src/api/task-tools.ts`.

**Interface:** `TaskTerminalPanel({ issueId, active })` requests a token only when opened, connects to the same-origin WebSocket, renders xterm, sends input and resize frames, and reports reconnect/errors inline.

- [ ] Test that opening a Terminal tab displays the correct empty state for tasks with no workspace.
- [ ] Test input, resize, disconnect, and reconnect behavior with a fake WebSocket.
- [ ] Add the Terminal launcher item and persisted tab payload; render the panel.
- [ ] Run focused UI tests, typecheck, build, and token gates.

## Task 3: Live proof

- [ ] Build on the Paperclip server without restarting active agent runs until the build passes.
- [ ] Open a task with a local workspace, run `pwd` in the terminal, and confirm its path equals that task's workspace.
- [ ] Confirm a task from another company and a task with no local workspace cannot open a shell.
