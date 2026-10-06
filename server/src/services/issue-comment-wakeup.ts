import { allowsParkedIssueWake } from "../lib/issue-wake-policy.js";

export function shouldWakeAssigneeForIssueComment(input: {
  selfComment: boolean;
  requestedByActorType?: "user" | "agent" | "system";
  resumeRequested: boolean;
  commentCreatedByRunId?: string | null;
  issueAtCommentStart: {
    checkoutRunId?: string | null;
    executionRunId?: string | null;
  };
  reopened: boolean;
  currentStatus: string | null | undefined;
}) {
  if (!allowsParkedIssueWake({
    issueStatus: input.currentStatus, wakeReason: "issue_commented",
    requestedByActorType: input.requestedByActorType,
  })) return false;
  const sourceRunId = input.commentCreatedByRunId;
  const commentIsFromCurrentIssueRun = Boolean(
    sourceRunId &&
    (sourceRunId === input.issueAtCommentStart.checkoutRunId ||
      sourceRunId === input.issueAtCommentStart.executionRunId),
  );
  if (
    input.selfComment &&
    (!input.resumeRequested || commentIsFromCurrentIssueRun)
  ) {
    return false;
  }
  return (
    input.reopened ||
    (input.currentStatus !== "done" && input.currentStatus !== "cancelled")
  );
}
