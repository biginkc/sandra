import { describe, expect, it } from "vitest";

import { resolveResponderOutcome } from "./route";
import type { AiAction, AiStructuredOutput } from "./types";

const base = {
  confidence: 0.93,
  sentiment: "neutral" as const,
};

describe("resolveResponderOutcome", () => {
  it.each([
    ["hot_lead"],
    ["price_or_offer"],
    ["distress"],
    ["multi_property"],
    ["call_request"],
    ["third_party"],
    ["needs_review"],
  ] as const)("routes escalation reason %s to human handoff", (reason) => {
    expect(
      resolveResponderOutcome({
        ...base,
        action: "escalate",
        escalation_reason: reason,
      }),
    ).toEqual({ kind: "escalate", reason: `model:${reason}` });
  });

  it("routes send_reply to a send route", () => {
    expect(
      resolveResponderOutcome({
        ...base,
        action: "send_reply",
        body: "Would you consider a cash offer?",
      }),
    ).toEqual({
      kind: "send_reply",
      body: "Would you consider a cash offer?",
    });
  });

  it("routes opt_out to phone-level opt-out", () => {
    expect(resolveResponderOutcome({ ...base, action: "opt_out" })).toEqual({
      kind: "opt_out",
      reason: "model:opt_out",
    });
  });

  it.each(["this_property", "all"] as const)(
    "routes close_wrong_number scope %s",
    (scope) => {
      expect(
        resolveResponderOutcome({
          ...base,
          action: "close_wrong_number",
          wrong_scope: scope,
        }),
      ).toEqual({
        kind: "auto_close_wrong_number",
        reason: "model:wrong_number",
        scope,
      });
    },
  );

  it("routes close_not_interested to a re-textable disposition", () => {
    expect(
      resolveResponderOutcome({ ...base, action: "close_not_interested" }),
    ).toEqual({
      kind: "auto_close",
      dispo: "not_interested",
      reason: "model:not_interested",
    });
  });

  it("routes close_dnc to phone-level DNC suppression", () => {
    expect(resolveResponderOutcome({ ...base, action: "close_dnc" })).toEqual({
      kind: "close_dnc",
      reason: "model:threat_dnc",
    });
  });

  it("routes deescalate_close to the fixed-template send path", () => {
    expect(
      resolveResponderOutcome({
        ...base,
        action: "deescalate_close",
        body: "ignored by dispatch",
      }),
    ).toEqual({
      kind: "deescalate_close",
      reason: "model:deescalate_close",
    });
  });

  it("fails closed to needs_review for an unknown escalation reason at runtime", () => {
    expect(
      resolveResponderOutcome({
        ...base,
        action: "escalate",
        escalation_reason: "mystery_reason",
      } as unknown as AiStructuredOutput),
    ).toEqual({ kind: "escalate", reason: "model:needs_review" });
  });

  it("fails closed to needs_review for an unknown action at runtime", () => {
    expect(
      resolveResponderOutcome({
        ...base,
        action: "mystery_action",
      } as unknown as AiStructuredOutput),
    ).toEqual({ kind: "escalate", reason: "model:needs_review" });
  });

  it("keeps the action union exhaustiveness check compile-visible", () => {
    const _allActions: Record<AiAction, true> = {
      send_reply: true,
      escalate: true,
      opt_out: true,
      close_wrong_number: true,
      close_dnc: true,
      close_not_interested: true,
      deescalate_close: true,
    };
    expect(_allActions).toBeTruthy();
  });
});
