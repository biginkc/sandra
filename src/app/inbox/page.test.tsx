import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ client: vi.fn(), context: vi.fn(), getUser: vi.fn(), memberships: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: () => { throw Error("NOT_FOUND"); } }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.client }));
vi.mock("@/lib/auth/memberships", () => ({ getCallerMembershipsOrThrow: mocks.memberships }));
vi.mock("@/lib/inbox/supabase-sync-repository", () => ({ createSupabaseInboxRepository: () => ({ getContext: mocks.context }) }));
vi.mock("@/components/inbox-workspace/workspace-client", () => ({ InboxWorkspaceClient: () => <div>Authenticated workspace</div> }));
import InboxPage from "./page";
const PILOT_USER = "pilot-user-1";
beforeEach(() => {
  mocks.client.mockReset(); mocks.context.mockReset(); mocks.getUser.mockReset(); mocks.memberships.mockReset();
  vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "1");
  vi.stubEnv("INBOX_WORKSPACE_PILOT_USER_IDS", PILOT_USER);
  mocks.client.mockResolvedValue({ auth: { getUser: mocks.getUser } });
  mocks.getUser.mockResolvedValue({ data: { user: { id: PILOT_USER } } });
  mocks.memberships.mockResolvedValue([{ user_id: PILOT_USER, org_id: "org", role: "owner", acquisitions_enabled: false, access_status: "active" }]);
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });
it("returns not found before even constructing a database client when disabled", async () => {
  vi.stubEnv("INBOX_WORKSPACE_SERVER_ENABLED", "0");
  await expect(InboxPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NOT_FOUND");
  expect(mocks.client).not.toHaveBeenCalled();
});
it("returns not found for a user outside the pilot allowlist without calling the context RPC (GL-4/G5)", async () => {
  mocks.getUser.mockResolvedValue({ data: { user: { id: "not-piloted-user" } } });
  await expect(InboxPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NOT_FOUND");
  expect(mocks.context).not.toHaveBeenCalled();
});
it("returns not found for an acquisitions-only member before calling the context RPC", async () => {
  vi.stubEnv("INBOX_WORKSPACE_ROLLOUT_MODE", "all");
  mocks.memberships.mockResolvedValue([{ user_id: PILOT_USER, org_id: "org", role: "member", acquisitions_enabled: true, access_status: "active" }]);
  await expect(InboxPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NOT_FOUND");
  expect(mocks.context).not.toHaveBeenCalled();
});
// MUTATION: removing the pilot cohort check in page.tsx makes this test fail —
// an out-of-cohort user would reach getContext() (an inbox_* RPC) instead of
// being turned away before it runs.
it("returns not found when the allowlist is empty (default = nobody), even for an authenticated user", async () => {
  vi.stubEnv("INBOX_WORKSPACE_PILOT_USER_IDS", undefined);
  await expect(InboxPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NOT_FOUND");
  expect(mocks.context).not.toHaveBeenCalled();
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
