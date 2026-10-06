import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent, type WheelEvent } from "react";
import { ArrowRight, Hand, Maximize2, Minimize2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { operatorToolsApi, taskToolsApi, type TaskBrowserAction, type TaskBrowserState } from "@/api/task-tools";
import { cn } from "@/lib/utils";
import type { WorkspaceRuntimeService } from "@paperclipai/shared";

export function TaskBrowserPanel({ issueId, companyId, runtimeServices = [] }: { issueId?: string; companyId?: string; runtimeServices?: WorkspaceRuntimeService[] }) {
  const targetId = companyId ?? issueId!;
  const toolsApi = companyId ? operatorToolsApi : taskToolsApi;
  const [state, setState] = useState<TaskBrowserState | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await toolsApi.browserState(targetId);
      if (!mounted.current) return;
      setState(next);
      setUrl((current) => document.activeElement?.getAttribute("data-task-browser-url") === "true" ? current : next.url === "about:blank" ? current : next.url);
      const screenshot = await toolsApi.browserScreenshot(targetId);
      if (mounted.current) setImage(`data:image/jpeg;base64,${screenshot.data}`);
      setError(null);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Browser unavailable.");
    }
  }, [targetId, toolsApi]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 2_000);
    return () => { mounted.current = false; window.clearInterval(interval); };
  }, [refresh]);

  const act = useCallback(async (action: TaskBrowserAction) => {
    setBusy(true);
    setError(null);
    try {
      await toolsApi.browserAction(targetId, action);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Browser action failed.");
    } finally { setBusy(false); }
  }, [targetId, toolsApi, refresh]);

  const control = async (operation: "take" | "release") => {
    setBusy(true);
    try { await toolsApi.browserControl(targetId, operation); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Control change failed."); }
    finally { setBusy(false); }
  };

  const controlled = state?.control.by === "human";
  const submitUrl = (event: FormEvent) => {
    event.preventDefault();
    if (!url.trim()) return;
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        if (!controlled) await toolsApi.browserControl(targetId, "take");
        await toolsApi.browserAction(targetId, { type: "navigate", url: /^https?:\/\//i.test(url) ? url : `https://${url}` });
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not open this address.");
      } finally { setBusy(false); }
    })();
  };
  const clickImage = (event: MouseEvent<HTMLImageElement>) => {
    if (!controlled || !state) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.round((event.clientX - rect.left) * state.viewport.width / rect.width);
    const y = Math.round((event.clientY - rect.top) * state.viewport.height / rect.height);
    void act({ type: "click", x, y });
  };
  const scrollImage = (event: WheelEvent<HTMLImageElement>) => {
    if (!controlled) return;
    void act({ type: "scroll", x: Math.round(event.deltaX), y: Math.round(event.deltaY) });
  };

  return <div className={cn("flex h-full min-h-0 flex-col bg-card", expanded && "fixed inset-4 z-50 h-auto rounded-lg border border-border shadow-xl")}>
    <div className="space-y-2 border-b border-border p-3">
      <div className="flex items-center gap-2">
        <form onSubmit={submitUrl} className="flex min-w-0 flex-1 items-center gap-1">
          <Input data-task-browser-url="true" aria-label="Browser address" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com" className="min-w-0 flex-1 font-mono text-xs" />
          <Button type="submit" size="icon-sm" variant="outline" aria-label="Open address" disabled={busy || !url.trim()}><ArrowRight aria-hidden /></Button>
        </form>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Refresh browser view" onClick={() => void refresh()}><RefreshCw aria-hidden /></Button>
        <Button type="button" size="icon-sm" variant="ghost" aria-label={expanded ? "Restore browser panel" : "Expand browser"} onClick={() => setExpanded((value) => !value)}>{expanded ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}</Button>
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate">{controlled ? "You are controlling this browser" : companyId ? "Your browser · enter an address above" : "Agent browser · live view"}</span>
        <Button type="button" size="sm" variant={controlled ? "outline" : "default"} disabled={busy} onClick={() => void control(controlled ? "release" : "take")}><Hand aria-hidden />{controlled ? "Release" : "Take control"}</Button>
      </div>
      {runtimeServices.some((service) => service.url?.startsWith("http")) && <div className="flex gap-1 overflow-x-auto" aria-label="Task service previews">
        {runtimeServices.filter((service) => service.url?.startsWith("http")).map((service) => <Button
          key={service.id} type="button" size="sm" variant="outline" className="shrink-0"
          disabled={!controlled || busy || !service.url}
          onClick={() => { if (service.url) void act({ type: "navigate", url: service.url }); }}
          title={service.url ?? undefined}
        >{service.serviceName}</Button>)}
      </div>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
    <div className="min-h-0 flex-1 overflow-auto bg-muted/20 p-2">
      {state?.url === "about:blank" ? <div className="flex h-full min-h-64 flex-col items-center justify-center gap-2 text-center"><p className="text-sm font-medium">Open a website</p><p className="max-w-sm text-xs text-muted-foreground">Enter its address above and press Enter. Browser control starts automatically.</p></div> : image ? <img src={image} alt={state?.title ? `Current browser page: ${state.title}` : "Current browser page"} onClick={clickImage} onWheel={scrollImage} className="mx-auto block w-full max-w-7xl border border-border bg-card" /> : <p className="p-3 text-sm text-muted-foreground">Opening browser…</p>}
    </div>
    <form onSubmit={(event) => { event.preventDefault(); if (controlled && text) { void act({ type: "type", text }); setText(""); } }} className="flex gap-2 border-t border-border p-2">
      <Input aria-label="Type into focused browser field" value={text} onChange={(event) => setText(event.target.value)} placeholder="Type into the selected field" disabled={!controlled} className="min-w-0 flex-1" />
      <Button type="submit" size="sm" disabled={!controlled || busy || !text}>Type</Button>
      <Button type="button" size="sm" variant="outline" disabled={!controlled || busy} onClick={() => void act({ type: "key", key: "Enter" })}>Enter</Button>
    </form>
  </div>;
}
