// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

vi.hoisted(() => {
  const original = window.CSSStyleSheet.prototype.insertRule;
  window.CSSStyleSheet.prototype.insertRule = function (rule: string, index?: number) {
    try { return original.call(this, rule, index); }
    catch { return original.call(this, ".chat-routing-test{}", index); }
  };
});

vi.mock("./hooks/useStreamlinedUiEnabled", () => ({
  useStreamlinedUiEnabled: () => ({ enabled: true, loaded: true }),
}));
vi.mock("./components/Layout", async () => {
  const { Outlet } = await import("react-router-dom");
  return { Layout: () => <Outlet /> };
});
vi.mock("./components/Layout.production", async () => {
  const { Outlet } = await import("react-router-dom");
  return { Layout: () => <Outlet /> };
});
vi.mock("./components/CloudAccessGate", async () => {
  const { Outlet } = await import("react-router-dom");
  return { CloudAccessGate: () => <Outlet /> };
});
vi.mock("./components/OnboardingWizardVariant", () => ({ OnboardingWizardVariant: () => null }));
vi.mock("./pages/PluginPage", () => ({ PluginPage: () => <div>PLUGIN_FALLBACK</div> }));
vi.mock("./pages/NotFound", () => ({ NotFoundPage: () => <div>NOT_FOUND</div> }));
vi.mock("./pages/AgentChat", () => ({
  AgentChat: () => {
    const location = useLocation();
    return <div>{`AGENT_CHAT@${location.pathname}`}</div>;
  },
}));
vi.mock("./pages/AgentChatsHome", () => ({
  AgentChatsHome: () => {
    const location = useLocation();
    return <div>{`CHATS_HOME@${location.pathname}`}</div>;
  },
}));
vi.mock("./context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", issuePrefix: "PAP", name: "Paperclip", status: "active" }],
    selectedCompany: { id: "company-1", issuePrefix: "PAP", name: "Paperclip", status: "active" },
    loading: false,
  }),
  CompanyProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

describe("agent chat routes", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("opens an unprefixed agent chat in the selected company", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => root.render(<MemoryRouter initialEntries={["/chats/test-agent"]}><App /></MemoryRouter>));
    await vi.waitFor(() => expect(container.textContent).toContain("AGENT_CHAT@/PAP/chats/test-agent"));
    flushSync(() => root.unmount());
  });

  it("opens the Chats home in the selected company", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => root.render(<MemoryRouter initialEntries={["/chats"]}><App /></MemoryRouter>));
    await vi.waitFor(() => expect(container.textContent).toContain("CHATS_HOME@/PAP/chats"));
    flushSync(() => root.unmount());
  });
});
