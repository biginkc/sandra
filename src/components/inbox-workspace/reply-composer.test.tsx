import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InboxReplyComposer } from "./reply-composer";

const conversationA = "00000000-0000-4000-8000-000000000001";
const conversationB = "00000000-0000-4000-8000-000000000002";
const preparationId = "00000000-0000-4000-8000-000000000003";
const operationId = "00000000-0000-4000-8000-000000000004";

function prepared(id: string, key: string) {
  return { preparationId, idempotencyKey: key, expiresAt: new Date(Date.now() + 60_000).toISOString(), items: [{ id: "item", target: { kind: "conversation", id }, exclusion: null, recipient: { contactName: "Ada", propertyAddress: "123 Oak", renderedBody: "Approved text", to: "+15555550100" } }], recipientCount: 1, blockers: [] };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("drops a delayed preparation when the open conversation changes", async () => {
  let resolve: ((response: Response) => void) | undefined;
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith("/replies/prepare")) return new Promise<Response>(done => { resolve = done; void init; });
    return Promise.resolve(Response.json({}));
  }));
  const view = render(<InboxReplyComposer conversationId={conversationA} enabled />);
  fireEvent.change(screen.getByRole("textbox", { name: "Reply message" }), { target: { value: "A draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Review reply" }));
  view.rerender(<InboxReplyComposer conversationId={conversationB} enabled />);
  resolve?.(Response.json(prepared(conversationA, "00000000-0000-4000-8000-000000000005")));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Review reply" })).toBeNull());
  expect(screen.getByRole("textbox", { name: "Reply message" })).toHaveValue("");
});

it("invalidates a frozen review when the operator edits the draft", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/replies/prepare")) return Response.json(prepared(conversationA, JSON.parse(String(init?.body)).idempotencyKey));
    throw new Error(`unexpected request ${url}`);
  }));
  render(<InboxReplyComposer conversationId={conversationA} enabled />);
  const text = screen.getByRole("textbox", { name: "Reply message" });
  fireEvent.change(text, { target: { value: "Original" } });
  fireEvent.click(screen.getByRole("button", { name: "Review reply" }));
  await screen.findByRole("dialog", { name: "Review reply" });
  fireEvent.change(text, { target: { value: "Edited" } });
  expect(screen.queryByRole("dialog", { name: "Review reply" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Accept reviewed reply" })).toBeNull();
});

it("recovers the same acceptance key and displays the terminal reply receipt", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.endsWith("/replies/prepare")) return Response.json(prepared(conversationA, JSON.parse(String(init?.body)).idempotencyKey));
    if (url.startsWith("/api/inbox/replies/recover")) return Response.json({ state: "prepared", preparationId, idempotencyKey: JSON.parse(String(init?.body ?? "{}"))?.idempotencyKey ?? "" });
    if (url.endsWith("/replies/accept")) return Response.json({ operationId });
    if (url.endsWith(`/replies/${operationId}`)) return Response.json({ operationId, dispatchComplete: true, result: "succeeded", receipts: [], items: [] });
    throw new Error(`unexpected request ${url}`);
  }));
  render(<InboxReplyComposer conversationId={conversationA} enabled />);
  fireEvent.change(screen.getByRole("textbox", { name: "Reply message" }), { target: { value: "Original" } });
  fireEvent.click(screen.getByRole("button", { name: "Review reply" }));
  await screen.findByRole("dialog", { name: "Review reply" });
  fireEvent.click(screen.getByRole("button", { name: "Accept reviewed reply" }));
  await screen.findByText("Reply succeeded");
  expect(calls.some(url => url.startsWith("/api/inbox/replies/recover?preparationId="))).toBe(true);
  expect(screen.getByRole("link", { name: "Open reply receipt" })).toHaveAttribute("href", `/api/inbox/replies/${operationId}`);
});
