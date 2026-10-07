import { describe, expect, it } from "vitest";

import { finishRunFromOutcome, runStatusForOutcome } from "./outcome";
import { recordStep } from "./record";

describe("runStatusForOutcome", () => {
  it("maps every dispatch outcome to a run status", () => {
    expect(runStatusForOutcome({ outcome: "sent", messageId: "m", confidence: 1 })).toMatchObject({
      status: "replied",
      outboundMessageId: "m",
    });
    expect(runStatusForOutcome({ outcome: "escalated", reason: "keyword:hard" })).toMatchObject({
      status: "escalated",
      reason: "keyword:hard",
    });
    expect(
      runStatusForOutcome({ outcome: "escalated", reason: "jev_below_threshold:nurture" }).status,
    ).toBe("held");
    expect(runStatusForOutcome({ outcome: "auto_closed", reason: "r" }).status).toBe("closed");
    expect(runStatusForOutcome({ outcome: "opted_out", reason: "r" }).status).toBe("closed");
    expect(runStatusForOutcome({ outcome: "skipped", reason: "already_replied" })).toMatchObject({
      status: "skipped",
      reason: "already_replied",
    });
  });
});

describe("held deferred dispositions", () => {
  it("maps opted_out/auto_closed to held when a hold was recorded in the run", () => {
    expect(runStatusForOutcome({ outcome: "opted_out", reason: "r" }, { held: true }).status).toBe("held");
    expect(runStatusForOutcome({ outcome: "auto_closed", reason: "r" }, { held: true }).status).toBe("held");
    expect(runStatusForOutcome({ outcome: "auto_closed", reason: "r" }, { held: false }).status).toBe("closed");
  });

  it("recordStep of a held action marks the ctx and finishRunFromOutcome writes status held", async () => {
    const updates: unknown[] = [];
    const admin = {
      from: () => ({
        insert: async () => ({ error: null }),
        update: (p: unknown) => {
          updates.push(p);
          const chain = {
            eq: () => chain,
            select: async () => ({ data: [{ id: "r" }], error: null }),
          };
          return chain;
        },
      }),
    } as never;
    const ctx = { runId: "r", orgId: "o", seq: 0 };
    await recordStep(admin, ctx, { kind: "action", name: "opted_out", result: "held" });
    await finishRunFromOutcome(admin, ctx, { outcome: "opted_out", reason: "model:opt_out" });
    expect(updates[0]).toMatchObject({ status: "held", final_outcome: "opted_out" });

    const applied = { runId: "r2", orgId: "o", seq: 0 };
    await recordStep(admin, applied, { kind: "action", name: "opted_out", result: "applied" });
    await finishRunFromOutcome(admin, applied, { outcome: "opted_out", reason: "model:opt_out" });
    expect(updates[1]).toMatchObject({ status: "closed" });
  });
});
