import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ load: vi.fn(), send: vi.fn(), acknowledge: vi.fn() }));
vi.mock("../sms-actions", () => ({ loadRepSmsContext: mocks.load, sendRepSms: mocks.send, acknowledgeRepSmsSubmission: mocks.acknowledge }));
vi.mock("@/components/sequences/after-attempt-drip-picker", () => ({ AfterAttemptDripPicker: () => null }));

import { queueRowFixture } from "../_components/call-next-test-support";
import type { BrokenItem, WorkFacts } from "./contract";
import { workFacts } from "./test-support";
import { UnifiedQueue, type UnifiedQueueActions, type UnifiedQueueProps } from "./unified-queue";
import { Q, makeServer } from "./work-queue-fixtures";

const composition = {
  acquisitionsManager: "Maria", policyVersion: 1, introId: "mel-maria-assistant-1", introVersion: 2, templateId: "no-answer-callback-time", templateVersion: 1,
  initialRemainder: "Maria wasn't able to reach you. What time would work for her to call you back?",
  remainder: "Please text Maria a time that works.",
  body: "Hey, this is Mel with BMH, Maria's assistant.\n\nPlease text Maria a time that works.",
};
const senders = [{ id: "s1", number: "+18163706846", label: "Mel", isDefault: true, provider: "sendillo", providerSenderId: "p", grantStatus: "active", compositionPolicyVersion: 1 }];
const baseContext = { orgId: "o", actorId: "a", contactId: "c", phone: "+18165550123", provider: "sendillo", senders, obligation: null as unknown, submission: null as unknown };
const obligation = (status: string) => ({ id: "obl-1", attemptId: "att-1", status, messageBody: composition.body, composition, blockedReason: status === "blocked" ? "sender_grant_missing" : null, senderAssignmentId: "s1", fromNumber: "+18163706846", toNumber: "+18165550123" });

function mount(...items: BrokenItem[]) {
  const item = items[0];
  const server = makeServer(25);
  server.add("b1", workFacts("broken", "6", { kind: item.kind, action: item.action, at: item.at }, { propertyId: "b1", broken: items, row: queueRowFixture("b1", { homeownerName: "Owner b1", address: "b1 Main St" }) } as Partial<WorkFacts>));
  const actions = {
    loadWorkPage: vi.fn(async ({ query }: { query: unknown }) => ({ ok: true as const, page: server.page(query as never) })),
    loadWorkFacts: vi.fn(async ({ ids }: { ids: string[] }) => ({ ok: true as const, facts: server.facts(ids) })),
    pinLead: vi.fn(), dismissBroken: vi.fn(),
  } as unknown as UnifiedQueueActions;
  render(
    <UnifiedQueue
      initial={server.initial(Q(), null)} actions={actions} memberId="rep-1" canAct canSelectRep={false}
      repOptions={[{ id: "rep-1", label: "Maria" }]} selectedRepLabel="Maria" onRepChange={vi.fn()}
      onAction={vi.fn() as unknown as UnifiedQueueProps["onAction"]}
      onLoadDetailPage={vi.fn(async () => ({ ok: true as const, group: "messages" as const, page: { rows: [], hasMore: false, nextCursor: null } })) as unknown as UnifiedQueueProps["onLoadDetailPage"]}
    />,
  );
}
const item = (kind: BrokenItem["kind"], action: BrokenItem["action"], refId: string | null = "obl-1"): BrokenItem => ({ kind, action, at: "2026-10-14T12:00:00Z", refId });
const clickFix = async () => {
  await userEvent.click(screen.getByTestId("work-row-toggle-b1"));
  await userEvent.click(await screen.findByTestId("work-row-broken-fix-0-b1"));
};

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  mocks.send.mockResolvedValue({ ok: true, data: { outcome: { status: "sent", messageId: "m1", externalId: "e" } } });
  mocks.acknowledge.mockResolvedValue({ ok: true, data: { ok: true, state: "accepted" } });
});

