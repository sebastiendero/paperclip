import { useMemo } from "react";
import { AlertTriangle, CheckCircle2, Eye, MessageCircleQuestion, ShieldCheck } from "lucide-react";
import type { BoardQuestionItem } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useBoardQuestions } from "../hooks/useBoardQuestions";
import { relativeTime } from "../lib/utils";

interface BoardQuestionsInboxViewProps {
  companyId: string;
  searchQuery: string;
}

export function boardQuestionMatchesSearch(item: BoardQuestionItem, searchQuery: string): boolean {
  const needle = searchQuery.trim().toLowerCase();
  if (!needle) return true;
  return [item.title, item.question, item.issueTitle, item.issueIdentifier]
    .some((value) => value?.toLowerCase().includes(needle));
}

export function BoardQuestionsInboxView({ companyId, searchQuery }: BoardQuestionsInboxViewProps) {
  const { data, isLoading, error, refetch } = useBoardQuestions(companyId);
  const items = useMemo(
    () => (data?.items ?? []).filter((item) => boardQuestionMatchesSearch(item, searchQuery)),
    [data, searchQuery],
  );

  if (isLoading) {
    return (
      <div data-testid="board-questions-loading" className="space-y-2" aria-busy="true">
        {[0, 1, 2].map((index) => (
          <div key={index} className="h-16 animate-pulse rounded-md bg-muted/60" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-md border border-amber-300/70 bg-amber-50/90 p-4 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p className="flex-1 text-sm font-medium">Couldn't load the questions waiting for you.</p>
        <Button variant="outline" size="sm" className="h-7 shrink-0" onClick={() => void refetch()}>
          Retry
        </Button>
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
    <ul data-testid="board-questions-list" className="divide-y divide-border rounded-md border border-border">
      {items.map((item) => {
        const Icon = item.kind === "approval_stage" ? ShieldCheck : item.kind === "review_stage" ? Eye : MessageCircleQuestion;
        return (
          <li key={item.id}>
            <Link
              to={item.href}
              className="flex items-start gap-3 px-3 py-3 transition-colors hover:bg-accent/50"
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="font-mono text-xs text-muted-foreground">
                    {item.issueIdentifier ?? item.issueId.slice(0, 8)}
                  </span>
                  <span className="text-sm font-medium text-foreground">{item.title}</span>
                </div>
                {item.question ? (
                  <p className="line-clamp-3 whitespace-pre-line text-sm text-foreground/80">{item.question}</p>
                ) : null}
                <p className="truncate text-xs text-muted-foreground">{item.issueTitle}</p>
              </div>
              <time
                dateTime={item.createdAt}
                title={new Date(item.createdAt).toLocaleString()}
                className="shrink-0 text-xs text-muted-foreground"
              >
                {relativeTime(item.createdAt)}
              </time>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
