import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ client: vi.fn(), receipt: vi.fn(() => <div>receipt client</div>) }));
vi.mock("next/navigation", () => ({ notFound: () => { throw Error("NOT_FOUND"); }, redirect: (value: string) => { throw Error(`REDIRECT:${value}`); } }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.client }));
vi.mock("@/components/inbox-workspace/operation-receipt", () => ({ InboxOperationReceipt: mocks.receipt }));
import InboxOperationReceiptPage from "./page";

const operationId = "00000000-0000-4000-8000-000000000041";
afterEach(() => cleanup());
beforeEach(() => { mocks.client.mockReset(); mocks.receipt.mockClear(); });

it("rejects malformed operation IDs before reading authenticated data", async () => {
  await expect(InboxOperationReceiptPage({ params: Promise.resolve({ operationId: "not-an-id" }) })).rejects.toThrow("NOT_FOUND");
  expect(mocks.client).not.toHaveBeenCalled();
});

it("requires authentication while remaining independent of Inbox workspace admission", async () => {
  mocks.client.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user" } }, error: null }) } });
  render(await InboxOperationReceiptPage({ params: Promise.resolve({ operationId }) }));
  expect(screen.getByText("receipt client")).toBeVisible();
  expect(mocks.receipt).toHaveBeenCalledWith(expect.objectContaining({ operationId, kind: "metadata" }), undefined);
});

it("redirects unauthenticated visitors instead of exposing receipt existence", async () => {
  mocks.client.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }) } });
  await expect(InboxOperationReceiptPage({ params: Promise.resolve({ operationId }) })).rejects.toThrow("REDIRECT:/login");
});
