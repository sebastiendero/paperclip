import { api } from "./client";

export interface TaskBrowserState {
  url: string;
  title: string;
  text: string;
  revision: number;
  control: { by: "human" | "agent"; until: number | null };
  viewport: { width: number; height: number };
}

export type TaskBrowserAction =
  | { type: "navigate"; url: string }
  | { type: "click"; x: number; y: number }
  | { type: "type"; text: string }
  | { type: "key"; key: string }
  | { type: "scroll"; x: number; y: number };

function base(issueId: string) { return `/issues/${encodeURIComponent(issueId)}`; }

export const taskToolsApi = {
  createTerminalSession: (issueId: string) => api.post<{ token: string; websocketPath: string }>(`${base(issueId)}/terminal/session`, {}),
  browserState: (issueId: string) => api.get<TaskBrowserState>(`${base(issueId)}/browser/state`, { cache: "no-store" }),
  browserScreenshot: (issueId: string) => api.get<{ revision: number; data: string }>(`${base(issueId)}/browser/screenshot`, { cache: "no-store" }),
  browserControl: (issueId: string, operation: "take" | "release") => api.post<TaskBrowserState["control"]>(`${base(issueId)}/browser/control`, { operation }),
  browserAction: (issueId: string, action: TaskBrowserAction) => api.post<{ url: string; revision: number }>(`${base(issueId)}/browser/action`, action),
};
