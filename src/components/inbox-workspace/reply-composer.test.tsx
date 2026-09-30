import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxReplyStatus, PreparedInboxReply } from "@/lib/inbox/reply-api-contract";
import { InboxReplyComposer } from "./reply-composer";

const conversationId = "00000000-0000-4000-8000-000000000001";
const operationId = "00000000-0000-4000-8000-000000000002";
const itemId = "00000000-0000-4000-8000-000000000003";
const target = { kind: "conversation" as const, id: conversationId };

function prepared(key: string, exclusion: PreparedInboxReply["items"][number]["exclusion"] = null): PreparedInboxReply {
  return {
    preparationId: "00000000-0000-4000-8000-000000000004", idempotencyKey: key, inputHash: "a".repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    items: [{ id: itemId, target, exclusion, duplicateDestination: false, recipient: exclusion ? null : { contactName: "Ada Lovelace", propertyAddress: "123 Oak St", propertyId: "00000000-0000-4000-8000-000000000005", contactId: "00000000-0000-4000-8000-000000000006", from: "+18165550100", to: "+18165550142", renderedBody: "Hello Ada" } }], recipientCount: exclusion ? 0 : 1, blockers: exclusion ? ["empty"] : [],
  };
}

function status(receiptState: InboxReplyStatus["receipts"][number]["state"]): InboxReplyStatus {
  return { operationId, preparationId: "00000000-0000-4000-8000-000000000004", dispatchComplete: true, items: [prepared("00000000-0000-4000-8000-000000000007").items[0]], receipts: [{ itemId, attemptId: null, version: "1", state: receiptState, reason: receiptState === "uncertain" ? "provider timeout" : null }] };
}

function responseFor(url: string, init?: RequestInit, receiptState: InboxReplyStatus["receipts"][number]["state"] = "delivered"): Response {
  if (url.endsWith("/replies/prepare")) return Response.json(prepared(JSON.parse(String(init?.body)).idempotencyKey));
  if (url.endsWith("/replies/accept")) return Response.json({ operationId });
  return Response.json(status(receiptState));
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => Promise.resolve(responseFor(url, init))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function mount(routeKey = "route-a") {
  return render(<InboxReplyComposer targets={[target]} routeKey={routeKey} enabled />);
}

describe("InboxReplyComposer", () => {
  it("starts ready with one review control and no send control", () => {
    mount();
    expect(screen.getByRole("button", { name: "Review reply" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Send reply" })).toBeNull();
  });

  it("shows reviewing while the server review is in flight and does not mutate", async () => {
    let resolve!: (value: Response) => void;
    let requestedKey = "";
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => url.endsWith("/replies/prepare") ? new Promise<Response>(done => { requestedKey = JSON.parse(String(init?.body)).idempotencyKey; resolve = done; }) : Promise.reject(Error("unexpected mutation"))));
    mount();
    fireEvent.change(screen.getByRole("textbox", { name: "Reply message" }), { target: { value: "Draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Review reply" }));
    expect(screen.getByRole("status")).toHaveTextContent("Checking current eligibility");
    expect(screen.queryByRole("button", { name: "Send reply" })).toBeNull();
    await act(async () => { resolve(Response.json(prepared(requestedKey))); });
    await screen.findByText("Review before sending");
  });

  it("sends only after the review and renders the terminal receipt", async () => {
    mount();
    fireEvent.change(screen.getByRole("textbox", { name: "Reply message" }), { target: { value: "Draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Review reply" }));
    await screen.findByText("Review before sending");
    expect(screen.getByText("Ada Lovelace")).toBeVisible();
    expect(screen.getByText("+18165550100")).toBeVisible();
    expect(screen.getByText("+18165550142")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await screen.findByText("Delivered");
    const calls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
    expect(calls.filter(url => url.endsWith("/replies/accept"))).toHaveLength(1);
  });

  it("blocks an exclusion and never calls accept", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => url.endsWith("/replies/prepare") ? Promise.resolve(Response.json(prepared(JSON.parse(String(init?.body)).idempotencyKey, "no_consent"))) : Promise.reject(Error("accept must not run"))));
    mount();
    fireEvent.change(screen.getByRole("textbox", { name: "Reply message" }), { target: { value: "Draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Review reply" }));
    await screen.findByText("No affirmative SMS consent is on file.");
    expect(screen.queryByRole("button", { name: "Send reply" })).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/replies/accept"))).toBe(false);
  });

  it("discards the review when the route changes and preserves the draft", async () => {
    const view = mount("route-a");
    fireEvent.change(screen.getByRole("textbox", { name: "Reply message" }), { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Review reply" }));
    await screen.findByText("Review before sending");
    view.rerender(<InboxReplyComposer targets={[target]} routeKey="route-b" enabled />);
    await screen.findByRole("alert", { name: "" });
    expect(screen.getByRole("textbox", { name: "Reply message" })).toHaveValue("Keep this draft");
    expect(screen.queryByRole("button", { name: "Send reply" })).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/replies/accept"))).toBe(false);
  });

  it("renders an uncertain receipt without offering a resend", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => Promise.resolve(responseFor(url, init, "uncertain"))));
    mount();
    fireEvent.change(screen.getByRole("textbox", { name: "Reply message" }), { target: { value: "Draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Review reply" }));
    await screen.findByText("Review before sending");
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await screen.findByText("Send result not confirmed");
    expect(screen.getByText(/Do not resend/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Send reply" })).toBeNull();
  });

  it("keeps a prepare network error separate and never calls accept", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { if (url.endsWith("/replies/prepare")) throw Error("Network connection lost"); return Response.json({}); }));
    mount();
    fireEvent.change(screen.getByRole("textbox", { name: "Reply message" }), { target: { value: "Draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Review reply" }));
    await screen.findByText("Network connection lost");
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/replies/accept"))).toBe(false);
  });
});
