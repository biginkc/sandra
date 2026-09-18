import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InboxReceiptRecovery } from "./receipt-recovery";

const identity = { orgId: "00000000-0000-4000-8000-000000000031", userId: "00000000-0000-4000-8000-000000000032", sessionId: "00000000-0000-4000-8000-000000000033", accessEpoch: "7" };
const prepA = "00000000-0000-4000-8000-000000000034";
const keyA = "00000000-0000-4000-8000-000000000035";
const prepB = "00000000-0000-4000-8000-000000000036";
const keyB = "00000000-0000-4000-8000-000000000037";
const storage = `inbox-saved-action-recovery:${JSON.stringify(Object.values(identity))}`;

afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

it("recovers multiple opaque entries independently and never offers acceptance", async () => {
  sessionStorage.setItem(storage, JSON.stringify([{ kind: "metadata", preparationId: prepA, idempotencyKey: keyA }, { kind: "reply", preparationId: prepB, idempotencyKey: keyB }]));
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    if (url.includes(prepA)) return Response.json({ state: "accepted", operation: { operationId: "00000000-0000-4000-8000-000000000038" } });
    return Response.json({ state: "pending", preparationId: prepB, idempotencyKey: keyB });
  }));
  render(<InboxReceiptRecovery identity={identity} />);
  await screen.findByText("Accepted. Open the durable receipt to inspect progress.");
  expect(screen.getByRole("link", { name: "Open receipt" })).toHaveAttribute("href", "/inbox/operations/00000000-0000-4000-8000-000000000038");
  expect(screen.getByText("Not confirmed yet; the original identifiers are retained.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Check again" })).toBeVisible();
  expect(screen.queryByRole("button", { name: /accept|retry|send/i })).toBeNull();
  expect(calls).toHaveLength(2);
});

it("does not read a different authenticated identity's registry", async () => {
  sessionStorage.setItem(storage, JSON.stringify({ kind: "reply", preparationId: prepA, idempotencyKey: keyA }));
  vi.stubGlobal("fetch", vi.fn());
  render(<InboxReceiptRecovery identity={{ ...identity, sessionId: "00000000-0000-4000-8000-000000000039" }} />);
  await screen.findByText("No accepted or uncertain actions need recovery.");
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.queryByText(prepA)).not.toBeInTheDocument();
});

it("removes only the matching expired entry", async () => {
  sessionStorage.setItem(storage, JSON.stringify([{ kind: "metadata", preparationId: prepA, idempotencyKey: keyA }, { kind: "reply", preparationId: prepB, idempotencyKey: keyB }]));
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes(prepA) ? Response.json({ state: "expired_not_accepted" }) : Response.json({ state: "pending" })));
  render(<InboxReceiptRecovery identity={identity} />);
  await screen.findByText("An expired record was removed from this authenticated session.");
  const remaining = JSON.parse(sessionStorage.getItem(storage)!);
  expect(remaining).toEqual({ kind: "reply", preparationId: prepB, idempotencyKey: keyB });
});
