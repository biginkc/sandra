import { describe, expect, it } from "vitest";

import type { OpenHold, PipelineRun } from "@/app/(dashboard)/messages-v2/types";

import { runHoldAlertsForOrg } from "./core";
import {
  HOT_HOLD_REASON_TOKENS,
  holdKeyFor,
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
    reason: "Jev decision pending",
    run: run(),
    ...over,
  };
}

const labels = new Map([["prop-1", { name: "Dana", address: "12 Oak St, Kansas City" }]]);

describe("HOT_HOLD_REASON_TOKENS", () => {
  it("is exactly the three PLAN D8 tokens", () => {
    expect([...HOT_HOLD_REASON_TOKENS]).toEqual(["new_lead", "price", "distress"]);
  });
});

describe("holdKeyFor", () => {
  it("keys on property and since, with unknown when age is unknown", () => {
    expect(holdKeyFor("p", "2026-10-08T10:00:00.000Z")).toBe("p:2026-10-08T10:00:00.000Z");
    expect(holdKeyFor("p", null)).toBe("p:unknown");
  });
});

describe("isHotHold", () => {
  it("matches a token in reason, flag_reason, final_outcome or run reason, case-insensitively", () => {
    expect(isHotHold(openHold({ reason: "Needs attention (NEW_LEAD)" }))).toBe(true);
    expect(isHotHold(openHold({ flag_reason: "asks_about_Price" }))).toBe(true);
    expect(isHotHold(openHold({ run: run({ final_outcome: "distress_signal" }) }))).toBe(true);
    expect(isHotHold(openHold({ run: run({ reason: "price_quoted" }) }))).toBe(true);
  });
  it("does not match other text, and never reads the inbound preview", () => {
    expect(isHotHold(openHold({ run: run({ inbound_preview: "price new_lead distress" }) }))).toBe(false);
    expect(isHotHold(openHold())).toBe(false);
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

  it("builds ids, first name, address and the hold key, nothing else", () => {
    const [h] = toAlertHolds([openHold()], labels);
    expect(h).toEqual({
      holdKey: "prop-1:2026-10-08T10:00:00.000Z",
      propertyId: "prop-1",
      since: "2026-10-08T10:00:00.000Z",
      name: "Dana",
      address: "12 Oak St, Kansas City",
      hot: false,
    });
  });

  it("falls back to an unknown-sender label when no label was loaded", () => {
    const [h] = toAlertHolds([openHold()], new Map());
    expect(h.name).toBe("Unknown sender");
    expect(h.address).toBeNull();
  });
});

describe("payloads never carry seller message text", () => {
  it("no channel's text contains the run's inbound_preview", async () => {
    const holds = toAlertHolds([openHold({ reason: "price", flag_reason: "new_lead" })], labels);
    expect(JSON.stringify(holds)).not.toContain("SELLER SAID");
    const t = makeDeps({ holds, emailEnabled: true });
    t.setNow("2026-10-08T12:00:00.000Z");
    await runHoldAlertsForOrg(t.deps, ORG);
    const channels = new Set(t.sent.map((s) => s.channel));
    expect(channels).toEqual(new Set(["slack", "sms", "email"]));
    for (const s of t.sent) {
      expect(s.text).not.toContain("SELLER SAID");
      expect(s.text).not.toContain("555-0100");
    }
    expect(JSON.stringify(t.store.rows)).not.toContain("SELLER SAID");
  });
});
