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

function toolsApi(base: (id: string) => string) {
  return {
    createTerminalSession: (id: string) => api.post<{ token: string; websocketPath: string }>(`${base(id)}/terminal/session`, {}),
    browserState: (id: string) => api.get<TaskBrowserState>(`${base(id)}/browser/state`, { cache: "no-store" }),
    browserScreenshot: (id: string) => api.get<{ revision: number; data: string }>(`${base(id)}/browser/screenshot`, { cache: "no-store" }),
    browserControl: (id: string, operation: "take" | "release") => api.post<TaskBrowserState["control"]>(`${base(id)}/browser/control`, { operation }),
    browserAction: (id: string, action: TaskBrowserAction) => api.post<{ url: string; revision: number }>(`${base(id)}/browser/action`, action),
  };
}

export const taskToolsApi = toolsApi((issueId) => `/issues/${encodeURIComponent(issueId)}`);
export const operatorToolsApi = toolsApi((companyId) => `/companies/${encodeURIComponent(companyId)}/operator`);
