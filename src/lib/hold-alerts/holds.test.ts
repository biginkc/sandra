import { describe, expect, it, vi } from "vitest";

import type { OpenHold, PipelineRun } from "@/app/(dashboard)/messages-v2/types";

import { runHoldAlertsForOrg } from "./core";
import {
  HOT_HOLD_REASONS,
  holdKeyFor,
  parseHotHoldReasons,
  holdReasonKey,
  isHotHold,
  isInformationalHold,
  toAlertHolds,
} from "./holds";
import { makeDeps, ORG } from "./test-support";

const SECRET = "SELLER SAID: please call me about the price at 555-0100";

function run(over: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: "run-1",
    org_id: ORG,
    inbound_message_id: "msg-1",
    property_id: "prop-1",
    contact_id: "contact-1",
    conversation_id: "conv-1",
    status: "held",
    mode: "automatic",
    final_outcome: null,
    reason: null,
    classification_run_id: null,
    claim_id: null,
    outbound_message_id: null,
    inbound_preview: SECRET,
    started_at: "2026-10-08T10:00:00.000Z",
    completed_at: null,
    ...over,
  };
}

function openHold(over: Partial<OpenHold<PipelineRun>> = {}): OpenHold<PipelineRun> {
  return {
    id: "prop-1",
    property_id: "prop-1",
    conversation_id: "conv-1",
    sources: ["jev_decision"],
    since: "2026-10-08T10:00:00.000Z",
    alert_since: "2026-10-08T10:00:00.000Z",
    reason: "Jev decision pending",
    run: run(),
    ...over,
  };
}

const labels = new Map([["prop-1", { name: "Dana", address: "12 Oak St, Kansas City" }]]);

describe("HOT_HOLD_REASONS", () => {
  it("is empty by default: no hold is hot until reasons are configured", () => {
    expect([...HOT_HOLD_REASONS]).toEqual([]);
  });
});

describe("parseHotHoldReasons (HOLD_ALERT_HOT_REASONS)", () => {
  it("is empty when the env var is unset or blank", () => {
    expect(parseHotHoldReasons({})).toEqual([]);
    expect(parseHotHoldReasons({ HOLD_ALERT_HOT_REASONS: "  " })).toEqual([]);
  });
  it("reads a comma-separated list of known hold reasons, trimmed and de-duplicated", () => {
    expect(
      parseHotHoldReasons({ HOLD_ALERT_HOT_REASONS: " price_or_offer, distress ,price_or_offer,jev_below_threshold:new_lead" }),
    ).toEqual(["price_or_offer", "distress", "jev_below_threshold:new_lead"]);
  });
  it("ignores unknown values with a warning", () => {
    const warn = vi.fn();
    expect(parseHotHoldReasons({ HOLD_ALERT_HOT_REASONS: "distress,made_up,PRICE_OR_OFFER" }, warn)).toEqual(["distress"]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.flat().join(" ")).toContain("made_up");
  });
});

describe("holdKeyFor", () => {
  it("keys on property and reason only; the hold's start time is not in it", () => {
    expect(holdKeyFor("p", "draft_held")).toBe("p:draft_held");
    const a = toAlertHolds([openHold({ since: "2026-10-08T10:00:00.000Z", flag_reason: "draft_held" })], labels)[0]!;
    const b = toAlertHolds([openHold({ since: "2026-10-08T07:00:00.000Z", flag_reason: "draft_held" })], labels)[0]!;
    expect(a.holdKey).toBe(b.holdKey);
  });
  it("uses the sources when the hold has no flag reason, and changes when the reason does", () => {
    expect(holdReasonKey({ flag_reason: undefined, sources: ["jev_decision", "pending_draft"] })).toBe("jev_decision+pending_draft");
    expect(holdReasonKey({ flag_reason: "price_or_offer", sources: ["needs_attention"] })).toBe("price_or_offer");
  });
});

