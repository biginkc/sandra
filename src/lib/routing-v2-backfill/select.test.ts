import { describe, expect, it } from "vitest";

import {
  ageBucket,
  alreadyBackfilled,
  selectCandidates,
  type ContactFacts,
  type InboundRow,
  type LatestOutbound,
  type PropertyFacts,
  type SelectionFacts,
} from "./select";

const NOW = Date.parse("2026-10-31T18:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const C1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function row(id: string, propertyId: string, age: number, over: Partial<InboundRow> = {}): InboundRow {
  return { id, propertyId, contactId: C1, conversationId: null, createdAt: daysAgo(age), fromAddress: "+18165550101", webhookKeyword: null, marker: null, hasLiveDecision: false, ...over };
}
function prop(id: string, over: Partial<PropertyFacts> = {}): PropertyFacts {
  return { id, needsHumanAttention: false, terminalDisposition: false, isDncLocked: false, aiResponderDisabled: false, testRunId: null, lastPersonTakeoverAt: null, v2Live: true, ...over };
}
function facts(inbounds: InboundRow[], over: Partial<{ properties: PropertyFacts[]; outbound: Array<[string, LatestOutbound]>; contacts: Array<[string, ContactFacts]>; suppressed: string[] }> = {}): SelectionFacts {
  const props = over.properties ?? [...new Set(inbounds.map((r) => r.propertyId))].map((id) => prop(id));
  return {
    inbounds,
    properties: new Map(props.map((p) => [p.id, p])),
    latestOutbound: new Map(over.outbound ?? []),
    contacts: new Map(over.contacts ?? [[C1, { doNotContact: false, smsOptedOut: false, consentOptedOut: false }]]),
    suppressedInboundIds: new Set(over.suppressed ?? []),
  };
}
const sel = (f: SelectionFacts, mode: "dry_run" | "classify_only" | "apply" = "apply") => selectCandidates(f, { nowMs: NOW, maxAgeDays: 60, mode });

describe("age buckets", () => {
  it.each([[0, "0-7d"], [7.9, "0-7d"], [8, "8-14d"], [14.5, "8-14d"], [15, "15-30d"], [30.9, "15-30d"], [31, "31-60d"], [60.5, "31-60d"], [61, "61d+"]])("%s days -> %s", (d, b) => {
    expect(ageBucket(d as number)).toBe(b);
  });
});

describe("newest seller text per property wins", () => {
  it("picks the newest text; older unanswered texts on the same property are superseded, not routed", () => {
    const s = sel(facts([row("a", P1, 20), row("b", P1, 3), row("c", P1, 10), row("d", P2, 40)]));
    expect(s.candidates.map((c) => c.id).sort()).toEqual(["b", "d"]);
    expect(s.superseded.map((x) => [x.inboundId, x.byInboundId]).sort()).toEqual([["a", "b"], ["c", "b"]]);
    expect(s.candidates.find((c) => c.id === "b")!.supersedes.sort()).toEqual(["a", "c"]);
    expect(s.candidates.find((c) => c.id === "b")!.bucket).toBe("0-7d");
  });

  it("texts outside the window never become candidates", () => {
    const s = sel(facts([row("old", P1, 75)]));
    expect(s.candidates).toEqual([]);
    expect(s.skipped).toEqual([expect.objectContaining({ inboundId: "old", reason: "outside_window" })]);
  });

  it("a skipped newest text does not let an older text on the same property through", () => {
    const s = sel(facts([row("old", P1, 20), row("new", P1, 2)], { outbound: [[P1, { at: daysAgo(1), humanAt: daysAgo(1) }]] }));
    expect(s.candidates).toEqual([]);
    expect(s.superseded).toEqual([]);
    expect(s.skipped).toEqual([expect.objectContaining({ inboundId: "new", reason: "answered_by_human" })]);
  });
});

