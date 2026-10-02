import { describe, expect, it } from "vitest";
import type { InboxReplyReceipt, InboxReplyStatus, PreparedInboxReplyItem } from "@/lib/inbox/reply-api-contract";
import {
  classifyReceipt,
  classifyReceiptRow,
  isTerminalReceiptStatus,
  receiptItemViews,
  receiptProgressFingerprint,
  receiptRollupBadge,
  receiptRollup,
  type ReceiptClassification,
  type ReceiptRowClass,
} from "./reply-receipt-policy";

const operationId = "00000000-0000-4000-8000-000000000001";
const preparationId = "00000000-0000-4000-8000-000000000002";
const now = 1_000_000;

function item(index: number, exclusion: PreparedInboxReplyItem["exclusion"] = null): PreparedInboxReplyItem {
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  return {
    id,
    target: { kind: "conversation", id },
    exclusion,
    duplicateDestination: false,
    recipient: exclusion ? null : {
      contactName: `Contact ${index}`,
      propertyAddress: `${index} Oak St`,
      propertyId: id,
      contactId: id,
      from: "+18165550100",
      to: `+18165550${String(index).padStart(3, "0")}`,
      renderedBody: "Hello",
    },
  };
}

function receipt(index: number, state: InboxReplyReceipt["state"], reason: string | null = null, version = "1"): InboxReplyReceipt {
  return { itemId: item(index).id, attemptId: null, version, state, reason };
}

function status(states: readonly InboxReplyReceipt["state"][], options: { dispatchComplete?: boolean; reasons?: readonly (string | null)[]; items?: readonly PreparedInboxReplyItem[]; version?: string } = {}): InboxReplyStatus {
  const items = options.items ?? states.map((_, index) => item(index + 1));
  return {
    operationId,
    preparationId,
    dispatchComplete: options.dispatchComplete ?? false,
    items,
    receipts: states.map((state, index) => receipt(index + 1, state, options.reasons?.[index] ?? null, options.version)),
  };
}

function classify(value: InboxReplyStatus, unchanged: boolean) {
  const fingerprint = receiptProgressFingerprint(value);
  return classifyReceipt(value, unchanged ? { fingerprint, unchangedSince: now - 120_000 } : { unchangedSince: now }, now);
}

type ReceiptCase = {
  name: string;
  state: InboxReplyReceipt["state"];
  unchanged: boolean;
  label: string;
  className: ReceiptRowClass;
  polling: boolean;
  classification: ReceiptClassification;
  reason?: string;
};

const receiptCases: ReceiptCase[] = [
  { name: "1 pending before timeout", state: "pending", unchanged: false, label: "Sending", className: "sending", polling: true, classification: "in_flight" },
  { name: "2 dispatch_started before timeout", state: "dispatch_started", unchanged: false, label: "Sending", className: "sending", polling: true, classification: "in_flight" },
  { name: "3 dispatch_started after timeout", state: "dispatch_started", unchanged: true, label: "Could not confirm, may still send", className: "not_confirmed_timeout", polling: false, classification: "not_confirmed" },
  { name: "4 uncertain first render", state: "uncertain", unchanged: false, label: "Not confirmed, may or may not have sent. Do not resend", className: "not_confirmed_server", polling: false, classification: "not_confirmed", reason: "server" },
  { name: "5 uncertain after timeout", state: "uncertain", unchanged: true, label: "Not confirmed, may or may not have sent. Do not resend", className: "not_confirmed_server", polling: false, classification: "not_confirmed", reason: "server" },
  { name: "6 blocked is final", state: "blocked", unchanged: false, label: "Not sent: Outside window", className: "blocked", polling: false, classification: "terminal" },
  { name: "7 provider_accepted keeps polling", state: "provider_accepted", unchanged: false, label: "Accepted, delivery pending", className: "sending", polling: true, classification: "in_flight" },
  { name: "8 provider_accepted to delivered", state: "delivered", unchanged: false, label: "Delivered", className: "delivered", polling: false, classification: "terminal" },
  { name: "9 provider_accepted after timeout", state: "provider_accepted", unchanged: true, label: "Accepted by carrier, delivery not confirmed", className: "not_confirmed_timeout", polling: false, classification: "not_confirmed" },
  { name: "10 delivery_failed", state: "delivery_failed", unchanged: false, label: "Delivery failed", className: "failed", polling: false, classification: "terminal" },
  { name: "11 confirmed_not_submitted", state: "confirmed_not_submitted", unchanged: false, label: "Not sent", className: "failed", polling: false, classification: "terminal" },
  { name: "12 rejected_unsent", state: "rejected_unsent", unchanged: false, label: "Not sent (rejected)", className: "failed", polling: false, classification: "terminal" },
];

