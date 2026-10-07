import { describe, expect, it } from "vitest";

import {
  classifyGateRow,
  classifyNewerInboundHandler,
  decideDraftGate,
  decideSendGate,
  NEWER_INBOUND_GRACE_MS,
  silentExitReason,
  silentSkipClaimOutcome,
  type GateOutboundFact,
  type NewerInboundFact,
} from "./send-gate";

const none: NewerInboundFact = { present: false };
const fact = (
  author: GateOutboundFact["author"],
  stage: GateOutboundFact["stage"] = "submitted",
  scheduledFuture = false,
): GateOutboundFact => ({ author, stage, scheduledFuture });
const decide = (
  outbound: GateOutboundFact[],
  newerInbound: NewerInboundFact = none,
  phase: "early" | "presend" = "presend",
) => decideSendGate({ newerInbound, outbound }, { phase });

describe("Q8 rule 1: a newer inbound text from the seller exists", () => {
  it("rule 1 live handler: not sent, nothing flagged", () => {
    expect(decide([], { present: true, handled: true, ageMs: 60_000 })).toEqual({
      action: "skip",
      flag: false,
      rule: 1,
      reason: "newer_inbound_handled",
    });
  });
  it("rule 1 no live handler: not sent, flagged for a human", () => {
    expect(decide([], { present: true, handled: false, ageMs: 60_000 })).toEqual({
      action: "skip",
      flag: true,
      rule: 1,
      reason: "newer_inbound_unhandled",
    });
  });
  it("rule 1 (early gate only): a newer inbound younger than the grace window with no handler yet is deferred, not flagged", () => {
    const young: NewerInboundFact = { present: true, handled: false, ageMs: NEWER_INBOUND_GRACE_MS - 1 };
    expect(decide([], young, "early")).toEqual({ action: "defer", rule: 1 });
    // The pre-send check is final: the same young inbound is flagged there.
    expect(decide([], young, "presend")).toMatchObject({ action: "skip", flag: true, rule: 1 });
    // A future timestamp (clock skew) is young too; an unusable one is not.
    expect(decide([], { present: true, handled: false, ageMs: -2_000 }, "early")).toEqual({ action: "defer", rule: 1 });
    expect(decide([], { present: true, handled: false, ageMs: null }, "early")).toMatchObject({ action: "skip", flag: true });
    // At exactly the grace age (or older) the early gate flags.
    expect(decide([], { present: true, handled: false, ageMs: NEWER_INBOUND_GRACE_MS }, "early")).toMatchObject({
      action: "skip",
      flag: true,
      rule: 1,
    });
  });
  it("rule 1 ordering: an unhandled newer inbound beats an already-answered seller (flag, not silent)", () => {
    expect(decide([fact("ai_this_inbound")], { present: true, handled: false, ageMs: 60_000 })).toMatchObject({
      action: "skip",
      flag: true,
      rule: 1,
    });
  });
  it("rule 1 ordering: a handled newer inbound beats an unrelated text and a pending competitor (silent)", () => {
    expect(
      decide([fact("ai_other_inbound"), fact("human_after_inbound", "queued")], {
        present: true,
        handled: true,
        ageMs: 60_000,
      }),
    ).toMatchObject({ action: "skip", flag: false, rule: 1 });
  });
});

describe("Q8 rule 2: the seller is already answered", () => {
  it("rule 2 an AI reply to this inbound, submitted or delivered: silent", () => {
    for (const author of ["ai_this_inbound"] as const) {
      expect(decide([fact(author)])).toEqual({
        action: "skip",
        flag: false,
        rule: 2,
        reason: "already_answered",
        answeredBy: "ai",
      });
    }
  });
  it("rule 2 a human/rep text after the inbound, submitted or delivered: silent", () => {
    expect(decide([fact("human_after_inbound")])).toEqual({
      action: "skip",
      flag: false,
      rule: 2,
      reason: "already_answered",
      answeredBy: "human",
    });
  });
  it("rule 2 ordering: answered beats an unrelated AI reply, a queued competitor and a broadcast", () => {
    expect(
      decide([
        fact("ai_other_inbound"),
        fact("human_after_inbound", "queued"),
        fact("broadcast"),
        fact("human_after_inbound"),
      ]),
    ).toMatchObject({ action: "skip", flag: false, rule: 2 });
  });
});

