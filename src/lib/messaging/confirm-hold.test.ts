import { describe, expect, it } from "vitest";
import {
  HOSTILE_NEEDS_CONFIRM_REASON,
  OPTOUT_PHRASE_NEEDS_CONFIRM_REASON,
} from "@/lib/ai-responder/hostile";
import { hasOpenConfirmHold } from "./confirm-hold";

describe("hasOpenConfirmHold", () => {
  it("is true for an open stop-texting hold", () => {
    expect(hasOpenConfirmHold({ needs_human_attention: true, last_ai_escalation_reason: `${OPTOUT_PHRASE_NEEDS_CONFIRM_REASON}:msg-1` })).toBe(true);
  });
  it("is true for an open hostile hold (with or without message id)", () => {
    expect(hasOpenConfirmHold({ needs_human_attention: true, last_ai_escalation_reason: `${HOSTILE_NEEDS_CONFIRM_REASON}:msg-2` })).toBe(true);
    expect(hasOpenConfirmHold({ needs_human_attention: true, last_ai_escalation_reason: HOSTILE_NEEDS_CONFIRM_REASON })).toBe(true);
  });
  it("is false once a person clears it (needs_human_attention false)", () => {
    expect(hasOpenConfirmHold({ needs_human_attention: false, last_ai_escalation_reason: `${HOSTILE_NEEDS_CONFIRM_REASON}:msg-2` })).toBe(false);
    expect(hasOpenConfirmHold({ needs_human_attention: null, last_ai_escalation_reason: OPTOUT_PHRASE_NEEDS_CONFIRM_REASON })).toBe(false);
  });
  it("is false for other attention reasons and missing rows", () => {
    expect(hasOpenConfirmHold({ needs_human_attention: true, last_ai_escalation_reason: "some_other_reason" })).toBe(false);
    expect(hasOpenConfirmHold({ needs_human_attention: true, last_ai_escalation_reason: null })).toBe(false);
    expect(hasOpenConfirmHold(null)).toBe(false);
  });
});