describe("Broken fixes route through the existing composer workflows", () => {
  it("Send text opens the composer on the saved follow-up and sends through its original obligation", async () => {
    mocks.load.mockResolvedValue({ ok: true, data: { ...baseContext, obligation: obligation("required") } });
    mount(item("followup_text_not_sent", "send_text"));
    await clickFix();
    await userEvent.click(await screen.findByRole("button", { name: "Send resumed draft" }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ obligationId: "obl-1", to: "+18165550123" })));
  });

  it("Resend on a failed-not-dispatched follow-up resumes the saved body (no blind new text)", async () => {
    mocks.load.mockResolvedValue({ ok: true, data: { ...baseContext, obligation: obligation("failed_not_dispatched") } });
    mount(item("followup_text_not_sent", "resend"));
    await clickFix();
    await waitFor(() => expect(screen.getByLabelText("Editable message remainder")).toHaveValue(composition.remainder));
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("Check status opens the composer on the saved send and offers the existing reconcile action, never a blind resend", async () => {
    const key = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
    mocks.load.mockResolvedValue({
      ok: true,
      data: { ...baseContext, submission: { key, receiptId: "r1", state: "unknown", assignmentId: "s1", from: "+18163706846", to: "+18165550123", body: composition.body, composition, providerMessageId: null, providerError: null, createdAt: "2026-10-14T12:00:00Z", updatedAt: null } },
    });
    mount(item("text_status_unknown", "check_status"));
    await clickFix();
    await userEvent.click(await screen.findByRole("button", { name: "Reconcile saved send" }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: key })));
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("Review on a blocked follow-up opens the composer showing the block reason", async () => {
    mocks.load.mockResolvedValue({ ok: true, data: { ...baseContext, obligation: obligation("blocked") } });
    mount(item("followup_text_blocked", "review"));
    await clickFix();
    await screen.findByText(/sender_grant_missing/);
  });

  it("Review on an AI dead letter opens the Messages v2 dead-letter view with that id, not the lead page", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    mount(item("ai_reply_failed", "review", "dl-9"));
    await clickFix();
    expect(open).toHaveBeenCalledWith("/messages-v2?deadLetter=dl-9", "_blank", expect.any(String));
    expect(mocks.load).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("Review on a Norma item opens the Norma review surface by request id (by lead until the item carries one), never the lead page", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    mount(item("norma_needs_review", "review", "nr-3"));
    await clickFix();
    expect(open).toHaveBeenCalledWith("/norma/queue?request=nr-3", "_blank", expect.any(String));
    open.mockRestore();
    const again = vi.spyOn(window, "open").mockReturnValue(null);
    mount(item("norma_needs_review", "review", null));
    await userEvent.click(screen.getAllByTestId("work-row-toggle-b1").at(-1)!);
    await userEvent.click((await screen.findAllByTestId("work-row-broken-fix-0-b1")).at(-1)!);
    expect(again).toHaveBeenLastCalledWith("/norma/queue?property=b1", "_blank", expect.any(String));
    again.mockRestore();
  });
});

// ---- the chosen {sourceKind, refId} reaches the context load, resume, resend and check (a lead can have several failures)
const target = (over: Record<string, unknown>) => ({
  sourceKind: "ledger", refId: "led-1", disposition: "replace", state: "delivery_failed", body: composition.body, composition,
  assignmentId: "s1", from: "+18163706846", to: "+18165550123", submissionKey: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f", reason: "carrier rejected", ...over,
});
const loadByTarget = (byRef: Record<string, { target: unknown; obligation?: unknown }>) =>
  mocks.load.mockImplementation(async (_property: string, t?: { refId: string }) => {
    const hit = t ? byRef[t.refId] : undefined;
    // The lead's "current" obligation is deliberately NOT the chosen one unless the record says so.
    return { ok: true, data: { ...baseContext, obligation: hit?.obligation ?? obligation("delivery_failed"), target: hit?.target ?? null } };
  });
const clickFixAt = async (index: number) => {
  const toggle = screen.getByTestId("work-row-toggle-b1");
  if (toggle.getAttribute("aria-expanded") !== "true") await userEvent.click(toggle);
  await userEvent.click(await screen.findByTestId(`work-row-broken-fix-${index}-b1`));
};