describe("Q8 rule 3: an unrelated conversational text was submitted", () => {
  it("rule 3 an AI reply to a different inbound (or with no inbound id): flagged", () => {
    expect(decide([fact("ai_other_inbound")])).toEqual({
      action: "skip",
      flag: true,
      rule: 3,
      reason: "unrelated_conversational_text",
    });
  });
  it("rule 3 any other conversational text that does not answer the seller: flagged", () => {
    expect(decide([fact("human_unrelated")])).toMatchObject({ action: "skip", flag: true, rule: 3 });
  });
  it("rule 3 ordering: beats a queued competitor and a broadcast", () => {
    expect(decide([fact("broadcast"), fact("human_after_inbound", "queued"), fact("ai_other_inbound")])).toMatchObject({
      flag: true,
      rule: 3,
    });
  });
});

describe("Q8 rule 4: a competing reply is still queued, not yet submitted", () => {
  it("rule 4 a queued human/rep text: retry later (never a silent skip)", () => {
    expect(decide([fact("human_after_inbound", "queued")])).toEqual({ action: "retry", rule: 4 });
    expect(decide([fact("human_after_inbound", "queued", false)])).toEqual({ action: "retry", rule: 4 });
  });
  it("rule 4 a queued AI reply to THIS inbound is pending, not answered", () => {
    expect(decide([fact("ai_this_inbound", "queued")])).toEqual({ action: "retry", rule: 4 });
  });
  it("rule 4 an AI reply to a DIFFERENT inbound that is still pending is pending, not unrelated", () => {
    expect(decide([fact("ai_other_inbound", "queued")])).toEqual({ action: "retry", rule: 4 });
  });
  it("rule 4 a rep's text scheduled for a future time: silent, nothing flagged, no retry", () => {
    expect(decide([fact("human_after_inbound", "queued", true)])).toEqual({
      action: "skip",
      flag: false,
      rule: 4,
      reason: "rep_text_scheduled",
    });
  });
  it("rule 4 a queued broadcast is not a competing reply", () => {
    expect(decide([fact("broadcast", "queued")])).toEqual({ action: "send", rule: 6 });
  });
});

describe("Q8 rule 5: only automated broadcasts have gone out", () => {
  it("rule 5 a submitted or delivered broadcast: silent", () => {
    expect(decide([fact("broadcast")])).toEqual({
      action: "skip",
      flag: false,
      rule: 5,
      reason: "broadcast_only",
    });
  });
});

describe("Q8 rule 6: otherwise the AI reply is sent", () => {
  it("rule 6 no evidence at all", () => {
    expect(decide([])).toEqual({ action: "send", rule: 6 });
  });
});

