import { describe, expect, it } from "vitest";
import type { MyLeadStage } from "../_components/types";
import { brokenButton, BROKEN_ACTION_LABELS, contactBlock, dismissableBroken, primaryButton, rowButtons } from "./button-map";
import type { BrokenAction, WorkReason } from "./contract";
import { workFacts } from "./test-support";

const label = (reason: WorkReason, headline: Record<string, unknown> = {}, over = {}) => primaryButton(workFacts(reason, "x", headline, over))?.label ?? null;

describe("primary button per reason", () => {
  it("maps each reason", () => {
    expect(label("new_lead")).toBe("Call");
    expect(label("call_today")).toBe("Call");
    expect(label("due")).toBe("Call");
    expect(label("new_reply")).toBe("Reply");
    expect(label("offer", { kind: "ready" })).toBe("Log offer");
    expect(label("offer", { kind: "follow_up_due" })).toBe("Call");
    expect(label("offer", { kind: "follow_up_missing" })).toBe("Call");
    expect(label("gone_quiet")).toBe("Set drip");
    expect(label("nothing_planned")).toBe("Set drip");
  });
  it("Nothing planned with a waiting text is Send text (text command), gated like Reply", () => {
    const f = workFacts("nothing_planned", "6a", { variant: "text_waiting" }, { labels: ["text_waiting"] });
    expect(primaryButton(f)).toMatchObject({ label: "Send text", command: { type: "text" }, disabled: false });
    expect(primaryButton({ ...f, hasPhone: false })).toMatchObject({ label: "Send text", disabled: true, disabledReason: "No phone number" });
    expect(label("nothing_planned", {}, { labels: ["check_texts"] })).toBe("Set drip");
  });
  it("Waiting reasons and Under contract have no primary", () => {
    for (const reason of ["in_drip", "texted_last", "offer_out", "callback_booked", "under_contract"] as const) expect(label(reason)).toBeNull();
  });
  it("Call and Reply map to the existing commands", () => {
    expect(primaryButton(workFacts("due", "4"))?.command).toEqual({ type: "action", action: "start-call" });
    expect(primaryButton(workFacts("new_reply", "5"))?.command).toEqual({ type: "text" });
    expect(primaryButton(workFacts("offer", "7", { kind: "ready" }))?.command).toEqual({ type: "action", action: "log-offer" });
  });
});

describe("Broken fix button follows the item's action (design 2.1)", () => {
  const actions: BrokenAction[] = ["fix_drip", "send_text", "resend", "review", "check_status", "open_campaign"];
  it.each(actions)("%s", (action) => {
    const item = { kind: "text_not_sent" as const, action, at: null, refId: "r1" };
    const button = primaryButton(workFacts("broken", "6", {}, { broken: [item] }));
    expect(button?.label).toBe(BROKEN_ACTION_LABELS[action]);
    expect(button?.command).toEqual({ type: "broken", item });
  });
  it("labels", () => {
    expect(BROKEN_ACTION_LABELS).toMatchObject({ fix_drip: "Fix drip", send_text: "Send text", resend: "Resend", review: "Review", check_status: "Check status" });
  });
  it("the first item decides the primary; no items means no button", () => {
    const f = workFacts("broken", "6", {}, {
      broken: [{ kind: "drip_stuck", action: "fix_drip", at: null, refId: "a" }, { kind: "text_not_sent", action: "resend", at: null, refId: "b" }],
    });
    expect(primaryButton(f)?.label).toBe("Fix drip");
    expect(primaryButton(workFacts("broken", "6"))).toBeNull();
  });
  it("Resend and Send text need a phone; Review and Check status do not", () => {
    const noPhone = { hasPhone: false, contactDnc: false };
    const mk = (action: BrokenAction) => brokenButton({ kind: "text_not_sent", action, at: null, refId: null }, noPhone);
    expect(mk("resend").disabled).toBe(true);
    expect(mk("send_text").disabledReason).toBe("No phone number");
    expect(mk("review").disabled).toBe(false);
    expect(mk("check_status").disabled).toBe(false);
    expect(mk("fix_drip").disabled).toBe(false);
  });
  it("dismiss only for items with a refId", () => {
    const f = workFacts("broken", "6", {}, {
      broken: [{ kind: "norma_needs_review", action: "review", at: null, refId: null }, { kind: "text_not_sent", action: "resend", at: null, refId: "b" }],
    });
    expect(dismissableBroken(f).map((i) => i.refId)).toEqual(["b"]);
  });
  it("never offers Dismiss on a Norma review, even with its request id as refId", () => {
    const f = workFacts("broken", "6", {}, {
      broken: [{ kind: "norma_needs_review", action: "review", at: null, refId: "11111111-1111-4111-8111-111111111111" }],
    });
    expect(dismissableBroken(f)).toEqual([]);
  });
});

