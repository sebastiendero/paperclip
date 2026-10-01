import { and, desc, eq, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, issueThreadInteractions, issues } from "@paperclipai/db";
import type { BoardQuestionItem, BoardQuestionsResponse } from "@paperclipai/shared";
import type { AgentOrgRow } from "./agent-invokability.js";
import { collapsePendingConfirmationsToNewest, isInteractionAddressedToBoardUser } from "./attention.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { executionIssueCondition, visibleIssueCondition } from "./issue-visibility.js";

// A card on a closed issue can no longer be acted on (resolution is refused
// with `interaction_issue_closed`), so it must not count as waiting.
const CLOSED_ISSUE_STATUSES = ["done", "cancelled"];
const QUESTION_MAX_LENGTH = 500;

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function clip(value: string | null): string | null {
  if (!value) return null;
  return value.length > QUESTION_MAX_LENGTH ? `${value.slice(0, QUESTION_MAX_LENGTH - 1)}…` : value;
}

function interactionFallbackTitle(kind: string) {
  switch (kind) {
    case "ask_user_questions":
      return "Questions need answers";
    case "request_confirmation":
      return "Confirmation requested";
    case "request_checkbox_confirmation":
      return "Selection confirmation requested";
    case "request_item_verdicts":
      return "Item verdicts requested";
    case "suggest_tasks":
      return "Suggested tasks need a decision";
    case "connection_intent":
      return "Connection requested";
    default:
      return "Waiting for your answer";
  }
}

/** The question a card asks, as plain text, read from its kind-specific payload. */
export function boardQuestionText(kind: string, payload: unknown, summary: string | null): string | null {
  const record = readRecord(payload);
  if (kind === "ask_user_questions") {
    const prompts = readArray(record.questions)
      .map((question) => readString(readRecord(question).prompt))
      .filter((prompt): prompt is string => prompt !== null);
    if (prompts.length > 0) return clip(prompts.join("\n"));
  }
  if (kind === "suggest_tasks") {
    const titles = readArray(record.tasks)
      .map((task) => readString(readRecord(task).title))
      .filter((title): title is string => title !== null);
    if (titles.length > 0) {
      return clip(`${titles.length} suggested task${titles.length === 1 ? "" : "s"}: ${titles.join(", ")}`);
    }
  }
  if (kind === "connection_intent") {
    const service = readString(record.serviceName) ?? readString(record.serviceSlug);
    const agentName = readString(record.requestingAgentName);
    if (service) return `${agentName ?? "An agent"} asks to connect ${service}.`;
  }
  return clip(readString(record.prompt) ?? readString(record.detailsMarkdown) ?? readString(summary));
}

export function boardQuestionsService(db: Db) {
  return {
    list: async (companyId: string, userId: string): Promise<BoardQuestionsResponse> => {
      const prefix = await db
        .select({ issuePrefix: companies.issuePrefix })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0]?.issuePrefix ?? "PAP");
      const issueHref = (issue: { id: string; identifier: string | null }) =>
        `/${prefix}/issues/${issue.identifier ?? issue.id}`;

      const interactionRows = await db
        .select({
          id: issueThreadInteractions.id,
          issueId: issueThreadInteractions.issueId,
          kind: issueThreadInteractions.kind,
          title: issueThreadInteractions.title,
          summary: issueThreadInteractions.summary,
          payload: issueThreadInteractions.payload,
          addresseeAgentId: issueThreadInteractions.addresseeAgentId,
          addresseeUserId: issueThreadInteractions.addresseeUserId,
          createdAt: issueThreadInteractions.createdAt,
          issueIdentifier: issues.identifier,
          issueTitle: issues.title,
          issueStatus: issues.status,
        })
        .from(issueThreadInteractions)
        .innerJoin(issues, eq(issueThreadInteractions.issueId, issues.id))
        .where(and(
          eq(issueThreadInteractions.companyId, companyId),
          eq(issues.companyId, companyId),
          eq(issueThreadInteractions.status, "pending"),
          notInArray(issues.status, CLOSED_ISSUE_STATUSES),
          visibleIssueCondition(),
        ))
        .orderBy(desc(issueThreadInteractions.createdAt), desc(issueThreadInteractions.id));

      const companyAgentRows: AgentOrgRow[] = interactionRows.some((row) => row.addresseeAgentId !== null)
        ? await db
          .select({
            id: agents.id,
            companyId: agents.companyId,
            name: agents.name,
            reportsTo: agents.reportsTo,
            status: agents.status,
          })
          .from(agents)
          .where(eq(agents.companyId, companyId))
        : [];
      const companyAgentMap = new Map(companyAgentRows.map((agent) => [agent.id, agent]));
      const visibleInteractions = collapsePendingConfirmationsToNewest(
        interactionRows.filter((row) =>
          isInteractionAddressedToBoardUser(row, userId, companyAgentMap, companyAgentRows)
        ),
      );

      const items: BoardQuestionItem[] = visibleInteractions.map((row) => ({
        id: `interaction:${row.id}`,
        kind: "interaction",
        interactionId: row.id,
        interactionKind: row.kind,
        issueId: row.issueId,
        issueIdentifier: row.issueIdentifier,
        issueTitle: row.issueTitle,
        issueStatus: row.issueStatus,
        title: readString(row.title) ?? interactionFallbackTitle(row.kind),
        question: boardQuestionText(row.kind, row.payload, row.summary),
        createdAt: row.createdAt.toISOString(),
        href: `${issueHref({ id: row.issueId, identifier: row.issueIdentifier })}#interaction-${row.id}`,
      }));

      // An issue that already shows a pending card is answered through that
      // card; listing its approval stage too would count one wait twice.
      const issuesWithCard = new Set(visibleInteractions.map((row) => row.issueId));
      const reviewRows = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          executionState: issues.executionState,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.status, "in_review"), executionIssueCondition()))
        .orderBy(desc(issues.updatedAt), desc(issues.id));

      for (const row of reviewRows) {
        if (issuesWithCard.has(row.id)) continue;
        const state = parseIssueExecutionState(row.executionState);
        if (!state || state.status !== "pending" || state.currentStageType !== "approval") continue;
        const participant = state.currentParticipant;
        if (participant?.type !== "user") continue;
        if (participant.userId && participant.userId !== userId) continue;
        items.push({
          id: `approval_stage:${row.id}`,
          kind: "approval_stage",
          interactionId: null,
          interactionKind: null,
          issueId: row.id,
          issueIdentifier: row.identifier,
          issueTitle: row.title,
          issueStatus: row.status,
          title: "Approval requested",
          question: clip(readString(state.reviewRequest?.instructions)) ?? `Approve "${row.title}"?`,
          createdAt: row.updatedAt.toISOString(),
          href: issueHref(row),
        });
      }

      items.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
      return { items, count: items.length };
    },
  };
}
