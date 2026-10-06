/** A parked task needs a new event; scheduler retries alone are not work. */
export function allowsParkedIssueWake(input: {
  issueStatus: string | null | undefined;
  wakeReason: string | null | undefined;
  requestedByActorType?: string | null;
}): boolean {
  if (input.issueStatus !== "blocked" && input.issueStatus !== "backlog") return true;
  return input.wakeReason === "issue_assigned"
    || input.wakeReason === "issue_blockers_resolved"
    || (input.requestedByActorType === "user"
      && ["issue_commented", "issue_resumed", "issue_reopened_via_comment", "issue_status_changed"].includes(input.wakeReason ?? ""));
}
