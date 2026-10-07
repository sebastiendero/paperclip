import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowUpRight, MessageCircle, Send, X } from "lucide-react";
import { agentChatsApi } from "@/api/agentChats";
import { agentsApi } from "@/api/agents";
import { authApi } from "@/api/auth";
import { heartbeatsApi } from "@/api/heartbeats";
import { issuesApi } from "@/api/issues";
import { AgentIcon } from "@/components/AgentIconPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCompany } from "@/context/CompanyContext";
import { useAgentChatEnabled } from "@/hooks/useAgentChatEnabled";
import { recordAgentChatVisit, useRecentAgentChats } from "@/lib/recent-agent-chats";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { agentRouteRef, cn } from "@/lib/utils";
import { CommentSubmissionUnknownError } from "@/lib/comment-submit-result";
import type { Agent, IssueComment } from "@paperclipai/shared";

interface PendingMessage {
  agentId: string;
  body: string;
  requestId: string;
  confirmedId?: string;
  status: "sending" | "confirmed" | "unconfirmed";
}

export function FloatingAgentChat() {
  const { selectedCompanyId } = useCompany();
  const { enabled } = useAgentChatEnabled();
  if (!enabled || !selectedCompanyId) return null;
  return <CompanyFloatingAgentChat key={selectedCompanyId} companyId={selectedCompanyId} />;
}

