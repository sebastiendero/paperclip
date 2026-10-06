import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, MessagesSquare } from "lucide-react";
import { agentsApi } from "@/api/agents";
import { authApi } from "@/api/auth";
import { AgentIcon } from "@/components/AgentIconPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCompany } from "@/context/CompanyContext";
import { useAgentChatEnabled } from "@/hooks/useAgentChatEnabled";
import { useRecentAgentChats } from "@/lib/recent-agent-chats";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { agentRouteRef } from "@/lib/utils";

export function AgentChatsHome() {
  const { selectedCompanyId } = useCompany();
  const { enabled, loaded } = useAgentChatEnabled();
  const [search, setSearch] = useState("");
  const session = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const userId = session.data?.user?.id ?? session.data?.session?.userId;
  const recentIds = useRecentAgentChats(selectedCompanyId ?? "", userId);
  const agents = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: enabled && !!selectedCompanyId,
  });

  if (!loaded) return <p className="p-6 text-sm text-muted-foreground">Loading chats…</p>;
  if (!selectedCompanyId) return <p className="p-6 text-sm text-muted-foreground">Select an organization to chat with its agents.</p>;
  if (!enabled) return <p className="p-6 text-sm text-muted-foreground">Agent Chat is disabled in Experimental settings.</p>;

  const query = search.trim().toLocaleLowerCase();
  const recentOrder = new Map(recentIds.map((id, index) => [id, index]));
  const visibleAgents = [...(agents.data ?? [])]
    .filter((agent) => !query || `${agent.name} ${agent.title ?? ""} ${agent.role}`.toLocaleLowerCase().includes(query))
    .sort((left, right) =>
      (recentOrder.get(left.id) ?? Infinity) - (recentOrder.get(right.id) ?? Infinity)
      || left.name.localeCompare(right.name),
    );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-8">
      <header className="space-y-2">
        <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-tight">
          <MessagesSquare aria-hidden className="size-6" /> Chats
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Talk with an agent, ask questions, or ask them to create a task. Each conversation stays here.
        </p>
      </header>

      <Input
        aria-label="Search agents to chat with"
        placeholder="Find an agent by name or role…"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />

      {agents.isPending ? <p role="status" className="text-sm text-muted-foreground">Loading agents…</p> : null}
      {agents.error ? (
        <div role="alert" className="flex items-center gap-3 text-sm text-destructive">
          <span>Couldn’t load agents.</span>
          <Button size="sm" variant="outline" onClick={() => void agents.refetch()}>Retry</Button>
        </div>
      ) : null}
      {!agents.isPending && !agents.error && visibleAgents.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {query ? "No agents match your search." : "No agents yet. Create one from the Agents page to start a chat."}
        </p>
      ) : null}

      {visibleAgents.length > 0 ? (
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {visibleAgents.map((agent) => (
            <Link
              key={agent.id}
              to={`/chats/${encodeURIComponent(agentRouteRef(agent))}`}
              className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
            >
              <AgentIcon icon={agent.icon} className="size-9 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{agent.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{agent.title ?? agent.role}</span>
              </span>
              {recentOrder.has(agent.id) ? <span className="text-xs text-muted-foreground">Recent</span> : null}
              <ArrowRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
