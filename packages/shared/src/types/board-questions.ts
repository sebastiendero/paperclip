/**
 * One thing waiting on the signed-in board user: a pending thread interaction
 * card addressed to them, or an issue whose current execution stage is a
 * board approval.
 */
export type BoardQuestionKind = "interaction" | "approval_stage";

export interface BoardQuestionItem {
  /** Stable key: `interaction:<id>` or `approval_stage:<issueId>`. */
  id: string;
  kind: BoardQuestionKind;
  interactionId: string | null;
  /** Interaction kind (`ask_user_questions`, `request_confirmation`, ...); null for approval stages. */
  interactionKind: string | null;
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string;
  issueStatus: string;
  title: string;
  /** The question in plain text, or null when the card carries none. */
  question: string | null;
  createdAt: string;
  /** Company-prefixed link to the card (or the issue) in the thread. */
  href: string;
}

export interface BoardQuestionsResponse {
  items: BoardQuestionItem[];
  count: number;
}