describe("classifyGateRow", () => {
  const T0 = Date.parse("2026-06-13T18:00:00.000Z");
  const ctx = { inboundMessageId: "in-1", inboundCreatedAtMs: T0, nowMs: T0 + 30_000 };
  const row = (over: Record<string, unknown> = {}) => ({
    id: "m1",
    created_at: "2026-06-13T18:00:05.000Z",
    status: "sent",
    campaign_id: null,
    metadata: null,
    ...over,
  });

  it("only pending/queued/sent/delivered rows are evidence (failed, bounced, paused are dropped)", () => {
    for (const status of ["failed", "bounced", "paused", "received"]) {
      expect(classifyGateRow(row({ status }), ctx), status).toBeNull();
    }
    expect(classifyGateRow(row({ status: "pending" }), ctx)?.stage).toBe("queued");
    expect(classifyGateRow(row({ status: "queued" }), ctx)?.stage).toBe("queued");
    expect(classifyGateRow(row({ status: "sent" }), ctx)?.stage).toBe("submitted");
    expect(classifyGateRow(row({ status: "delivered" }), ctx)?.stage).toBe("submitted");
  });
  it("bulk campaign, Norma pre-call, sequence tick, seller reminder and step-run links are broadcast", () => {
    expect(classifyGateRow(row({ campaign_id: "c1" }), ctx)?.author).toBe("broadcast");
    expect(classifyGateRow(row({ metadata: { generated_by: "norma_precall" } }), ctx)?.author).toBe("broadcast");
    expect(classifyGateRow(row({ metadata: { generated_by: "sequence_tick" } }), ctx)?.author).toBe("broadcast");
    expect(classifyGateRow(row({ metadata: { kind: "seller_appointment_reminder" } }), ctx)?.author).toBe("broadcast");
    expect(classifyGateRow(row(), { ...ctx, sequenceMessageIds: new Set(["m1"]) })?.author).toBe("broadcast");
  });
  it("an AI row stamped with THIS inbound vs another inbound vs no inbound id", () => {
    const meta = (inbound?: string) => ({ generated_by: "ai_responder_v1", ...(inbound ? { inbound_message_id: inbound } : {}) });
    expect(classifyGateRow(row({ metadata: meta("in-1") }), ctx)?.author).toBe("ai_this_inbound");
    expect(classifyGateRow(row({ metadata: meta("in-2") }), ctx)?.author).toBe("ai_other_inbound");
    expect(classifyGateRow(row({ metadata: meta() }), ctx)?.author).toBe("ai_other_inbound");
    expect(classifyGateRow(row({ metadata: meta("in-1") }), { ...ctx, inboundMessageId: null })?.author).toBe("ai_other_inbound");
  });
  it("a queued same-inbound AI row stays queued (pending), never answered", () => {
    expect(
      classifyGateRow(row({ status: "queued", metadata: { generated_by: "ai_responder_v1", inbound_message_id: "in-1" } }), ctx),
    ).toEqual({ author: "ai_this_inbound", stage: "queued", scheduledFuture: false });
  });
  it("a human/rep text answers only when created at/after the inbound; otherwise it is unrelated", () => {
    expect(classifyGateRow(row(), ctx)?.author).toBe("human_after_inbound");
    // Submitted evidence from before the inbound is dropped (rule 3 is "since the inbound").
    expect(classifyGateRow(row({ created_at: "2026-06-13T17:59:00.000Z" }), ctx)).toBeNull();
    expect(classifyGateRow(row(), { ...ctx, inboundCreatedAtMs: null })?.author).toBe("human_unrelated");
    expect(classifyGateRow(row({ created_at: "garbage" }), ctx)?.author).toBe("human_unrelated");
  });
  it("a queued human text with a future scheduled_for is scheduledFuture; a past or null one is not", () => {
    expect(classifyGateRow(row({ status: "queued", scheduled_for: "2026-06-13T20:00:00.000Z" }), ctx)?.scheduledFuture).toBe(true);
    expect(classifyGateRow(row({ status: "queued", scheduled_for: "2026-06-13T18:00:10.000Z" }), ctx)?.scheduledFuture).toBe(false);
    expect(classifyGateRow(row({ status: "queued", scheduled_for: null }), ctx)?.scheduledFuture).toBe(false);
  });
});

