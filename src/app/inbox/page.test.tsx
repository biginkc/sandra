import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ client: vi.fn(), context: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: () => { throw Error("NOT_FOUND"); } }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.client }));
vi.mock("@/lib/inbox/supabase-sync-repository", () => ({ createSupabaseInboxRepository: () => ({ getContext: mocks.context }) }));
vi.mock("@/components/inbox-workspace/workspace-client", () => ({ InboxWorkspaceClient: () => <div>Authenticated workspace</div> }));
import InboxPage from "./page";
beforeEach(() => { mocks.client.mockReset(); mocks.context.mockReset(); vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1"); });
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });
it("returns not found before even constructing a database client when disabled", async () => {
  vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "0");
  await expect(InboxPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NOT_FOUND");
  expect(mocks.client).not.toHaveBeenCalled();
});
it("renders the page only after canonical authorization supplies context", async () => {
  mocks.context.mockResolvedValue({ orgId: "org", userId: "user", sessionId: "session", accessEpoch: "1", expiresAt: Date.now() + 1000 });
  render(await InboxPage({ searchParams: Promise.resolve({ view: "unread" }) }));
  expect(screen.getByText("Authenticated workspace")).toBeVisible();
});
it("fails closed on missing canonical schema without affecting legacy Messages", async () => {
  mocks.context.mockRejectedValue(Error("missing RPC"));
  render(await InboxPage({ searchParams: Promise.resolve({}) }));
  expect(screen.getByText("Inbox workspace unavailable")).toBeVisible();
  expect(screen.queryByText("Authenticated workspace")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Back to Messages" })).toHaveAttribute("href", "/messages");
});
