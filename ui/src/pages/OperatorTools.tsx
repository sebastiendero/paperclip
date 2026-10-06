import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Globe2, ShieldAlert, TerminalSquare } from "lucide-react";
import { accessApi } from "@/api/access";
import { Button } from "@/components/ui/button";
import { TaskBrowserPanel } from "@/components/task-side-panel/TaskBrowserPanel";
import { TaskTerminalPanel } from "@/components/task-side-panel/TaskTerminalPanel";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";

export function OperatorTools() {
  const { selectedCompanyId } = useCompany();
  const [tab, setTab] = useState<"browser" | "terminal">("browser");
  const access = useQuery({ queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(), retry: false });

  if (access.isPending) return <div className="p-6 text-sm text-muted-foreground">Loading tools…</div>;
  if (!selectedCompanyId) return <div className="p-6 text-sm text-muted-foreground">Select a company to open your tools.</div>;
  if (!access.data?.isInstanceAdmin && access.data?.source !== "local_implicit") {
    return <div className="mx-auto mt-12 max-w-xl rounded-lg border border-border bg-card p-6">
      <h1 className="flex items-center gap-2 text-lg font-semibold"><ShieldAlert className="size-5" />Administrator access required</h1>
      <p className="mt-2 text-sm text-muted-foreground">The direct browser and server terminal are reserved for Paperclip instance administrators.</p>
    </div>;
  }

  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
      <div>
        <h1 className="text-lg font-semibold">Browser &amp; Terminal</h1>
        <p className="text-xs text-muted-foreground">Your own session, available outside any task.</p>
      </div>
      <div className="flex items-center gap-1 rounded-lg border border-border p-1" role="tablist" aria-label="Operator tools">
        <Button role="tab" aria-selected={tab === "browser"} variant={tab === "browser" ? "secondary" : "ghost"} size="sm" onClick={() => setTab("browser")}><Globe2 aria-hidden />Browser</Button>
        <Button role="tab" aria-selected={tab === "terminal"} variant={tab === "terminal" ? "secondary" : "ghost"} size="sm" onClick={() => setTab("terminal")}><TerminalSquare aria-hidden />Terminal</Button>
      </div>
    </div>
    <div className="min-h-0 flex-1" role="tabpanel" key={`${selectedCompanyId}:${tab}`}>
      {tab === "browser" ? <TaskBrowserPanel companyId={selectedCompanyId} /> : <TaskTerminalPanel companyId={selectedCompanyId} />}
    </div>
  </div>;
}