describe("classifyNewerInboundHandler (rule 1: what counts as a LIVE handler)", () => {
  const nowMs = Date.parse("2026-06-13T18:00:00.000Z");
  const future = "2026-06-13T18:05:00.000Z";
  const past = "2026-06-13T17:55:00.000Z";
  const workflow = { outcome: "delayed", workflowRunId: "wf_1" };

  it("a processing claim with an unexpired lease is live; an expired one is not", () => {
    expect(classifyNewerInboundHandler({ claim: { status: "processing", lease_expires_at: future }, stamp: null, nowMs })).toBe(true);
    expect(classifyNewerInboundHandler({ claim: { status: "processing", lease_expires_at: past }, stamp: null, nowMs })).toBe(false);
    // A confirmed reply delay (workflow id) still counts alongside an expired claim.
    expect(classifyNewerInboundHandler({ claim: { status: "processing", lease_expires_at: past }, stamp: workflow, nowMs })).toBe(true);
    expect(classifyNewerInboundHandler({ claim: { status: "processing", lease_expires_at: "garbage" }, stamp: null, nowMs })).toBe(false);
  });
  it("a retry parked retry_scheduled counts only when its scheduling was confirmed (workflow run id stamped)", () => {
    const claim = { status: "error", error_message: "retry_scheduled:send_lease_lost:1", lease_expires_at: past };
    expect(classifyNewerInboundHandler({ claim, stamp: workflow, nowMs })).toBe(true);
    expect(classifyNewerInboundHandler({ claim, stamp: null, nowMs })).toBe(false);
    expect(classifyNewerInboundHandler({ claim, stamp: { outcome: "delayed" }, nowMs })).toBe(false);
  });
  it("a delayed stamp counts only with a workflow run id (no claim yet)", () => {
    expect(classifyNewerInboundHandler({ claim: null, stamp: workflow, nowMs })).toBe(true);
    expect(classifyNewerInboundHandler({ claim: null, stamp: { outcome: "delayed" }, nowMs })).toBe(false);
    expect(classifyNewerInboundHandler({ claim: null, stamp: { outcome: "delayed", workflowRunId: "" }, nowMs })).toBe(false);
    expect(classifyNewerInboundHandler({ claim: null, stamp: null, nowMs })).toBe(false);
  });
  it("a plain errored claim is not a handler, even when a stale delayed stamp is present", () => {
    expect(classifyNewerInboundHandler({ claim: { status: "error", error_message: "boom", lease_expires_at: past }, stamp: workflow, nowMs })).toBe(false);
  });
  it("a completed claim is a live handler ONLY when it sent a reply or flagged the property (or ended by design)", () => {
    const completed = (outcome: string | null) =>
      classifyNewerInboundHandler({ claim: { status: "completed", outcome, lease_expires_at: past }, stamp: null, nowMs });
    expect(completed("sent")).toBe(true);
    expect(completed("escalated")).toBe(true);
    // Rule-0 type endings: silent by design.
    expect(completed("opted_out")).toBe(true);
    expect(completed("auto_closed")).toBe(true);
    // Everything else handled nothing.
    for (const outcome of ["skipped", "no_consent", "disabled_org_wide", "disabled_per_property", "retry", null]) {
      expect(completed(outcome)).toBe(false);
    }
  });
  it("a completed claim is authoritative over a stale delayed stamp", () => {
    expect(classifyNewerInboundHandler({ claim: { status: "completed", outcome: "skipped", lease_expires_at: past }, stamp: workflow, nowMs })).toBe(false);
  });
  it("a terminally errored claim (reply_ineligible) is not a handler", () => {
    expect(classifyNewerInboundHandler({ claim: { status: "error", error_message: "reply_ineligible", lease_expires_at: past }, stamp: null, nowMs })).toBe(false);
  });
});

describe("Q8 rule 0: suppression / disabled / consent exits are silent by design and checked first", () => {
  const silentExit = { reason: "disabled_per_property" };
  it("rule 0 beats every other rule, including an unhandled newer inbound and an unrelated text (nothing flagged)", () => {
    expect(
      decideSendGate({
        silentExit,
        newerInbound: { present: true, handled: false, ageMs: 60_000 },
        outbound: [fact("ai_other_inbound"), fact("human_unrelated")],
      }),
    ).toEqual({ action: "skip", flag: false, rule: 0, reason: "disabled_per_property" });
  });
  it("rule 0 also applies at the early gate (no defer)", () => {
    expect(
      decideSendGate(
        { silentExit, newerInbound: { present: true, handled: false, ageMs: 1_000 }, outbound: [] },
        { phase: "early" },
      ),
    ).toMatchObject({ action: "skip", flag: false, rule: 0 });
  });
  it("silentExitReason maps org off, opt-out and disabled property; otherwise null", () => {
    expect(silentExitReason({ configActive: false, consentState: "opted_in", propertyDisabled: false })).toBe("disabled_org_wide");
    expect(silentExitReason({ configActive: true, consentState: "opted_out", propertyDisabled: false })).toBe("no_consent");
    expect(silentExitReason({ configActive: true, consentState: "cold", propertyDisabled: true })).toBe("disabled_per_property");
    expect(silentExitReason({ configActive: true, consentState: "cold", propertyDisabled: false })).toBeNull();
  });
});

