// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BoardQuestionItem } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAttentionApi = vi.hoisted(() => ({
  boardQuestions: vi.fn(),
}));

vi.mock("../api/attention", () => ({
  attentionApi: mockAttentionApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, className, to }: { children: React.ReactNode; className?: string; to: string }) => (
    <a className={className} href={to}>
      {children}
    </a>
  ),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> | undefined;
  flushSync(() => {
    result = callback();
  });
  return result;
}

import { BoardQuestionsInboxView, boardQuestionMatchesSearch } from "./BoardQuestionsInboxView";

function question(overrides: Partial<BoardQuestionItem> = {}): BoardQuestionItem {
  return {
    id: "interaction:card-1",
    kind: "interaction",
    interactionId: "card-1",
    interactionKind: "ask_user_questions",
    issueId: "issue-1",
    issueIdentifier: "REM-12",
    issueTitle: "Renegotiate the dairy supplier",
    issueStatus: "in_progress",
    title: "Pick a supplier",
    question: "Which supplier should we keep?",
    createdAt: "2026-09-30T10:00:00.000Z",
    href: "/REM/issues/REM-12#interaction-card-1",
    ...overrides,
  };
}

function renderWithClient(node: React.ReactNode, container: HTMLDivElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  const root = createRoot(container);
  act(() => {
    root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
  });
  return { root };
}

async function waitFor(predicate: () => boolean, attempts = 30): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error("waitFor predicate did not become true");
}

describe("BoardQuestionsInboxView", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAttentionApi.boardQuestions.mockReset();
  });

  afterEach(() => {
    container.remove();
  });

  it("lists each waiting question with its task, text and a deep link to the card", async () => {
    mockAttentionApi.boardQuestions.mockResolvedValue({
      count: 2,
      items: [
        question(),
        question({
          id: "approval_stage:issue-2",
          kind: "approval_stage",
          interactionId: null,
          interactionKind: null,
          issueId: "issue-2",
          issueIdentifier: "REM-13",
          issueTitle: "Publish the menu",
          title: "Approval requested",
          question: "Check the prices",
          href: "/REM/issues/REM-13",
        }),
      ],
    });
    const { root } = renderWithClient(<BoardQuestionsInboxView companyId="company-1" searchQuery="" />, container);
    await waitFor(() => container.querySelector('[data-testid="board-questions-list"]') !== null);

    expect(mockAttentionApi.boardQuestions).toHaveBeenCalledWith("company-1");
    const links = [...container.querySelectorAll("a")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/REM/issues/REM-12#interaction-card-1",
      "/REM/issues/REM-13",
    ]);
    expect(links[0]?.textContent).toContain("REM-12");
    expect(links[0]?.textContent).toContain("Pick a supplier");
    expect(links[0]?.textContent).toContain("Which supplier should we keep?");
    expect(links[1]?.textContent).toContain("Approval requested");
    act(() => root.unmount());
  });

  it("says so when nothing is waiting", async () => {
    mockAttentionApi.boardQuestions.mockResolvedValue({ count: 0, items: [] });
    const { root } = renderWithClient(<BoardQuestionsInboxView companyId="company-1" searchQuery="" />, container);
    await waitFor(() => container.textContent?.includes("Nothing is waiting for your answer.") ?? false);
    act(() => root.unmount());
  });

  it("matches search against the card, the question and the task", () => {
    expect(boardQuestionMatchesSearch(question(), "dairy")).toBe(true);
    expect(boardQuestionMatchesSearch(question(), "rem-12")).toBe(true);
    expect(boardQuestionMatchesSearch(question(), "keep")).toBe(true);
    expect(boardQuestionMatchesSearch(question(), "bakery")).toBe(false);
  });
});
