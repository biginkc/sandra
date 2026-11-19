import { describe, expect, it } from "vitest";

import { brokenTarget, messagesDeadLetterHref, normaReviewHref } from "./broken-target";
import type { BrokenItem } from "./contract";

const item = (kind: BrokenItem["kind"], action: BrokenItem["action"], refId: string | null = "r1"): BrokenItem => ({ kind, action, at: null, refId });

describe("brokenTarget", () => {
  it("follow-up kinds are obligations; receipt kinds are ledger; text_not_sent is a message", () => {
    expect(brokenTarget(item("followup_text_not_delivered", "resend"))).toEqual({ sourceKind: "obligation", refId: "r1", mode: "resend" });
    expect(brokenTarget(item("followup_text_blocked", "review"))).toEqual({ sourceKind: "obligation", refId: "r1", mode: "review" });
    expect(brokenTarget(item("text_not_delivered", "resend"))).toEqual({ sourceKind: "ledger", refId: "r1", mode: "resend" });
    expect(brokenTarget(item("text_blocked", "review"))).toEqual({ sourceKind: "ledger", refId: "r1", mode: "review" });
    expect(brokenTarget(item("text_status_unknown", "check_status"))).toEqual({ sourceKind: "ledger", refId: "r1", mode: "check" });
    expect(brokenTarget(item("text_not_sent", "resend"))).toEqual({ sourceKind: "message", refId: "r1", mode: "resend" });
    expect(brokenTarget(item("followup_text_not_sent", "send_text"))).toEqual({ sourceKind: "obligation", refId: "r1", mode: "send" });
  });
  it("no target without a refId or for non-text kinds", () => {
    expect(brokenTarget(item("text_not_sent", "resend", null))).toBeNull();
    expect(brokenTarget(item("drip_paused", "fix_drip"))).toBeNull();
    expect(brokenTarget(item("ai_reply_failed", "review"))).toBeNull();
  });
  it("related-surface links carry the id", () => {
    expect(messagesDeadLetterHref("dl-1", "p1")).toBe("/messages-v2?deadLetter=dl-1");
    expect(messagesDeadLetterHref(null, "p1")).toBe("/messages-v2?property=p1");
    expect(normaReviewHref("nr-1", "p1")).toBe("/norma/queue?request=nr-1");
    expect(normaReviewHref(null, "p1")).toBe("/norma/queue");
  });
});