describe("no phone / do not contact", () => {
  it("disables Call, Reply and Text with the reason", () => {
    const f = workFacts("new_reply", "5", {}, { hasPhone: false });
    const buttons = rowButtons(f, { canAct: true });
    expect(buttons.call).toMatchObject({ disabled: true, disabledReason: "No phone number" });
    expect(buttons.primary).toMatchObject({ disabled: true, disabledReason: "No phone number" });
    expect(buttons.more.find((m) => m.id === "text")).toMatchObject({ disabled: true, disabledReason: "No phone number" });
    const dnc = rowButtons(workFacts("due", "4", {}, { contactDnc: true }), { canAct: true });
    expect(dnc.call.disabledReason).toBe("Do not contact");
    expect(contactBlock({ hasPhone: false, contactDnc: true })).toBe("Do not contact");
  });
  it("leaves Set drip and Log attempt usable", () => {
    const buttons = rowButtons(workFacts("due", "4", {}, { hasPhone: false }), { canAct: true });
    expect(buttons.setDrip.disabled).toBe(false);
    expect(buttons.logAttempt?.disabled).toBe(false);
  });
});

describe("expanded buttons", () => {
  it("has the six buttons", () => {
    const b = rowButtons(workFacts("due", "4"), { canAct: true });
    expect([b.call.label, b.logAttempt?.label, b.callToday.label, b.setDrip.label]).toEqual(["Call", "Log attempt", "Call today", "Set drip"]);
    expect(b.more.length).toBeGreaterThan(0);
  });
  it("Call today is disabled once pinned", () => {
    expect(rowButtons(workFacts("call_today", "2"), { canAct: true }).callToday).toMatchObject({ disabled: true, disabledReason: "Already pinned" });
    expect(rowButtons(workFacts("due", "4"), { canAct: true }).callToday.disabled).toBe(false);
  });
  it("owner viewing a rep: everything disabled", () => {
    const b = rowButtons(workFacts("new_reply", "5"), { canAct: false, coachAvailable: true });
    for (const button of [b.primary!, b.call, b.logAttempt!, b.callToday, b.setDrip, ...b.more]) {
      expect(button.disabled).toBe(true);
      expect(button.disabledReason).toBe("Viewing another rep's queue");
    }
  });
  it("has no Not today anywhere", () => {
    for (const stage of ["not_contacted", "contacted", "needs_offer", "offer_sent", "under_contract"] as const) {
      const b = rowButtons(workFacts("due", "4", {}, { stage }), { canAct: true, coachAvailable: true });
      expect(JSON.stringify(b)).not.toMatch(/not today/i);
    }
  });
});

describe("More menu mirrors queue-row ACTIONS_BY_STAGE", () => {
  const items = (stage: MyLeadStage, coach = false) =>
    rowButtons(workFacts("due", "4", {}, { stage }), { canAct: true, coachAvailable: coach }).more.map((m) => m.label);
  it("per stage", () => {
    expect(items("not_contacted")).toEqual(["Text", "Contract signed", "Dead / Nurture", "Open in Zillow"]);
    expect(items("contacted")).toEqual(["Text", "Ready to make an offer", "Log offer", "Schedule a callback", "Contract signed", "Dead / Nurture", "Open in Zillow"]);
    expect(items("needs_offer")).toEqual(["Text", "Log offer", "Contract signed", "Dead / Nurture", "Open in Zillow"]);
    expect(items("offer_sent")).toEqual(["Text", "Contract signed", "Offer declined", "Dead / Nurture", "Open in Zillow"]);
    expect(items("under_contract")).toEqual(["Text", "Open in Zillow", "Archive"]);
  });
  it("Call with coach sits before Open in Zillow", () => {
    expect(items("offer_sent", true)).toEqual(["Text", "Contract signed", "Offer declined", "Dead / Nurture", "Call with coach", "Open in Zillow"]);
  });
  it("maps onto existing MyLeadAction kinds", () => {
    const b = rowButtons(workFacts("due", "4", {}, { stage: "offer_sent" }), { canAct: true });
    const actions = b.more.map((m) => m.command).filter((c) => c.type === "action").map((c) => (c as { action: string }).action);
    expect(actions).toEqual(["contract-signed", "decline-offer", "handoff"]);
    expect(b.more.find((m) => m.id === "decline-offer")?.danger).toBe(true);
  });
  it("Under contract has no Log attempt; the others do", () => {
    expect(rowButtons(workFacts("due", "4", {}, { stage: "under_contract" }), { canAct: true }).logAttempt).toBeNull();
    expect(rowButtons(workFacts("due", "4", {}, { stage: "contacted" }), { canAct: true }).logAttempt).not.toBeNull();
  });
  it("Zillow is a link item built from the address", () => {
    const z = rowButtons(workFacts("due", "4"), { canAct: true }).more.find((m) => m.id === "zillow");
    expect(z?.command).toMatchObject({ type: "link" });
    expect((z?.command as { href: string }).href).toContain("zillow.com");
  });
});