describe("skip rules", () => {
  const one = (over: Parameters<typeof facts>[1], r: Partial<InboundRow> = {}) => sel(facts([row("x", P1, 5, r)], over));
  const reason = (s: ReturnType<typeof sel>) => s.skipped.find((k) => k.inboundId === "x")?.reason ?? null;

  it("any outbound after the text = answered (human vs automation named)", () => {
    expect(reason(one({ outbound: [[P1, { at: daysAgo(4), humanAt: daysAgo(4) }]] }))).toBe("answered_by_human");
    expect(reason(one({ outbound: [[P1, { at: daysAgo(4), humanAt: null }]] }))).toBe("answered_by_automation");
    // Outbound BEFORE the text does not answer it.
    expect(reason(one({ outbound: [[P1, { at: daysAgo(6), humanAt: daysAgo(6) }]] }))).toBeNull();
  });
  it("needs a person already", () => expect(reason(one({ properties: [prop(P1, { needsHumanAttention: true })] }))).toBe("needs_human_attention"));
  it("terminal disposition", () => expect(reason(one({ properties: [prop(P1, { terminalDisposition: true })] }))).toBe("terminal_disposition"));
  it("DNC-locked property", () => expect(reason(one({ properties: [prop(P1, { isDncLocked: true })] }))).toBe("dnc_locked"));
  it("suppressed phone", () => expect(reason(one({ suppressed: ["x"] }))).toBe("phone_suppressed"));
  it("contact do-not-contact", () => expect(reason(one({ contacts: [[C1, { doNotContact: true, smsOptedOut: false, consentOptedOut: false }]] }))).toBe("contact_do_not_contact"));
  it("opted out (flag or consent)", () => {
    expect(reason(one({ contacts: [[C1, { doNotContact: false, smsOptedOut: true, consentOptedOut: false }]] }))).toBe("opted_out");
    expect(reason(one({ contacts: [[C1, { doNotContact: false, smsOptedOut: false, consentOptedOut: true }]] }))).toBe("opted_out");
  });
  it("test-tagged lead", () => expect(reason(one({ properties: [prop(P1, { testRunId: "stress-1" })] }))).toBe("test_tagged"));
  it("a person took over after the text (§14)", () => {
    expect(reason(one({ properties: [prop(P1, { lastPersonTakeoverAt: daysAgo(4) })] }))).toBe("human_takeover_after_inbound");
    expect(reason(one({ properties: [prop(P1, { lastPersonTakeoverAt: daysAgo(9) })] }))).toBeNull();
  });
  it("responder switched off for the property", () => expect(reason(one({ properties: [prop(P1, { aiResponderDisabled: true })] }))).toBe("ai_responder_disabled"));
  it("v2 not live for the property (flags / canary / engine)", () => expect(reason(one({ properties: [prop(P1, { v2Live: false })] }))).toBe("v2_not_live"));
  it("webhook keyword exit", () => expect(reason(one({}, { webhookKeyword: "STOP" }))).toBe("webhook_keyword"));
  it("no contact", () => expect(reason(one({}, { contactId: null }))).toBe("no_contact"));
  it("a live v2 decision a backfill did not write", () => expect(reason(one({}, { hasLiveDecision: true }))).toBe("already_routed_live"));
});

describe("idempotence / resume", () => {
  const classified = { classify: { runId: "bf-1", at: daysAgo(1) } };
  const applied = { apply: { runId: "bf-2", at: daysAgo(1) } };
  const superseded = { superseded: { runId: "bf-2", at: daysAgo(1), byInboundId: "y" } };

  it("apply never re-routes a text any backfill apply run routed or superseded", () => {
    expect(alreadyBackfilled(applied, "apply")).toBe(true);
    expect(alreadyBackfilled(superseded, "apply")).toBe(true);
    expect(alreadyBackfilled(applied, "classify_only")).toBe(true);
  });
  it("classify-only does not re-classify; apply still carries out a classify-only decision", () => {
    expect(alreadyBackfilled(classified, "classify_only")).toBe(true);
    expect(alreadyBackfilled(classified, "apply")).toBe(false);
    const s = sel(facts([row("x", P1, 5, { marker: classified, hasLiveDecision: true })]), "apply");
    expect(s.candidates.map((c) => c.id)).toEqual(["x"]);
  });
  it("a second apply run over the same data selects nothing new", () => {
    const s = sel(facts([row("old", P1, 9, { marker: superseded }), row("new", P1, 2, { marker: applied, hasLiveDecision: true })]), "apply");
    expect(s.candidates).toEqual([]);
    expect(s.superseded).toEqual([]);
    expect(s.skipped.map((k) => k.reason)).toEqual(["already_backfilled"]);
  });
  it("an interrupted backfill apply (decision row + applyStarted, no apply) is resumable, not routed-live", () => {
    const started = { applyStarted: { runId: "bf-3", at: daysAgo(1) } };
    const s = sel(facts([row("x", P1, 5, { marker: started, hasLiveDecision: true })]), "apply");
    expect(s.candidates.map((c) => c.id)).toEqual(["x"]);
  });
  it("an interrupted apply's OWN reply is not an answer by someone else; another reply still is", () => {
    const started = { applyStarted: { runId: "bf-3", at: daysAgo(1) } };
    const own = { at: daysAgo(4), humanAt: null, aiReplies: [{ at: daysAgo(4), inboundRef: "x" }], nonAiAt: null };
    expect(sel(facts([row("x", P1, 5, { marker: started, hasLiveDecision: true })], { outbound: [[P1, own]] }), "apply").candidates.map((c) => c.id)).toEqual(["x"]);
    // Not interrupted: the same reply means it was answered.
    expect(sel(facts([row("x", P1, 5)], { outbound: [[P1, own]] }), "apply").skipped.map((k) => k.reason)).toEqual(["answered_by_automation"]);
    // Interrupted, but a drip went out after the text: answered by automation.
    const drip = { at: daysAgo(4), humanAt: null, aiReplies: [], nonAiAt: daysAgo(4) };
    expect(sel(facts([row("x", P1, 5, { marker: started, hasLiveDecision: true })], { outbound: [[P1, drip]] }), "apply").skipped.map((k) => k.reason)).toEqual(["answered_by_automation"]);
  });
  it("an older text already superseded is not superseded again", () => {
    const s = sel(facts([row("old", P1, 9, { marker: superseded }), row("new", P1, 2)]), "apply");
    expect(s.candidates.map((c) => c.id)).toEqual(["new"]);
    expect(s.superseded).toEqual([]);
  });
});