describe("isHotHold", () => {
  const HOT = ["jev_below_threshold:new_lead", "price_or_offer", "distress"];
  it("is never hot with no configured reasons", () => {
    expect(isHotHold(openHold({ flag_reason: "price_or_offer" }))).toBe(false);
  });
  it("matches only an exact reason from HOT_HOLD_REASONS: flag reason, run outcome or run reason", () => {
    expect(isHotHold(openHold({ flag_reason: "jev_below_threshold:new_lead" }), HOT)).toBe(true);
    expect(isHotHold(openHold({ flag_reason: "price_or_offer" }), HOT)).toBe(true);
    expect(isHotHold(openHold({ run: run({ final_outcome: "distress" }) }), HOT)).toBe(true);
    expect(isHotHold(openHold({ run: run({ reason: "price_or_offer" }) }), HOT)).toBe(true);
  });
  it("does not match substrings, other casing, composite hold text or other reasons", () => {
    expect(isHotHold(openHold({ flag_reason: "price_quoted" }), HOT)).toBe(false);
    expect(isHotHold(openHold({ flag_reason: "distressed_seller" }), HOT)).toBe(false);
    expect(isHotHold(openHold({ flag_reason: "jev_below_threshold:not_interested" }), HOT)).toBe(false);
    expect(isHotHold(openHold({ flag_reason: "PRICE_OR_OFFER" }), HOT)).toBe(false);
    expect(isHotHold(openHold({ reason: "Needs attention (price_or_offer, distress)" }), HOT)).toBe(false);
  });
  it("never reads the inbound preview", () => {
    expect(isHotHold(openHold({ run: run({ inbound_preview: "price_or_offer distress" }) }), HOT)).toBe(false);
    expect(isHotHold(openHold(), HOT)).toBe(false);
  });
});

describe("isInformationalHold", () => {
  it("is only the send_timeout_then_sent flag with the needs_attention source alone", () => {
    expect(isInformationalHold(openHold({ flag_reason: "send_timeout_then_sent", sources: ["needs_attention"] }))).toBe(true);
    expect(isInformationalHold(openHold({ flag_reason: "send_timeout_then_sent", sources: ["needs_attention", "jev_decision"] }))).toBe(false);
    expect(isInformationalHold(openHold({ flag_reason: "other", sources: ["needs_attention"] }))).toBe(false);
  });
});

describe("toAlertHolds", () => {
  it("skips holds without a property and informational holds", () => {
    const out = toAlertHolds(
      [
        openHold(),
        openHold({ id: "draft:1", property_id: null }),
        openHold({ id: "prop-3", property_id: "prop-3", flag_reason: "send_timeout_then_sent", sources: ["needs_attention"] }),
      ],
      labels,
    );
    expect(out.map((h) => h.propertyId)).toEqual(["prop-1"]);
  });

  it("builds ids, first name and the hold key, nothing else (no address)", () => {
    const [h] = toAlertHolds([openHold()], labels);
    expect(h).toEqual({
      holdKey: "prop-1:jev_decision",
      propertyId: "prop-1",
      since: "2026-10-08T10:00:00.000Z",
      startedAt: "2026-10-08T10:00:00.000Z",
      name: "Dana",
      hot: false,
    });
  });

  it("carries an unknown start through as null (backlog never alerts)", () => {
    const [h] = toAlertHolds([openHold({ alert_since: null })], labels);
    expect(h.startedAt).toBeNull();
  });

  it("falls back to an unknown-sender label when no label was loaded", () => {
    const [h] = toAlertHolds([openHold()], new Map());
    expect(h.name).toBe("Unknown sender");
  });
});

describe("payloads never carry seller message text", () => {
  it("no channel's text contains the run's inbound_preview", async () => {
    const holds = toAlertHolds([openHold({ flag_reason: "price_or_offer" })], labels, ["price_or_offer"]);
    expect(JSON.stringify(holds)).not.toContain("SELLER SAID");
    const t = makeDeps({ holds, emailEnabled: true });
    t.setNow("2026-10-08T12:00:00.000Z");
    await runHoldAlertsForOrg(t.deps, ORG);
    const channels = new Set(t.sent.map((s) => s.channel));
    expect(channels).toEqual(new Set(["slack", "sms", "email"]));
    for (const s of t.sent) {
      expect(s.text).not.toContain("SELLER SAID");
      expect(s.text).not.toContain("555-0100");
      expect(s.text).not.toContain("Oak St");
    }
    expect(JSON.stringify(t.store.rows)).not.toContain("SELLER SAID");
  });
});

describe("nurture auto-drip hold reasons are known", () => {
  it("recognises nurture_reply_not_sent:<reason> and drip_enroll_failed:<reason>, but not an empty tail", async () => {
    const { isKnownHoldReason } = await import("./holds");
    expect(isKnownHoldReason("nurture_reply_not_sent:quiet_hours_recipient:closed")).toBe(true);
    expect(isKnownHoldReason("nurture_reply_not_sent:no_mapping")).toBe(true);
    expect(isKnownHoldReason("drip_enroll_failed:no_consent")).toBe(true);
    expect(isKnownHoldReason("drip_enroll_failed:")).toBe(false);
    expect(isKnownHoldReason("drip_enroll_failed:has space")).toBe(false);
  });
});