describe("authoritative receipt policy truth table", () => {
  it.each(receiptCases)("$name", testCase => {
    const value = status([testCase.state], { dispatchComplete: testCase.state !== "blocked" && (testCase.state === "provider_accepted" || testCase.classification === "terminal"), reasons: testCase.state === "blocked" ? ["outside_window"] : undefined });
    const row = classifyReceiptRow(value.receipts[0], testCase.unchanged);
    const decision = classify(value, testCase.unchanged);
    expect(row.label).toBe(testCase.label);
    expect(row.className).toBe(testCase.className);
    expect(row.keepPolling).toBe(testCase.polling);
    expect(row.canResend).toBe(false);
    if (testCase.state === "blocked") expect(row.statusLabel).toBe("Blocked");
    expect(decision.classification).toBe(testCase.classification);
    if (testCase.reason) expect(decision.notConfirmedReason).toBe(testCase.reason);
  });

  it("13 rolls mixed states up by UI class and keeps polling only for pending", () => {
    const value = status(["delivered", "uncertain", "blocked", "pending"], {
      dispatchComplete: false,
      reasons: [null, "reentered_without_result", "outside_window", null],
    });
    const rollup = receiptRollup(value);
    const decision = classify(value, false);
    expect(rollup.counts).toMatchObject({ delivered: 1, sending: 1, notConfirmedServer: 1, blocked: 1 });
    expect(rollup.headline).toBe("Some not confirmed, do not resend");
    expect(rollup.keepPolling).toBe(true);
    expect(decision.classification).toBe("in_flight");
    expect(rollup.rows.map(row => row.label)).toEqual([
      "Delivered",
      "Not confirmed, may or may not have sent. Do not resend",
      "Not sent: Outside window",
      "Sending",
    ]);
  });

  it("14 stops on delivered plus blocked even when dispatchComplete is false", () => {
    const value = status(["delivered", "blocked"], { dispatchComplete: false, reasons: [null, "outside_window"] });
    const rollup = receiptRollup(value);
    expect(rollup.headline).toBe("Some not sent");
    expect(rollup.keepPolling).toBe(false);
    expect(isTerminalReceiptStatus(value)).toBe(true);
    expect(receiptRollup(status(["blocked"], { dispatchComplete: false, reasons: ["outside_window"] })).headline).toBe("Not sent");
  });

  it.each([
    { name: "all delivered", states: ["delivered"] as const, label: "Delivered", tone: "success" },
    { name: "provider accepted pending", states: ["provider_accepted"] as const, label: "Sending", tone: "pending" },
    { name: "blocked only", states: ["blocked"] as const, label: "Blocked", tone: "blocked" },
    { name: "failed only", states: ["delivery_failed"] as const, label: "Failed", tone: "failed" },
    { name: "uncertain", states: ["uncertain"] as const, label: "Not confirmed", tone: "uncertain" },
    { name: "mixed", states: ["delivered", "blocked"] as const, label: "Mixed", tone: "mixed" },
  ])("maps the $name rollup to its own composer badge", ({ states, label, tone }) => {
    const rollup = receiptRollup(status(states, { reasons: states.map(state => state === "blocked" ? "outside_window" : null) }));
    expect(receiptRollupBadge(rollup)).toEqual({ label, tone });
  });

  it("15 resets only when a fingerprint field changes, not when receipts reorder", () => {
    const first = status(["pending", "delivered"], { dispatchComplete: false });
    const reordered = { ...first, receipts: [...first.receipts].reverse() };
    const changed = status(["dispatch_started", "delivered"], { dispatchComplete: false });
    const tracker = { fingerprint: receiptProgressFingerprint(first), unchangedSince: now - 10_000 };
    expect(classifyReceipt(reordered, tracker, now).unchangedSince).toBe(now - 10_000);
    expect(classifyReceipt(changed, tracker, now).unchangedSince).toBe(now);
  });

  it("16 renders excluded items from items.exclusion instead of inventing a sending receipt", () => {
    const excluded = item(2, "outside_window");
    const value = status(["delivered"], { dispatchComplete: false, items: [item(1), excluded] });
    const rows = receiptItemViews(value);
    expect(rows[1]).toMatchObject({ itemId: excluded.id, label: "Excluded: Outside window", className: "excluded", keepPolling: false });
    expect(receiptRollup(value).counts.excluded).toBe(1);
    expect(rows[1].label).not.toContain("Sending");
  });

  it("17 treats zero receipts with dispatchComplete true as complete", () => {
    const value = status([], { dispatchComplete: true, items: [] });
    const decision = classify(value, true);
    expect(decision.classification).toBe("terminal");
    expect(decision.rollup.keepPolling).toBe(false);
    expect(isTerminalReceiptStatus(value)).toBe(true);
  });

  it("18 has no resend control for any of the nine wire states", () => {
    const states: InboxReplyReceipt["state"][] = ["pending", "dispatch_started", "provider_accepted", "delivered", "delivery_failed", "uncertain", "blocked", "confirmed_not_submitted", "rejected_unsent"];
    expect(states.every(state => classifyReceiptRow(receipt(1, state), false).canResend === false)).toBe(true);
  });

  it("19 maps a local invalid-input refusal to the approved not-sent copy without exposing evidence", () => {
    expect(classifyReceiptRow(receipt(1, "confirmed_not_submitted", "local_not_attempted:invalid_input"))).toEqual({
      label: "Not sent. This number is not on the pilot allowed list (or the message was invalid). Nothing went out.",
      className: "failed",
      keepPolling: false,
      canResend: false,
    });
    expect(classifyReceiptRow(receipt(1, "confirmed_not_submitted", "local_not_attempted:cancelled_before_dispatch"))).toMatchObject({ label: "Not sent", reason: "Local not attempted:cancelled before dispatch" });
  });
});