describe("the selected Broken record (refId) is the one resumed, resent or checked", () => {
  it("two failures on one lead: each Resend loads and prefills its own record", async () => {
    const bodyA = { ...composition, remainder: "Record A body" };
    const bodyB = { ...composition, remainder: "Record B body" };
    loadByTarget({
      "led-A": { target: target({ refId: "led-A", composition: bodyA, submissionKey: "11111111-1111-4111-8111-111111111111" }) },
      "msg-B": { target: target({ sourceKind: "message", refId: "msg-B", state: "failed", composition: bodyB, submissionKey: null }) },
    });
    mount(item("text_not_delivered", "resend", "led-A"), item("text_not_sent", "resend", "msg-B"));
    await clickFixAt(0);
    await waitFor(() => expect(screen.getByLabelText("Editable message remainder")).toHaveValue("Record A body"));
    expect(mocks.load).toHaveBeenLastCalledWith("b1", { sourceKind: "ledger", refId: "led-A" });
    await userEvent.click(screen.getByTestId("work-row-toggle-b1")); // collapse
    await userEvent.click(screen.getByTestId("work-row-toggle-b1")); // re-open
    await clickFixAt(1);
    await waitFor(() => expect(screen.getByLabelText("Editable message remainder")).toHaveValue("Record B body"));
    expect(mocks.load).toHaveBeenLastCalledWith("b1", { sourceKind: "message", refId: "msg-B" });
  });

  it("delivery_failed (follow-up obligation): opens prefilled with THAT body and sends as a replacement under a NEW submission key", async () => {
    loadByTarget({ "obl-1": { target: target({ sourceKind: "obligation", refId: "obl-1", submissionKey: null }), obligation: obligation("delivery_failed") } });
    mount(item("followup_text_not_delivered", "resend", "obl-1"));
    await clickFix();
    await waitFor(() => expect(screen.getByLabelText("Editable message remainder")).toHaveValue(composition.remainder));
    await userEvent.click(await screen.findByRole("button", { name: "Send text" }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
    const sent = mocks.send.mock.calls[0][0];
    expect(sent.replaceFailed).toEqual({ sourceKind: "obligation", refId: "obl-1" });
    expect(sent.obligationId).toBeNull();
    expect(sent.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent.idempotencyKey).not.toBe("obl-1");
  });

  it("delivery_failed (ledger receipt): the replacement key is never the failed receipt's key", async () => {
    const failedKey = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
    loadByTarget({ "led-1": { target: target({}) } });
    mount(item("text_not_delivered", "resend", "led-1"));
    await clickFix();
    await userEvent.click(await screen.findByRole("button", { name: "Send text" }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
    expect(mocks.send.mock.calls[0][0].idempotencyKey).not.toBe(failedKey);
    expect(mocks.send.mock.calls[0][0].replaceFailed).toEqual({ sourceKind: "ledger", refId: "led-1" });
  });

  it("transport-only unknown (a message with provider_unknown): Check status re-reads that record and never sends", async () => {
    loadByTarget({ "msg-7": { target: target({ sourceKind: "message", refId: "msg-7", disposition: "check", state: "failed", composition: null, submissionKey: null, reason: null }) } });
    mount(item("text_status_unknown", "check_status", "msg-7"));
    await clickFix();
    await screen.findByTestId("rep-sms-composer");
    const check = await within(screen.getByTestId("rep-sms-composer")).findByRole("button", { name: "Check status" });
    expect(screen.queryByRole("button", { name: "Send text" })).toBeNull();
    const before = mocks.load.mock.calls.length;
    await userEvent.click(check);
    await waitFor(() => expect(mocks.load.mock.calls.length).toBeGreaterThan(before));
    expect(mocks.load).toHaveBeenLastCalledWith("b1", { sourceKind: "ledger", refId: "msg-7" });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("unverified ledger receipt: Check status replays the saved request under its own key and acknowledges that receipt", async () => {
    const key = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
    loadByTarget({ "led-9": { target: target({ refId: "led-9", disposition: "check", state: "unknown", submissionKey: key }) } });
    mount(item("text_status_unknown", "check_status", "led-9"));
    await clickFix();
    await screen.findByTestId("rep-sms-composer");
    await userEvent.click(await within(screen.getByTestId("rep-sms-composer")).findByRole("button", { name: "Check status" }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: key })));
    expect(mocks.send.mock.calls[0][0].replaceFailed).toBeUndefined();
    await waitFor(() => expect(mocks.acknowledge).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: key, target: { sourceKind: "ledger", refId: "led-9" } })));
  });

  it("blocked: Review shows that item's block reason and offers no send", async () => {
    loadByTarget({ "led-b": { target: target({ refId: "led-b", disposition: "review", state: "blocked", reason: "Quiet hours until 8am" }) } });
    mount(item("text_blocked", "review", "led-b"));
    await clickFix();
    await screen.findByText(/Quiet hours until 8am/);
    expect(screen.queryByRole("button", { name: "Send text" })).toBeNull();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("a resumable obligation is resumed by ITS id even when the lead's current obligation is another one", async () => {
    loadByTarget({ "obl-2": { target: target({ sourceKind: "obligation", refId: "obl-2", disposition: "resume", state: "required" }), obligation: { ...obligation("required"), id: "obl-2" } } });
    mount(item("followup_text_not_sent", "send_text", "obl-2"));
    await clickFix();
    await userEvent.click(await screen.findByRole("button", { name: "Send resumed draft" }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ obligationId: "obl-2" })));
  });
});
