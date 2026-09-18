import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ client: vi.fn(), context: vi.fn(), recovery: vi.fn(() => <div>recovery client</div>) }));
vi.mock("next/navigation", () => ({ redirect: (value: string) => { throw Error(`REDIRECT:${value}`); } }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.client }));
vi.mock("@/lib/inbox/supabase-sync-repository", () => ({ createSupabaseInboxRepository: () => ({ getContext: mocks.context }) }));
vi.mock("@/components/inbox-workspace/receipt-recovery", () => ({ InboxReceiptRecovery: mocks.recovery }));
import InboxReceiptRecoveryPage from "./page";

const identity = { orgId: "00000000-0000-4000-8000-000000000051", userId: "00000000-0000-4000-8000-000000000052", sessionId: "00000000-0000-4000-8000-000000000053", accessEpoch: "1", expiresAt: Date.now() + 60_000 };
afterEach(() => cleanup());
beforeEach(() => { mocks.client.mockReset(); mocks.context.mockReset(); mocks.recovery.mockClear(); });

it("derives the recovery identity from authenticated server context", async () => {
  mocks.client.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: identity.userId } }, error: null }) } });
  mocks.context.mockResolvedValue(identity);
  render(await InboxReceiptRecoveryPage());
  expect(screen.getByText("recovery client")).toBeVisible();
  expect(mocks.recovery).toHaveBeenCalledWith(expect.objectContaining({ identity }), undefined);
});

it("fails closed when the authenticated context is unavailable", async () => {
  mocks.client.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: identity.userId } }, error: null }) } });
  mocks.context.mockRejectedValue(Error("missing context"));
  render(await InboxReceiptRecoveryPage());
  expect(screen.getByText("Action recovery unavailable")).toBeVisible();
  expect(screen.getByRole("link", { name: "Back to Messages" })).toHaveAttribute("href", "/messages");
});