function CompanyFloatingAgentChat({ companyId }: { companyId: string }) {
  const [open, setOpen] = useState(false);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [pendingMessage, setPendingMessage] = useState<PendingMessage | null>(null);
  const [autoOpenLastChat, setAutoOpenLastChat] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const client = useQueryClient();
  const session = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: true,
  });
  const userId = session.data?.user?.id ?? session.data?.session?.userId;
  const recentIds = useRecentAgentChats(companyId, userId);
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: open,
  });
  const agent = agents.data?.find((item) => item.id === agentId);
  const chatKey = queryKeys.agentChats.detail(companyId, userId ?? null, agentId ?? undefined);
  const chat = useQuery({
    queryKey: chatKey,
    queryFn: () => agentChatsApi.get(companyId, agentId!),
    enabled: open && !!agentId,
    refetchInterval: open && agentId ? 5000 : false,
  });
  const issueId = chat.data?.id;
  const liveRuns = useQuery({
    queryKey: queryKeys.issues.liveRuns(issueId!),
    queryFn: () => heartbeatsApi.liveRunsForIssue(issueId!),
    enabled: open && !!issueId,
    refetchInterval: open && issueId ? 2000 : false,
  });
  const comments = useQuery({
    queryKey: queryKeys.issues.comments(issueId!),
    queryFn: () => issuesApi.listComments(issueId!, { order: "desc", limit: 100 }),
    enabled: open && !!issueId,
    refetchInterval: open && issueId ? 3000 : false,
  });
  const visibleComments = [...(comments.data ?? [])].reverse().filter((comment) => !comment.deletedAt);
  const lastComment = visibleComments.at(-1);
  const pendingForAgent = pendingMessage?.agentId === agentId && !visibleComments.some(
    (comment) => comment.id === pendingMessage.confirmedId || comment.clientRequestId === pendingMessage.requestId,
  ) ? pendingMessage : null;
  const awaitingReply = !!(pendingForAgent && pendingForAgent.status !== "unconfirmed") || !!(lastComment && !lastComment.authorAgentId && !lastComment.derivedAuthorAgentId && lastComment.authorType !== "agent");
  const activeRun = awaitingReply ? liveRuns.data?.find((run) => run.agentId === agentId) : undefined;

  useEffect(() => {
    if (!open || !autoOpenLastChat || !session.isFetched || !agents.data) return;
    const mostRecent = recentIds.find((id) => agents.data.some((item) => item.id === id));
    setAgentId(mostRecent ?? null);
    setAutoOpenLastChat(false);
  }, [open, autoOpenLastChat, session.isFetched, agents.data, recentIds]);

  useEffect(() => {
    if (open && agentId) inputRef.current?.focus();
  }, [open, agentId]);
  useEffect(() => {
    if (open && agentId) messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [open, agentId, visibleComments.length, pendingForAgent?.requestId, activeRun?.currentStatusMessage]);
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const body = draft.trim();
    if (!body || !agentId || sending || chat.isPending || chat.isError) return;
    const requestId = crypto.randomUUID();
    setPendingMessage({ agentId, body, requestId, status: "sending" });
    setDraft("");
    setSending(true);
    setSendError(null);
    try {
      const issue = chat.data ?? await agentChatsApi.ensure(companyId, agentId);
      client.setQueryData(chatKey, issue);
      const confirmed = await issuesApi.addComment(issue.id, body, undefined, undefined, undefined, requestId);
      setPendingMessage((current) => current?.requestId === requestId ? { ...current, confirmedId: confirmed.id, status: "confirmed" } : current);
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.issues.comments(issue.id) }),
        client.invalidateQueries({ queryKey: chatKey }),
        client.invalidateQueries({ queryKey: ["agent-chat", "recent-previews", companyId] }),
      ]);
      inputRef.current?.focus();
    } catch (error) {
      if (error instanceof CommentSubmissionUnknownError) {
        setPendingMessage((current) => current?.requestId === requestId ? { ...current, status: "unconfirmed" } : current);
        setSendError("Message delivery could not be confirmed. Check the conversation before sending it again.");
        if (issueId) void client.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId) });
      } else {
        setPendingMessage((current) => current?.requestId === requestId ? null : current);
        setDraft((current) => current || body);
        setSendError(error instanceof Error ? error.message : "Couldn’t send your message.");
      }
    } finally {
      setSending(false);
    }
  }

  const query = search.trim().toLocaleLowerCase();
  const recentOrder = new Map(recentIds.map((id, index) => [id, index]));
  const visibleAgents = [...(agents.data ?? [])]
    .filter((item) => !query || `${item.name} ${item.title ?? ""} ${item.role}`.toLocaleLowerCase().includes(query))
    .sort((left, right) =>
      (recentOrder.get(left.id) ?? Infinity) - (recentOrder.get(right.id) ?? Infinity)
      || left.name.localeCompare(right.name),
    );

  return (
    <div className="fixed inset-x-3 bottom-20 z-40 flex flex-col items-end sm:inset-x-auto sm:right-6 sm:bottom-6">
      {open && (
        <section
          aria-label={agent ? `Chat with ${agent.name}` : "Agent chats"}
          className="mb-3 flex h-(--sz-70vh) max-h-(--sz-85dvh) w-full flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-xl sm:w-96"
        >
          <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-3">
            {agent ? (
              <Button variant="ghost" size="sm" aria-label="Choose another agent" onClick={() => { setAgentId(null); setSendError(null); }}>
                <ArrowLeft className="size-4" /> Chats
              </Button>
            ) : <MessageCircle aria-hidden className="ml-1 size-5 text-primary" />}
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-semibold">{agent?.name ?? "Chats"}</h2>
              <p className="truncate text-xs text-muted-foreground">{agent ? (agent.title ?? agent.role) : "Talk directly with an agent"}</p>
            </div>
            {agent && (
              <Button variant="ghost" size="icon-sm" asChild aria-label="Open full conversation">
                <Link to={`/chats/${encodeURIComponent(agentRouteRef(agent))}`} onClick={() => setOpen(false)}>
                  <ArrowUpRight className="size-4" />
                </Link>
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" aria-label="Close chat" onClick={() => setOpen(false)}>
              <X className="size-4" />
            </Button>
          </header>

          {agent ? (
            <>
              <div role="log" aria-label="Messages" className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-muted/20 px-4 py-4">
                {chat.isPending || (issueId && comments.isPending) ? <p role="status" className="text-sm text-muted-foreground">Loading conversation…</p> : null}
                {chat.isError || comments.isError ? (
                  <div role="alert" className="space-y-2 text-sm text-destructive">
                    <p>Couldn’t load this conversation.</p>
                    <Button variant="outline" size="sm" onClick={() => { void chat.refetch(); void comments.refetch(); }}>Retry</Button>
                  </div>
                ) : null}
                {!chat.isPending && !chat.isError && !comments.isPending && visibleComments.length === 0 ? (
                  <p className="pt-10 text-center text-sm text-muted-foreground">Say hello to {agent.name}. Your conversation will appear here.</p>
                ) : null}
                {visibleComments.map((comment) => {
                  const fromAgent = !!(comment.authorAgentId || comment.derivedAuthorAgentId || comment.authorType === "agent");
                  return (
                    <div key={comment.id} className={cn("flex", fromAgent ? "justify-start" : "justify-end")}>
                      <div className={cn("max-w-(--pct-90) whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm leading-relaxed", fromAgent ? "rounded-bl-sm border border-border bg-background text-foreground" : "rounded-br-sm bg-primary text-primary-foreground")}>
                        {comment.body}
                      </div>
                    </div>
                  );
                })}
                {pendingForAgent ? (
                  <div className="flex justify-end">
                    <div className="max-w-(--pct-90) whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm leading-relaxed text-primary-foreground opacity-70">
                      {pendingForAgent.body}
                      <span className="mt-1 block text-xs">{pendingForAgent.status === "sending" ? "Sending…" : pendingForAgent.status === "unconfirmed" ? "Delivery unconfirmed" : "Sent"}</span>
                    </div>
                  </div>
                ) : null}
                {activeRun ? (
                  <div role="status" className="flex items-start gap-2 text-xs text-muted-foreground">
                    <span aria-hidden className="mt-1 size-2 shrink-0 animate-pulse rounded-full bg-primary" />
                    <span><span className="block font-medium text-foreground">{agent.name} is replying…</span>{activeRun.currentStatusMessage || activeRun.lastAssistantSnippet ? <span className="block">{activeRun.currentStatusMessage ?? activeRun.lastAssistantSnippet}</span> : null}</span>
                  </div>
                ) : awaitingReply ? (
                  <p role="status" className="text-xs text-muted-foreground">Waiting for {agent.name} to reply…</p>
                ) : null}
                <div ref={messagesEndRef} />
              </div>
              <form onSubmit={(event) => void send(event)} className="shrink-0 border-t border-border bg-background p-3">
                {sendError ? <p role="alert" className="mb-2 text-xs text-destructive">{sendError}</p> : null}
                <div className="flex items-end gap-2">
                  <textarea
                    ref={inputRef}
                    aria-label={`Message ${agent.name}`}
                    placeholder={`Message ${agent.name}…`}
                    rows={2}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        void send();
                      }
                    }}
                    className="min-h-10 max-h-32 min-w-0 flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
                  />
                  <Button type="submit" size="icon" aria-label="Send message" disabled={!draft.trim() || sending || chat.isPending || chat.isError}>
                    <Send className="size-4" />
                  </Button>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">Enter to send · Shift+Enter for a new line</p>
              </form>
            </>
          ) : (
            <>
              {!query ? <RecentConversations
                companyId={companyId}
                userId={userId}
                agents={agents.data ?? []}
                recentIds={recentIds}
                onSelect={(selected) => { setAgentId(selected.id); setDraft(""); setSendError(null); recordAgentChatVisit(companyId, userId, selected.id); }}
              /> : null}
              <div className="border-b border-border px-3 py-3">
                <Input aria-label="Find an agent" placeholder="Find an agent by name or role…" value={search} onChange={(event) => setSearch(event.target.value)} />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto py-1">
                {agents.isPending ? <p role="status" className="px-4 py-3 text-sm text-muted-foreground">Loading agents…</p> : null}
                {agents.isError ? (
                  <div role="alert" className="space-y-2 px-4 py-3 text-sm text-destructive">
                    <p>Couldn’t load agents.</p>
                    <Button variant="outline" size="sm" onClick={() => void agents.refetch()}>Retry</Button>
                  </div>
                ) : null}
                {!agents.isPending && !agents.isError && visibleAgents.length === 0 ? (
                  <p className="px-4 py-3 text-sm text-muted-foreground">{query ? "No agents match your search." : "No agents yet."}</p>
                ) : null}
                {visibleAgents.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => { setAgentId(item.id); setAutoOpenLastChat(false); setDraft(""); setSendError(null); recordAgentChatVisit(companyId, userId, item.id); }}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                  >
                    <AgentIcon icon={item.icon} className="size-9 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{item.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{item.title ?? item.role}</span>
                    </span>
                  </button>
                ))}
              </div>
              <div className="border-t border-border px-4 py-3 text-right">
                <Link to="/chats" onClick={() => setOpen(false)} className="text-xs text-muted-foreground hover:text-foreground">See all chats</Link>
              </div>
            </>
          )}
        </section>
      )}
      <Button
        type="button"
        size="lg"
        aria-label={open ? "Close agent chat" : "Open agent chat"}
        aria-expanded={open}
        onClick={() => {
          if (!open && !agentId) setAutoOpenLastChat(true);
          if (open) setAutoOpenLastChat(false);
          setOpen((current) => !current);
        }}
        className="h-12 rounded-full px-4 shadow-lg"
      >
        <MessageCircle className="size-5" />
        <span>Chats</span>
      </Button>
    </div>
  );
}

