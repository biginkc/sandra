import { render, screen, waitFor } from "@testing-library/react";
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

function mount(item: BrokenItem) {
  const server = makeServer(25);
  server.add("b1", workFacts("broken", "6", { kind: item.kind, action: item.action, at: item.at }, { propertyId: "b1", broken: [item], row: queueRowFixture("b1", { homeownerName: "Owner b1", address: "b1 Main St" }) } as Partial<WorkFacts>));
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

  it("Resend on a delivery-failed follow-up opens the composer in review state and sends nothing on its own", async () => {
    mocks.load.mockResolvedValue({ ok: true, data: { ...baseContext, obligation: obligation("delivery_failed") } });
    mount(item("followup_text_not_delivered", "resend"));
    await clickFix();
    await screen.findByText(/Automatic retry is disabled/);
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

  it("Review on an AI dead letter or Norma item opens the lead page carrying the refId and kind", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    mount(item("ai_reply_failed", "review", "dl-9"));
    await clickFix();
    expect(open).toHaveBeenCalledWith("/leads/b1?broken=ai_reply_failed&ref=dl-9", "_blank", expect.any(String));
    expect(mocks.load).not.toHaveBeenCalled();
    open.mockRestore();
  });
});
