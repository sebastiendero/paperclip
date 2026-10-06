import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowUpRight, CheckCircle2, Eye, MessageCircleQuestion, ShieldCheck } from "lucide-react";
import type { BoardQuestionItem } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AttentionInteractionResolver } from "./AttentionInteractionResolver";
import { useBoardQuestions } from "../hooks/useBoardQuestions";
import { queryKeys } from "../lib/queryKeys";
import { relativeTime } from "../lib/utils";

interface BoardQuestionsInboxViewProps {
  companyId: string;
  searchQuery: string;
  currentUserId?: string | null;
}

export function boardQuestionMatchesSearch(item: BoardQuestionItem, searchQuery: string): boolean {
  const needle = searchQuery.trim().toLowerCase();
  if (!needle) return true;
  return [item.title, item.question, item.issueTitle, item.issueIdentifier]
    .some((value) => value?.toLowerCase().includes(needle));
}

export function BoardQuestionsInboxView({ companyId, searchQuery, currentUserId }: BoardQuestionsInboxViewProps) {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useBoardQuestions(companyId);
  const items = useMemo(
    () => (data?.items ?? []).filter((item) => boardQuestionMatchesSearch(item, searchQuery)),
    [data, searchQuery],
  );

  if (isLoading) {
    return (
      <div data-testid="board-questions-loading" className="space-y-3" aria-busy="true">
        {[0, 1, 2].map((index) => (
          <div key={index} className="h-32 animate-pulse rounded-lg bg-muted/60" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-destructive">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p className="flex-1 text-sm font-medium">Couldn't load the questions waiting for you.</p>
        <Button variant="outline" size="sm" onClick={() => void refetch()}>Retry</Button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <Card className="items-center gap-3 border-border/70 bg-card/40 px-6 py-10 text-center">
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
          <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
        </span>
        <p className="text-sm font-medium text-foreground">
          {searchQuery.trim() ? "No questions match your search." : "Nothing is waiting for your answer."}
        </p>
      </Card>
    );
  }

  return (
    <section aria-label="Questions waiting for your answer" className="space-y-4">
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
        <p className="text-sm font-semibold text-foreground">
          {items.length} {items.length === 1 ? "request needs your input" : "requests need your input"}
        </p>
        <p className="text-xs text-muted-foreground">Answer questions here. Open the task for approvals and reviews.</p>
      </div>
      <ul data-testid="board-questions-list" className="space-y-4">
        {items.map((item) => {
          const Icon = item.kind === "approval_stage" ? ShieldCheck : item.kind === "review_stage" ? Eye : MessageCircleQuestion;
          return (
            <li key={item.id} className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 px-1 text-xs text-muted-foreground">
                <Icon className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                <Link to={item.href} className="font-mono text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {item.issueIdentifier ?? item.issueId.slice(0, 8)}
                </Link>
                <span aria-hidden="true">·</span>
                <span className="min-w-0 flex-1 truncate">{item.issueTitle}</span>
                <time dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString()}>
                  {relativeTime(item.createdAt)}
                </time>
              </div>
              {item.kind === "interaction" && item.interactionId ? (
                <AttentionInteractionResolver
                  companyId={companyId}
                  issueId={item.issueId}
                  interactionId={item.interactionId}
                  currentUserId={currentUserId}
                  onResolved={() => void queryClient.invalidateQueries({ queryKey: queryKeys.boardQuestions(companyId) })}
                />
              ) : (
                <Card className="gap-4 border-amber-500/30 p-5 shadow-sm">
                  <h2 className="text-base font-semibold text-foreground">{item.title}</h2>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{item.question}</p>
                  <div className="flex justify-end border-t border-border/70 pt-3">
                    <Button variant="outline" size="sm" asChild>
                      <Link to={item.href}>Review in task <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" /></Link>
                    </Button>
                  </div>
                </Card>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
