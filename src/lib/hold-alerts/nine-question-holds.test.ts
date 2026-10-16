import { describe, expect, it } from "vitest";

import type { OpenHold, PipelineRun } from "@/app/(dashboard)/messages-v2/types";

import { runHoldAlertsForOrg } from "./core";
import { isHotHold, isKnownHoldReason } from "./holds";
import { ACQ, hold, makeDeps, ORG, OWNER } from "./test-support";

const asHold = (flag_reason: string) => ({ flag_reason, sources: ["needs_attention"], run: null }) as unknown as OpenHold<PipelineRun>;

// Every hold reason the nine-question engine can write, and whether PR 2 calls it hot.
const NINE_REASONS: Array<[string, boolean]> = [
  ["hot_lead", true], // open_to_selling / talked_price with the new_lead switch off
  ["jev_new_lead_promotion_failed", true],
  ["hot_lead_assign_failed", true],
  ["hot_lead_event_failed", true],
  ["nine_asked_stop", false],
  ["nine_needs_person", false],
  ["hostile_needs_confirm:msg-1", false],
  ["reply_text_not_approved", false],
  ["classifier_engine_unreadable", false],
  ["nine_reply_not_sent:quiet_hours_recipient:x", false],
  ["nine_automation_disabled:wrong_number", false],
  ["nine_automation_disabled:asked_who", false], // PR 4 identity-reply switch off
  ["nine_close_wrong_person_unreadable", false],
  ["drip_enroll_failed:drip_not_found", false],
  ["drip_paused", false],
  ["jev_automatic_failed:auth", false],
];

describe("nine-question hold reasons vs the hot-seller definition", () => {
  it.each(NINE_REASONS)("%s hot=%s and is a known reason", (reason, hot) => {
    expect(isHotHold(asHold(reason))).toBe(hot);
    expect(isKnownHoldReason(reason)).toBe(true);
  });

  it("alert decision: only the hot holds ping, exactly one Slack + one SMS each", async () => {
    const holds = NINE_REASONS.map(([reason, hot], i) =>
      hold({ hot: isHotHold(asHold(reason)), holdKey: `p${i}:${reason}`, propertyId: `p${i}`, startedAt: "2026-10-15T11:00:00.000Z", reasonLabel: reason }),
    );
    const t = makeDeps({ nowIso: "2026-10-15T12:00:00.000Z", recipients: [OWNER, ACQ], holds });
    t.store.watermarks.set(ORG, "2026-10-15T00:00:00.000Z");
    await runHoldAlertsForOrg(t.deps, ORG);
    const hotCount = NINE_REASONS.filter(([, hot]) => hot).length;
    expect(t.sent.filter((s) => s.channel === "slack")).toHaveLength(hotCount);
    expect(t.sent.filter((s) => s.channel === "sms")).toHaveLength(hotCount);
  });
});