describe("Q8 rule 8 inside the gate: a terminal draft ends silently, before rules 1-6", () => {
  it("rule 8 beats an unhandled newer inbound and an unrelated text", () => {
    expect(
      decideSendGate({
        terminalDraft: true,
        newerInbound: { present: true, handled: false, ageMs: 60_000 },
        outbound: [fact("ai_other_inbound")],
      }),
    ).toEqual({ action: "skip", flag: false, rule: 8, reason: "already_answered" });
  });
  it("rule 0 is checked before rule 8", () => {
    expect(
      decideSendGate({ silentExit: { reason: "no_consent" }, terminalDraft: true, newerInbound: none, outbound: [] }),
    ).toMatchObject({ rule: 0 });
  });
});

describe("classifyGateRow: 'went out' is the submission time", () => {
  const ctx = {
    inboundMessageId: "in-1",
    inboundCreatedAtMs: Date.parse("2026-06-13T18:00:00.000Z"),
    nowMs: Date.parse("2026-06-13T18:30:00.000Z"),
  };
  const rep = (over: Record<string, unknown>) => ({ id: "m", created_at: "2026-06-13T17:00:00.000Z", status: "sent", metadata: null, ...over });
  it("a rep text created BEFORE the inbound but submitted AFTER it answers the seller", () => {
    expect(classifyGateRow(rep({ sent_at: "2026-06-13T18:05:00.000Z" }), ctx)?.author).toBe("human_after_inbound");
  });
  it("a rep text created and submitted before the inbound is not evidence (rule 3 is since the inbound)", () => {
    expect(classifyGateRow(rep({ sent_at: "2026-06-13T17:30:00.000Z" }), ctx)).toBeNull();
  });
  it("a QUEUED rep text is judged by created_at only (it has not gone out)", () => {
    expect(classifyGateRow(rep({ status: "queued", sent_at: "2026-06-13T18:05:00.000Z" }), ctx)?.author).toBe("human_unrelated");
  });
});

describe("rules 3 and 5 are bounded 'since the seller's inbound' (classifyGateRow)", () => {
  const inboundMs = Date.parse("2026-06-13T18:00:00.000Z");
  const ctx = { inboundMessageId: "in-2", inboundCreatedAtMs: inboundMs, nowMs: inboundMs + 60_000 };
  const base = { id: "m", created_at: "2026-06-13T17:59:40.000Z", sent_at: "2026-06-13T17:59:40.000Z", status: "sent" };
  const aiTo = (inbound: string) => ({ generated_by: "ai_responder_v1", inbound_message_id: inbound });

  it("AI reply to X that went out before Y is dropped; after Y it is ai_other_inbound", () => {
    expect(classifyGateRow({ ...base, metadata: aiTo("in-1") }, ctx)).toBeNull();
    expect(
      classifyGateRow({ ...base, created_at: "2026-06-13T18:00:05.000Z", sent_at: "2026-06-13T18:00:05.000Z", metadata: aiTo("in-1") }, ctx)?.author,
    ).toBe("ai_other_inbound");
  });
  it("a broadcast submitted before Y is dropped; one submitted after Y is a broadcast", () => {
    expect(classifyGateRow({ ...base, campaign_id: "c1", metadata: null }, ctx)).toBeNull();
    expect(classifyGateRow({ ...base, metadata: { generated_by: "sequence_tick" } }, ctx)).toBeNull();
    expect(
      classifyGateRow({ ...base, campaign_id: "c1", sent_at: "2026-06-13T18:00:05.000Z", metadata: null }, ctx)?.author,
    ).toBe("broadcast");
  });
  it("sent_at, not created_at, is the time that counts for a submitted row", () => {
    expect(
      classifyGateRow({ ...base, created_at: "2026-06-13T17:00:00.000Z", sent_at: "2026-06-13T18:00:05.000Z", campaign_id: "c1", metadata: null }, ctx)?.author,
    ).toBe("broadcast");
  });
  it("QUEUED rows are never dropped by the bound (outstanding competitors stay evidence)", () => {
    expect(classifyGateRow({ ...base, status: "queued", metadata: aiTo("in-1") }, ctx)).toEqual({ author: "ai_other_inbound", stage: "queued", scheduledFuture: false });
    expect(classifyGateRow({ ...base, status: "queued", campaign_id: "c1", metadata: null }, ctx)?.stage).toBe("queued");
  });
  it("an unreadable time stays evidence (fail toward the gate)", () => {
    expect(classifyGateRow({ ...base, created_at: "garbage", sent_at: null, metadata: aiTo("in-1") }, ctx)?.author).toBe("ai_other_inbound");
  });
});

