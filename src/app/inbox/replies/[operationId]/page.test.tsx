import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ client: vi.fn(), receipt: vi.fn(() => <div>reply receipt client</div>) }));
vi.mock("next/navigation", () => ({ notFound: () => { throw Error("NOT_FOUND"); }, redirect: (value: string) => { throw Error(`REDIRECT:${value}`); } }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.client }));
vi.mock("@/components/inbox-workspace/operation-receipt", () => ({ InboxOperationReceipt: mocks.receipt }));
import InboxReplyReceiptPage from "./page";

const operationId = "00000000-0000-4000-8000-000000000042";
afterEach(() => cleanup());
beforeEach(() => { mocks.client.mockReset(); mocks.receipt.mockClear(); });

it("renders an authenticated reply receipt without checking the workspace admission flag", async () => {
  mocks.client.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user" } }, error: null }) } });
  render(await InboxReplyReceiptPage({ params: Promise.resolve({ operationId }) }));
  expect(screen.getByText("reply receipt client")).toBeVisible();
  expect(mocks.receipt).toHaveBeenCalledWith(expect.objectContaining({ operationId, kind: "reply" }), undefined);
});

it("does not reveal an invalid reply operation ID", async () => {
  await expect(InboxReplyReceiptPage({ params: Promise.resolve({ operationId: "invalid" }) })).rejects.toThrow("NOT_FOUND");
  expect(mocks.client).not.toHaveBeenCalled();
});
