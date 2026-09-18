import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InboxOperationReceipt } from "./operation-receipt";

const operationId = "00000000-0000-4000-8000-000000000021";
const targetId = "00000000-0000-4000-8000-000000000022";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shows per-target metadata outcomes and a standalone navigation path", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ operationId, acceptedAt: new Date().toISOString(), completed: true, result: "partial", items: [{ id: "item", target: { kind: "conversation", id: targetId }, propertyId: null, exclusion: null, stepIds: ["step"], state: "conflicted", code: "source_changed" }], steps: [{ id: "step", action: "outcome", state: "conflicted", code: "source_changed", changed: null }] })));
  render(<InboxOperationReceipt operationId={operationId} kind="metadata" />);
  await screen.findByText("Action partial");
  expect(screen.getByText(`Conversation ${targetId}`)).toBeVisible();
  expect(screen.getByText(/Conflict: the record changed/)).toBeVisible();
  expect(screen.getByRole("link", { name: "Back to Messages" })).toHaveAttribute("href", "/messages");
  expect(screen.getByText(/No send retry is offered/)).toBeVisible();
});

it("shows uncertain per-recipient replies without offering a resend", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ operationId, preparationId: "00000000-0000-4000-8000-000000000023", dispatchComplete: true, items: [{ id: "item", target: { kind: "conversation", id: targetId }, exclusion: null, recipient: { contactName: "Ada", propertyAddress: "123 Oak", to: "+15555550100", renderedBody: "Hi" } }], receipts: [{ itemId: "item", attemptId: null, version: "1", state: "uncertain", reason: "provider timeout" }] })));
  render(<InboxOperationReceipt operationId={operationId} kind="reply" />);
  await screen.findByText("Reply dispatch complete");
  expect(screen.getByText("Ada")).toBeVisible();
  expect(screen.getByText(/Uncertain send: wait for provider reconciliation/)).toBeVisible();
  expect(screen.queryByRole("button", { name: /retry|resend|send/i })).toBeNull();
});

it("does not render another tenant's receipt response", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ operationId: "00000000-0000-4000-8000-000000000099", acceptedAt: new Date().toISOString(), completed: true, result: "succeeded", items: [], steps: [] })));
  render(<InboxOperationReceipt operationId={operationId} kind="metadata" />);
  await screen.findByText("The receipt response could not be verified.");
  expect(screen.queryByText("Action succeeded")).not.toBeInTheDocument();
});

it("clears a previously loaded receipt when the authenticated status check is denied", async () => {
  const nextOperationId = "00000000-0000-4000-8000-000000000024";
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith(`/operations/${operationId}`)
    ? Response.json({ operationId, acceptedAt: new Date().toISOString(), completed: true, result: "succeeded", items: [], steps: [] })
    : new Response(null, { status: 403 })));
  const view = render(<InboxOperationReceipt operationId={operationId} kind="metadata" />);
  await screen.findByText("Action succeeded");
  view.rerender(<InboxOperationReceipt operationId={nextOperationId} kind="metadata" />);
  await screen.findByText("This receipt is unavailable for the current account.");
  expect(screen.queryByText("Action succeeded")).not.toBeInTheDocument();
});

it("ignores a delayed response from the previous operation after navigation", async () => {
  const nextOperationId = "00000000-0000-4000-8000-000000000025";
  let resolveOld!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn((url: string) => url.endsWith(`/operations/${operationId}`)
    ? new Promise<Response>(resolve => { resolveOld = resolve; })
    : Promise.resolve(Response.json({ operationId: nextOperationId, acceptedAt: new Date().toISOString(), completed: true, result: "succeeded", items: [], steps: [] }))));
  const view = render(<InboxOperationReceipt operationId={operationId} kind="metadata" />);
  view.rerender(<InboxOperationReceipt operationId={nextOperationId} kind="metadata" />);
  resolveOld(Response.json({ operationId, acceptedAt: new Date().toISOString(), completed: true, result: "failed", items: [{ id: "old", target: { kind: "conversation", id: targetId }, propertyId: null, exclusion: null, stepIds: [], state: "failed", code: "old" }], steps: [] }));
  await screen.findByText("Action succeeded");
  expect(screen.queryByText("Action failed")).not.toBeInTheDocument();
});
