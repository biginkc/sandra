import { describe, expect, it } from "vitest";

import { resolvePolicyOutcome } from "./policy";
import type { SmsClassificationDecision } from "./types";

function baseDecision(
  overrides: Partial<SmsClassificationDecision> = {},
): SmsClassificationDecision {
  return {
    outcome: "not_interested",
    wrongScope: null,
    escalationReason: null,
    replyIntent: null,
    replyIntentAvailable: false,
    probabilities: {},
    provider: "jev",
    model: "jev-1.13.0",
    schemaVersion: "1",
    usage: null,
    latencyMs: 10,
    ...overrides,
  };
}

describe("resolvePolicyOutcome", () => {
  it.each([0, 0.5, 1, null])("keeps new leads out of nurture even at confidence %s", async (confidence) => {
    const result = await resolvePolicyOutcome(baseDecision({ outcome: "new_lead", outcomeConfidence: confidence }));
    expect(result).toMatchObject({ kind: "route", route: { kind: "escalate", reason: "model:hot_lead" } });
  });

  it("preserves the seller call-request reason", async () => {
    const result = await resolvePolicyOutcome(baseDecision({ outcome: "new_lead", escalationReason: "call_request" }));
    expect(result).toMatchObject({ route: { kind: "escalate", reason: "model:call_request" } });
  });

  it("routes not_interested to close_not_interested with no body", async () => {
    const result = await resolvePolicyOutcome(baseDecision());
    expect(result.kind).toBe("route");
    if (result.kind === "route") {
      expect(result.route.kind).toBe("auto_close");
      expect(result.assembled.action).toBe("close_not_interested");
      expect("body" in result.assembled ? result.assembled.body : undefined).toBeUndefined();
    }
  });

  it("routes opted_out to opt_out", async () => {
    const result = await resolvePolicyOutcome(baseDecision({ outcome: "opted_out" }));
    if (result.kind === "route") expect(result.route.kind).toBe("opt_out");
    else throw new Error("expected route");
  });

  it("routes dnc to close_dnc", async () => {
    const result = await resolvePolicyOutcome(baseDecision({ outcome: "dnc" }));
    if (result.kind === "route") expect(result.route.kind).toBe("close_dnc");
    else throw new Error("expected route");
  });

  it("routes wrong_number with the decision's scope", async () => {
    const result = await resolvePolicyOutcome(
      baseDecision({ outcome: "wrong_number", wrongScope: "all" }),
    );
    if (result.kind === "route" && result.route.kind === "auto_close_wrong_number") {
      expect(result.route.scope).toBe("all");
    } else {
      throw new Error("expected auto_close_wrong_number route");
    }
  });

  it("defaults wrong_number scope to this_property when uncertain", async () => {
    const result = await resolvePolicyOutcome(
      baseDecision({ outcome: "wrong_number", wrongScope: "uncertain" }),
    );
    if (result.kind === "route" && result.route.kind === "auto_close_wrong_number") {
      expect(result.route.scope).toBe("this_property");
    } else {
      throw new Error("expected auto_close_wrong_number route");
    }
  });

  it("defaults wrong_number scope to this_property when null", async () => {
    const result = await resolvePolicyOutcome(
      baseDecision({ outcome: "wrong_number", wrongScope: null }),
    );
    if (result.kind === "route" && result.route.kind === "auto_close_wrong_number") {
      expect(result.route.scope).toBe("this_property");
    } else {
      throw new Error("expected auto_close_wrong_number route");
    }
  });

  it("returns kind=nurture without calling resolveResponderOutcome", async () => {
    const result = await resolvePolicyOutcome(baseDecision({ outcome: "nurture" }));
    expect(result).toEqual({ kind: "nurture" });
  });

  it("returns kind=no_action for bad_number", async () => {
    const result = await resolvePolicyOutcome(baseDecision({ outcome: "bad_number" }));
    expect(result).toEqual({ kind: "no_action" });
  });

  it("returns kind=no_action for unclear", async () => {
    const result = await resolvePolicyOutcome(baseDecision({ outcome: "unclear" }));
    expect(result).toEqual({ kind: "no_action" });
  });

  it("uses native confidence rather than the winning probability", async () => {
    const result = await resolvePolicyOutcome(
      baseDecision({
        outcome: "dnc",
        outcomeConfidence: 0.42,
        probabilities: { outcome: { dnc: 0.73, not_interested: 0.2 } },
      }),
    );
    if (result.kind === "route") expect(result.assembled.confidence).toBe(0.42);
    else throw new Error("expected route");
  });

  it("uses zero confidence when native confidence is missing", async () => {
    const result = await resolvePolicyOutcome(baseDecision({ outcome: "dnc" }));
    if (result.kind === "route") expect(result.assembled.confidence).toBe(0);
    else throw new Error("expected route");
  });
});