function RecentConversations({ companyId, userId, agents, recentIds, onSelect }: {
  companyId: string;
  userId?: string;
  agents: Agent[];
  recentIds: string[];
  onSelect: (agent: Agent) => void;
}) {
  const recentAgents = recentIds.slice(0, 12).flatMap((id) => agents.filter((agent) => agent.id === id));
  const previews = useQuery({
    queryKey: ["agent-chat", "recent-previews", companyId, userId, ...recentAgents.map((agent) => agent.id)],
    queryFn: async () => {
      const results = await Promise.allSettled(recentAgents.map(async (agent) => {
        const conversation = await agentChatsApi.get(companyId, agent.id);
        if (!conversation) return null;
        const latest = await issuesApi.listComments(conversation.id, { order: "desc", limit: 1 });
        return { agent, last: latest[0] ?? null };
      }));
      return {
        rows: results.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []),
        failed: results.some((result) => result.status === "rejected"),
      };
    },
    enabled: recentAgents.length > 0,
    staleTime: 10_000,
  });
  const conversations = previews.data?.rows ?? [];
  if (recentAgents.length === 0) return null;
  return (
    <div className="max-h-48 shrink-0 overflow-y-auto border-b border-border py-2">
      <h3 className="px-4 pb-1 text-xs font-medium text-muted-foreground">Recent conversations</h3>
      {previews.isPending ? <p role="status" className="px-4 py-2 text-xs text-muted-foreground">Loading recent chats…</p> : null}
      {previews.isError || previews.data?.failed ? <p role="alert" className="px-4 py-2 text-xs text-destructive">Some recent chats couldn’t be loaded.</p> : null}
      {conversations.map(({ agent, last }) => (
        <button key={agent.id} type="button" onClick={() => onSelect(agent)} className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none">
          <AgentIcon icon={agent.icon} className="size-8 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{agent.name}</span>
            <span className="block truncate text-xs text-muted-foreground">{last ? `${last.authorAgentId || last.derivedAuthorAgentId || last.authorType === "agent" ? "" : "You: "}${last.body}` : "Conversation started"}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