describe("rule 1 'handled': a claim that ended silently under rule 0/2/4/5/8", () => {
  const nowMs = Date.parse("2026-06-13T18:00:00.000Z");
  const past = "2026-06-13T17:55:00.000Z";
  const workflow = { outcome: "delayed", workflowRunId: "wf_1" };
  it("skipped:rule_0/2/4/5/8 count as handled", () => {
    for (const rule of [0, 2, 4, 5, 8] as const) {
      expect(
        classifyNewerInboundHandler({ claim: { status: "completed", outcome: silentSkipClaimOutcome(rule), lease_expires_at: past }, stamp: null, nowMs }),
      ).toBe(true);
    }
  });
  it("a bare skipped, an unknown rule, rule 1/3/6/7 and look-alikes do NOT count", () => {
    for (const outcome of ["skipped", "skipped:rule_1", "skipped:rule_3", "skipped:rule_6", "skipped:rule_7", "skipped:rule_2x", "skipped:", "rule_2"]) {
      expect(
        classifyNewerInboundHandler({ claim: { status: "completed", outcome, lease_expires_at: past }, stamp: null, nowMs }),
      ).toBe(false);
    }
  });
  it("a delay stamp counts only while its claim has not since finished without handling", () => {
    // finished without handling (bare skipped / errored non-retry): stamp is history
    expect(classifyNewerInboundHandler({ claim: { status: "completed", outcome: "skipped", lease_expires_at: past }, stamp: workflow, nowMs })).toBe(false);
    expect(classifyNewerInboundHandler({ claim: { status: "error", error_message: "reply_ineligible", lease_expires_at: past }, stamp: workflow, nowMs })).toBe(false);
    // finished by a silent rule: handled
    expect(classifyNewerInboundHandler({ claim: { status: "completed", outcome: silentSkipClaimOutcome(2), lease_expires_at: past }, stamp: workflow, nowMs })).toBe(true);
    // not finished yet: the stamp still counts
    expect(classifyNewerInboundHandler({ claim: { status: "processing", lease_expires_at: past }, stamp: workflow, nowMs })).toBe(true);
  });
});

describe("silentExitReason: the sender's own suppression is rule 0", () => {
  const base = { configActive: true, consentState: "can_send_marketing", propertyDisabled: false };
  it("contact do_not_contact, sms_opted_out and a suppressed destination phone are silent exits", () => {
    expect(silentExitReason({ ...base, doNotContact: true })).toBe("contact_do_not_contact");
    expect(silentExitReason({ ...base, smsOptedOut: true })).toBe("contact_sms_opted_out");
    expect(silentExitReason({ ...base, phoneSuppressed: true })).toBe("phone_suppressed");
    expect(silentExitReason({ ...base, doNotContact: false, smsOptedOut: false, phoneSuppressed: false })).toBeNull();
  });
});

describe("Q8 rule 8: terminal drafts are never revived", () => {
  it("rule 8 a discarded or already-sent draft is resolved (silent already_answered); pending is held; none falls through", () => {
    expect(decideDraftGate(["discarded"])).toBe("resolved");
    expect(decideDraftGate(["pending", "sent"])).toBe("resolved");
    expect(decideDraftGate(["pending"])).toBe("pending");
    expect(decideDraftGate([])).toBe("none");
  });
});
